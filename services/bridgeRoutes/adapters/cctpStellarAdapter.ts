/**
 * `cctp` — Circle CCTP for routes touching STELLAR, both directions.
 *
 * Spec: docs/bridge-capability-spec.md §5.4, §5.4.1, §10.5, §10.6.
 *
 * The registry earns its keep here: LI.FI has NO Stellar path (§3.2) and
 * Circle's Arc App Kit reaches EVM + Solana only, so Stellar is raw CCTP
 * (domain 27), USDC only.
 *
 *   - EVM → Stellar: an EVM `depositForBurnWithHook`, signed by the EVM
 *     kit. Stellar has NO Forwarding Service, so once Circle attests the
 *     burn the user's own Stellar wallet claims it with
 *     `CctpForwarder.mint_and_forward` (`bridge_claim`).
 *   - Stellar → EVM: a Soroban `deposit_for_burn_with_hook` (plus the
 *     SEP-41 approve it needs), signed by the Stellar kit, carrying
 *     Circle's Forwarding Service hook so Circle mints on the EVM side.
 *
 * Because these are raw calls, the device decodes every payload and
 * proves it matches the approved quote before signing
 * (`stellarCctpVerify.ts`): §5.4.1's wrong-recipient failure is permanent.
 *
 * Note the absent `gasTopUp`. Stellar's precondition is a TRUSTLINE plus
 * an XLM base reserve, not gas, and a trustline is a hard opt-in the
 * recipient must perform themselves. The remedy is `ensureTrustline` on
 * the user's own wallet, surfaced through `checkDestinationReadiness`.
 */

import { bridgeApi } from "@/api/endpoints/bridge";
import type {
  TBridgeBlocker,
  TBridgeQuote,
  TBridgeQuoteRequest,
  TBridgeQuoteResult,
  TBridgeStatus,
  TCaip2,
  TCaip19,
} from "@/api/types/bridge";
import { parseCaip2 } from "../caip";
import {
  BridgeExecutionError,
  checkBridgeDestinationReadiness,
  executeBridgeQuote,
} from "../execute";
import type {
  BridgeExecContext,
  BridgeReadinessRequest,
  BridgeRef,
  BridgeRouteAdapter,
  BridgeSubmission,
} from "../types";
import { circleEvmCctpFacts } from "./circle/appKitBridge";
import { verifyStellarCctpPayload } from "./stellarCctpVerify";

export const cctpStellarBridgeAdapter: BridgeRouteAdapter = {
  key: "cctp",
  kinds: ["bridge"] as const,

  /**
   * Route fallback only (the backend stamps the provider on the quote):
   * exactly one side Stellar, the other EVM.
   */
  supports(from: TCaip2, to: TCaip2): boolean {
    const a = parseCaip2(from)?.namespace;
    const b = parseCaip2(to)?.namespace;
    return (
      (a === "eip155" && b === "stellar") || (a === "stellar" && b === "eip155")
    );
  },

  // Circle's domain numbering lives on the backend adapter (§5.2).
  toProviderChainId(_c: TCaip2): string | number | null {
    return null;
  },

  toProviderAsset(_a: TCaip19): string | null {
    return null;
  },

  quote(req: TBridgeQuoteRequest): Promise<TBridgeQuoteResult> {
    return bridgeApi.getQuote(req);
  },

  /**
   * The only EVM contract an EVM → Stellar burn may call: Circle's CCTP V2
   * `TokenMessenger` for that chain, from App Kit's pinned definitions. A
   * Stellar source has no EVM target, so it answers an empty list.
   */
  async targetAllowlist(chain: TCaip2): Promise<readonly string[]> {
    const parsed = parseCaip2(chain);
    const chainId = Number(parsed?.reference);
    if (parsed?.namespace !== "eip155" || !Number.isInteger(chainId)) return [];
    const pins = circleEvmCctpFacts(chainId);
    return pins ? [pins.tokenMessenger] : [];
  },

  execute(q: TBridgeQuote, ctx: BridgeExecContext): Promise<BridgeSubmission> {
    try {
      verifyStellarCctpPayload(q, circleEvmCctpFacts);
    } catch (err) {
      if (typeof __DEV__ !== "undefined" && __DEV__) {
        console.warn("[cctp-stellar] payload does not match the quote", err);
      }
      return Promise.reject(new BridgeExecutionError("payload_mismatch"));
    }
    // Signing dispatches by payload shape through the wallet kits: the EVM
    // kit for an inbound burn, the Stellar kit (pinned allowlist) for an
    // outbound one.
    return executeBridgeQuote(q, ctx);
  },

  status(ref: BridgeRef): Promise<TBridgeStatus> {
    return bridgeApi.getStatus({
      fromChain: ref.fromChain,
      toChain: ref.toChain,
      txHash: ref.sourceTxHash,
      provider: ref.provider,
    });
  },

  checkDestinationReadiness(
    req: BridgeReadinessRequest,
  ): Promise<TBridgeBlocker[]> {
    return checkBridgeDestinationReadiness(req);
  },
};
