/**
 * `circle-cctp` (USDC) and `circle-cctpx` (EURC) — the mobile halves of
 * the backend's Arc App Kit adapters.
 *
 * Spec: docs/bridge-capability-spec.md §2, §5.2, §5.4.
 *
 * Quoting, arbitration and status live on the backend (one place for
 * Circle's chain list and Iris). What only the device can do is here:
 * check the payload against the quote the user approved, then run App
 * Kit's `bridge()` with the user's own signer.
 *
 * Two registrations, two products: CCTP and CCTPx differ in contract, fee
 * currency and chain set, and on the device they differ in the App Kit
 * step that marks the point of no return (`burn` vs `transfer`). They
 * share this factory, not a branch on the token symbol.
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
import { chainToCaip2, parseCaip2 } from "../../caip";
import {
  BridgeExecutionError,
  checkBridgeDestinationReadiness,
  isQuoteExpired,
} from "../../execute";
import type {
  BridgeExecContext,
  BridgeReadinessRequest,
  BridgeRef,
  BridgeRouteAdapter,
  BridgeSubmission,
} from "../../types";
import {
  AppKitBridgeError,
  resolveCircleChain,
  runAppKitBridge,
} from "./appKitBridge";
import { appKitSignerFor } from "./signers";
import { verifyCirclePayload } from "./verifyPayload";

function makeCircleBridgeAdapter(cfg: {
  key: string;
  protocol: "cctp" | "cctpx";
  handoffStep: "burn" | "transfer";
}): BridgeRouteAdapter {
  return {
    key: cfg.key,
    kinds: ["bridge"] as const,

    /**
     * Route fallback only: the backend decides which adapter serves a
     * route and stamps it on the quote (`adapterForQuote` uses that key).
     */
    supports(from: TCaip2, to: TCaip2): boolean {
      if (from === to) return false;
      return Boolean(parseCaip2(from) && parseCaip2(to));
    },

    // Circle's domain numbering is the backend adapter's business (§5.2).
    toProviderChainId(_c: TCaip2): string | number | null {
      return null;
    },

    toProviderAsset(_a: TCaip19): string | null {
      return null;
    },

    quote(req: TBridgeQuoteRequest): Promise<TBridgeQuoteResult> {
      return bridgeApi.getQuote(req);
    },

    async execute(
      q: TBridgeQuote,
      ctx: BridgeExecContext,
    ): Promise<BridgeSubmission> {
      if (isQuoteExpired(q)) {
        if (typeof __DEV__ !== "undefined" && __DEV__) {
          console.warn("[circleAdapters] execute: quote expired", {
            expiresAt: q.expiresAt,
            nowIso: new Date().toISOString(),
            diffMs: Date.now() - new Date(q.expiresAt).getTime(),
          });
        }
        throw new BridgeExecutionError("quote_stale");
      }

      let payload: ReturnType<typeof verifyCirclePayload>;
      try {
        payload = verifyCirclePayload({
          quote: q,
          protocol: cfg.protocol,
          resolveChain: resolveCircleChain,
        });
      } catch (err) {
        if (typeof __DEV__ !== "undefined" && __DEV__) {
          console.error("[circle] payload does not match the quote:", err);
        }
        throw new BridgeExecutionError("payload_mismatch");
      }
      // Sign on the chain the payload names, and only that one.
      if (chainToCaip2(ctx.chain) !== payload.chain) {
        if (typeof __DEV__ !== "undefined" && __DEV__) {
          console.error(
            "[circle] chain mismatch between context and payload:",
            {
              contextChain: chainToCaip2(ctx.chain),
              payloadChain: payload.chain,
            },
          );
        }
        throw new BridgeExecutionError("payload_mismatch");
      }

      const signer = appKitSignerFor(ctx.wallet, ctx.chain);
      if (!signer) {
        if (typeof __DEV__ !== "undefined" && __DEV__) {
          console.error("[circle] signer could not be created for wallet:", {
            walletNamespace: ctx.wallet.namespace,
            walletType: ctx.wallet.type,
            chain: chainToCaip2(ctx.chain),
          });
        }
        throw new BridgeExecutionError("wallet_cannot_execute");
      }

      let sourceTxHash: string;
      try {
        sourceTxHash = await runAppKitBridge({
          payload,
          signer,
          handoffStep: cfg.handoffStep,
        });
      } catch (err) {
        if (
          err instanceof AppKitBridgeError &&
          err.code === "insufficient_funds"
        ) {
          throw new BridgeExecutionError("insufficient_funds");
        }
        if (typeof __DEV__ !== "undefined" && __DEV__) {
          console.error("[circle] runAppKitBridge submission error:", err);
        }
        throw new BridgeExecutionError("submission_failed");
      }

      return {
        sourceTxHash,
        provider: q.provider,
        fromChain: q.from.chain,
        toChain: q.to.chain,
      };
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

    // No `gasTopUp`: Circle's Forwarding Service pays the destination leg,
    // so there is no receive-side strand risk (§7.5.1).
  };
}

export const circleCctpBridgeAdapter = makeCircleBridgeAdapter({
  key: "circle-cctp",
  protocol: "cctp",
  handoffStep: "burn",
});

export const circleCctpxBridgeAdapter = makeCircleBridgeAdapter({
  key: "circle-cctpx",
  protocol: "cctpx",
  handoffStep: "transfer",
});
