/**
 * Ember Vaults adapter — a `DefiProtocolAdapter` for pool-level Sui deposits
 * (docs/defi-pool-level-deposits-spec.md §7, Phase 3). Ember (Bluefin-
 * incubated) is a GENERIC tokenized-vault protocol on Sui — the closest thing
 * to an ERC-4626 vault — so ONE adapter covers every Ember vault the backend
 * resolver returns, dispatched by `DepositTarget.kind === "ember-vault"` (the
 * Sui-family analog of the generic `Erc4626Adapter`).
 *
 * NO SDK. PTBs are built directly with `@mysten/sui`, calling Ember's public
 * gateway:
 *
 *   deposit  → gateway::deposit_asset_v2<T,R>(vault, config, coin, min_shares,
 *                receiver, clock)   — transfers Coin<R> shares to the sender
 *   withdraw → gateway::redeem_shares<T,R>(clock, vault, config, shares,
 *                receiver)          — redeems Coin<R> → underlying (the vault's
 *                                     own logic settles instantly or enqueues a
 *                                     withdrawal request for delayed vaults)
 *
 * The vault object id + coinType (T) + shareType (R) are the immutable
 * per-vault identity carried on the resolved `target`; the mutable package +
 * shared `ProtocolConfig` come from `ember.config.ts` (fetched, cached, pinned
 * fallback — "config not constants"). Ember is genuinely multi-vault (many USDC
 * vaults), so there is NO canonical default: a deposit REQUIRES a resolved
 * `ember-vault` target — the pool the user picked (spec §6/§8).
 *
 * MAINNET-ONLY (`chainId:"mainnet"`): `listDefiAdaptersForChain("sui",
 * "testnet")` resolves it nowhere — the network gate is free. Every failure
 * maps to a curated `DefiError`, never a raw RPC string (CLAUDE.md).
 */

import { toBase64 } from "@mysten/bcs";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import { SUI_CLOCK_OBJECT_ID } from "@mysten/sui/utils";
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
import { getEmberCore } from "./ember.config";
import { gatherAllCoins, leBytesToBigInt, prepareInputCoin } from "./sui/coins";

const SLUG = "ember-sui";
const NETWORK = "mainnet" as const;
const DEPOSIT_TARGET = "gateway::deposit_asset_v2" as const;
const REDEEM_TARGET = "gateway::redeem_shares" as const;
// v1: no share-slippage floor. A meaningful `min_shares` needs the vault's live
// share-price (an extra on-chain read); a vault deposit isn't front-run the way
// a swap is, so 0 is the pragmatic first cut (documented, tightenable later).
const MIN_SHARES = 0n;

function devWarn(scope: string, err: unknown): void {
  if (typeof __DEV__ !== "undefined" && __DEV__) {
    console.warn(`[emberSui] ${scope}:`, err);
  }
}

function suiClientFor(chain: SuiChainConfig): SuiJsonRpcClient {
  return new SuiJsonRpcClient({
    transport: createSuiGrpcJsonRpcTransport(chain.network),
    network: chain.network,
  });
}

/**
 * Convert a share (`Coin<R>`) balance to its underlying (`T`) amount via Ember's
 * OWN view `vault::calculate_amount_from_shares<T,R>(&Vault<T,R>, shares) -> u64`
 * (dry-run — reads nothing but the vault). Verified on mainnet (2026-07-03): the
 * returned u64 is in the underlying's native decimals (the same unit the deposit
 * amount is in), so it feeds `currentAmount` directly. Uses Ember's math rather
 * than reading vault rate/supply fields — no field-order guessing. Returns 0n on
 * any read failure (best-effort).
 */
