/**
 * Stellar-native mobile tool executors.
 *
 * Mirror of `./sui.ts` for the Stellar namespace — kept in a dedicated
 * file so the EVM/Solana/Sui executors stay untouched. Each executor
 * routes through `StellarWalletKit` via the `walletKitRegistry` so
 * shared code stays chain-agnostic per the space-docking rule (spec
 * §4.5, `docs/stellar-chain-support-spec.md` §7).
 *
 * Tools implemented here (spec §7.2):
 *   - get_wallet_xlm_balance      — connected wallet's XLM balance
 *   - get_xlm_balance             — arbitrary Stellar address balance
 *   - send_xlm                    — native XLM transfer
 *   - get_wallet_stellar_assets   — list the wallet's trustlines
 *   - send_stellar_asset          — non-native asset transfer
 *   - establish_stellar_trustline — opt the connected wallet into an
 *     asset (no cross-chain analogue — Sui/Solana never needed this)
 *
 * IMPORTANT: Stellar's transaction "hash" is a Horizon hex hash, but we
 * still surface it on `data.hash` (not the wire-typed `tx_hash`) for
 * consistency with the Sui `data.digest` / Solana `data.signature`
 * convention — the pendingTxCard branches on tool name, not on field
 * shape.
 */

import { formatUnits } from "viem";
import { tokenApi } from "@/api/endpoints/tokens";
import type { TToken } from "@/api/types/token";
import type { ChainConfig } from "@/constants/configs/chainConfig";
import { resolveNamespace } from "@/hooks/useWallet.helpers";
import { storage } from "@/lib/storage/mmkv";
import { parseDecimalStringAsStroops } from "@/services/chains/stellar/amount";
import { getHorizonClient } from "@/services/chains/stellar/horizonClient";
import { ensureTrustline } from "@/services/chains/stellar/trustlineService";
import { walletKitRegistry } from "@/services/walletKit/registry";
import { getStellarSignerForWallet } from "@/services/walletService";
import {
  type BalanceGroup,
  type BalanceTokenRow,
  toAgentSlice,
  type WalletBalancesPayload,
} from "../balancePayload";
import {
  ExecutorError,
  ExecutorErrorCode,
  logExecutorDetail,
  type MobileToolExecutor,
  optionalString,
  requireString,
  safeExecute,
} from "../types";
import { recordTransferHistory } from "./recordTransferHistory";

const STELLAR_NAMESPACE = "stellar" as const;

/** 1 XLM = 10,000,000 stroops; every Stellar asset is 7-decimal fixed point. */
const STELLAR_DECIMALS = 7;

function getActiveStellarChain(): Extract<
  ChainConfig,
  { namespace: "stellar" }
> {
  const raw = storage.getString("active_chain");
  if (!raw) {
    throw new ExecutorError(
      ExecutorErrorCode.UnsupportedChain,
      "no_active_chain",
    );
  }
  const parsed = JSON.parse(raw) as ChainConfig;
  if (parsed.namespace !== STELLAR_NAMESPACE) {
    throw new ExecutorError(
      ExecutorErrorCode.UnsupportedChain,
      "active_chain_is_not_stellar",
    );
  }
  return parsed;
}

function getStellarKit() {
  if (!walletKitRegistry.has(STELLAR_NAMESPACE)) {
    throw new ExecutorError(
      ExecutorErrorCode.NotImplemented,
      "stellar_kit_not_registered",
    );
  }
  return walletKitRegistry.get(STELLAR_NAMESPACE);
}

function requireStellarAddress(value: string, key: string): string {
  const kit = getStellarKit();
  if (!kit.validateAddress(value)) {
    throw new ExecutorError(ExecutorErrorCode.InvalidInput, `invalid_${key}`);
  }
  return value;
}

function networkLabel(network: string): string {
  return network === "testnet" ? "Stellar Testnet" : "Stellar Mainnet";
}

/**
 * Resolve the active Stellar blockchain row from context — used to
 * pull the native token's logo / name / decimals so single-balance
 * cards render the XLM icon instead of the generic Coins fallback.
 * Mirrors `resolveSuiNativeMeta` / `resolveSolanaNativeMeta`.
 */
