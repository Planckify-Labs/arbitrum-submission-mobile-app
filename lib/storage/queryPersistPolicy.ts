/**
 * Which queries may be written to the on-disk query cache. Pure (no
 * native imports) so it is node-testable; `queryPersister.ts` re-exports it.
 */

// Query keys that should never be persisted — real-time, polling, or wallet data
// Wallet queries are always reloaded from expo-secure-store on app start, so
// persisting them to MMKV (unencrypted) is both unnecessary and a security concern.
const EXCLUDED_QUERY_KEYS: string[] = [
  "auth", // nonces are single-use — never cache stale nonces across sessions
  "wallet-balance", // live on-chain balance (15s polling)
  "wallets", // reloaded from expo-secure-store on every start
  "active-wallet", // reloaded from expo-secure-store
  "active-wallet-index", // reloaded from expo-secure-store
  "active-chain", // reloaded from expo-secure-store
  "deposit", // point deposit status polling
  "status", // redemption status polling
  // Send-screen fee quotes: 12s polling, results hold `bigint` (which
  // JSON.stringify throws on, silently killing EVERY persisted write
  // below), and the key carries the recipient address.
  "transferFee",
  // MMKV is this value's source of truth (`usePreferredGasToken`); a
  // restored copy would shadow it.
  "preferredGasToken",
];

const shouldExclude = (queryKey: readonly unknown[]): boolean => {
  return queryKey.some((segment) =>
    EXCLUDED_QUERY_KEYS.includes(segment as string),
  );
};

// Used in dehydrateOptions.shouldDehydrateQuery to filter persisted queries
export const shouldPersistQuery = (query: {
  queryKey: readonly unknown[];
  state: { status: string };
}): boolean => {
  if (query.state.status !== "success") return false;
  return !shouldExclude(query.queryKey);
};
