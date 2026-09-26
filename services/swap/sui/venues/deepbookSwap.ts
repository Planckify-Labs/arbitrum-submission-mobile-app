/**
 * DeepBook v3 swap venue (spec §4.5) — testnet + mainnet, the baseline and
 * the only testnet-capable DEX.
 *
 * Uses `@mysten/deepbook-v3`: `getQuoteQuantityOut` / `getBaseQuantityOut`
 * for the pre-build quote (→ `expectedOut` + `priceImpact` for the
 * guardian), then `swapExactBaseForQuote` / `swapExactQuoteForBase` to
 * append the swap to a `Transaction`, transferring the output coins back to
 * the sender. The SDK works in DECIMAL amounts (it scales by each coin's
 * `scalar`), so we hand it the human amount and convert the quoted output
 * to raw units for the route.
 *
 * The SDK is dynamically imported so its (and Pyth's) module graph never
 * loads at app boot — only when a swap actually runs (the
 * `recordTransferHistory` precedent). Any inability to quote/build returns
 * `null` so the selector falls through to another venue or reports
 * `no_swap_route`; it never crashes the preview.
 *
 * DEEP fees: we pass `deepAmount: 0`. Whitelisted / input-fee pools (the
 * testnet `SUI_DBUSDC` baseline) need no DEEP; if a pool genuinely requires
 * DEEP the dry-run reverts and the guardian blocks with a plain-language
 * "this would fail on-chain" — never a silent bad sign.
 */

import { toBase64 } from "@mysten/bcs";
import type {
  CoinMap,
  DeepBookClient,
  DeepBookCompatibleClient,
  PoolMap,
} from "@mysten/deepbook-v3";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import {
  Transaction,
  type TransactionObjectArgument,
} from "@mysten/sui/transactions";
import { parseUnits } from "viem";
import { createSuiGrpcJsonRpcTransport } from "@/services/chains/sui/grpcTransport";
import type { SuiNetwork } from "@/services/chains/sui/payloads";
import { appendIntentReceipt } from "../appendIntentReceipt";
import { resolveDeepbookPool } from "../deepbook.config";
import { resolveIntentReceiptPackageId } from "../intentReceiptPackageId";
import {
  SuiSwapError,
  type SuiSwapRoute,
  type SuiSwapRouteParams,
  type SuiSwapVenue,
} from "../types";

/**
 * Output-coin metadata resolved from DeepBook's OWN config (the DEX is the
 * source of truth for the coins its pools trade — see CLAUDE.md / the
 * token-config-is-API-driven rule: we never hardcode decimals in the app,
 * and we never require the user to hold / have a registry row for the coin
 * they're swapping INTO). `scalar` is 10^decimals.
 */
interface OutputCoinMeta {
  coinType: string;
  decimals: number;
}

function decimalsFromScalar(scalar: number): number {
  if (!Number.isFinite(scalar) || scalar <= 0) return 0;
  return Math.round(Math.log10(scalar));
}

/**
 * Resolve the OUTPUT coin (the side the user receives) for a pool + trade
 * direction, reading the SDK's bundled coin/pool maps. Returns `null` if the
 * pool/coin isn't in the SDK config — the venue then can't honour the route.
 */
function resolveOutputCoin(
  network: SuiSwapRouteParams["chain"]["network"],
  poolKey: string,
  side: "base->quote" | "quote->base",
  pools: PoolMap,
  coins: CoinMap,
): OutputCoinMeta | null {
  const pool = pools[poolKey];
  if (!pool) return null;
  const outKey = side === "base->quote" ? pool.quoteCoin : pool.baseCoin;
  const coin = coins[outKey];
  if (!coin) return null;
  return { coinType: coin.type, decimals: decimalsFromScalar(coin.scalar) };
}

/** Convert a JS decimal number to raw bigint units, rounding down. */
function decimalToRaw(value: number, decimals: number): bigint {
  if (!Number.isFinite(value) || value <= 0) return 0n;
  // `toFixed(decimals)` then `parseUnits` avoids float drift at the
  // chain boundary; rounding down is conservative for an expected-out.
  try {
    return parseUnits(value.toFixed(Math.min(decimals, 18)), decimals);
  } catch {
    return 0n;
  }
}

