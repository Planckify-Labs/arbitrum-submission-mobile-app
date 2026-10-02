/**
 * Which stablecoins the app EXPOSES. Arbitrum Open House 2026 build: the
 * only stablecoin a user can see or pick is USDG (Global Dollar). The
 * chain's native token is always allowed, and so is every non-stablecoin.
 *
 * Same posture as the chain lockdown (`services/walletKit/chainSupport.ts`,
 * `FEATURE_CHAIN_LOCKDOWN`): HIDDEN, not deleted. The api still serves the
 * rows, balances are still on-chain, and the filter is the identity with
 * the flag off.
 *
 * Token rows from the backend catalogue carry `isStablecoin`. Rows from
 * indexers and portfolio discovery do not, so those are recognised by
 * symbol as well (`STABLECOIN_SYMBOLS`). A symbol match is deliberately
 * broad: hiding a lookalike is safe, showing a stray stablecoin is not.
 */

import { FEATURE_CHAIN_LOCKDOWN as CHAIN_LOCKDOWN_ACTIVE } from "@/constants/configs/featureFlags";

/** The one stablecoin the locked-down app surfaces. */
export const LOCKDOWN_STABLECOIN_SYMBOL = "USDG";

/**
 * Real USDG contracts on the four surfaced chains (Paxos / CoinGecko
 * `global-dollar`, as seeded by the api). A row that calls itself "USDG"
 * but sits at another address is a lookalike, not the token.
 */
const USDG_ADDRESSES: ReadonlySet<string> = new Set([
  "0x004b506865409877c9fa29bfb1eba929984b9bbc", // Arbitrum One
  "0xffc95faa3d63cde504a05b567c600b78c0b41892", // Arbitrum Sepolia
  "0x5fc5360d0400a0fd4f2af552add042d716f1d168", // Robinhood Chain
  "0x7e955252e15c84f5768b83c41a71f9eba181802f", // Robinhood Chain testnet
]);

/** Stablecoin symbols recognised when a row has no `isStablecoin` flag. */
const STABLECOIN_SYMBOLS: ReadonlySet<string> = new Set([
  "USDG",
  "USDC",
  "USDC.E",
  "USDBC",
  "USDT",
  "USDT0",
  "USD₮0",
  "DAI",
  "USDS",
  "SUSDS",
  "SDAI",
  "USDE",
  "SUSDE",
  "PYUSD",
  "FDUSD",
  "TUSD",
  "BUSD",
  "USDP",
  "GUSD",
  "LUSD",
  "FRAX",
  "CRVUSD",
  "GHO",
  "USD0",
  "USDX",
  "RLUSD",
  "AUSD",
  "MUSD",
  "EURC",
  "EURS",
  "EURE",
  "IDRX",
  "XSGD",
  "BRZ",
]);

export type TokenLike = {
  symbol?: string | null;
  contractAddress?: string | null;
  isStablecoin?: boolean | null;
  isNativeCurrency?: boolean | null;
};

/** True for a row that is a stablecoin by flag or by symbol. */
export function isStablecoinLike(token: TokenLike): boolean {
  if (token.isStablecoin) return true;
  const symbol = token.symbol?.trim().toUpperCase();
  return symbol != null && STABLECOIN_SYMBOLS.has(symbol);
}

/** A token row the app may surface. */
export function isTokenSupported(token: TokenLike): boolean {
  if (!CHAIN_LOCKDOWN_ACTIVE) return true;
  if (token.isNativeCurrency) return true;
  if (!isStablecoinLike(token)) return true;
  if (token.symbol?.trim().toUpperCase() !== LOCKDOWN_STABLECOIN_SYMBOL) {
    return false;
  }
  // No address on the row (rare): trust the symbol. With one, it must be real.
  return (
    !token.contractAddress ||
    USDG_ADDRESSES.has(token.contractAddress.toLowerCase())
  );
}

/** Filters any token-shaped list down to what the app surfaces. */
export function filterSupportedTokens<T extends TokenLike>(tokens: T[]): T[] {
  if (!CHAIN_LOCKDOWN_ACTIVE) return tokens;
  return tokens.filter(isTokenSupported);
}
