/**
 * BalancesCard — single registry entry for every namespace's
 * "list wallet balances" tool. Reads only `WalletBalancesOutput`; the
 * `normalizeWalletBalancesOutput` adapter at the bottom of this file
 * folds legacy EVM / Solana payloads into the same shape so cached
 * conversation history keeps rendering after the executors are
 * migrated.
 */

import { AlertTriangle, Coins } from "lucide-react-native";
import type React from "react";
import { Text, View } from "react-native";
import OptimizedImage from "@/components/common/OptimizedImage";
import SingleLoadingSekeleton from "@/components/common/SingleLoadingSekeleton";
import type {
  BalanceGroup,
  BalanceTokenRow,
  Namespace,
  WalletBalancesOutput,
  WalletBalancesPayload,
} from "@/services/agent-executors/balancePayload";
import { agentErrorCopy } from "../agentErrorCopy";
import type { ToolComponentProps } from "../types";

const BRAND_RED = "#c71c4b";

type BalancesInput = {
  chain_id?: number;
  chain_ids?: number[];
  include_balance?: boolean;
  symbol?: string;
  is_stable_coin?: boolean;
  is_native_currency?: boolean;
};

function formatBalance(display: string | undefined): string {
  if (!display) return "—";
  const num = Number(display);
  if (!Number.isFinite(num)) return display;
  if (num === 0) return "0";
  if (num >= 1)
    return num.toLocaleString(undefined, { maximumFractionDigits: 4 });
  return num.toLocaleString(undefined, { maximumSignificantDigits: 6 });
}

function hasAnyBalance(tokens: BalanceTokenRow[]): boolean {
  return tokens.some((t) => {
    const n = Number(t.balance_display ?? "0");
    return Number.isFinite(n) && n > 0;
  });
}

function SkeletonRow() {
  return (
    <View className="flex-row items-center gap-3 py-2">
      <SingleLoadingSekeleton width={36} height={36} borderRadius={18} />
      <View className="flex-1 min-w-0">
        <SingleLoadingSekeleton
          height={12}
          borderRadius={4}
          style={{ width: "40%" }}
        />
        <SingleLoadingSekeleton
          height={10}
          borderRadius={4}
          style={{ marginTop: 4, width: "60%" }}
        />
      </View>
      <View className="items-end" style={{ width: "25%" }}>
        <SingleLoadingSekeleton
          height={12}
          borderRadius={4}
          style={{ width: "100%" }}
        />
        <SingleLoadingSekeleton
          height={10}
          borderRadius={4}
          style={{ marginTop: 4, width: "60%" }}
        />
      </View>
    </View>
  );
}

function TokenRowItem({ token }: { token: BalanceTokenRow }) {
  const balance = formatBalance(token.balance_display);
  const hasBalance = token.balance_display !== undefined;
  return (
    <View className="flex-row items-center gap-3 py-2">
      <View className="rounded-full overflow-hidden w-9 h-9 border border-light-matte-black/10 bg-light-primary-red/10 items-center justify-center">
        {token.logo_url ? (
          <OptimizedImage
            source={{ uri: token.logo_url }}
            containerStyle={{ width: 36, height: 36 }}
            contentFit="cover"
            alt={`${token.symbol ?? "token"} logo`}
          />
        ) : (
          <Coins size={16} color={BRAND_RED} />
        )}
      </View>
      <View className="flex-1 min-w-0">
        <Text
          className="text-sm font-semibold text-light-matte-black"
          numberOfLines={1}
        >
          {token.symbol ?? "—"}
          {token.is_native ? (
            <Text className="text-[10px] text-gray-500 font-normal">
              {" "}
              · native
            </Text>
          ) : null}
        </Text>
        {token.name ? (
          <Text className="text-[11px] text-gray-500" numberOfLines={1}>
            {token.name}
          </Text>
        ) : null}
      </View>
      <View className="items-end">
        <Text
          className={`text-sm font-semibold ${
            hasBalance ? "text-light-matte-black" : "text-gray-400"
          }`}
          numberOfLines={1}
        >
          {balance}
        </Text>
        <Text className="text-[10px] text-gray-500" numberOfLines={1}>
          {token.symbol ?? ""}
        </Text>
      </View>
    </View>
  );
}