function resolveStellarNativeMeta(
  chain: Extract<ChainConfig, { namespace: "stellar" }>,
  context: Parameters<MobileToolExecutor>[1],
): { symbol: string; name: string; decimals: number; logoUrl?: string } {
  const isTestnet = chain.network !== "mainnet";
  const blockchain = context.blockchains.find(
    (b) =>
      resolveNamespace(b) === STELLAR_NAMESPACE &&
      b.isActive &&
      b.isTestnet === isTestnet,
  );
  const nativeRow = blockchain?.tokens?.find((t) => t.isNativeCurrency);
  return {
    symbol: nativeRow?.symbol ?? "XLM",
    name: nativeRow?.name ?? "Stellar Lumens",
    decimals: nativeRow?.decimals ?? STELLAR_DECIMALS,
    ...(nativeRow?.logoUrl ? { logoUrl: nativeRow.logoUrl } : {}),
  };
}

/**
 * Wrap a single native XLM balance in the shared `WalletBalancesPayload`
 * shape so `BalancesCard` can render it without a Stellar-specific
 * branch. Mirrors `singleSuiNativePayload`.
 */
function singleStellarNativePayload(
  chain: Extract<ChainConfig, { namespace: "stellar" }>,
  native: ReturnType<typeof resolveStellarNativeMeta>,
  stroops: bigint,
): WalletBalancesPayload {
  const tokenRow: BalanceTokenRow = {
    symbol: native.symbol,
    name: native.name,
    address: "",
    decimals: native.decimals,
    is_native: true,
    is_stable_coin: false,
    ...(native.logoUrl ? { logo_url: native.logoUrl } : {}),
    balance_raw: stroops.toString(),
    balance_display: formatUnits(stroops, native.decimals),
  };
  return {
    groups: [
      {
        namespace: STELLAR_NAMESPACE,
        chain_id: chain.network,
        chain_label: networkLabel(chain.network),
        chain_symbol: native.symbol,
        ...(native.logoUrl ? { chain_logo_url: native.logoUrl } : {}),
        tokens: [tokenRow],
      },
    ],
  };
}

/**
 * `get_wallet_xlm_balance` — connected wallet's XLM balance on the
 * active Stellar network.
 */
export const getWalletXlmBalance: MobileToolExecutor = (_input, context) =>
  safeExecute(async () => {
    const address = context.wallet?.address;
    if (!address) {
      throw new ExecutorError(
        ExecutorErrorCode.WalletCannotExecute,
        "no connected wallet",
      );
    }
    if (context.wallet.namespace !== STELLAR_NAMESPACE) {
      throw new ExecutorError(
        ExecutorErrorCode.UnsupportedChain,
        "wallet_not_stellar",
      );
    }
    const chain = getActiveStellarChain();
    const kit = getStellarKit();
    const stroops = await kit.getNativeBalance(address, chain);
    const native = resolveStellarNativeMeta(chain, context);
    const display = singleStellarNativePayload(chain, native, stroops);
    return { status: "success", data: toAgentSlice(display), display };
  });

/**
 * `get_xlm_balance` — XLM balance for an arbitrary address. Falls back
 * to the connected wallet when the agent omits `address`.
 */
export const getXlmBalance: MobileToolExecutor = (input, context) =>
  safeExecute(async () => {
    const kit = getStellarKit();
    const chain = getActiveStellarChain();

    const explicit = optionalString(input, "address");
    const address = explicit ?? context.wallet?.address;
    if (!address) {
      throw new ExecutorError(
        ExecutorErrorCode.InvalidInput,
        "missing_or_invalid_address",
      );
    }
    requireStellarAddress(address, "address");

    const stroops = await kit.getNativeBalance(address, chain);
    const native = resolveStellarNativeMeta(chain, context);
    const display = singleStellarNativePayload(chain, native, stroops);
    return { status: "success", data: toAgentSlice(display), display };
  });

/**
 * `send_xlm` — native XLM transfer. Dispatches createAccount vs
 * payment internally (`buildAndSendStellarNativeTransfer`, spec §3.5)
 * — no per-tool branching needed.
 */
