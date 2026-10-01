/**
 * Slippage and price impact severity classification.
 *
 * Spec: docs/swap-capability-spec.md §9.2.
 */

export type PriceImpactSeverity = "safe" | "warn" | "danger";

export function getPriceImpactSeverity(impactPct: number): PriceImpactSeverity {
  const abs = Math.abs(impactPct);
  if (abs < 2) return "safe";
  if (abs < 10) return "warn";
  return "danger";
}

export function getPriceImpactSeverityFromBps(
  impactBps: number,
): PriceImpactSeverity {
  return getPriceImpactSeverity(impactBps / 100);
}

export function validateSlippage(slippage: number): {
  valid: boolean;
  warning?: string;
} {
  if (slippage < 0.01) return { valid: false, warning: "Slippage too low" };
  if (slippage > 50) return { valid: false, warning: "Slippage too high" };
  if (slippage > 1)
    return {
      valid: true,
      warning: "High slippage. You may receive significantly less.",
    };
  return { valid: true };
}