async function loadDeepBook(
  chain: SuiSwapRouteParams["chain"],
  address: string,
): Promise<{ db: DeepBookClient; coins: CoinMap; pools: PoolMap }> {
  const mod = await import("@mysten/deepbook-v3");
  const suiClient = new SuiJsonRpcClient({
    transport: createSuiGrpcJsonRpcTransport(chain.network),
    network: chain.network,
  });
  const db = new mod.DeepBookClient({
    // 2.16 vs the SDK's 2.18 peer differ only structurally; the methods
    // DeepBook calls exist on our client. Cast at the single boundary.
    client: suiClient as unknown as DeepBookCompatibleClient,
    address,
    network: chain.network as SuiNetwork,
  });
  // The SDK's bundled coin/pool maps are the source of truth for the coins
  // each pool trades (decimals via `scalar`, Move `type`).
  const isMainnet = chain.network === "mainnet";
  return {
    db,
    coins: isMainnet ? mod.mainnetCoins : mod.testnetCoins,
    pools: isMainnet ? mod.mainnetPools : mod.testnetPools,
  };
}

export const deepbookSwapVenue: SuiSwapVenue = {
  id: "deepbook",

  supports(): boolean {
    // DeepBook runs on testnet and mainnet; devnet has no pools (config gates).
    return true;
  },

  async getRoute(params: SuiSwapRouteParams): Promise<SuiSwapRoute | null> {
    try {
      const tx = new Transaction();
      tx.setSender(params.wallet.address);
      const swap = await appendDeepbookSwap(tx, params);
      if (!swap) return null;

      // Single-swap path: sweep the output + leftover coins back to the user.
      tx.transferObjects(
        [swap.outputCoin, ...swap.leftoverCoins],
        tx.pure.address(params.wallet.address),
      );

      // Final command: the on-chain intent receipt. The Package ID is resolved
      // from the smart-contracts API (MMKV-cached), never hardcoded — undefined
      // ⇒ not registered / unreachable ⇒ no-op, the swap is unaffected (§10).
      const receiptPackageId = await resolveIntentReceiptPackageId(
        params.chain.network as SuiNetwork,
      );
      appendIntentReceipt(tx, {
        packageId: receiptPackageId,
        descriptor: `swap ${params.amountHuman} ${params.fromSymbol}->${params.toSymbol}`,
      });

      const bytes = await tx.build({
        client: new SuiJsonRpcClient({
          transport: createSuiGrpcJsonRpcTransport(params.chain.network),
          network: params.chain.network,
        }),
      });

      return {
        venue: this.id,
        ptbBase64: toBase64(bytes),
        expectedOut: swap.expectedOut,
        priceImpact: swap.priceImpact,
        poolObjectId: swap.poolObjectId,
        fromCoinType: params.fromCoinType,
        toCoinType: swap.toCoinType,
      };
    } catch (err) {
      // A typed, actionable reason (e.g. amount_below_minimum) must reach the
      // selector — re-throw it. Any other quote/build failure is a plain skip
      // (selector reports no_swap_route if no venue answers); surface the real
      // SDK reason in dev logs ONLY (CLAUDE.md user-facing-errors).
      if (err instanceof SuiSwapError) throw err;
      if (typeof __DEV__ !== "undefined" && __DEV__) {
        console.warn(
          `[deepbookSwap] route failed for ${params.fromSymbol}->${params.toSymbol} on ${params.chain.network}:`,
          err,
        );
      }
      return null;
    }
  },
};

/** A DeepBook swap appended to an existing tx (the `buildInto` seam, §4.7). */
export interface AppendedDeepbookSwap {
  /** The coin the user receives — kept (single swap) or supplied (zap). */
  outputCoin: TransactionObjectArgument;
  /** The swap's other return coins (leftover input + DEEP) — return to user. */
  leftoverCoins: TransactionObjectArgument[];
  expectedOut: bigint;
  priceImpact: number;
  toCoinType: string;
  toDecimals: number;
  poolObjectId?: string;
}

/**
 * Quote + append a DeepBook swap to an EXISTING `Transaction`, returning the
 * output coin **un-transferred** plus the leftover coins and the quote numbers
 * the guardian needs. This is the composable seam (spec §4.7):
 *   • `getRoute` (single swap) transfers everything back to the user;
 *   • the atomic swap→supply compose feeds `outputCoin` straight into a
 *     Scallop deposit on the SAME tx — one all-or-nothing PTB.
 *
 * Returns `null` for an ordinary no-route (so the selector falls through);
 * throws `SuiSwapError("amount_below_minimum")` for an actionable too-small
 * order. Does NOT set the sender, transfer, append the receipt, or build —
 * the caller owns the tx lifecycle.
 */
