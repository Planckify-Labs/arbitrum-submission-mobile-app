/**
 * EVM chain ids of the Arbitrum Open House 2026 hackathon build: Arbitrum
 * One and Robinhood Chain (an Arbitrum Orbit L2), each with its testnet.
 *
 * Only the ids live here. RPC, explorer, native token and token rows come
 * from the backend `/blockchains` feed like every other chain (the api
 * seeds all four: `api/src/scripts/prisma/seed.ts`). These constants feed
 * the chain lockdown allowlist (`services/walletKit/chainSupport.ts`).
 */

export const ARBITRUM_ONE_CHAIN_ID = 42161;
export const ARBITRUM_SEPOLIA_CHAIN_ID = 421614;
export const ROBINHOOD_MAINNET_CHAIN_ID = 4663;
export const ROBINHOOD_TESTNET_CHAIN_ID = 46630;

export function isArbitrumStackChainId(
  chainId: number | undefined | null,
): boolean {
  return (
    chainId === ARBITRUM_ONE_CHAIN_ID ||
    chainId === ARBITRUM_SEPOLIA_CHAIN_ID ||
    chainId === ROBINHOOD_MAINNET_CHAIN_ID ||
    chainId === ROBINHOOD_TESTNET_CHAIN_ID
  );
}
