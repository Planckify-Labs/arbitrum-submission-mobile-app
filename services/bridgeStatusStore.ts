/**
 * Bridge status store and background poller for Takumi Agent.
 *
 * Mirrors the `pendingTxStore` singleton pattern:
 *  1. Tracks the in-flight lifecycle of bridge transfers by source tx hash.
 *  2. Polls `bridgeApi.getStatus` in the background until reaching a
 *     terminal outcome (`completed`, `failed`, `partial`, `refunded`):
 *     every 4 s at first, backing off to 10 s and then 30 s, one request
 *     at a time, and giving up after `MAX_POLL_MS`.
 *  3. Flags a transfer as `stalled` when it takes far longer than expected,
 *     so the card can state a recovery path instead of spinning forever
 *     (bridge spec §7.7).
 *  3. Notifies subscribers (`BridgeProgressCard`) so the UI updates in
 *     real time without agent loop churning or duplicate card rendering.
 *  4. Survives navigation away from and back to the chat screen.
 */

import { useEffect, useState } from "react";
import { bridgeApi } from "@/api/endpoints/bridge";
import type { TBridgeStatus } from "@/api/types/bridge";

export interface BridgeStatusRecord {
  sourceTxHash: string;
  fromChain: string;
  toChain: string;
  provider?: string;
  status: TBridgeStatus;
  lastUpdated: number;
  /** When tracking began, for the backoff and stall clocks. */
  startedAt: number;
  /**
   * Taking far longer than a transfer should: never seen on the source
   * chain for `SOURCE_STALL_MS`, or unsettled after `STALL_MS`. The card
   * says so and offers a way to act. Not a failure: it can still settle.
   */
  stalled?: boolean;
}

/** Poll cadence by elapsed time: responsive early, cheap for long waits. */
export function pollDelayMs(elapsedMs: number): number {
  if (elapsedMs < 2 * 60_000) return 4_000;
  if (elapsedMs < 20 * 60_000) return 10_000;
  return 30_000;
}

/** Not even seen on the source chain after this long: likely never landed. */
export const SOURCE_STALL_MS = 30 * 60_000;
/** Longer than any Standard CCTP or bridge settlement we route. */
export const STALL_MS = 2 * 60 * 60_000;
/** Stop polling entirely; the card keeps its stalled state and recovery. */
export const MAX_POLL_MS = 8 * 60 * 60_000;

function isStalled(status: TBridgeStatus, elapsedMs: number): boolean {
  if (isTerminalOutcome(status)) return false;
  if (status.phase === "pending_source" && elapsedMs > SOURCE_STALL_MS) {
    return true;
  }
  return elapsedMs > STALL_MS;
}

type Listener = (records: Map<string, BridgeStatusRecord>) => void;

const records = new Map<string, BridgeStatusRecord>();
const listeners = new Set<Listener>();
const activePollers = new Map<string, ReturnType<typeof setTimeout>>();
/**
 * The live poll chain per transfer. A request already in flight when its
 * chain is stopped must not schedule another, so each chain checks it is
 * still the current one before re-arming.
 */
const pollChains = new Map<string, object>();

function normalizeHash(hash: string): string {
  return hash.trim().toLowerCase();
}

function normalizeProvider(provider?: string): string | undefined {
  if (!provider) return undefined;
  // Backend adapter key for Circle CCTP is "circle-cctp", not "circle"
  if (provider === "circle") return "circle-cctp";
  return provider;
}

function isTerminalOutcome(status: TBridgeStatus | null | undefined): boolean {
  if (!status) return false;
  return Boolean(
    status.outcome === "completed" ||
      status.outcome === "failed" ||
      status.outcome === "partial" ||
      status.outcome === "refunded" ||
      status.phase === "settled",
  );
}

function notify(): void {
  for (const listener of listeners) {
    try {
      listener(records);
    } catch (err) {
      if (typeof __DEV__ !== "undefined" && __DEV__) {
        console.warn("[bridgeStatusStore] listener threw:", err);
      }
    }
  }
}

