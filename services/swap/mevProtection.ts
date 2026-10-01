/**
 * MEV protection via private relay endpoints (Flashbots Protect) for public mempool chains.
 * Spec: docs/swap-capability-spec.md §9.2 (B3 + B4).
 */

import { http, type Transport } from "viem";
import { storage } from "@/lib/storage/mmkv";

const FLASHBOTS_PROTECT_RPC = "https://rpc.flashbots.net";

export interface MevRelayConfig {
  chainId: number;
  name: string;
  privateRpcUrl: string;
}

/**
 * Pinned table of trusted private RPC relays for public mempool chains.
 */
export const TRUSTED_PRIVATE_RELAYS: Record<number, MevRelayConfig> = {
  1: {
    chainId: 1,
    name: "Flashbots Protect",
    privateRpcUrl: FLASHBOTS_PROTECT_RPC,
  },
  11155111: {
    chainId: 11155111,
    name: "Flashbots Protect Sepolia",
    privateRpcUrl: "https://rpc-sepolia.flashbots.net",
  },
};

/**
 * Protection applies where we hold a trusted private relay for the chain.
 * Chains without a public mempool (sequencer-ordered L2s, Arc's fixed
 * validator set) simply have no entry, so no separate "L2" list is needed.
 */
export function isMevProtectionApplicable(chainId: number): boolean {
  return chainId in TRUSTED_PRIVATE_RELAYS;
}

const MEV_STORAGE_KEY = "takumipay.mev_protection_enabled";

export function getMevEnabled(): boolean {
  try {
    const val = storage.getString(MEV_STORAGE_KEY);
    if (val === "false") return false;
    return true; // Default ON for protected chains
  } catch {
    return true;
  }
}

export function setMevEnabled(enabled: boolean): void {
  try {
    storage.set(MEV_STORAGE_KEY, enabled ? "true" : "false");
  } catch (err) {
    if (__DEV__) console.warn("[MEV] Failed to persist MEV setting:", err);
  }
}

export const MEV_SETTINGS_QUERY_KEY = ["mevSettings"] as const;

export function isMevProtectionActive(chainId: number): boolean {
  return isMevProtectionApplicable(chainId) && getMevEnabled();
}

export function getMevTransportForChain(
  chainId: number,
): Transport | undefined {
  if (!isMevProtectionActive(chainId)) return undefined;
  const relay = TRUSTED_PRIVATE_RELAYS[chainId];
  return relay ? http(relay.privateRpcUrl) : undefined;
}

export function getMevProtectionStatus(caip2OrChainId: string | number): {
  active: boolean;
  relayName?: string;
} {
  let chainId: number | null = null;
  if (typeof caip2OrChainId === "number") {
    chainId = caip2OrChainId;
  } else if (typeof caip2OrChainId === "string") {
    const parts = caip2OrChainId.split(":");
    if (parts.length === 2 && parts[0] === "eip155") {
      const parsed = Number.parseInt(parts[1], 10);
      if (!Number.isNaN(parsed)) chainId = parsed;
    }
  }

  if (chainId !== null && isMevProtectionActive(chainId)) {
    return {
      active: true,
      relayName: TRUSTED_PRIVATE_RELAYS[chainId]?.name,
    };
  }

  return { active: false };
}