function GroupBlock({
  group,
  showHeader,
}: {
  group: BalanceGroup;
  showHeader: boolean;
}) {
  const tokens = group.tokens ?? [];
  const withBalance = tokens.filter((t) => {
    const n = Number(t.balance_display ?? "0");
    return Number.isFinite(n) && n > 0;
  });
  const display = withBalance.length > 0 ? withBalance : tokens.slice(0, 6);

  return (
    <View className="mt-2 first:mt-0">
      {showHeader ? (
        <View className="flex-row items-center gap-1.5 mb-1">
          {group.chain_logo_url ? (
            <OptimizedImage
              source={{ uri: group.chain_logo_url }}
              containerStyle={{ width: 14, height: 14, borderRadius: 7 }}
              contentFit="cover"
              alt={`${group.chain_label} logo`}
            />
          ) : null}
          <Text className="text-[10px] uppercase tracking-wide text-gray-500 font-bold">
            {group.chain_label}
          </Text>
        </View>
      ) : null}
      <View className="divide-y divide-gray-100">
        {display.map((token, idx) => (
          <TokenRowItem
            key={`${token.address ?? token.symbol ?? "row"}-${idx}`}
            token={token}
          />
        ))}
      </View>
      {withBalance.length === 0 && tokens.length > 0 ? (
        <Text className="text-[11px] text-gray-400 mt-1">
          No balances yet — showing supported tokens.
        </Text>
      ) : null}
    </View>
  );
}

const BalancesCard: React.FC<
  ToolComponentProps<BalancesInput, WalletBalancesOutput>
> = ({ state, output }) => {
  if (state === "input-streaming" || state === "input-available" || !output) {
    return (
      <View className="my-1.5 rounded-2xl border border-light-matte-black/10 bg-white px-3.5 py-3">
        <View className="flex-row items-center gap-2 mb-1">
          <Coins size={14} color={BRAND_RED} />
          <Text className="text-xs font-bold uppercase tracking-wide text-light-matte-black">
            Wallet balances
          </Text>
          <View className="ml-auto">
            <SingleLoadingSekeleton width={50} height={10} borderRadius={4} />
          </View>
        </View>
        <View className="divide-y divide-gray-100">
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
        </View>
      </View>
    );
  }

  const normalized = normalizeWalletBalancesOutput(output);

  if (state === "output-error" || normalized.status === "failed") {
    return (
      <View className="my-1.5 rounded-2xl border border-light-primary-red/30 bg-light-primary-red/5 px-3.5 py-3">
        <View className="flex-row items-center gap-2">
          <AlertTriangle size={14} color={BRAND_RED} />
          <Text className="text-xs font-bold uppercase tracking-wide text-light-primary-red">
            Couldn&apos;t read balances
          </Text>
        </View>
        {normalized.error ? (
          <Text className="text-sm text-light-matte-black/80 mt-1.5">
            {agentErrorCopy(normalized.error)}
          </Text>
        ) : null}
      </View>
    );
  }

  const payload: WalletBalancesPayload = normalized.display ??
    normalized.data ?? { groups: [] };
  const groups = Array.isArray(payload.groups) ? payload.groups : [];
  const groupErrors = Array.isArray(payload.group_errors)
    ? payload.group_errors
    : [];

  const totalTokens = groups.reduce(
    (sum, g) => sum + (g.tokens?.length ?? 0),
    0,
  );
  const anyBalance = groups.some((g) => hasAnyBalance(g.tokens ?? []));
  const showGroupHeaders = groups.length > 1;

  return (
    <View className="my-1.5 rounded-2xl border border-light-matte-black/10 bg-white px-3.5 py-3">
      <View className="flex-row items-center gap-2 mb-1">
        <Coins size={14} color={BRAND_RED} />
        <Text className="text-xs font-bold uppercase tracking-wide text-light-matte-black">
          Wallet balances
        </Text>
        <Text className="text-[11px] text-gray-500 ml-auto">
          {!showGroupHeaders && groups[0]?.chain_label
            ? `${groups[0].chain_label} · `
            : ""}
          {totalTokens} {totalTokens === 1 ? "token" : "tokens"}
        </Text>
      </View>
      {groups.length === 0 ? (
        <Text className="text-sm text-gray-500">No tokens to show.</Text>
      ) : (
        groups.map((g, i) => (
          <GroupBlock
            key={`${g.namespace}-${g.chain_id ?? i}`}
            group={g}
            showHeader={showGroupHeaders}
          />
        ))
      )}
      {!anyBalance && totalTokens > 0 ? (
        <Text className="text-[11px] text-gray-400 mt-2">
          Balances will appear once the wallet has funds.
        </Text>
      ) : null}
      {groupErrors.length > 0 ? (
        <View className="mt-2 rounded-xl bg-light-primary-red/5 border border-light-primary-red/20 px-2.5 py-1.5">
          <Text className="text-[10px] uppercase tracking-wide text-light-primary-red font-bold">
            Couldn&apos;t reach {groupErrors.length} chain
            {groupErrors.length === 1 ? "" : "s"}
          </Text>
        </View>
      ) : null}
    </View>
  );
};