export const sendXlm: MobileToolExecutor = (input, context) =>
  safeExecute(async () => {
    if (!context.wallet?.address) {
      throw new ExecutorError(
        ExecutorErrorCode.WalletCannotExecute,
        "no connected wallet",
      );
    }
    if (context.wallet.namespace !== STELLAR_NAMESPACE) {
      throw new ExecutorError(
        ExecutorErrorCode.UnsupportedChain,
        "wallet_not_stellar",
      );
    }

    const to = requireString(input, "to");
    requireStellarAddress(to, "to");

    const amountHuman = requireString(input, "amount_xlm");
    const amountFloat = parseFloat(amountHuman);
    if (!Number.isFinite(amountFloat) || amountFloat <= 0) {
      throw new ExecutorError(
        ExecutorErrorCode.InvalidInput,
        "invalid_amount_xlm",
      );
    }

    const kit = getStellarKit();
    const chain = getActiveStellarChain();
    const stroops = kit.parseNativeAmount(amountHuman, chain);
    const hash = await kit.sendNativeTransfer({
      wallet: context.wallet,
      to,
      amount: stroops,
      chain,
    });

    const transaction_id = await recordTransferHistory({
      blockchains: context.blockchains,
      namespace: "stellar",
      chainSlug: `stellar-${chain.network}`,
      type: "TRANSFER",
      amount: stroops.toString(),
      txHash: hash,
      fromAddress: context.wallet.address,
      toAddress: to,
    });

    return {
      status: "success",
      tx_confirmed: true,
      transaction_id,
      data: {
        hash,
        to,
        network: chain.network,
        amount_stroops: stroops.toString(),
        amount_xlm: amountHuman,
      },
    };
  });

/**
 * `get_wallet_stellar_assets` — lists the wallet's trustlines (code +
 * issuer via the compound `address` field, + live balance). Mirrors
 * `get_wallet_sui_coins` / `get_wallet_spl_tokens`.
 */
