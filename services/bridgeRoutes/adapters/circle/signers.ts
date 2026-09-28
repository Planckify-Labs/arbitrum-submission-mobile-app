/**
 * Per-namespace signers for App Kit, as a registry rather than a branch.
 *
 * Spec: docs/bridge-capability-spec.md §5.2, §5.4.
 *
 * App Kit ships one adapter per wallet family (Viem for EVM, a Solana
 * adapter for Solana). The Circle bridge adapters look the signer up by
 * the SOURCE chain's namespace, so docking App Kit's Solana adapter later
 * is one `registerAppKitSigner("solana", …)` call, not an edit here or in
 * the adapters. A namespace with no registered signer simply cannot be a
 * Circle source yet (`wallet_cannot_execute`), which the backend already
 * mirrors by refusing non-EVM sources.
 */

import { type Chain, createPublicClient, http } from "viem";
import type { ChainConfig } from "@/constants/configs/chainConfig";
import type { TWallet } from "@/constants/types/walletTypes";
import { getAccountForWallet } from "@/services/walletService";
import { getPublicClient, getWalletClient } from "@/utils/clients";
import type { AppKitEvmSigner } from "./appKitBridge";

export type AppKitSignerFactory = (
  wallet: TWallet,
  chain: ChainConfig,
) => AppKitEvmSigner | null;

const factories = new Map<string, AppKitSignerFactory>();

export function registerAppKitSigner(
  namespace: string,
  factory: AppKitSignerFactory,
): void {
  factories.set(namespace, factory);
}

/**
 * The signer for `wallet` on `chain` — the wallet bound to THIS intent,
 * never a home-screen `activeWallet` fallback
 * (`feedback_dapp_bridge_isolation`).
 */
export function appKitSignerFor(
  wallet: TWallet,
  chain: ChainConfig,
): AppKitEvmSigner | null {
  return factories.get(chain.namespace)?.(wallet, chain) ?? null;
}

/**
 * EVM: App Kit's Viem adapter around the wallet's own viem account and
 * the app's own RPC (the authenticated rpc-proxy), not Circle's shared
 * public endpoints.
 *
 * The wallet client is issued for the SOURCE chain only. A forwarded
 * Circle route has nothing to sign anywhere else, so a request for any
 * other chain is refused outright rather than served: it could only mean
 * the flow is doing something this app never approved.
 */
export const evmAppKitSigner: AppKitSignerFactory = (wallet, chain) => {
  // Registered under `eip155` only; the guard narrows the union.
  if (chain.namespace !== "eip155") return null;
  const account = getAccountForWallet(wallet);
  if (!account) return null;
  const source = chain.chain;
  return {
    account,
    publicClientFor: (c: Chain) =>
      (c.id === source.id
        ? getPublicClient(source)
        : createPublicClient({ chain: c, transport: http() })) as never,
    walletClientFor: (c: Chain) => {
      if (c.id !== source.id) {
        throw new Error("app kit asked to sign off the source chain");
      }
      const client = getWalletClient(account, source);
      // App Kit's ViemAdapter checks `if (typeof window !== 'undefined') await walletClient.switchChain(...)`
      // In React Native / Expo, `window` is polyfilled on globalThis, so ViemAdapter mistakenly thinks
      // it is in a browser with an injected wallet (like MetaMask) and calls `walletClient.switchChain({ id })`.
      // By default, viem's switchChain sends `wallet_switchEthereumChain` RPC call over the transport.
      // Since our transport points to an RPC node proxy (Alchemy/Infura), the RPC rejects it with
      // code -32600 "Unsupported method: wallet_switchEthereumChain".
      //
      // Because this walletClient is ALREADY created for the exact source chain, we intercept
      // `switchChain` and `request({ method: 'wallet_switchEthereumChain' })` as an in-memory no-op.
      const originalRequest = client.request.bind(client);
      client.request = (async (args: {
        method: string;
        params?: unknown[];
      }) => {
        if (args.method === "wallet_switchEthereumChain") {
          return null;
        }
        return originalRequest(args as never);
      }) as typeof client.request;
      client.switchChain = (async ({ id }: { id: number }) => {
        if (id !== source.id) {
          throw new Error(
            `Cannot switch to chain ${id}, expected ${source.id}`,
          );
        }
      }) as typeof client.switchChain;
      return client as never;
    },
  };
};