async function readEmberUnderlyingFromShares(
  client: SuiJsonRpcClient,
  packageId: string,
  vault: string,
  coinType: string,
  shareType: string,
  shares: bigint,
  sender: string,
): Promise<bigint> {
  const tx = new Transaction();
  tx.moveCall({
    target: `${packageId}::vault::calculate_amount_from_shares`,
    typeArguments: [coinType, shareType],
    arguments: [tx.object(vault), tx.pure.u64(shares)],
  });
  const res = await client.devInspectTransactionBlock({
    transactionBlock: tx,
    sender,
  });
  const bytes = res.results?.[0]?.returnValues?.[0]?.[0];
  return bytes && bytes.length > 0 ? leBytesToBigInt(bytes) : 0n;
}

/**
 * The `ember-vault` target is mandatory: Ember is multi-vault with no canonical
 * market per asset, so without the exact pool the user picked there's nothing to
 * deposit into. Fail closed with a curated code (never guess a vault).
 */
function requireEmberTarget(
  target: DepositTarget | undefined,
): Extract<DepositTarget, { kind: "ember-vault" }> {
  if (target?.kind !== "ember-vault") {
    throw new DefiError(
      "deposit_failed",
      "ember: a resolved pool target is required (multi-vault; no canonical market)",
    );
  }
  return target;
}

/**
 * Atomic swap→supply zap (Sui Intent Engine §4.7) — MAINNET-ONLY. Builds ONE
 * PTB: the injected swap leg produces the vault's deposit coin (T), which feeds
 * straight into `gateway::deposit_asset_v2` (shares minted to the sender), and
 * any swap leftovers transfer back. Ember is multi-vault, so the exact
 * `ember-vault` target is REQUIRED (no canonical market) — the same target the
 * plain supply path uses. `deposit_asset_v2` is an `entry` fn, and Sui PTBs let
 * entry fns consume a prior move-call result (the swap output), so the compose
 * is valid (verified on mainnet 2026-07-03).
 */
