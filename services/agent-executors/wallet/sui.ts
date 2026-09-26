/**
 * Sui-native mobile tool executors.
 *
 * Mirror of `./solana.ts` for the Sui namespace — kept in a dedicated
 * file so the EVM and Solana executors stay untouched. Each executor
 * routes through `SuiWalletKit` via the `walletKitRegistry` so shared
 * code stays chain-agnostic per the space-docking rule (spec §4.5).
 *
 * Tools implemented here (spec §7):
 *   - get_wallet_sui_balance — connected wallet's SUI balance
 *   - get_sui_balance        — arbitrary Sui address balance
 *   - send_sui               — native SUI transfer
 *   - get_wallet_sui_coins   — list Coin<T> balances for the wallet
 *   - send_sui_coin          — non-native Coin<T> transfer
 *
 * IMPORTANT: Sui's transaction "hash" is a base58 digest, not 0x-hex.
 * The wire `tx_hash` field is typed `0x${string}` and the server
 * validates it as hex, so digests live in `data.digest` instead — the
 * same wire-schema constraint Solana hits with base58 signatures.
 */

import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { formatUnits, parseUnits } from "viem";
import { tokenApi } from "@/api/endpoints/tokens";
import type { TToken } from "@/api/types/token";
import type { ChainConfig } from "@/constants/configs/chainConfig";
import { resolveNamespace } from "@/hooks/useWallet.helpers";
import { storage } from "@/lib/storage/mmkv";
import { createSuiGrpcJsonRpcTransport } from "@/services/chains/sui/grpcTransport";
import { walletKitRegistry } from "@/services/walletKit/registry";
import {
  type BalanceGroup,
  type BalanceTokenRow,
  toAgentSlice,
  type WalletBalancesPayload,
} from "../balancePayload";
import {
  ExecutorError,
  ExecutorErrorCode,
  type MobileToolExecutor,
  optionalString,
  requireString,
  safeExecute,
} from "../types";
import { recordTransferHistory } from "./recordTransferHistory";

const SUI_NAMESPACE = "sui" as const;

/** 1 SUI = 1e9 MIST (mirrors `SuiWalletKit#MIST_PER_SUI`). */
const SUI_DECIMALS = 9;

/**
 * Pull the currently-active chain from the same MMKV slot that
 * `useWallet` writes to. Executors can't read the React Query cache
 * directly, so we deserialize the persisted `ChainConfig` here.
 *
 * Narrow to Sui with a predictable error so callers that fire while
 * the active chain is EVM / Solana fail fast instead of crashing
 * inside the kit.
 */
function getActiveSuiChain(): Extract<ChainConfig, { namespace: "sui" }> {
  const raw = storage.getString("active_chain");
  if (!raw) {
    throw new ExecutorError(
      ExecutorErrorCode.UnsupportedChain,
      "no_active_chain",
    );
  }
  const parsed = JSON.parse(raw) as ChainConfig;
  if (parsed.namespace !== SUI_NAMESPACE) {
    throw new ExecutorError(
      ExecutorErrorCode.UnsupportedChain,
      "active_chain_is_not_sui",
    );
  }
  return parsed;
}

function getSuiKit() {
  if (!walletKitRegistry.has(SUI_NAMESPACE)) {
    throw new ExecutorError(
      ExecutorErrorCode.NotImplemented,
      "sui_kit_not_registered",
    );
  }
  return walletKitRegistry.get(SUI_NAMESPACE);
}

function requireSuiAddress(value: string, key: string): string {
  const kit = getSuiKit();
  if (!kit.validateAddress(value)) {
    throw new ExecutorError(ExecutorErrorCode.InvalidInput, `invalid_${key}`);
  }
  return value;
}

function networkLabel(network: string): string {
  if (network === "testnet") return "Sui Testnet";
  if (network === "devnet") return "Sui Devnet";
  return "Sui Mainnet";
}

/**
 * Resolve the active Sui blockchain row from context — used to pull
 * the native token's logo / name / decimals so single-balance cards
 * render the SUI icon instead of the generic Coins fallback. Mirror
 * of Solana's `resolveSolanaNativeMeta`.
 */
