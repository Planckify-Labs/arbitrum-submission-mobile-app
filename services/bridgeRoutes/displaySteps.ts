/**
 * Display steps pipeline for swap and bridge quotes.
 *
 * Spec: docs/swap-capability-spec.md §6.5.
 *
 * Folds protocol fee collection steps, resolves venue attribution,
 * and formats human-friendly leg descriptions.
 */

import type {
  TBridgeQuote,
  TBridgeRouteStep,
  TBridgeStepKind,
} from "@/api/types/bridge";

export interface DisplayStep {
  key: string;
  kind: TBridgeStepKind;
  label: string;
  detail?: string;
  venueName?: string;
  fromChain?: string;
  toChain?: string;
}

export function buildDisplaySteps(quote: TBridgeQuote): DisplayStep[] {
  const isSameChain =
    quote.kind === "swap" || quote.from.chain === quote.to.chain;
  const steps = quote.steps ?? [];
  const result: DisplayStep[] = [];

  for (const step of steps) {
    // Protocol step (e.g. fee collection) is folded into the overall fee breakdown
    // rather than displayed as a standalone swap step (§6.5).
    if (step.kind === "protocol") {
      continue;
    }

    let label = step.label;
    // The adapter's own naming, never a provider name written in here
    // (swap spec §4.6: provider knowledge lives in the adapter).
    const venueName = step.provider?.name ?? quote.venue?.name;

    if (step.kind === "swap") {
      const fromSym = step.fromToken?.symbol ?? quote.from.token.symbol;
      const toSym = step.toToken?.symbol ?? quote.to.token.symbol;
      if (venueName) {
        label = `Swap ${fromSym} for ${toSym} on ${venueName}`;
      } else {
        label = `Swap ${fromSym} for ${toSym}`;
      }
    } else if (step.kind === "approve") {
      const tokenSym = step.fromToken?.symbol ?? quote.from.token.symbol;
      label = `Approve ${tokenSym}`;
    }

    result.push({
      key: step.key,
      kind: step.kind,
      label,
      venueName,
      fromChain: step.fromChain,
      toChain: step.toChain,
    });
  }

  // Fallback if no steps were explicitly returned by quote provider
  if (result.length === 0) {
    if (isSameChain) {
      const venueStr = quote.venue?.name;
      result.push({
        key: "swap",
        kind: "swap",
        label: venueStr
          ? `Swap ${quote.from.token.symbol} for ${quote.to.token.symbol} on ${venueStr}`
          : `Swap ${quote.from.token.symbol} for ${quote.to.token.symbol}`,
        venueName: venueStr,
        fromChain: quote.from.chain,
        toChain: quote.to.chain,
      });
    } else {
      result.push({
        key: "bridge",
        kind: "burn",
        label: `Transfer ${quote.from.token.symbol} to ${quote.to.chainName ?? "destination"}`,
        fromChain: quote.from.chain,
        toChain: quote.to.chain,
      });
    }
  }

  return result;
}
