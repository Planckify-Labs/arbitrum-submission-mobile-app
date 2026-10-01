import type { TBlockchain } from "@/api/types/blockchain";
import { ARC_MAINNET_CHAIN_ID } from "@/services/chains/evm/arc";

/**
 * Chain a brand-new install lands on. The chain list is API-driven, so
 * this only ever picks from the `/blockchains` feed it is given: Arc
 * mainnet when the feed serves it, otherwise the first selectable row
 * on the list (mainnets preferred over testnets). Rows without a numeric
 * `chainId` (non-EVM) can't be switched to by id, so they are skipped.
 * Returns `undefined` for an empty feed.
 */
export function pickOnboardingDefaultChainId(
  blockchains: readonly TBlockchain[],
): number | undefined {
  const selectable = blockchains.filter(
    (b): b is TBlockchain & { chainId: number } =>
      b.isActive && typeof b.chainId === "number",
  );
  const arc = selectable.find(
    (b) => b.chainId === ARC_MAINNET_CHAIN_ID && !b.isTestnet,
  );
  if (arc) return arc.chainId;
  return (selectable.find((b) => !b.isTestnet) ?? selectable[0])?.chainId;
}