function resolveSuiNativeMeta(
  chain: Extract<ChainConfig, { namespace: "sui" }>,
  context: Parameters<MobileToolExecutor>[1],
): { symbol: string; name: string; decimals: number; logoUrl?: string } {
  const isTestnet = chain.network !== "mainnet";
  const blockchain = context.blockchains.find(
    (b) =>
      resolveNamespace(b) === SUI_NAMESPACE &&
      b.isActive &&
      b.isTestnet === isTestnet,
  );
  const nativeRow = blockchain?.tokens?.find((t) => t.isNativeCurrency);
  return {
    symbol: nativeRow?.symbol ?? "SUI",
    name: nativeRow?.name ?? "Sui",
    decimals: nativeRow?.decimals ?? SUI_DECIMALS,
    ...(nativeRow?.logoUrl ? { logoUrl: nativeRow.logoUrl } : {}),
  };
}

/**
 * Wrap a single native SUI balance in the shared `WalletBalancesPayload`
 * shape so `BalancesCard` (one card per namespace) can render it without
 * a SUI-specific branch. Mirrors Solana's `singleSolanaNativePayload`.
 */
function singleSuiNativePayload(
  chain: Extract<ChainConfig, { namespace: "sui" }>,
  native: ReturnType<typeof resolveSuiNativeMeta>,
  mist: bigint,
): WalletBalancesPayload {
  const tokenRow: BalanceTokenRow = {
    symbol: native.symbol,
    name: native.name,
    address: "",
    decimals: native.decimals,
    is_native: true,
    is_stable_coin: false,
    ...(native.logoUrl ? { logo_url: native.logoUrl } : {}),
    balance_raw: mist.toString(),
    balance_display: formatUnits(mist, native.decimals),
  };
  return {
    groups: [
      {
        namespace: "sui",
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
 * `get_wallet_sui_balance` — connected wallet's SUI balance on the
 * active Sui network. Emits the shared `WalletBalancesPayload` so
 * `BalancesCard` renders it through the same path EVM and Solana use.
 */
export const getWalletSuiBalance: MobileToolExecutor = (_input, context) =>
  safeExecute(async () => {
    const address = context.wallet?.address;
    if (!address) {
      throw new ExecutorError(
        ExecutorErrorCode.WalletCannotExecute,
        "no connected wallet",
      );
    }
    if (context.wallet.namespace !== SUI_NAMESPACE) {
      throw new ExecutorError(
        ExecutorErrorCode.UnsupportedChain,
        "wallet_not_sui",
      );
    }
    const chain = getActiveSuiChain();
    const kit = getSuiKit();
    const mist = await kit.getNativeBalance(address, chain);
    const native = resolveSuiNativeMeta(chain, context);
    const display = singleSuiNativePayload(chain, native, mist);
    return {
      status: "success",
      data: toAgentSlice(display),
      display,
    };
  });

/**
 * `get_sui_balance` — SUI balance for an arbitrary address. Falls
 * back to the connected wallet when the agent omits `address`,
 * mirroring the EVM `get_balance` and Solana `get_sol_balance`
 * ergonomics.
 */
export const getSuiBalance: MobileToolExecutor = (input, context) =>
  safeExecute(async () => {
    const kit = getSuiKit();
    const chain = getActiveSuiChain();

    const explicit = optionalString(input, "address");
    const address = explicit ?? context.wallet?.address;
    if (!address) {
      throw new ExecutorError(
        ExecutorErrorCode.InvalidInput,
        "missing_or_invalid_address",
      );
    }
    requireSuiAddress(address, "address");

    const mist = await kit.getNativeBalance(address, chain);
    const native = resolveSuiNativeMeta(chain, context);
    const display = singleSuiNativePayload(chain, native, mist);
    return {
      status: "success",
      data: toAgentSlice(display),
      display,
    };
  });

/**
 * `send_sui` — native SUI transfer from the connected wallet. The
 * dispatcher gates on the approval sheet (`capability: "write"`)
 * before this runs, so by the time we're called the user has
 * confirmed.
 *
 * NOTE: Sui digests are base58, not 0x-hex. We deliberately do NOT
 * populate the wire-typed `tx_hash` field (typed `0x${string}` and
 * regex-validated server-side). The digest lives on `data.digest`
 * instead — the pendingTxCard branches on tool name (`send_sui`) to
 * render/link it correctly. Same pattern as Solana's `data.signature`.
 */
export const sendSui: MobileToolExecutor = (input, context) =>
  safeExecute(async () => {
    if (!context.wallet?.address) {
      throw new ExecutorError(
        ExecutorErrorCode.WalletCannotExecute,
        "no connected wallet",
      );
    }
    if (context.wallet.namespace !== SUI_NAMESPACE) {
      throw new ExecutorError(
        ExecutorErrorCode.UnsupportedChain,
        "wallet_not_sui",
      );
    }

    const to = requireString(input, "to");
    requireSuiAddress(to, "to");

    const amountHuman = requireString(input, "amount_sui");
    const amountFloat = parseFloat(amountHuman);
    if (!Number.isFinite(amountFloat) || amountFloat <= 0) {
      throw new ExecutorError(
        ExecutorErrorCode.InvalidInput,
        "invalid_amount_sui",
      );
    }

    const kit = getSuiKit();
    const chain = getActiveSuiChain();
    const mist = kit.parseNativeAmount(amountHuman, chain);
    const digest = await kit.sendNativeTransfer({
      wallet: context.wallet,
      to,
      amount: mist,
      chain,
    });

    const transaction_id = await recordTransferHistory({
      blockchains: context.blockchains,
      namespace: "sui",
      chainSlug: `sui-${chain.network}`,
      type: "TRANSFER",
      amount: mist.toString(),
      txHash: digest,
      fromAddress: context.wallet.address,
      toAddress: to,
    });

    return {
      status: "success",
      tx_confirmed: true,
      transaction_id,
      data: {
        digest,
        to,
        network: chain.network,
        amount_mist: mist.toString(),
        amount_sui: amountHuman,
      },
    };
  });

/**
 * `get_wallet_sui_coins` — list Sui Coin<T> balances for the active
 * network. Counterpart to Solana's `get_wallet_spl_tokens` (and the
 * EVM `get_wallet_tokens`). Loads the cached token list (per-blockchain
 * MMKV cache) and optionally resolves live on-chain balances via
 * `client.getAllBalances`. Native SUI is prepended as a pseudo-row
 * (`is_native: true`) unless excluded via `is_native_currency: false`.
 */
export const getSuiWalletTokens: MobileToolExecutor = (input, context) =>
  safeExecute(async () => {
    const kit = getSuiKit();
    const chain = getActiveSuiChain();

    const walletAddress = context.wallet?.address;
    if (!walletAddress) {
      throw new ExecutorError(
        ExecutorErrorCode.WalletCannotExecute,
        "no connected wallet",
      );
    }
    if (context.wallet.namespace !== SUI_NAMESPACE) {
      throw new ExecutorError(
        ExecutorErrorCode.UnsupportedChain,
        "wallet_not_sui",
      );
    }

    // Match the Sui blockchain row from the registry, gated on namespace
    // and the active network's testnet flag so devnet/testnet wallets
    // don't accidentally query mainnet coin types. Uses the shared
    // `resolveNamespace` seam so backends that haven't yet shipped the
    // `namespace` column on `TBlockchain` (falling back to `chainSlug` /
    // `isEVM` heuristics) still resolve correctly. Same pattern as
    // `solana.ts::getSolanaWalletTokens`.
    const isTestnet = chain.network !== "mainnet";
    const suiBlockchain = context.blockchains.find(
      (b) =>
        resolveNamespace(b) === SUI_NAMESPACE &&
        b.isActive &&
        b.isTestnet === isTestnet,
    );
    if (!suiBlockchain) {
      throw new ExecutorError(
        ExecutorErrorCode.UnsupportedChain,
        "sui_blockchain_not_found_in_registry",
      );
    }

    // Per-blockchain MMKV cache — same shape and stale window as Solana's
    // SPL token cache so the agent's rendering side stays parallel.
    const SUI_CACHE_KEY = `cached_sui_tokens_${suiBlockchain.id}`;
    const SUI_CACHE_TS_KEY = `cached_sui_tokens_ts_${suiBlockchain.id}`;
    const SUI_STALE_MS = 5 * 60 * 1000;

    let allTokens: TToken[];
    try {
      const cachedRaw = storage.getString(SUI_CACHE_KEY);
      const tsRaw = storage.getString(SUI_CACHE_TS_KEY);
      const ts = tsRaw ? parseInt(tsRaw, 10) : 0;
      if (cachedRaw && Date.now() - ts < SUI_STALE_MS) {
        const parsed = JSON.parse(cachedRaw);
        allTokens = Array.isArray(parsed) ? (parsed as TToken[]) : [];
      } else {
        allTokens = await tokenApi.searchTokens({
          blockchainId: suiBlockchain.id,
          isActive: true,
        });
        storage.set(SUI_CACHE_KEY, JSON.stringify(allTokens));
        storage.set(SUI_CACHE_TS_KEY, Date.now().toString());
      }
    } catch (err) {
      // Offline fallback: serve stale cache if available.
      const cachedRaw = storage.getString(SUI_CACHE_KEY);
      if (cachedRaw) {
        try {
          const parsed = JSON.parse(cachedRaw);
          allTokens = Array.isArray(parsed) ? (parsed as TToken[]) : [];
        } catch {
          throw new ExecutorError(
            ExecutorErrorCode.NetworkError,
            `failed to fetch Sui token list: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } else {
        throw new ExecutorError(
          ExecutorErrorCode.NetworkError,
          `failed to fetch Sui token list: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const symFilter =
      typeof input.symbol === "string" && input.symbol.length > 0
        ? (input.symbol as string).toLowerCase()
        : null;

    const coins = allTokens.filter((t) => {
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

    // Resolve all live balances in one round-trip via `getAllBalances`,
    // then index by coinType so per-row lookup is O(1). Falls back to
    // empty (per-token row drops `balance_*` fields) if the call fails.
    let balanceByCoinType = new Map<string, bigint>();
    if (includeBalance) {
      try {
        const client = new SuiJsonRpcClient({
          transport: createSuiGrpcJsonRpcTransport(chain.network),
          network: chain.network,
        });
        const all = await client.getAllBalances({ owner: walletAddress });
        balanceByCoinType = new Map(
          all.map((b) => [b.coinType, BigInt(b.totalBalance)]),
        );
      } catch {
        // balance unavailable — omit fields but keep going
      }
    }

    // Native SUI canonical coinType per the Sui SDK.
    const SUI_NATIVE_COIN_TYPE = "0x2::sui::SUI";
    const suiMist = balanceByCoinType.get(SUI_NATIVE_COIN_TYPE);

    // Build the Coin<T> rows in the unified BalanceTokenRow shape. The
    // Move struct path (CoinType) goes in `address` since the unified
    // shape is namespace-agnostic — agents on Sui receive it as the coin
    // identifier the same way EVM agents receive a contract address.
    const coinRows: BalanceTokenRow[] = coins.map((t) => {
      let balance_raw: string | undefined;
      let balance_display: string | undefined;

      if (includeBalance && t.contractAddress) {
        const raw = balanceByCoinType.get(t.contractAddress);
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

    // Prepend native SUI row. Pull symbol/name/decimals/logoUrl from the
    // resolved blockchain row's native token so the card renders the
    // proper SUI icon (mirrors Solana's `resolveSolanaNativeMeta` path).
    const nativeMeta = resolveSuiNativeMeta(chain, context);
    const nativePasses =
      !symFilter ||
      nativeMeta.symbol.toLowerCase() === symFilter ||
      nativeMeta.symbol.toLowerCase().startsWith(symFilter);
    const stablePasses = input.is_stable_coin !== true;

    // `address: ""` for the native row matches `singleSuiNativePayload`
    // (and Solana's convention) so the content-addressed dedupe in
    // `MessageContent.computeSuppressedToolParts` recognises a back-to-
    // back `get_wallet_sui_balance` + `get_wallet_sui_coins` turn as a
    // subset and suppresses the smaller card. The Move struct path
    // identifier (`0x2::sui::SUI`) for the native coin is not lost — it
    // is implied by `is_native: true`, the same way EVM/Solana imply
    // their native identifiers.
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
            ...(suiMist !== undefined
              ? {
                  balance_raw: suiMist.toString(),
                  balance_display: formatUnits(suiMist, nativeMeta.decimals),
                }
              : {}),
          }
        : null;

    const tokens: BalanceTokenRow[] = nativeRow
      ? [nativeRow, ...coinRows]
      : coinRows;

    const group: BalanceGroup = {
      namespace: "sui",
      chain_id: chain.network,
      chain_label: networkLabel(chain.network),
      chain_symbol: nativeMeta.symbol,
      ...(nativeMeta.logoUrl ? { chain_logo_url: nativeMeta.logoUrl } : {}),
      tokens,
    };

    const display: WalletBalancesPayload = { groups: [group] };

    return {
      status: "success",
      data: toAgentSlice(display),
      display,
    };
  });

/**
 * `send_sui_coin` — non-native Coin<T> transfer from the connected
 * wallet. The kit's `sendTokenTransfer` dispatches via
 * `buildAndSendSuiCoinTransfer`, which handles per-kind branching
 * (regulated, closed-loop, plain Coin<T>). No per-tool kind branching
 * here — that logic lives inside the kit per spec §4.5.
 *
 * Agent passes:
 *   - `coin_type`     — the Move `0x...::module::Symbol` string
 *   - `to`            — recipient Sui address
 *   - `token_amount`  — human amount (e.g. "1.5")
 *   - `token_decimals`— integer decimals for parseUnits
 */
export const sendSuiCoin: MobileToolExecutor = (input, context) =>
  safeExecute(async () => {
    if (!context.wallet?.address) {
      throw new ExecutorError(
        ExecutorErrorCode.WalletCannotExecute,
        "no connected wallet",
      );
    }
    if (context.wallet.namespace !== SUI_NAMESPACE) {
      throw new ExecutorError(
        ExecutorErrorCode.UnsupportedChain,
        "wallet_not_sui",
      );
    }

    const to = requireString(input, "to");
    requireSuiAddress(to, "to");

    const coinType = requireString(input, "coin_type");
    // Coin types follow `0x{addr}::{module}::{Name}` — minimal sanity
    // check to fail fast on obviously wrong inputs without hard-coding
    // the full Move identifier grammar (the kit's BCS layer enforces
    // the rest).
    if (!/^0x[0-9a-fA-F]+::[a-zA-Z_][\w]*::[a-zA-Z_][\w]*/.test(coinType)) {
      throw new ExecutorError(
        ExecutorErrorCode.InvalidInput,
        "invalid_coin_type",
      );
    }

    const tokenAmountHuman = requireString(input, "token_amount");

    const rawDecimals = input.token_decimals;
    const decimals =
      typeof rawDecimals === "number"
        ? rawDecimals
        : parseInt(String(rawDecimals), 10);
    if (!Number.isInteger(decimals) || decimals < 0) {
      throw new ExecutorError(
        ExecutorErrorCode.InvalidInput,
        "invalid_token_decimals",
      );
    }

    let amountRaw: bigint;
    try {
      amountRaw = parseUnits(tokenAmountHuman, decimals);
    } catch {
      throw new ExecutorError(
        ExecutorErrorCode.InvalidInput,
        "invalid_token_amount",
      );
    }
    if (amountRaw <= 0n) {
      throw new ExecutorError(
        ExecutorErrorCode.InvalidInput,
        "token_amount_must_be_positive",
      );
    }

    const kit = getSuiKit();
    const chain = getActiveSuiChain();
    const digest = await kit.sendTokenTransfer({
      wallet: context.wallet,
      to,
      amount: amountRaw,
      chain,
      contractAddress: coinType,
      decimals,
    });

    const transaction_id = await recordTransferHistory({
      blockchains: context.blockchains,
      namespace: "sui",
      chainSlug: `sui-${chain.network}`,
      contractAddress: coinType,
      type: "TRANSFER",
      amount: amountRaw.toString(),
      txHash: digest,
      fromAddress: context.wallet.address,
      toAddress: to,
    });

    // Same `data.digest` discipline as `send_sui` — base58 digest must
    // not occupy the hex-typed `tx_hash` slot.
    return {
      status: "success",
      tx_confirmed: true,
      transaction_id,
      data: {
        digest,
        to,
        coin_type: coinType,
        network: chain.network,
        amount_raw: amountRaw.toString(),
        token_amount: tokenAmountHuman,
        decimals,
      },
    };
  });

export const SUI_EXECUTORS: Record<string, MobileToolExecutor> = {
  get_wallet_sui_balance: getWalletSuiBalance,
  get_sui_balance: getSuiBalance,
  send_sui: sendSui,
  get_wallet_sui_coins: getSuiWalletTokens,
  send_sui_coin: sendSuiCoin,
};
