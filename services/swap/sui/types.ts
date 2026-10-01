/**
 * Sui swap layer types (spec §4.5). Mirrors the removed EVM aggregator's
 * `SwapRoute` shape — a venue returns a finished `sui-ptb` plus the quote
 * numbers the guardian needs (`expectedOut`, `priceImpact`).
 *
 * Swap is NOT a `DefiProtocolAdapter` (EVM swaps go through `services/bridgeRoutes`),
 * so the Sui swap router lives here and is selected per-network by
 * `venueSelector.ts` — the model never picks a DEX (§3, §4.6).
 */

import type { SuiChainConfig } from "@/constants/configs/chainConfig";
import type { TWallet } from "@/constants/types/walletTypes";
import type { SuiNetwork } from "@/services/chains/sui/payloads";

export interface SuiSwapRouteParams {
  wallet: TWallet;
  chain: SuiChainConfig;
  /** App-level symbols (e.g. "SUI", "USDC"). */
  fromSymbol: string;
  toSymbol: string;
  /**
   * INPUT coin metadata, resolved from the token registry (§3). The input
   * is something the user holds, so it's always in the registry (SUI is
   * native-resolvable). Required.
   */
  fromCoinType: string;
  fromDecimals: number;
  /**
   * OUTPUT coin metadata is **venue-authoritative** — the DEX defines the
   * pool's coins, so each venue resolves the output `coinType` + `decimals`
   * itself (e.g. DeepBook reads them from its own coin map). These are
   * optional hints only: the user need not hold the output token, and it
   * need not have a registry row. Do NOT rely on them being present.
   */
  toCoinType?: string;
  toDecimals?: number;
  /** Exact-in amount. `human` as the user said it; `raw` in `fromDecimals`. */
  amountHuman: string;
  amountRaw: bigint;
  maxSlippageBps: number;
}

export interface SuiSwapRoute {
  /** Venue id that produced this route ("deepbook" | "cetus"). */
  venue: string;
  /** base64 BCS — a finished `sui-ptb`. */
  ptbBase64: string;
  /** Expected output in raw `toDecimals` units — feeds the guardian. */
  expectedOut: bigint;
  /** Price impact as a fraction (0.032 = 3.2%) — feeds high-slippage (§5.2). */
  priceImpact: number;
  /** Pool/object id touched, for the stale-pool check (§5.2). */
  poolObjectId?: string;
  fromCoinType: string;
  toCoinType: string;
}

/** One swap venue (DeepBook / Cetus / 7K). Docks via the selector, never a branch. */
export interface SuiSwapVenue {
  readonly id: string;
  /** True when this venue runs on `network` (DeepBook: all; Cetus/7K: mainnet). */
  supports(network: SuiNetwork): boolean;
  /**
   * Quote + build a finished route, or `null` when this venue can't serve
   * the pair / has no route. For an ordinary "no route" return `null`.
   *
   * A venue MAY throw a typed `SuiSwapError` to surface a *specific,
   * actionable* reason (e.g. `amount_below_minimum`). The selector skips the
   * venue either way, but preserves the first such reason and re-throws it
   * when no venue produces a route — so the user gets "that amount is below
   * the pool minimum" instead of a generic `no_swap_route`. Never throw a
   * raw SDK/RPC error (those are caught and swallowed as a plain skip).
   */
  getRoute(params: SuiSwapRouteParams): Promise<SuiSwapRoute | null>;
}

export type SuiSwapErrorCode =
  | "no_swap_route"
  | "amount_below_minimum"
  | "unsupported_pair"
  | "quote_failed"
  | "build_failed"
  | "network_error";

/**
 * Typed swap error. Carries a curated `code` only — never a raw SDK/RPC
 * string (CLAUDE.md user-facing-errors). The executor maps `code` →
 * `ExecutorErrorCode` + friendly copy.
 */
export class SuiSwapError extends Error {
  readonly name = "SuiSwapError";
  readonly code: SuiSwapErrorCode;
  constructor(code: SuiSwapErrorCode, detail?: string) {
    super(detail ?? code);
    this.code = code;
  }
}
