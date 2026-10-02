import { useQuery } from "@tanstack/react-query";
import { tokenApi } from "@/api/endpoints/tokens";
import type { TToken, TTokenSearchParams } from "@/api/types/token";
import { storage } from "@/lib/storage/mmkv";
import { filterSupportedTokens } from "@/services/tokens/tokenSupport";

const TOKEN_STORAGE_KEY = "cached_tokens";
const TOKEN_TIMESTAMP_KEY = "cached_tokens_timestamp";
const OFFLINE_CACHE_TTL = 24 * 60 * 60 * 1000; // 24h — offline fallback only
const STALE_TIME = 5 * 60 * 1000; // 5 min — React Query freshness window

const filterTokens = (tokens: TToken[], options?: TTokenSearchParams) => {
  if (!options) return tokens;
  return tokens.filter((token) => {
    if (options.blockchainId && token.blockchainId !== options.blockchainId)
      return false;
    if (
      options.isStablecoin !== undefined &&
      token.isStablecoin !== options.isStablecoin
    )
      return false;
    if (options.isActive !== undefined && token.isActive !== options.isActive)
      return false;
    if (
      options.isNativeCurrency !== undefined &&
      token.isNativeCurrency !== options.isNativeCurrency
    )
      return false;
    if (
      options.isPaymentEnabled !== undefined &&
      token.isPaymentEnabled !== options.isPaymentEnabled
    )
      return false;
    return true;
  });
};

function readCachedTokens(): TToken[] | undefined {
  const raw = storage.getString(TOKEN_STORAGE_KEY);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as TToken[];
  } catch {
    return undefined;
  }
}

function readCacheTimestamp(): number {
  const raw = storage.getString(TOKEN_TIMESTAMP_KEY);
  return raw ? Number.parseInt(raw, 10) || 0 : 0;
}

async function fetchAndCacheTokens(): Promise<TToken[]> {
  const response = await tokenApi.getTokenList();
  // Synchronous MMKV write. Persists the full catalogue (unfiltered)
  // so every `useTokens({ ... })` consumer can seed its `initialData`
  // from the same bundle without a per-filter cache entry.
  storage.set(TOKEN_STORAGE_KEY, JSON.stringify(response));
  storage.set(TOKEN_TIMESTAMP_KEY, Date.now().toString());
  return response;
}

export const useTokens = (options?: TTokenSearchParams) => {
  const isServerFiltered = !!(
    options?.name ||
    options?.symbol ||
    options?.contractAddress ||
    options?.blockchainId ||
    options?.isNativeCurrency !== undefined ||
    options?.isStablecoin !== undefined ||
    options?.isActive !== undefined ||
    options?.isPaymentEnabled !== undefined
  );

  return useQuery<TToken[]>({
    queryKey: ["tokens", options],
    initialData: () => {
      if (isServerFiltered) return undefined;
      const cached = readCachedTokens();
      if (!cached) return undefined;
      return filterTokens(cached, options);
    },
    initialDataUpdatedAt: () => (isServerFiltered ? 0 : readCacheTimestamp()),
    queryFn: async () => {
      if (isServerFiltered) {
        return await tokenApi.searchTokens(options ?? {});
      }
      try {
        const fresh = await fetchAndCacheTokens();
        return filterTokens(fresh, options);
      } catch (err) {
        const cached = readCachedTokens();
        const ts = readCacheTimestamp();
        if (cached && Date.now() - ts < OFFLINE_CACHE_TTL) {
          return filterTokens(cached, options);
        }
        throw err;
      }
    },
    // Stablecoin lockdown is applied at the read, not in the MMKV cache,
    // so nothing is lost when the flag flips. Identity when it is off.
    select: filterSupportedTokens,
    staleTime: STALE_TIME,
    gcTime: OFFLINE_CACHE_TTL,
    refetchOnMount: true,
    refetchOnReconnect: "always",
  });
};