export async function appendDeepbookSwap(
  tx: Transaction,
  params: SuiSwapRouteParams,
): Promise<AppendedDeepbookSwap | null> {
  const resolved = resolveDeepbookPool(
    params.chain.network,
    params.fromSymbol,
    params.toSymbol,
  );
  if (!resolved) {
    if (typeof __DEV__ !== "undefined" && __DEV__) {
      console.warn(
        `[deepbookSwap] no pool for ${params.fromSymbol}->${params.toSymbol} on ${params.chain.network}`,
      );
    }
    return null;
  }

  const { db, coins, pools } = await loadDeepBook(
    params.chain,
    params.wallet.address,
  );
  const amountIn = Number(params.amountHuman);
  if (!Number.isFinite(amountIn) || amountIn <= 0) return null;

  // Output coin (coinType + decimals) from DeepBook's own config — the DEX is
  // authoritative for the pool's coins, so the user never needs a registry row
  // or holdings for the asset they're swapping INTO. If the SDK doesn't
  // describe the pool's coins we skip the venue rather than fabricate decimals.
  const outMeta = resolveOutputCoin(
    params.chain.network,
    resolved.poolKey,
    resolved.side,
    pools,
    coins,
  );
  if (!outMeta) {
    if (typeof __DEV__ !== "undefined" && __DEV__) {
      console.warn(
        `[deepbookSwap] SDK has no coin metadata for pool ${resolved.poolKey} on ${params.chain.network}`,
      );
    }
    return null;
  }

  // Quote (decimal out). Use the INPUT-FEE quote variants: the build below
  // passes `deepAmount: 0`, so DeepBook charges the swap fee from the INPUT
  // coin — the user needs NO DEEP token (the pool is not whitelisted). Quoting
  // with the pay-DEEP variant would mis-state expectedOut/minOut vs. what
  // actually executes and could make a valid swap revert on `minOut`.
  let expectedOutDecimal: number;
  if (resolved.side === "base->quote") {
    const q = await db.getQuoteQuantityOutInputFee(resolved.poolKey, amountIn);
    expectedOutDecimal = q.quoteOut;
  } else {
    const q = await db.getBaseQuantityOutInputFee(resolved.poolKey, amountIn);
    expectedOutDecimal = q.baseOut;
  }
  if (!Number.isFinite(expectedOutDecimal) || expectedOutDecimal <= 0) {
    // A zero fill on a pool that HAS liquidity means the amount is below the
    // pool's *usable* minimum. NOTE the input fee is taken FROM the input, so
    // the effective minimum sits a bit ABOVE the raw on-chain minSize + lot
    // rounding — e.g. on minSize-1 SUI_DBUSDC, 1.0 SUI yields 0 (fee+lot push
    // it under 1.0) while ~1.1 fills. So we can't gate on `amountIn < minSize`;
    // instead, a 0 fill while the book has liquidity IS the actionable "amount
    // below minimum" case. Only a genuinely empty/priceless book is a real
    // no-route (→ null).
    let minSize: number | undefined;
    try {
      minSize = (await db.poolBookParams(resolved.poolKey)).minSize;
    } catch {
      minSize = undefined;
    }
    let hasLiquidity = false;
    try {
      const mid = await db.midPrice(resolved.poolKey);
      hasLiquidity = Number.isFinite(mid) && mid > 0;
    } catch {
      hasLiquidity = false;
    }
    if (typeof __DEV__ !== "undefined" && __DEV__) {
      console.warn(
        `[deepbookSwap] ${resolved.poolKey}: 0 output for ${amountIn} ${params.fromSymbol} (minSize ${minSize ?? "?"}, liquidity ${hasLiquidity})`,
      );
    }
    if (hasLiquidity) {
      throw new SuiSwapError(
        "amount_below_minimum",
        minSize !== undefined
          ? `min ~${minSize} ${params.fromSymbol} (after fee)`
          : undefined,
      );
    }
    return null;
  }

  const priceImpact = await computePriceImpact(
    db,
    resolved.poolKey,
    resolved.side,
    amountIn,
  );

  const minOutDecimal =
    expectedOutDecimal * (1 - params.maxSlippageBps / 10_000);

  const swapArgs = {
    poolKey: resolved.poolKey,
    amount: amountIn,
    deepAmount: 0,
    minOut: minOutDecimal,
  };
  // DeepBook returns [baseOut, quoteOut, deepOut]. The user's OUTPUT is the
  // quote coin for base->quote, the base coin for quote->base; the other two
  // (leftover input + DEEP) are returned to the user by the caller.
  const results =
    resolved.side === "base->quote"
      ? db.deepBook.swapExactBaseForQuote(swapArgs)(tx)
      : db.deepBook.swapExactQuoteForBase(swapArgs)(tx);
  const coinsOut = [...results] as TransactionObjectArgument[];
  const outputCoin =
    resolved.side === "base->quote" ? coinsOut[1] : coinsOut[0];
  const leftoverCoins =
    resolved.side === "base->quote"
      ? [coinsOut[0], coinsOut[2]]
      : [coinsOut[1], coinsOut[2]];

  let poolObjectId: string | undefined;
  try {
    poolObjectId = await db.poolId(resolved.poolKey);
  } catch {
    poolObjectId = undefined;
  }

  return {
    outputCoin,
    leftoverCoins,
    expectedOut: decimalToRaw(expectedOutDecimal, outMeta.decimals),
    priceImpact,
    toCoinType: outMeta.coinType,
    toDecimals: outMeta.decimals,
    poolObjectId,
  };
}

