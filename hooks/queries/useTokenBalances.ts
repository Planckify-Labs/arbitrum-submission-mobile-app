/**
 * Token balances hook with grouping: main, discovered, hidden.
 * Wraps useIndexer().getTokenBalances with spam filtering and user prefs.
 */

import { useQuery } from "@tanstack/react-query";
import { getCached, setCache } from "@/services/indexer/cache";
import { indexerRegistry } from "@/services/indexer/registry";
import type { TokenBalance } from "@/services/indexer/types";
import { checkSpam } from "@/services/tokens/spamFilter";
import {
  getAllTokenPrefs,
  getUserTokens,
  isDefaultToken,
} from "@/services/tokens/tokenList";
import { filterSupportedTokens } from "@/services/tokens/tokenSupport";
import type {
  GroupedTokenBalances,
  TokenBalanceItem,
} from "@/services/tokens/types";

export const tokenBalancesQueryKeys = {
  grouped: (address: string, chainId: number) =>
    ["tokenBalances", "grouped", address, chainId] as const,
};

function toBalanceItem(
  token: TokenBalance,
  prefs: { isPinned: boolean; isHidden: boolean; isSpam: boolean },
): TokenBalanceItem {
  const spam = checkSpam(token);

  return {
    contractAddress: token.contractAddress,
    symbol: token.symbol,
    name: token.name,
    decimals: token.decimals,
    balance: token.balance,
    price: token.price,
    logoURI: token.logoURI,
    chainId: token.chainId,
    namespace: token.namespace,
    isSpam: spam.isSpam || prefs.isSpam,
    spamReason: spam.reason,
    source: token.source,
    isPinned: prefs.isPinned,
    isHidden: prefs.isHidden || spam.isSpam || prefs.isSpam,
  };
}

function groupTokens(items: TokenBalanceItem[]): GroupedTokenBalances {
  const main: TokenBalanceItem[] = [];
  const discovered: TokenBalanceItem[] = [];
  const hidden: TokenBalanceItem[] = [];

  for (const item of items) {
    if (item.isHidden || item.isSpam) {
      hidden.push(item);
    } else if (item.source === "auto-discovered" && !item.isPinned) {
      discovered.push(item);
    } else {
      main.push(item);
    }
  }

  // Sort main: pinned first, then by USD value descending
  main.sort((a, b) => {
    if (a.isPinned && !b.isPinned) return -1;
    if (!a.isPinned && b.isPinned) return 1;
    const aValue = Number(a.balance) * (a.price ?? 0);
    const bValue = Number(b.balance) * (b.price ?? 0);
    return bValue - aValue;
  });

  return { main, discovered, hidden };
}

export function useGroupedTokenBalances(
  address: string | undefined,
  chainId: number,
) {
  return useQuery({
    queryKey: tokenBalancesQueryKeys.grouped(address ?? "", chainId),
    queryFn: async (): Promise<{
      data: GroupedTokenBalances;
      isStale: boolean;
    }> => {
      if (!address) {
        return {
          data: { main: [], discovered: [], hidden: [] },
          isStale: false,
        };
      }

      // Check cache
      const cached = getCached<TokenBalance[]>(
        "tokenBalances",
        address,
        chainId,
      );

      let balances: TokenBalance[];
      let isStale = false;

      try {
        balances = await indexerRegistry.call<TokenBalance[]>(
          "getTokenBalances",
          address,
          chainId,
        );
        setCache("tokenBalances", balances, address, chainId);
      } catch {
        if (cached) {
          balances = cached.data;
          isStale = true;
        } else {
          return {
            data: { main: [], discovered: [], hidden: [] },
            isStale: false,
          };
        }
      }

      // Merge user-added tokens that may not appear in indexer
      const userTokens = getUserTokens(chainId);
      const allPrefs = getAllTokenPrefs();

      // Build balance items with prefs
      const items = filterSupportedTokens(balances).map((t) => {
        const key = `${t.contractAddress.toLowerCase()}:${t.chainId}`;
        const prefs = allPrefs.get(key) ?? {
          isPinned: false,
          isHidden: false,
          isSpam: false,
        };

        // Determine source
        if (!t.source) {
          t.source = isDefaultToken(t.contractAddress, t.chainId)
            ? "default-list"
            : "auto-discovered";
        }

        return toBalanceItem(t, prefs);
      });

      return { data: groupTokens(items), isStale };
    },
    enabled: !!address,
    staleTime: 30_000,
  });
}