export const getWalletStellarAssets: MobileToolExecutor = (input, context) =>
  safeExecute(async () => {
    // Called for its "kit registered" guard — the rest of this executor
    // talks to Horizon directly rather than through kit methods.
    getStellarKit();
    const chain = getActiveStellarChain();

    const walletAddress = context.wallet?.address;
    if (!walletAddress) {
      throw new ExecutorError(
        ExecutorErrorCode.WalletCannotExecute,
        "no connected wallet",
      );
    }
    if (context.wallet.namespace !== STELLAR_NAMESPACE) {
      throw new ExecutorError(
        ExecutorErrorCode.UnsupportedChain,
        "wallet_not_stellar",
      );
    }

    const isTestnet = chain.network !== "mainnet";
    const stellarBlockchain = context.blockchains.find(
      (b) =>
        resolveNamespace(b) === STELLAR_NAMESPACE &&
        b.isActive &&
        b.isTestnet === isTestnet,
    );
    if (!stellarBlockchain) {
      throw new ExecutorError(
        ExecutorErrorCode.UnsupportedChain,
        "stellar_blockchain_not_found_in_registry",
      );
    }

    // Per-blockchain MMKV cache — same shape and stale window as Sui's
    // Coin<T> token cache.
    const STELLAR_CACHE_KEY = `cached_stellar_tokens_${stellarBlockchain.id}`;
    const STELLAR_CACHE_TS_KEY = `cached_stellar_tokens_ts_${stellarBlockchain.id}`;
    const STELLAR_STALE_MS = 5 * 60 * 1000;

    let allTokens: TToken[];
    try {
      const cachedRaw = storage.getString(STELLAR_CACHE_KEY);
      const tsRaw = storage.getString(STELLAR_CACHE_TS_KEY);
      const ts = tsRaw ? parseInt(tsRaw, 10) : 0;
      if (cachedRaw && Date.now() - ts < STELLAR_STALE_MS) {
        const parsed = JSON.parse(cachedRaw);
        allTokens = Array.isArray(parsed) ? (parsed as TToken[]) : [];
      } else {
        allTokens = await tokenApi.searchTokens({
          blockchainId: stellarBlockchain.id,
          isActive: true,
        });
        storage.set(STELLAR_CACHE_KEY, JSON.stringify(allTokens));
        storage.set(STELLAR_CACHE_TS_KEY, Date.now().toString());
      }
    } catch (err) {
      const cachedRaw = storage.getString(STELLAR_CACHE_KEY);
      if (cachedRaw) {
        try {
          const parsed = JSON.parse(cachedRaw);
          allTokens = Array.isArray(parsed) ? (parsed as TToken[]) : [];
        } catch {
          logExecutorDetail("Stellar token list fetch failed", err);
          throw new ExecutorError(
            ExecutorErrorCode.NetworkError,
            "token_list_unavailable",
          );
        }
      } else {
        logExecutorDetail("Stellar token list fetch failed", err);
        throw new ExecutorError(
          ExecutorErrorCode.NetworkError,
          "token_list_unavailable",
        );
      }
    }

    const symFilter =
      typeof input.symbol === "string" && input.symbol.length > 0
        ? (input.symbol as string).toLowerCase()
        : null;

    const assets = allTokens.filter((t) => {
      if (t.isActive === false) return false;
      if (t.isNativeCurrency) return false; // native handled separately
      if (
        typeof input.is_stable_coin === "boolean" &&
        t.isStablecoin !== input.is_stable_coin
      ) {
        return false;
      }
      if (symFilter) {
        const s = t.symbol.toLowerCase();
        if (s !== symFilter && !s.startsWith(symFilter)) return false;
      }
      return true;
    });

    const includeNative = input.is_native_currency !== false;
    const includeBalance = input.include_balance === true;

    // One `loadAccount` call gives every trustline balance in one
    // round-trip. Falls back to omitted balance fields (not a thrown
    // error) if the account doesn't exist yet or Horizon is unreachable
    // — an unfunded wallet trivially holds none of any asset.
    let nativeStroops: bigint | undefined;
    const balanceByAssetId = new Map<string, bigint>();
    if (includeBalance) {
      try {
        const horizon = getHorizonClient(chain);
        const account = await horizon.loadAccount(walletAddress);
        for (const b of account.balances) {
          if (b.asset_type === "native") {
            nativeStroops = parseDecimalStringAsStroops(b.balance);
          } else if (b.asset_code && b.asset_issuer) {
            balanceByAssetId.set(
              `${b.asset_code}:${b.asset_issuer}`,
              parseDecimalStringAsStroops(b.balance),
            );
          }
        }
      } catch {
        // balance unavailable — omit fields but keep going
      }
    }

    const assetRows: BalanceTokenRow[] = assets.map((t) => {
      let balance_raw: string | undefined;
      let balance_display: string | undefined;

      if (includeBalance && t.contractAddress) {
        const raw = balanceByAssetId.get(t.contractAddress);
        if (raw !== undefined) {
          balance_raw = raw.toString();
          balance_display = formatUnits(raw, t.decimals);
        }
      }

      return {
        symbol: t.symbol,
        name: t.name,
        address: t.contractAddress ?? "",
        decimals: t.decimals,
        is_native: false,
        is_stable_coin: t.isStablecoin ?? false,
        ...(t.logoUrl ? { logo_url: t.logoUrl } : {}),
        ...(t.peggedCurrency ? { pegged_currency: t.peggedCurrency } : {}),
        ...(balance_raw !== undefined ? { balance_raw } : {}),
        ...(balance_display !== undefined ? { balance_display } : {}),
      };
    });

    const nativeMeta = resolveStellarNativeMeta(chain, context);
    const nativePasses =
      !symFilter ||
      nativeMeta.symbol.toLowerCase() === symFilter ||
      nativeMeta.symbol.toLowerCase().startsWith(symFilter);
    const stablePasses = input.is_stable_coin !== true;

    const nativeRow: BalanceTokenRow | null =
      includeNative && nativePasses && stablePasses
        ? {
            symbol: nativeMeta.symbol,
            name: nativeMeta.name,
            address: "",
            decimals: nativeMeta.decimals,
            is_native: true,
            is_stable_coin: false,
            ...(nativeMeta.logoUrl ? { logo_url: nativeMeta.logoUrl } : {}),
            ...(nativeStroops !== undefined
              ? {
                  balance_raw: nativeStroops.toString(),
                  balance_display: formatUnits(
                    nativeStroops,
                    nativeMeta.decimals,
                  ),
                }
              : {}),
          }
        : null;

    const tokens: BalanceTokenRow[] = nativeRow
      ? [nativeRow, ...assetRows]
      : assetRows;

    const group: BalanceGroup = {
      namespace: STELLAR_NAMESPACE,
      chain_id: chain.network,
      chain_label: networkLabel(chain.network),
      chain_symbol: nativeMeta.symbol,
      ...(nativeMeta.logoUrl ? { chain_logo_url: nativeMeta.logoUrl } : {}),
      tokens,
    };

    const display: WalletBalancesPayload = { groups: [group] };

    return { status: "success", data: toAgentSlice(display), display };
  });