/**
 * Price impact ≈ (referenceOut − expectedOut) / referenceOut, where the
 * reference is the swap valued at the pool's mid price. Returns 0 when the
 * mid price is unavailable (the on-chain `minOut` is still enforced).
 */
/**
 * Price impact = how far the order's volume-weighted execution price sits from
 * the mid, computed FROM THE ORDER BOOK — i.e. pure market depth, with NO fee
 * in it.
 *
 * The earlier version compared the swap's *post-fee* quote against mid, which
 * counted the DeepBook taker fee (large on the no-DEEP `…InputFee` path used
 * here) as "price impact" — so a ~$4 swap on the deep `SUI_USDC` book reported
 * ~9% impact and the guardian blocked a perfectly fine trade. Impact and fee
 * are different costs: impact is depth (this function), the fee is a separate
 * flat cost, and the guardian's on-chain dry-run is the authoritative check on
 * the *actual* received amount. We walk the book the order would consume and
 * take the VWAP vs mid; a too-large order that exhausts the returned depth adds
 * the unfilled fraction as impact so genuine thin-pool cases still flag.
 */
async function computePriceImpact(
  db: DeepBookClient,
  poolKey: string,
  side: "base->quote" | "quote->base",
  amountIn: number,
): Promise<number> {
  try {
    // Wide enough to cover any demo-sized order on a liquid pool; a huge order
    // that still exhausts it falls through to the shortfall term below.
    const book = await db.getLevel2TicksFromMid(poolKey, 100);
    const bestBid = book.bid_prices?.[0];
    const bestAsk = book.ask_prices?.[0];
    if (
      !Number.isFinite(bestBid) ||
      !Number.isFinite(bestAsk) ||
      bestBid <= 0 ||
      bestAsk <= 0
    ) {
      return 0; // no readable book → don't fabricate impact; dry-run is the guard
    }
    const mid = (bestBid + bestAsk) / 2;

    if (side === "base->quote") {
      // Selling `amountIn` base into the bids (best/highest first).
      let baseLeft = amountIn;
      let quoteOut = 0;
      for (let i = 0; i < book.bid_prices.length && baseLeft > 0; i++) {
        const fill = Math.min(book.bid_quantities[i], baseLeft);
        quoteOut += fill * book.bid_prices[i];
        baseLeft -= fill;
      }
      const filled = amountIn - baseLeft;
      if (filled <= 0) return 1;
      const vwap = quoteOut / filled; // quote per base
      const depthImpact = Math.max(0, (mid - vwap) / mid);
      return depthImpact + baseLeft / amountIn; // + unfilled shortfall
    }

    // quote->base: buying base with `amountIn` quote from the asks (best first).
    let quoteLeft = amountIn;
    let baseOut = 0;
    for (let i = 0; i < book.ask_prices.length && quoteLeft > 0; i++) {
      const px = book.ask_prices[i];
      const spend = Math.min(book.ask_quantities[i] * px, quoteLeft);
      baseOut += spend / px;
      quoteLeft -= spend;
    }
    const spent = amountIn - quoteLeft;
    if (baseOut <= 0 || spent <= 0) return 1;
    const vwap = spent / baseOut; // quote per base
    const depthImpact = Math.max(0, (vwap - mid) / mid);
    return depthImpact + quoteLeft / amountIn;
  } catch {
    return 0;
  }
}
