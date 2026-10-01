/**
 * `tower` — same-chain swaps on Arc (Tower Exchange).
 *
 * The backend `tower` adapter (api `src/bridge/providers/tower.adapter.ts`)
 * docks Arc swaps into the bridge surface as a SAME-CHAIN route, so the
 * quote card, re-quote at signing, approval + transaction payload and
 * progress card are all the bridge ones. This mobile half exists only so
 * `adapterForQuote("tower", …)` resolves: signing is chain-owned and goes
 * through the same `executeBridgeQuote` walletKit dispatch as `lifi`.
 *
 * It never overlaps the other adapters. They refuse same-chain routes;
 * this one refuses cross-chain ones.
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
import {
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

/** Arc mainnet and testnet — the chains Tower serves. */
const ARC_CHAINS = new Set<TCaip2>(["eip155:5042", "eip155:5042002"]);

export const towerBridgeAdapter: BridgeRouteAdapter = {
  key: "tower",
  kinds: ["swap"] as const,

  supports(from: TCaip2, to: TCaip2): boolean {
    return from === to && ARC_CHAINS.has(from);
  },

  // The provider's numbering is the backend adapter's business (§5.2).
  toProviderChainId(_c: TCaip2): string | number | null {
    return null;
  },

  toProviderAsset(_a: TCaip19): string | null {
    return null;
  },

  quote(req: TBridgeQuoteRequest): Promise<TBridgeQuoteResult> {
    return bridgeApi.getQuote(req);
  },

  execute(q: TBridgeQuote, ctx: BridgeExecContext): Promise<BridgeSubmission> {
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
