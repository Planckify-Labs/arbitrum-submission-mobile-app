/**
 * Bridge status store and background poller for Takumi Agent.
 *
 * Mirrors the `pendingTxStore` singleton pattern:
 *  1. Tracks the in-flight lifecycle of bridge transfers by source tx hash.
 *  2. Polls `bridgeApi.getStatus` every 4 s in the background until reaching
 *     a terminal outcome (`completed`, `failed`, `partial`, `refunded`).
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
}

type Listener = (records: Map<string, BridgeStatusRecord>) => void;

const records = new Map<string, BridgeStatusRecord>();
const listeners = new Set<Listener>();
const activePollers = new Map<string, ReturnType<typeof setInterval>>();

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

    const record: BridgeStatusRecord = {
      sourceTxHash,
      fromChain,
      toChain,
      provider,
      status,
      lastUpdated: Date.now(),
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
      records.set(key, {
        sourceTxHash,
        fromChain,
        toChain,
        provider,
        status: params.initialStatus,
        lastUpdated: Date.now(),
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

    let cancelled = false;

    const poll = async () => {
      if (cancelled) return;
      try {
        if (typeof __DEV__ !== "undefined" && __DEV__) {
          console.log("[bridgeStatusStore] polling status for:", {
            sourceTxHash,
            fromChain,
            toChain,
            provider,
          });
        }
        const res = await bridgeApi.getStatus({
          fromChain,
          toChain,
          txHash: sourceTxHash,
          ...(provider ? { provider } : {}),
        });

        if (!cancelled && res) {
          if (typeof __DEV__ !== "undefined" && __DEV__) {
            console.log("[bridgeStatusStore] poll result received:", {
              sourceTxHash,
              phase: res.phase,
              outcome: res.outcome,
              destinationTxHash: res.destinationTxHash,
            });
          }
          this.update(sourceTxHash, res, { fromChain, toChain, provider });
        }
      } catch (err) {
        if (typeof __DEV__ !== "undefined" && __DEV__) {
          console.warn("[bridgeStatusStore] status poll error:", err);
        }
      }
    };

    void poll();
    const intervalId = setInterval(poll, 4000);
    activePollers.set(key, intervalId);

    return () => {
      cancelled = true;
      this.stopPolling(sourceTxHash);
    };
  },

  stopPolling(sourceTxHash: string): void {
    const key = normalizeHash(sourceTxHash);
    const timer = activePollers.get(key);
    if (timer) {
      clearInterval(timer);
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
      clearInterval(timer);
    }
    activePollers.clear();
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