export async function buildEmberZapSupply(
  args: ZapSupplyArgs,
): Promise<ZapSupplyResult> {
  if (args.chain.namespace !== "sui") {
    throw new DefiError("unsupported_chain", "ember: requires sui namespace");
  }
  const { vault, coinType, shareType } = requireEmberTarget(args.target);
  try {
    const core = await getEmberCore();
    const tx = new Transaction();
    tx.setSender(args.wallet.address);

    const swap = await args.appendSwap(tx);
    if (!swap) {
      throw new DefiError("deposit_failed", "zap: swap leg unavailable");
    }

    // gateway::deposit_asset_v2<T,R>(vault, config, coin, min_shares, receiver
    //   None, clock) — the swap's output coin (T) is the deposit; shares go to
    //   the sender internally (receiver = None).
    tx.moveCall({
      target: `${core.packageId}::${DEPOSIT_TARGET}`,
      typeArguments: [coinType, shareType],
      arguments: [
        tx.object(vault),
        tx.object(core.protocolConfig),
        swap.outputCoin,
        tx.pure.u64(MIN_SHARES),
        tx.pure.option("address", null),
        tx.object(SUI_CLOCK_OBJECT_ID),
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
    devWarn("buildEmberZapSupply", err);
    throw classifySuiMoveError(err, "deposit_failed");
  }
}

export const EmberSuiAdapter: DefiProtocolAdapter = {
  slug: SLUG,
  namespace: "sui",
  kind: "yield_vault",
  chainId: NETWORK, // string id → free network gate via listDefiAdaptersForChain
  displayName: "Ember",
  staticSafetyScore: 60,
  // DeFiLlama project slug (+ shorthand) so a discovered opportunity or an
  // agent-named venue resolves to this adapter without a central map.
  externalSlugs: ["ember-protocol", "ember"],
  // Pool-level deposits (§7): routed by `{ kind: "ember-vault" }`. Reading the
  // concrete { vault, coinType, shareType } from the target is the ONLY mode —
  // Ember has no single-market symbol fallback.
  targetKinds: ["ember-vault"],
  // Atomic swap→supply zap (§4.7) — presence-checked by the compiler.
  buildZapSupply: buildEmberZapSupply,

  async buildDeposit({
    wallet,
    chain,
    amount,
    target,
  }: BuildDepositArgs): Promise<UnsignedCall> {
    if (chain.namespace !== "sui") {
      throw new DefiError("unsupported_chain", "ember: requires sui namespace");
    }
    const { vault, coinType, shareType } = requireEmberTarget(target);
    try {
      const core = await getEmberCore();
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

      // gateway::deposit_asset_v2<T,R>(vault, config, coin, min_shares,
      //   receiver: Option<address>, clock). Shares are transferred to the
      //   sender inside the call (receiver = None → ctx.sender), so there's no
      //   return value to forward.
      tx.moveCall({
        target: `${core.packageId}::${DEPOSIT_TARGET}`,
        typeArguments: [coinType, shareType],
        arguments: [
          tx.object(vault),
          tx.object(core.protocolConfig),
          depositCoin,
          tx.pure.u64(MIN_SHARES),
          tx.pure.option("address", null),
          tx.object(SUI_CLOCK_OBJECT_ID),
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
      throw new DefiError("unsupported_chain", "ember: requires sui namespace");
    }
    const { vault, coinType, shareType } = requireEmberTarget(target);
    // First cut: full exit only. A partial withdraw by underlying amount needs
    // the share↔underlying rate to split the receipt coin exactly; until that's
    // read on-chain we support "withdraw all" (the common path), like Scallop.
    if (amount !== "MAX") {
      throw new DefiError(
        "withdraw_failed",
        "ember: partial withdraw not supported yet",
      );
    }
    try {
      const core = await getEmberCore();
      const client = suiClientFor(chain);
      const tx = new Transaction();
      tx.setSender(wallet.address);

      // Gather the wallet's receipt (share) coins for this vault — Coin<R>.
      const shareCoin = await gatherAllCoins(
        tx,
        client,
        wallet.address,
        shareType,
      );
      if (!shareCoin) {
        throw new DefiError("no_onchain_balance", "ember: nothing to withdraw");
      }

      // gateway::redeem_shares<T,R>(clock, vault, config, shares,
      //   receiver: Option<address>). The vault's own logic settles instantly
      //   or enqueues a withdrawal request for delayed vaults; either way the
      //   proceeds go to the sender (receiver = None).
      tx.moveCall({
        target: `${core.packageId}::${REDEEM_TARGET}`,
        typeArguments: [coinType, shareType],
        arguments: [
          tx.object(SUI_CLOCK_OBJECT_ID),
          tx.object(vault),
          tx.object(core.protocolConfig),
          shareCoin,
          tx.pure.option("address", null),
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
    // Needs the exact vault (multi-vault venue) — carried on the resolved
    // `ember-vault` target, threaded from the position row's pool_id by
    // services/defi/positions/reader.ts. Value = wallet's `Coin<R>` share
    // balance converted through Ember's own `calculate_amount_from_shares`
    // (shares mid-withdrawal, i.e. pending in the vault, are excluded — this is
    // the currently-redeemable value). Best-effort → null on any read failure.
    if (ctx?.target?.kind !== "ember-vault") return null;
    const { vault, coinType, shareType } = ctx.target;
    try {
      const client = suiClientFor(getSuiMainnetChain());
      const { totalBalance } = await client.getBalance({
        owner: walletAddress,
        coinType: shareType,
      });
      const shares = BigInt(totalBalance);
      if (shares <= 0n) return null;
      const core = await getEmberCore();
      const amount = await readEmberUnderlyingFromShares(
        client,
        core.packageId,
        vault,
        coinType,
        shareType,
        shares,
        walletAddress,
      );
      if (amount <= 0n) return null;
      return {
        protocolSlug: SLUG,
        namespace: "sui",
        chainId: NETWORK,
        assetSymbol: ctx.assetSymbol ?? "",
        amountAtDeposit: amount,
        amountAtDepositUsd: 0,
        currentAmount: amount,
        currentAmountUsd: 0,
        pnlUsd: 0,
      };
    } catch (err) {
      devWarn("readPosition", err);
      return null;
    }
  },
};
