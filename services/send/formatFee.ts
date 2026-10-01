/**
 * Display formatting for network fees.
 *
 * `WalletKitAdapter.formatNativeAmount` rounds to 4 decimals, which turns a
 * typical fee (0.000021 ETH, 0.000005 SOL) into "0.0000". Fees need
 * significant digits, not fixed decimals. Pure; no chain knowledge: the
 * caller supplies the decimals.
 */

const MAX_FEE_DECIMALS = 8;

/** Decimals of the native coin, read from the kit's own parser (1 unit → 10^d). */
export function decimalsFromOneUnit(oneUnitRaw: bigint): number {
  return oneUnitRaw.toString().length - 1;
}

/**
 * Formats `raw` (smallest units) with at least 2 significant digits, capped
 * at 8 decimals. Values that would round to nothing show as `<0.00000001`.
 */
export function formatFeeAmount(raw: bigint, decimals: number): string {
  if (raw <= 0n) return "0";
  const digits = raw.toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals) || "0";
  const frac = decimals > 0 ? digits.slice(digits.length - decimals) : "";

  if (whole !== "0") {
    // 1.2345... → keep 4 decimals max, trimmed.
    const trimmed = frac.slice(0, 4).replace(/0+$/, "");
    return trimmed ? `${whole}.${trimmed}` : whole;
  }

  const firstSig = frac.search(/[1-9]/);
  if (firstSig === -1) return "0";
  const keep = Math.min(firstSig + 2, MAX_FEE_DECIMALS);
  if (firstSig >= MAX_FEE_DECIMALS) {
    return `<0.${"0".repeat(MAX_FEE_DECIMALS - 1)}1`;
  }
  const trimmed = frac.slice(0, keep).replace(/0+$/, "");
  return `0.${trimmed}`;
}
