/**
 * "That's an address for a different network": a recipient that fails the
 * active chain's check but passes another registered chain's is almost
 * always a paste from the wrong place, and naming it beats a generic
 * "doesn't look valid". Chain-agnostic: it only asks each kit.
 */

import type { Namespace } from "@/services/chains/types";
import type { WalletKitAdapter } from "@/services/walletKit/types";

type KitLike = Pick<WalletKitAdapter, "namespace" | "validateAddress"> & {
  displayName?: string;
};

/** Display name of another chain the address IS valid on, or null. */
export function otherChainNameForAddress(
  recipient: string,
  current: Namespace,
  kits: readonly KitLike[],
): string | null {
  for (const kit of kits) {
    if (kit.namespace === current) continue;
    if (kit.validateAddress(recipient)) return kit.displayName ?? null;
  }
  return null;
}