export default BalancesCard;

// ──────────────────────────────────────────────────────────────────
// Legacy adapter — folds pre-migration EVM / Solana payloads onto
// the unified shape so persisted chat history keeps rendering. Pure
// function; takes whatever sat on the wire when the tool ran.
// ──────────────────────────────────────────────────────────────────

type LegacyTokenRow = BalanceTokenRow & {
  balance_wei?: string;
  balance_lamports?: string;
};

type LegacyEvmGroup = {
  chain_id?: number;
  chain_name?: string;
  chain_symbol?: string;
  tokens?: LegacyTokenRow[];
};

type LegacyEvmPayload = {
  // single-chain flat shape
  chain_id?: number;
  chain_name?: string;
  tokens?: LegacyTokenRow[];
  // multi-chain
  chains?: LegacyEvmGroup[];
  chain_errors?: Array<{ chain_id: number; error: string }>;
};

type LegacySolanaPayload = {
  cluster?: string;
  tokens?: LegacyTokenRow[];
};

type LegacyOrUnifiedOutput = WalletBalancesOutput & {
  display?: WalletBalancesPayload | LegacyEvmPayload | LegacySolanaPayload;
  data?: WalletBalancesPayload | LegacyEvmPayload | LegacySolanaPayload;
};

function clusterLabel(cluster: string | undefined): string {
  if (cluster === "devnet") return "Solana Devnet";
  if (cluster === "testnet") return "Solana Testnet";
  return "Solana Mainnet";
}

function liftRawAmount(t: LegacyTokenRow): BalanceTokenRow {
  if (t.balance_raw !== undefined) return t;
  const raw = t.balance_wei ?? t.balance_lamports;
  if (raw === undefined) return t;
  const { balance_wei: _w, balance_lamports: _l, ...rest } = t;
  return { ...rest, balance_raw: raw };
}

function isUnified(p: unknown): p is WalletBalancesPayload {
  return (
    !!p &&
    typeof p === "object" &&
    Array.isArray((p as { groups?: unknown }).groups)
  );
}

function isLegacySolana(p: unknown): p is LegacySolanaPayload {
  return (
    !!p &&
    typeof p === "object" &&
    "cluster" in (p as object) &&
    Array.isArray((p as { tokens?: unknown }).tokens)
  );
}

function isLegacyEvmMulti(p: unknown): p is LegacyEvmPayload {
  return (
    !!p &&
    typeof p === "object" &&
    Array.isArray((p as { chains?: unknown }).chains)
  );
}

function isLegacyEvmSingle(p: unknown): p is LegacyEvmPayload {
  return (
    !!p &&
    typeof p === "object" &&
    "chain_id" in (p as object) &&
    Array.isArray((p as { tokens?: unknown }).tokens)
  );
}

/**
 * Pre-migration single-balance read shapes:
 *   EVM    : { address, chain_id, balance_wei, balance_display, symbol, decimals, name? }
 *   Solana : { address, cluster,  balance_lamports, balance_display, symbol }
 * Detect by the presence of a flat `balance_wei`/`balance_lamports` and
 * the absence of a `tokens[]` array (which would mean the multi-row
 * legacy shape).
 */
type LegacySingleBalance = {
  address?: string;
  chain_id?: number;
  cluster?: string;
  balance_wei?: string;
  balance_lamports?: string;
  balance_raw?: string;
  balance_display?: string;
  symbol?: string;
  name?: string;
  decimals?: number;
  logo_url?: string;
};