/**
 * `send_stellar_asset` — non-native asset transfer, given `code` +
 * `issuer`. Surfaces `StellarNoTrustlineError` (mapped to
 * `invalid_input`, spec §4.3) if the destination hasn't opted in.
 */
export const sendStellarAsset: MobileToolExecutor = (input, context) =>
  safeExecute(async () => {
    if (!context.wallet?.address) {
      throw new ExecutorError(
        ExecutorErrorCode.WalletCannotExecute,
        "no connected wallet",
      );
    }
    if (context.wallet.namespace !== STELLAR_NAMESPACE) {
      throw new ExecutorError(
        ExecutorErrorCode.UnsupportedChain,
        "wallet_not_stellar",
      );
    }

    const to = requireString(input, "to");
    requireStellarAddress(to, "to");

    const code = requireString(input, "code");
    const issuer = requireString(input, "issuer");
    requireStellarAddress(issuer, "issuer");

    const amountHuman = requireString(input, "amount");
    const amountRaw = parseDecimalStringAsStroops(amountHuman);
    if (amountRaw <= 0n) {
      throw new ExecutorError(
        ExecutorErrorCode.InvalidInput,
        "amount_must_be_positive",
      );
    }

    const kit = getStellarKit();
    const chain = getActiveStellarChain();
    const contractAddress = `${code}:${issuer}`;
    const hash = await kit.sendTokenTransfer({
      wallet: context.wallet,
      to,
      amount: amountRaw,
      chain,
      contractAddress,
      decimals: STELLAR_DECIMALS,
    });

    const transaction_id = await recordTransferHistory({
      blockchains: context.blockchains,
      namespace: "stellar",
      chainSlug: `stellar-${chain.network}`,
      contractAddress,
      type: "TRANSFER",
      amount: amountRaw.toString(),
      txHash: hash,
      fromAddress: context.wallet.address,
      toAddress: to,
    });

    return {
      status: "success",
      tx_confirmed: true,
      transaction_id,
      data: {
        hash,
        to,
        code,
        issuer,
        network: chain.network,
        amount_raw: amountRaw.toString(),
        amount: amountHuman,
      },
    };
  });

/**
 * `establish_stellar_trustline` — opts the CONNECTED wallet into
 * holding a given asset (self-service `changeTrust`). New primitive
 * with no cross-chain analogue (spec §4.3) — Sui/Solana never needed
 * an agent tool whose only job is "opt this wallet into holding an
 * asset" since neither chain has an opt-in step.
 */
export const establishStellarTrustline: MobileToolExecutor = (input, context) =>
  safeExecute(async () => {
    if (!context.wallet?.address) {
      throw new ExecutorError(
        ExecutorErrorCode.WalletCannotExecute,
        "no connected wallet",
      );
    }
    if (context.wallet.namespace !== STELLAR_NAMESPACE) {
      throw new ExecutorError(
        ExecutorErrorCode.UnsupportedChain,
        "wallet_not_stellar",
      );
    }

    const code = requireString(input, "code");
    const issuer = requireString(input, "issuer");
    requireStellarAddress(issuer, "issuer");

    const chain = getActiveStellarChain();
    const signer = await getStellarSignerForWallet(context.wallet);
    if (!signer) {
      throw new ExecutorError(
        ExecutorErrorCode.WalletCannotExecute,
        "no_stellar_signer",
      );
    }
    const horizon = getHorizonClient(chain);
    const result = await ensureTrustline({ horizon, signer, code, issuer });

    return {
      status: "success",
      tx_confirmed: !result.alreadyTrusted,
      data: {
        already_trusted: result.alreadyTrusted,
        ...(result.hash ? { hash: result.hash } : {}),
        code,
        issuer,
        network: chain.network,
      },
    };
  });

export const STELLAR_EXECUTORS: Record<string, MobileToolExecutor> = {
  get_wallet_xlm_balance: getWalletXlmBalance,
  get_xlm_balance: getXlmBalance,
  send_xlm: sendXlm,
  get_wallet_stellar_assets: getWalletStellarAssets,
  send_stellar_asset: sendStellarAsset,
  establish_stellar_trustline: establishStellarTrustline,
};