export const bridgeStatusStore = {
  get(sourceTxHash: string | undefined): BridgeStatusRecord | undefined {
    if (!sourceTxHash) return undefined;
    return records.get(normalizeHash(sourceTxHash));
  },

  list(): BridgeStatusRecord[] {
    return Array.from(records.values()).sort(
      (a, b) => b.lastUpdated - a.lastUpdated,
    );
  },

  update(
    sourceTxHash: string,
    status: TBridgeStatus,
    metadata?: { fromChain?: string; toChain?: string; provider?: string },
  ): void {
    if (!sourceTxHash) return;
    const key = normalizeHash(sourceTxHash);
    const existing = records.get(key);

    const fromChain = metadata?.fromChain ?? existing?.fromChain ?? "";
    const toChain = metadata?.toChain ?? existing?.toChain ?? "";
    const provider = normalizeProvider(
      metadata?.provider ?? existing?.provider,
    );

    const now = Date.now();
    const startedAt = existing?.startedAt ?? now;
    const record: BridgeStatusRecord = {
      sourceTxHash,
      fromChain,
      toChain,
      provider,
      status,
      lastUpdated: now,
      startedAt,
      stalled: isStalled(status, now - startedAt),
    };

    records.set(key, record);
    notify();

    if (isTerminalOutcome(status)) {
      this.stopPolling(sourceTxHash);
    }
  },

  startPolling(params: {
    sourceTxHash: string;
    fromChain: string;
    toChain: string;
    provider?: string;
    initialStatus?: TBridgeStatus;
  }): () => void {
    const { sourceTxHash, fromChain, toChain } = params;
    if (!sourceTxHash || !fromChain || !toChain) {
      return () => {};
    }

    const key = normalizeHash(sourceTxHash);
    const provider = normalizeProvider(params.provider);

    // Initialize in store if not present
    const existing = records.get(key);
    if (!existing && params.initialStatus) {
      const now = Date.now();
      records.set(key, {
        sourceTxHash,
        fromChain,
        toChain,
        provider,
        status: params.initialStatus,
        lastUpdated: now,
        startedAt: now,
      });
      notify();
    }

    // If already in terminal state, no need to poll
    if (isTerminalOutcome(existing?.status ?? params.initialStatus)) {
      return () => {};
    }

    // Already polling this transfer
    if (activePollers.has(key)) {
      return () => this.stopPolling(sourceTxHash);
    }

    const chain = {};
    pollChains.set(key, chain);
    const isLive = () => pollChains.get(key) === chain;
    const startedAt = records.get(key)?.startedAt ?? Date.now();

    // A self-scheduling chain rather than `setInterval`: the next request
    // is only scheduled once this one settles, so a slow backend can never
    // pile requests up.
    const poll = async () => {
      if (!isLive()) return;
      try {
        const res = await bridgeApi.getStatus({
          fromChain,
          toChain,
          txHash: sourceTxHash,
          ...(provider ? { provider } : {}),
        });
        if (isLive() && res) {
          this.update(sourceTxHash, res, { fromChain, toChain, provider });
        }
      } catch (err) {
        if (typeof __DEV__ !== "undefined" && __DEV__) {
          console.warn("[bridgeStatusStore] status poll error:", err);
        }
      }
      if (!isLive()) return;
      const record = records.get(key);
      if (record && isTerminalOutcome(record.status)) {
        activePollers.delete(key);
        pollChains.delete(key);
        return;
      }
      const elapsed = Date.now() - startedAt;
      if (elapsed >= MAX_POLL_MS) {
        activePollers.delete(key);
        pollChains.delete(key);
        if (record && !record.stalled) {
          records.set(key, { ...record, stalled: true });
          notify();
        }
        return;
      }
      activePollers.set(key, setTimeout(poll, pollDelayMs(elapsed)));
    };

    // Registered before the first request, so a concurrent `startPolling`
    // for the same transfer joins this chain instead of starting another.
    activePollers.set(key, setTimeout(poll, 0));

    return () => this.stopPolling(sourceTxHash);
  },

  stopPolling(sourceTxHash: string): void {
    const key = normalizeHash(sourceTxHash);
    pollChains.delete(key);
    const timer = activePollers.get(key);
    if (timer) {
      clearTimeout(timer);
      activePollers.delete(key);
    }
  },

  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  clear(): void {
    for (const timer of activePollers.values()) {
      clearTimeout(timer);
    }
    activePollers.clear();
    pollChains.clear();
    records.clear();
    notify();
  },
};

/**
 * React hook to subscribe to a bridge transfer's real-time status.
 */
export function useBridgeStatus(
  sourceTxHash: string | undefined,
  params?: {
    fromChain?: string;
    toChain?: string;
    provider?: string;
    initialStatus?: TBridgeStatus;
  },
): {
  status: TBridgeStatus | null;
  record: BridgeStatusRecord | undefined;
} {
  const [record, setRecord] = useState<BridgeStatusRecord | undefined>(() =>
    bridgeStatusStore.get(sourceTxHash),
  );

  useEffect(() => {
    if (!sourceTxHash) {
      setRecord(undefined);
      return;
    }

    setRecord(bridgeStatusStore.get(sourceTxHash));

    const unsubscribe = bridgeStatusStore.subscribe(() => {
      setRecord(bridgeStatusStore.get(sourceTxHash));
    });

    let stopPolling: (() => void) | undefined;
    if (params?.fromChain && params?.toChain) {
      stopPolling = bridgeStatusStore.startPolling({
        sourceTxHash,
        fromChain: params.fromChain,
        toChain: params.toChain,
        provider: params.provider,
        initialStatus: params.initialStatus,
      });
    }

    return () => {
      unsubscribe();
      stopPolling?.();
    };
  }, [
    sourceTxHash,
    params?.fromChain,
    params?.toChain,
    params?.provider,
    params?.initialStatus,
  ]);

  return {
    status: record?.status ?? null,
    record,
  };
}
