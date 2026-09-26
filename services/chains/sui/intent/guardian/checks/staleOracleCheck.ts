/**
 * Stale-pool / stale-oracle risk check (spec §5.2).
 *
 * Reads the pool/market object's last-update timestamp (the time of the
 * transaction that last touched it) and flags when it is older than the
 * freshness window for that action — price freshness for a swap, the
 * longer accrual window for a lending supply. Distinct from high-slippage:
 * that is order-size-vs-depth, this is data freshness.
 *
 * The pool-freshness reader is injected so unit tests can drive it from a
 * fixture; production reads it live via `SuiJsonRpcClient`. Any read
 * failure → `null` (no flag): the guardian must never *false-block* on a
 * transient RPC hiccup.
 */

import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { createSuiGrpcJsonRpcTransport } from "@/services/chains/sui/grpcTransport";
import { formatRiskCopy } from "../copy";
import type { RiskCheck, RiskCheckArgs, RiskFlag } from "../riskCheck";

/** Returns the pool's last-update epoch-ms, or null when unavailable. */
export type PoolFreshnessReader = (
  args: RiskCheckArgs,
) => Promise<number | null>;

/** Freshness windows (ms): swaps need a fresh price; lending accrues slowly. */
const SWAP_WINDOW_MS = 60_000; // 60s
const LENDING_WINDOW_MS = 30 * 60_000; // 30 min

function windowFor(action: string): number {
  // Anything that touches a DEX price (swap, or the swap leg of a zap) needs
  // a fresh price; a pure lending supply/withdraw accrues slowly.
  return action === "supply" || action === "withdraw"
    ? LENDING_WINDOW_MS
    : SWAP_WINDOW_MS;
}

/**
 * Production reader: object's `previousTransaction` → that block's
 * `timestampMs`. Two reads; wrapped so any failure returns null.
 */
export const livePoolFreshnessReader: PoolFreshnessReader = async (args) => {
  const { compiled, ctx, client: shared } = args;
  if (!compiled.poolObjectId) return null;
  try {
    // Reuse the executor's shared client when present (one connection per
    // preview); only construct one when called standalone (e.g. unit tests).
    const client =
      shared ??
      new SuiJsonRpcClient({
        transport: createSuiGrpcJsonRpcTransport(ctx.chain.network),
        network: ctx.chain.network,
      });
    const obj = await client.getObject({
      id: compiled.poolObjectId,
      options: { showPreviousTransaction: true },
    });
    const digest = (obj as { data?: { previousTransaction?: string } } | null)
      ?.data?.previousTransaction;
    if (!digest) return null;
    const tx = await client.getTransactionBlock({ digest, options: {} });
    const ts = (tx as { timestampMs?: string | number } | null)?.timestampMs;
    if (ts === undefined || ts === null) return null;
    const ms = typeof ts === "string" ? Number(ts) : ts;
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  } catch {
    return null;
  }
};

export function createStaleOracleCheck(
  readLastUpdateMs: PoolFreshnessReader = livePoolFreshnessReader,
): RiskCheck {
  return {
    code: "oracle.stale",
    async run(args): Promise<RiskFlag | null> {
      const { compiled, intent } = args;
      if (!compiled.poolObjectId) return null;

      const lastUpdateMs = await readLastUpdateMs(args);
      if (lastUpdateMs === null) return null;

      const ageMs = Date.now() - lastUpdateMs;
      const window = windowFor(intent.action);
      if (ageMs <= window) return null;

      const minutes = Math.max(1, Math.floor(ageMs / 60_000));
      const copy = formatRiskCopy({
        code: "oracle.stale",
        severity: "warn",
        params: { n: minutes },
      });
      return { code: "oracle.stale", severity: "warn", ...copy };
    },
  };
}
