/**
 * Arc App Kit — execution side, on the device.
 *
 * Spec: docs/bridge-capability-spec.md §5.4, §7.5.1, §7.7.
 *
 * THE ONLY FILE IN THE APP THAT IMPORTS `@circle-fin/app-kit`. The two
 * Circle bridge adapters call `runAppKitBridge`; nothing else knows App
 * Kit exists, so replacing it with raw contract calls stays a change here.
 *
 * ## Why an on-device `bridge()` is safe on a 15-minute transfer
 *
 * App Kit's `bridge()` awaits the whole CCTP lifecycle in-process: approve,
 * burn, then a plain poll of Circle's Iris API for the attestation (up to
 * 600 tries, 2 s or 30 s apart), then the mint. On a Standard transfer
 * that promise can stay open for ~15-19 minutes, which does not survive
 * the app backgrounding.
 *
 * It does not have to. Every payload this runs sets `useForwarder: true`,
 * so Circle's Forwarding Service submits the destination mint: after the
 * burn there is NOTHING left for this device to sign. So this resolves at
 * the point of no return, the moment App Kit reports the burn (`burn`
 * for CCTP, `transfer` for CCTPx) succeeded on-chain, and hands the hash
 * to `bridge_status`, which polls Iris from the backend. The rest of the
 * in-process promise finishes if the app stays alive and is harmless if
 * it does not: it only reads Iris.
 *
 * Verified against App Kit 1.15.3's shipped source (`createStepExecutors`,
 * `bridgeRelayerMint`, `dispatchStepEvent`) and a testnet run
 * (Arc Testnet → Base Sepolia, 2026-09-26): the `burn` event fired at
 * +6.8 s, the forwarded mint landed at +31.7 s with no further signing.
 */

import {
  resolveChainIdentifier,
  ViemAdapter,
} from "@circle-fin/adapter-viem-v2";
import { bridge } from "@circle-fin/app-kit/bridge";
import { createContext } from "@circle-fin/app-kit/context";
import type { Account, Chain, PublicClient, WalletClient } from "viem";
import type { CircleChainFacts, TCircleBridgePayload } from "./verifyPayload";

/** What App Kit's Viem adapter needs from the device's EVM wallet. */
export interface AppKitEvmSigner {
  account: Account;
  publicClientFor(chain: Chain): PublicClient;
  walletClientFor(chain: Chain): WalletClient;
}

export class AppKitBridgeError extends Error {
  readonly name = "AppKitBridgeError";
  readonly code: "insufficient_funds" | "submission_failed";
  constructor(code: AppKitBridgeError["code"]) {
    super(code);
    this.code = code;
  }
}

/**
 * App Kit's own chain definition for an identifier (`"Base"`, `"Arc"`),
 * or `null`. Used by `verifyCirclePayload` so the backend's chain names
 * are checked against Circle's registry on the device.
 */
export function resolveCircleChain(
  identifier: string,
): CircleChainFacts | null {
  try {
    const def = resolveChainIdentifier(identifier as never) as unknown as {
      type: string;
      chainId?: number;
      isTestnet: boolean;
      usdcAddress?: string | null;
      eurcAddress?: string | null;
    };
    return {
      type: def.type,
      chainId: def.chainId,
      isTestnet: def.isTestnet,
      usdcAddress: def.usdcAddress ?? null,
      eurcAddress: def.eurcAddress ?? null,
    };
  } catch {
    return null;
  }
}

type StepEvent = { values?: { state?: string; txHash?: string } };
type BridgeOutcome = {
  state?: string;
  steps?: {
    name?: string;
    state?: string;
    txHash?: string;
    errorCategory?: string;
    errorMessage?: string;
    error?: unknown;
  }[];
};

/**
 * App Kit reports balance failures as a `KitError` named
 * `BALANCE_INSUFFICIENT_TOKEN` / `BALANCE_INSUFFICIENT_GAS`, thrown or
 * carried on the failed step. Everything else is a curated generic.
 */
function classify(error: unknown): AppKitBridgeError["code"] {
  if (!error) return "submission_failed";
  const name = (error as { name?: unknown } | null)?.name;
  const msg = (error as { message?: unknown } | null)?.message;
  const shortMsg = (error as { shortMessage?: unknown } | null)?.shortMessage;
  const details = (error as { details?: unknown } | null)?.details;
  const str =
    `${typeof name === "string" ? name : ""} ${typeof msg === "string" ? msg : ""} ${typeof shortMsg === "string" ? shortMsg : ""} ${typeof details === "string" ? details : ""}`.toLowerCase();
  if (
    (typeof name === "string" && name.startsWith("BALANCE_")) ||
    str.includes("insufficient") ||
    str.includes("exceeds balance") ||
    str.includes("gas required exceeds allowance") ||
    (error as { code?: unknown })?.code === "INSUFFICIENT_FUNDS"
  ) {
    return "insufficient_funds";
  }
  return "submission_failed";
}

