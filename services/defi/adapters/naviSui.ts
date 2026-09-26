/**
 * NAVI adapter — a `DefiProtocolAdapter` for pool-level Sui deposits
 * (docs/defi-pool-level-deposits-spec.md §7, Phase 3). NAVI is a Sui money
 * market; ONE adapter covers every NAVI reserve, dispatched by
 * `DepositTarget.kind === "navi-pool"`.
 *
 * NO SDK. PTBs are built directly with `@mysten/sui`, calling NAVI's public
 * lending_core gateway:
 *
 *   deposit  → incentive_v3::entry_deposit<T>(clock, storage, pool, assetId,
 *                coin, amount, incentiveV2, incentiveV3)
 *   withdraw → incentive_v3::entry_withdraw_v2<T>(clock, oracle, storage, pool,
 *                assetId, amount, incentiveV2, incentiveV3, systemState)
 *
 * KEY DIFFERENCE vs Scallop/Ember: NAVI has NO receipt/share coin. A supply is
 * tracked inside the shared `Storage` object against the user (keyed by the
 * numeric `assetId`), so:
 *   - withdraw is BY AMOUNT, not by redeeming a share coin. "MAX" (withdraw-all)
 *     is supported by dry-running NAVI's public getter
 *     `logic::user_collateral_balance(&mut Storage, assetId, user) -> u256` to
 *     read the live supplied balance and passing it as the withdraw amount.
 *     Verified on mainnet (2026-07-03): that u256 is in the coin's NATIVE
 *     decimals — the same unit `entry_withdraw_v2`'s u64 amount expects — so it
 *     feeds the withdraw 1:1. Reading at build time is the safe direction:
 *     interest keeps accruing, so the live balance at execution is ≥ the read,
 *     leaving at most seconds-of-interest dust rather than ever over-withdrawing.
 *   - `readPosition` needs the reserve's `assetId`/`coinType`, which the current
 *     `readPosition(walletAddress)` dispatch doesn't thread, so it returns null
 *     for now (the same first-cut limitation as the other Sui adapters).
 *
 * The per-asset { pool, assetId, coinType } is the resolved `navi-pool` target;
 * the core shared objects come from `navi.config.ts`. MAINNET-ONLY
 * (`chainId:"mainnet"`). Every failure maps to a curated `DefiError` (CLAUDE.md).
 */

import { toBase64 } from "@mysten/bcs";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import {
  SUI_CLOCK_OBJECT_ID,
  SUI_SYSTEM_STATE_OBJECT_ID,
} from "@mysten/sui/utils";
import {
  getSuiMainnetChain,
  type SuiChainConfig,
} from "@/constants/configs/chainConfig";
import { createSuiGrpcJsonRpcTransport } from "@/services/chains/sui/grpcTransport";
import { SuiSwapError } from "@/services/swap/sui/types";
import { classifySuiMoveError, DefiError } from "../errors/defiErrors";
import type {
  BuildDepositArgs,
  BuildWithdrawArgs,
  DefiPosition,
  DefiProtocolAdapter,
  DepositTarget,
  PositionReadContext,
  UnsignedCall,
  ZapSupplyArgs,
  ZapSupplyResult,
} from "../types";
import { getNaviCore } from "./navi.config";
import { leBytesToBigInt, prepareInputCoin } from "./sui/coins";

const SLUG = "navi-sui";
const NETWORK = "mainnet" as const;
const DEPOSIT_TARGET = "incentive_v3::entry_deposit" as const;
const WITHDRAW_TARGET = "incentive_v3::entry_withdraw_v2" as const;

function devWarn(scope: string, err: unknown): void {
  if (typeof __DEV__ !== "undefined" && __DEV__) {
    console.warn(`[naviSui] ${scope}:`, err);
  }
}

function suiClientFor(chain: SuiChainConfig): SuiJsonRpcClient {
  return new SuiJsonRpcClient({
    transport: createSuiGrpcJsonRpcTransport(chain.network),
    network: chain.network,
  });
}

/** Largest value the on-chain `u64` withdraw amount can hold. */
const U64_MAX = (1n << 64n) - 1n;

/**
 * Read the user's live supplied (collateral) balance for a NAVI reserve, in the
 * reserve token's NATIVE decimals, by dry-running NAVI's public getter
 * `lending_core::logic::user_collateral_balance(&mut Storage, assetId, user) -> u256`.
 *
 * Verified on mainnet (2026-07-03): the returned u256 is in the coin's native
 * decimals — the SAME unit `entry_withdraw_v2`'s u64 `amount` expects (e.g. a
 * 1000 USDC supply reads `1_000_000_000`, matching a 1000 USDC withdraw). So it
 * feeds the withdraw amount 1:1. Clamped to u64 (realistic balances never come
 * close). Returns 0n when the wallet has no supply in this reserve.
 */
