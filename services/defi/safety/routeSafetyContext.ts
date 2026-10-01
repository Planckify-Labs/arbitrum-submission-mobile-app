/**
 * Route safety context builder.
 *
 * Bridges the gap between quote representations (TBridgeQuote)
 * and the safety pipeline (SafetyContext) for swap and bridge actions.
 * Spec: docs/swap-capability-spec.md §8.4.
 */

import type { TBridgeQuote } from "@/api/types/bridge";
import type { TWallet } from "@/constants/types/walletTypes";
import { parseCaip2 } from "@/services/bridgeRoutes/caip";
import type { Namespace } from "@/services/chains/types";
import { NATIVE_ASSET_SENTINEL, type UnsignedCall } from "../types";
import type {
  SafetyAction,
  SafetyContext,
  SafetyStage,
  SimResult,
} from "./types";

export interface BuildRouteSafetyContextArgs {
  quote: TBridgeQuote;
  wallet: TWallet;
  stage: SafetyStage;
  toolInput?: Record<string, unknown>;
  call?: UnsignedCall;
  sim?: SimResult;
  feeEstimate?: bigint;
  priceImpactAckBps?: number;
  /** Adapter-declared `targetAllowlist`, when it has one. */
  allowedTargets?: readonly string[];
  /** One route, one submission (`idempotency`, §8.4 L4). */
  submissionKey?: string;
}

export function buildRouteSafetyContext(
  args: BuildRouteSafetyContextArgs,
): SafetyContext {
  const {
    quote,
    wallet,
    stage,
    toolInput,
    call,
    sim,
    feeEstimate,
    priceImpactAckBps,
  } = args;

  const parsedFrom = parseCaip2(quote.from.chain);
  const namespace = (parsedFrom?.namespace ?? wallet.namespace) as Namespace;
  // EVM rows are keyed by numeric chainId; other namespaces keep their
  // CAIP-2 reference. A string here made every EVM route fail chain-binding.
  const rawChainId = parsedFrom?.reference ?? wallet.chainId ?? 1;
  const chainId =
    namespace === "eip155" && Number.isInteger(Number(rawChainId))
      ? Number(rawChainId)
      : rawChainId;
  const action: SafetyAction =
    quote.kind === "swap" || quote.from.chain === quote.to.chain
      ? "swap"
      : "bridge";

  let routeDestination: string | undefined;
  let routeSpender: string | undefined;
  if (quote.execution && "to" in quote.execution) {
    routeDestination = quote.execution.to;
    if ("approval" in quote.execution && quote.execution.approval?.spender) {
      routeSpender = quote.execution.approval.spender;
    }
  }

  const requestedAmount = BigInt(quote.from.amountRaw || "0");
  const previewOut = BigInt(quote.to.amountRaw || "0");

  let unsignedCall: UnsignedCall | undefined = call;
  if (
    !unsignedCall &&
    quote.execution &&
    quote.execution.kind === "evm_transaction"
  ) {
    unsignedCall = {
      kind: "evm-call",
      to: quote.execution.to as `0x${string}`,
      data: quote.execution.data as `0x${string}`,
      value: BigInt(quote.execution.value || "0"),
      needsApproval: quote.execution.approval
        ? {
            token: quote.execution.approval.token as `0x${string}`,
            spender: quote.execution.approval.spender as `0x${string}`,
            amount: BigInt(quote.execution.approval.amountRaw),
          }
        : undefined,
    };
  }

  return {
    namespace,
    action,
    chainId,
    wallet: wallet.address,
    requestedAmount,
    // A native input decodes to the zero-address sentinel, not "native".
    underlyingExpected: quote.from.token.address || NATIVE_ASSET_SENTINEL,
    previewOut,
    tvlUsdSnapshot: null,
    sim: sim ?? null,
    feeEstimate: feeEstimate ?? null,
    stage,
    call: unsignedCall,
    toolInput,
    protocolSlug: quote.provider,
    family: quote.provider,
    routeQuote: quote,
    // `priceImpact` is a PERCENT on the wire, so 1% is 100 bps. Each API
    // adapter converts its provider's unit (Tower reports basis points
    // despite its docs, live-verified 2026-09-30).
    priceImpactBps:
      typeof quote.priceImpact === "number"
        ? Math.round(quote.priceImpact * 100)
        : undefined,
    priceImpactAckBps,
    fromAsset: quote.from.token.address || "native",
    toAsset: quote.to.token.address || "native",
    fromChain: quote.from.chain,
    toChain: quote.to.chain,
    slippageBps: quote.slippageBps,
    routeDestination,
    routeSpender,
    routeAllowedTargets: args.allowedTargets,
    routeAllowedSpenders: args.allowedTargets,
    submissionKey: args.submissionKey,
  };
}