/**
 * Run App Kit's `bridge()` for a verified payload and resolve with the
 * source-chain hash of the hand-off step.
 *
 * Rejects only while NOTHING irreversible has happened: if `bridge()`
 * ends before the hand-off step succeeds, the burn never landed and no
 * funds moved. Once the hand-off fires, later failures are the backend
 * status poll's to report, never a rejection here (a retry after a burn
 * would be a second burn).
 */
export function runAppKitBridge(args: {
  payload: TCircleBridgePayload;
  signer: AppKitEvmSigner;
  /** App Kit step name that marks the point of no return. */
  handoffStep: "burn" | "transfer";
}): Promise<string> {
  const { payload, signer, handoffStep } = args;

  const source = resolveChainIdentifier(payload.sourceChain as never);
  const adapter = new ViemAdapter(
    {
      getPublicClient: ({ chain }: { chain: Chain }) =>
        signer.publicClientFor(chain),
      getWalletClient: ({ chain }: { chain: Chain }) =>
        signer.walletClientFor(chain),
    },
    // `user-controlled`: the address is the wallet's own, never passed in.
    { addressContext: "user-controlled", supportedChains: [source] } as never,
  );
  // React Native / Expo polyfills `window` on `globalThis`, which causes ViemAdapter's
  // `switchToChain` to think it is running in a browser with MetaMask. That leads it to call
  // `walletClient.switchChain({ id })`, which sends `wallet_switchEthereumChain` to our
  // node RPC (Alchemy / rpc-proxy) that does not support wallet methods (-32600).
  // Overriding `switchToChain` initializes the wallet client for the chain without the
  // browser-only `switchChain` call.
  (
    adapter as unknown as { switchToChain: (c: unknown) => Promise<void> }
  ).switchToChain = async (targetChain: unknown) => {
    await (
      adapter as unknown as {
        initializeWalletClient: (c: unknown) => Promise<unknown>;
      }
    ).initializeWalletClient(targetChain);
  };

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const onHandoff = (event: StepEvent) => {
      const v = event?.values;
      if (v?.state === "success" && typeof v.txHash === "string" && v.txHash) {
        const hash = v.txHash;
        if (typeof __DEV__ !== "undefined" && __DEV__) {
          console.log("[appKitBridge] onHandoff fired successfully:", {
            handoffStep,
            txHash: hash,
          });
        }
        settle(() => resolve(hash));
      }
    };

    // Error telemetry off: a report can carry wallet addresses, and the
    // app's own logging already covers failures.
    const context = createContext({
      disableErrorReporting: true,
      actions: { bridge: { [`bridge.${handoffStep}`]: [onHandoff] } },
    } as never);

    const params = {
      from: { adapter, chain: payload.sourceChain },
      to: {
        recipientAddress: payload.recipientAddress,
        chain: payload.destinationChain,
        useForwarder: true,
      },
      amount: payload.amount,
      token: payload.token,
      config: {
        transferSpeed: payload.transferSpeed,
        ...(payload.maxFee !== undefined ? { maxFee: payload.maxFee } : {}),
      },
      // Opaque provider-signed quote (CCTPx): "the fee you were quoted is
      // the fee you pay". Never decoded, never logged.
      ...(payload.quote !== undefined ? { quote: payload.quote } : {}),
    };

    if (typeof __DEV__ !== "undefined" && __DEV__) {
      console.log("[appKitBridge] starting bridge() execution with params:", {
        sourceChain: payload.sourceChain,
        destinationChain: payload.destinationChain,
        amount: payload.amount,
        token: payload.token,
        recipientAddress: payload.recipientAddress,
        handoffStep,
      });
    }

    (bridge(context as never, params as never) as Promise<BridgeOutcome>)
      .then((result) => {
        if (settled) return;
        // The event can in principle be missed; the result is the record.
        const step = result.steps?.find(
          (s) => s.name === handoffStep && s.state === "success" && s.txHash,
        );
        if (step?.txHash) {
          const hash = step.txHash;
          if (typeof __DEV__ !== "undefined" && __DEV__) {
            console.log("[appKitBridge] handoff step completed in result:", {
              step: handoffStep,
              txHash: hash,
            });
          }
          settle(() => resolve(hash));
          return;
        }
        const failed = result.steps?.find((s) => s.state === "error");
        if (typeof __DEV__ !== "undefined" && __DEV__) {
          console.error("[appKitBridge] ended before hand-off:", {
            state: result.state,
            failedStep: failed?.name,
            errorCategory: failed?.errorCategory,
            errorMessage: failed?.errorMessage,
            error: failed?.error,
            allSteps: result.steps?.map((s) => ({
              name: s.name,
              state: s.state,
              txHash: s.txHash,
            })),
          });
        }
        settle(() => reject(new AppKitBridgeError(classify(failed?.error))));
      })
      .catch((error: unknown) => {
        if (typeof __DEV__ !== "undefined" && __DEV__) {
          console.error("[appKitBridge] bridge() threw error:", error);
        }
        settle(() => reject(new AppKitBridgeError(classify(error))));
      });
  });
}
