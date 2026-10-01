/**
 * Bind the EVM safety provider to the chains the API published, for the
 * swap/bridge route path.
 *
 * Without this the provider's resolver is `() => null` until some DeFi write
 * happens to bind it, and every EVM route dies at `chain-binding`. Route
 * contexts carry the CAIP-2 reference (a string), the API rows carry a numeric
 * `chainId`, so the comparison is numeric on purpose.
 */

import type { TBlockchain } from "@/api/types/blockchain";
import { buildChainConfigFromBlockchain } from "@/hooks/useWallet.helpers";
import { setEvmChainResolver } from "./providers/eip155";

export function bindRouteSafetyChains(blockchains: readonly TBlockchain[]) {
  setEvmChainResolver((chainId) => {
    const wanted = Number(chainId);
    if (!Number.isInteger(wanted)) return null;
    const row = blockchains.find((b) => b.chainId === wanted);
    return row ? buildChainConfigFromBlockchain(row) : null;
  });
}
