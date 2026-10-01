/**
 * High-slippage risk check (spec §5.2).
 *
 * Slippage = the gap between what you expect to receive and what you
 * actually receive. The number comes from the swap router's pre-build
 * quote (`compiled.priceImpact` / `expectedOut`) — never the LLM. We reuse
 * the in-app swap thresholds (`getPriceImpactSeverity`: ≥2% warn, ≥10%
 * danger→block) so the slippage UX matches the existing swap surface, and
 * tighten with the user's `maxSlippageBps`.
 *
 * Conservative rounding (SI-6): price-impact is rounded UP for display so a
 * borderline-unsafe swap is never rounded into looking safe.
 */

import { getPriceImpactSeverity } from "@/services/swap/slippage";
import { formatRiskCopy } from "../copy";
import type { RiskCheck, RiskFlag, Severity } from "../riskCheck";

/** Round a percent UP to one decimal place (toward flagging risk). */
function ceilPct(pct: number): number {
  return Math.ceil(pct * 10) / 10;
}

export function createHighSlippageCheck(): RiskCheck {
  return {
    code: "slippage.high",
    async run({ intent, compiled }): Promise<RiskFlag | null> {
      // Only DEX legs carry a price-impact quote (a plain swap or the swap
      // leg of a swap→supply zap); supply/withdraw never do.
      if (intent.action !== "swap" && intent.action !== "swap_and_supply") {
        return null;
      }
      if (typeof compiled.priceImpact !== "number") return null;

      const pct = Math.abs(compiled.priceImpact) * 100;
      const band = getPriceImpactSeverity(pct); // "safe" | "warn" | "danger"
      if (band === "safe") return null;

      const severity: Severity = band === "danger" ? "block" : "warn";
      const shown = ceilPct(pct);
      const copy = formatRiskCopy({
        code: "slippage.high",
        severity,
        params: { pct: shown },
      });
      return { code: "slippage.high", severity, ...copy };
    },
  };
}