async function readNaviSupplyRaw(
  client: SuiJsonRpcClient,
  packageId: string,
  storage: string,
  assetId: number,
  owner: string,
): Promise<bigint> {
  const tx = new Transaction();
  tx.moveCall({
    target: `${packageId}::logic::user_collateral_balance`,
    arguments: [
      tx.object(storage),
      tx.pure.u8(assetId),
      tx.pure.address(owner),
    ],
  });
  const res = await client.devInspectTransactionBlock({
    transactionBlock: tx,
    sender: owner,
  });
  const bytes = res.results?.[0]?.returnValues?.[0]?.[0];
  if (!bytes || bytes.length === 0) return 0n;
  const v = leBytesToBigInt(bytes);
  return v > U64_MAX ? U64_MAX : v;
}

/**
 * The `navi-pool` target is mandatory: the reserve is addressed by a numeric
 * `assetId` + `Pool<T>` object the LLM must never supply, so without the
 * resolved target there's nothing to deposit into. Fail closed.
 */
function requireNaviTarget(
  target: DepositTarget | undefined,
): Extract<DepositTarget, { kind: "navi-pool" }> {
  if (target?.kind !== "navi-pool") {
    throw new DefiError(
      "deposit_failed",
      "navi: a resolved pool target is required (assetId + Pool object)",
    );
  }
  return target;
}

/**
 * Atomic swap→supply zap (Sui Intent Engine §4.7) — MAINNET-ONLY. ONE PTB: the
 * injected swap leg produces the reserve's coin (T), which feeds
 * `incentive_v3::entry_deposit`; leftovers transfer back. The `navi-pool` target
 * (assetId + Pool) is REQUIRED. Because the swap's exact output isn't known until
 * runtime (slippage), the deposit `amount` is read on-chain via `coin::value` of
 * the swap output rather than a fixed number. `entry_deposit` is an `entry` fn
 * but Sui PTBs let it consume prior move-call results (the coin + the u64
 * amount) — both verified on mainnet (2026-07-03).
 */
export async function buildNaviZapSupply(
  args: ZapSupplyArgs,
): Promise<ZapSupplyResult> {
  if (args.chain.namespace !== "sui") {
    throw new DefiError("unsupported_chain", "navi: requires sui namespace");
  }
  const { pool, assetId, coinType } = requireNaviTarget(args.target);
  try {
    const core = await getNaviCore();
    const tx = new Transaction();
    tx.setSender(args.wallet.address);

    const swap = await args.appendSwap(tx);
    if (!swap) {
      throw new DefiError("deposit_failed", "zap: swap leg unavailable");
    }

    // The swap output amount is only known at runtime (slippage), so deposit the
    // coin's on-chain value: coin::value(&outputCoin) -> u64 (used by ref here,
    // then consumed by value in entry_deposit).
    const [amount] = tx.moveCall({
      target: "0x2::coin::value",
      typeArguments: [coinType],
      arguments: [swap.outputCoin],
    });

    // incentive_v3::entry_deposit<T>(clock, storage, pool, assetId, coin,
    //   amount, incentiveV2, incentiveV3).
    tx.moveCall({
      target: `${core.packageId}::${DEPOSIT_TARGET}`,
      typeArguments: [coinType],
      arguments: [
        tx.object(SUI_CLOCK_OBJECT_ID),
        tx.object(core.storage),
        tx.object(pool),
        tx.pure.u8(assetId),
        swap.outputCoin,
        amount,
        tx.object(core.incentiveV2),
        tx.object(core.incentiveV3),
      ],
    });
    if (swap.leftoverCoins.length > 0) {
      tx.transferObjects(
        swap.leftoverCoins,
        tx.pure.address(args.wallet.address),
      );
    }

    const bytes = await tx.build({ client: suiClientFor(args.chain) });
    return {
      ptbBase64: toBase64(bytes),
      expectedOut: swap.expectedOut,
      priceImpact: swap.priceImpact,
      toCoinType: swap.toCoinType,
      poolObjectId: swap.poolObjectId,
    };
  } catch (err) {
    if (err instanceof DefiError) throw err;
    if (err instanceof SuiSwapError) throw err; // preserve actionable swap reason
    devWarn("buildNaviZapSupply", err);
    throw classifySuiMoveError(err, "deposit_failed");
  }
}