function isLegacySingleBalance(p: unknown): p is LegacySingleBalance {
  if (!p || typeof p !== "object") return false;
  const obj = p as Record<string, unknown>;
  if (Array.isArray(obj.tokens) || Array.isArray(obj.chains)) return false;
  return (
    typeof obj.balance_wei === "string" ||
    typeof obj.balance_lamports === "string" ||
    typeof obj.balance_raw === "string"
  );
}

function inferNamespaceFromTokens(
  tokens: LegacyTokenRow[] | undefined,
): Namespace {
  // Solana lamports-only payloads were never tagged; spot them by the
  // presence of `balance_lamports` on any row.
  return tokens?.some((t) => t.balance_lamports !== undefined)
    ? "solana"
    : "evm";
}

function normalizePayload(raw: unknown): WalletBalancesPayload {
  if (isUnified(raw)) {
    return {
      groups: raw.groups.map((g) => ({
        ...g,
        tokens: (g.tokens ?? []).map(liftRawAmount),
      })),
      ...(raw.group_errors ? { group_errors: raw.group_errors } : {}),
    };
  }

  if (isLegacySolana(raw)) {
    return {
      groups: [
        {
          namespace: "solana",
          chain_id: raw.cluster,
          chain_label: clusterLabel(raw.cluster),
          chain_symbol: "SOL",
          tokens: (raw.tokens ?? []).map(liftRawAmount),
        },
      ],
    };
  }

  if (isLegacyEvmMulti(raw)) {
    const groups: BalanceGroup[] = (raw.chains ?? []).map((c) => ({
      namespace: "evm" as const,
      chain_id: c.chain_id,
      chain_label: c.chain_name ?? `Chain ${c.chain_id ?? "?"}`,
      chain_symbol: c.chain_symbol,
      tokens: (c.tokens ?? []).map(liftRawAmount),
    }));
    const group_errors = (raw.chain_errors ?? []).map((e) => ({
      namespace: "evm" as const,
      chain_id: e.chain_id,
      chain_label: `Chain ${e.chain_id}`,
      error: e.error,
    }));
    return {
      groups,
      ...(group_errors.length > 0 ? { group_errors } : {}),
    };
  }

  if (isLegacyEvmSingle(raw)) {
    const ns = inferNamespaceFromTokens(raw.tokens);
    return {
      groups: [
        {
          namespace: ns,
          chain_id: raw.chain_id,
          chain_label:
            raw.chain_name ?? (ns === "solana" ? "Solana" : "Wallet"),
          tokens: (raw.tokens ?? []).map(liftRawAmount),
        },
      ],
    };
  }

  if (isLegacySingleBalance(raw)) {
    const isSolana = raw.balance_lamports !== undefined || !!raw.cluster;
    const namespace: Namespace = isSolana ? "solana" : "evm";
    const balance_raw =
      raw.balance_raw ?? raw.balance_wei ?? raw.balance_lamports;
    const tokenRow: BalanceTokenRow = {
      symbol: raw.symbol ?? (isSolana ? "SOL" : "ETH"),
      name: raw.name,
      address: isSolana ? "" : "0x0000000000000000000000000000000000000000",
      decimals: raw.decimals ?? (isSolana ? 9 : 18),
      is_native: true,
      is_stable_coin: false,
      ...(raw.logo_url ? { logo_url: raw.logo_url } : {}),
      ...(balance_raw !== undefined ? { balance_raw } : {}),
      ...(raw.balance_display !== undefined
        ? { balance_display: raw.balance_display }
        : {}),
    };
    return {
      groups: [
        {
          namespace,
          chain_id: raw.chain_id ?? raw.cluster,
          chain_label: isSolana ? clusterLabel(raw.cluster) : "Wallet",
          chain_symbol: tokenRow.symbol,
          tokens: [tokenRow],
        },
      ],
    };
  }

  return { groups: [] };
}

export function normalizeWalletBalancesOutput(
  output: LegacyOrUnifiedOutput,
): WalletBalancesOutput {
  const display = output.display ? normalizePayload(output.display) : undefined;
  const data = output.data ? normalizePayload(output.data) : undefined;
  return {
    status: output.status,
    error: output.error,
    ...(display ? { display } : {}),
    ...(data ? { data } : {}),
  };
}