export const NaviSuiAdapter: DefiProtocolAdapter = {
  slug: SLUG,
  namespace: "sui",
  kind: "stablecoin_lending",
  chainId: NETWORK, // string id → free network gate via listDefiAdaptersForChain
  displayName: "NAVI",
  staticSafetyScore: 75,
  externalSlugs: ["navi-lending", "navi", "navi-protocol"],
  targetKinds: ["navi-pool"],
  // Atomic swap→supply zap (§4.7) — presence-checked by the compiler.
  buildZapSupply: buildNaviZapSupply,

  async buildDeposit({
    wallet,
    chain,
    amount,
    target,
  }: BuildDepositArgs): Promise<UnsignedCall> {
    if (chain.namespace !== "sui") {
      throw new DefiError("unsupported_chain", "navi: requires sui namespace");
    }
    const { pool, assetId, coinType } = requireNaviTarget(target);
    try {
      const core = await getNaviCore();
      const client = suiClientFor(chain);
      const tx = new Transaction();
      tx.setSender(wallet.address);

      const depositCoin = await prepareInputCoin(
        tx,
        client,
        wallet.address,
        coinType,
        amount,
      );

      // incentive_v3::entry_deposit<T>(clock, storage, pool, assetId, coin,
      //   amount, incentiveV2, incentiveV3). Entry fn: credits the supply to the
      //   sender in Storage; no return value.
      tx.moveCall({
        target: `${core.packageId}::${DEPOSIT_TARGET}`,
        typeArguments: [coinType],
        arguments: [
          tx.object(SUI_CLOCK_OBJECT_ID),
          tx.object(core.storage),
          tx.object(pool),
          tx.pure.u8(assetId),
          depositCoin,
          tx.pure.u64(amount),
          tx.object(core.incentiveV2),
          tx.object(core.incentiveV3),
        ],
      });

      const bytes = await tx.build({ client });
      return { kind: "sui-ptb", transactionBlockBase64: toBase64(bytes) };
    } catch (err) {
      if (err instanceof DefiError) throw err;
      devWarn("buildDeposit", err);
      throw classifySuiMoveError(err, "deposit_failed");
    }
  },

  async buildWithdraw({
    wallet,
    chain,
    amount,
    target,
  }: BuildWithdrawArgs): Promise<UnsignedCall> {
    if (chain.namespace !== "sui") {
      throw new DefiError("unsupported_chain", "navi: requires sui namespace");
    }
    const { pool, assetId, coinType } = requireNaviTarget(target);
    try {
      const core = await getNaviCore();
      const client = suiClientFor(chain);

      // NAVI withdraws by underlying amount (no share coin to redeem). For
      // "withdraw all", read the user's live supplied balance from Storage (in
      // native decimals) and pass it as the amount; otherwise use the explicit
      // amount. See `readNaviSupplyRaw` for the verified unit match.
      let withdrawAmount: bigint;
      if (amount === "MAX") {
        withdrawAmount = await readNaviSupplyRaw(
          client,
          core.packageId,
          core.storage,
          assetId,
          wallet.address,
        );
        if (withdrawAmount <= 0n) {
          throw new DefiError(
            "no_onchain_balance",
            "navi: nothing to withdraw",
          );
        }
      } else {
        withdrawAmount = amount;
      }

      const tx = new Transaction();
      tx.setSender(wallet.address);

      // incentive_v3::entry_withdraw_v2<T>(clock, oracle, storage, pool,
      //   assetId, amount, incentiveV2, incentiveV3, systemState). Entry fn:
      //   sends the withdrawn underlying to the sender; no return value.
      tx.moveCall({
        target: `${core.packageId}::${WITHDRAW_TARGET}`,
        typeArguments: [coinType],
        arguments: [
          tx.object(SUI_CLOCK_OBJECT_ID),
          tx.object(core.priceOracle),
          tx.object(core.storage),
          tx.object(pool),
          tx.pure.u8(assetId),
          tx.pure.u64(withdrawAmount),
          tx.object(core.incentiveV2),
          tx.object(core.incentiveV3),
          tx.object(SUI_SYSTEM_STATE_OBJECT_ID),
        ],
      });

      const bytes = await tx.build({ client });
      return { kind: "sui-ptb", transactionBlockBase64: toBase64(bytes) };
    } catch (err) {
      if (err instanceof DefiError) throw err;
      devWarn("buildWithdraw", err);
      throw classifySuiMoveError(err, "withdraw_failed");
    }
  },

  async readPosition(
    walletAddress: string,
    ctx?: PositionReadContext,
  ): Promise<DefiPosition | null> {
    // NAVI has no wallet-held receipt coin — the supply lives in Storage keyed by
    // the reserve's numeric `assetId`, which rides on the resolved `navi-pool`
    // target (threaded by services/defi/positions/reader.ts from the row's
    // pool_id). Without it we can't know which reserve to read → omit the row.
    // Best-effort: any RPC/read failure returns null so the list falls back to
    // the DB snapshot rather than dropping the position.
    if (ctx?.target?.kind !== "navi-pool") return null;
    const { assetId } = ctx.target;
    try {
      const core = await getNaviCore();
      const client = suiClientFor(getSuiMainnetChain());
      const raw = await readNaviSupplyRaw(
        client,
        core.packageId,
        core.storage,
        assetId,
        walletAddress,
      );
      if (raw <= 0n) return null;
      // Live supplied balance in the reserve's native decimals (incl. accrued
      // interest). Only `currentAmount` is consumed downstream (reader overrides
      // the row's current_amount_raw); USD/pnl are the row's job, so left at 0.
      return {
        protocolSlug: SLUG,
        namespace: "sui",
        chainId: NETWORK,
        assetSymbol: ctx.assetSymbol ?? "",
        amountAtDeposit: raw,
        amountAtDepositUsd: 0,
        currentAmount: raw,
        currentAmountUsd: 0,
        pnlUsd: 0,
      };
    } catch (err) {
      devWarn("readPosition", err);
      return null;
    }
  },
};
