/**
 * EVM bridge capability — CAIP ids, execution, destination readiness.
 *
 * Spec: docs/bridge-capability-spec.md §5.1, §5.2, §7.5.
 *
 * Docked onto `EvmWalletKit` as optional, presence-checked methods
 * (`feedback_space_docking`). Everything EVM-specific about bridging
 * lives here — most importantly the ERC-20 allowance, which is the ONLY
 * namespace that has the concept and therefore the reason "does the
 * destination need an approve?" was the wrong framing (§10.4).
 */

import { encodeFunctionData, erc20Abi, keccak256, zeroAddress } from "viem";
import { simulateBlocks } from "viem/actions";
import type { ChainConfig } from "@/constants/configs/chainConfig";
import { getMevTransportForChain } from "@/services/swap/mevProtection";
import { getAccountForWallet } from "@/services/walletService";
import { getPublicClient, getWalletClient } from "@/utils/clients";
import {
  type BridgeDestinationReadinessArgs,
  BridgePayloadUnsupportedError,
  type BridgeReadinessBlocker,
  type BridgeSimulation,
  type SimulateBridgeExecutionArgs,
  type SubmitBridgeExecutionArgs,
} from "../types";

const EVM_NAMESPACE = "eip155" as const;

/** SLIP-44 coin type for ETH — the CAIP-19 canonical native form. */
const SLIP44_ETH = "60";

export function evmCaip2For(chain: ChainConfig): string | null {
  return chain.namespace === EVM_NAMESPACE
    ? `${EVM_NAMESPACE}:${chain.chain.id}`
    : null;
}

export function evmToAssetCaip19(
  chain: ChainConfig,
  contractAddress?: string | null,
): string | null {
  const caip2 = evmCaip2For(chain);
  if (!caip2) return null;
  if (!contractAddress) return `${caip2}/slip44:${SLIP44_ETH}`;
  // EVM hex addresses fold case, so lowercasing here is safe. It would
  // NOT be for a Solana mint or a Stellar strkey
  // (`feedback_address_case_per_encoding`).
  return `${caip2}/erc20:${contractAddress.toLowerCase()}`;
}

/**
 * Sign and submit the provider-built EVM bridge transaction.
 *
 * Ensures the ERC-20 allowance first when the payload carries one. That
 * approval is a REAL step the user sees in the route breakdown (§7.3) and
 * is presence-checked rather than assumed: native-token sources carry no
 * `approval` and skip it entirely.
 */
export async function evmSubmitBridgeExecution({
  wallet,
  chain,
  payload,
}: SubmitBridgeExecutionArgs): Promise<string> {
  if (payload.kind !== "evm_transaction") {
    throw new BridgePayloadUnsupportedError(payload.kind);
  }
  if (chain.namespace !== EVM_NAMESPACE) {
    throw new BridgePayloadUnsupportedError(payload.kind);
  }

  // The wallet bound to THIS intent, never a home-screen fallback
  // (`feedback_dapp_bridge_isolation`).
  const account = getAccountForWallet(wallet);
  if (!account) {
    throw new Error("EvmWalletKit.submitBridgeExecution: no signer");
  }

  const publicClient = getPublicClient(chain.chain);
  // The approval goes over the normal RPC: it is not sandwichable, and a
  // private relay only adds inclusion delay to a step the user waits on.
  // The route transaction itself uses the relay when protection is on.
  const walletClient = getWalletClient(account, chain.chain);
  const mevTransport = getMevTransportForChain(chain.chain.id);
  const routeClient = mevTransport
    ? getWalletClient(account, chain.chain, mevTransport)
    : walletClient;

  if (payload.approval) {
    const token = payload.approval.token as `0x${string}`;
    const spender = payload.approval.spender as `0x${string}`;
    const required = BigInt(payload.approval.amountRaw);

    const allowance = await publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [account.address, spender],
    });

    if (allowance < required) {
      const approveHash = await walletClient.writeContract({
        address: token,
        abi: erc20Abi,
        functionName: "approve",
        args: [spender, required],
        account,
        chain: chain.chain,
      });
      // Bounded: an approval that never confirms must fail this call (the
      // route transaction has not been sent, so nothing moved) rather than
      // hang the agent turn forever.
      await publicClient.waitForTransactionReceipt({
        hash: approveHash,
        timeout: APPROVAL_RECEIPT_TIMEOUT_MS,
      });
    }
  }

  // Sign locally first so the hash is known BEFORE broadcast. If the send
  // call errors after the node accepted the transaction (a response
  // timeout, a dropped connection), reporting failure would invite a retry
  // that moves the funds twice, so the chain is asked first.
  const request = await routeClient.prepareTransactionRequest({
    to: payload.to as `0x${string}`,
    data: payload.data as `0x${string}`,
    value: BigInt(payload.value || "0"),
    account,
    chain: chain.chain,
    ...(payload.gasLimit ? { gas: BigInt(payload.gasLimit) } : {}),
  });
  const serializedTransaction = await routeClient.signTransaction(
    request as Parameters<typeof routeClient.signTransaction>[0],
  );
  const hash = keccak256(serializedTransaction);
  try {
    return await routeClient.sendRawTransaction({ serializedTransaction });
  } catch (err) {
    const lookups = [publicClient, routeClient].map(
      (client) => () =>
        (client.request as (args: unknown) => Promise<unknown>)({
          method: "eth_getTransactionByHash",
          params: [hash],
        }),
    );
    if (await transactionSeen(lookups)) return hash;
    throw err;
  }
}

const APPROVAL_RECEIPT_TIMEOUT_MS = 180_000;

/**
 * `eth_simulateV1` without validation charges no gas, but a node may still
 * account for it; 0.01 native units covers that without admitting a drain.
 */
const EVM_SIM_NATIVE_FEE_ALLOWANCE = 10n ** 16n;

const MULTICALL3_ETH_BALANCE_ABI = [
  {
    type: "function",
    name: "getEthBalance",
    stateMutability: "view",
    inputs: [{ name: "addr", type: "address" }],
    outputs: [{ name: "balance", type: "uint256" }],
  },
] as const;

/**
 * Dry-run the route exactly as `evmSubmitBridgeExecution` would send it
 * (the approval first, only when the allowance is short), bracketed by
 * balance reads, in ONE `eth_simulateV1` request so the approval's effect is
 * visible to the route call. Balances are read before and after, for the
 * watched assets only; native balance needs Multicall3 and is skipped on a
 * chain without it.
 *
 * `unsupported` covers an RPC without `eth_simulateV1` and any transport
 * error: this is defence in depth, not the only protection (§8.6).
 */
export async function evmSimulateBridgeExecution({
  wallet,
  chain,
  payload,
  watch,
}: SimulateBridgeExecutionArgs): Promise<BridgeSimulation> {
  if (payload.kind !== "evm_transaction" || chain.namespace !== EVM_NAMESPACE) {
    return { status: "unsupported" };
  }
  const account = getAccountForWallet(wallet);
  if (!account) return { status: "unsupported" };
  const client = getPublicClient(chain.chain);
  const multicall = chain.chain.contracts?.multicall3?.address;

  type BalanceRead = { asset: string | null; call: Record<string, unknown> };
  const reads: BalanceRead[] = watch.flatMap((asset): BalanceRead[] => {
    if (asset === null) {
      return multicall
        ? [
            {
              asset,
              call: {
                to: multicall,
                abi: MULTICALL3_ETH_BALANCE_ABI,
                functionName: "getEthBalance",
                args: [account.address],
                from: zeroAddress,
              },
            },
          ]
        : [];
    }
    return [
      {
        asset,
        call: {
          to: asset as `0x${string}`,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [account.address],
          from: zeroAddress,
        },
      },
    ];
  });

  const routeCalls: {
    from: `0x${string}`;
    to: `0x${string}`;
    data: `0x${string}`;
    value?: bigint;
  }[] = [];
  try {
    if (payload.approval) {
      const required = BigInt(payload.approval.amountRaw);
      const allowance = await client.readContract({
        address: payload.approval.token as `0x${string}`,
        abi: erc20Abi,
        functionName: "allowance",
        args: [account.address, payload.approval.spender as `0x${string}`],
      });
      if (allowance < required) {
        routeCalls.push({
          from: account.address,
          to: payload.approval.token as `0x${string}`,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: "approve",
            args: [payload.approval.spender as `0x${string}`, required],
          }),
        });
      }
    }
  } catch {
    return { status: "unsupported" };
  }
  const approvalPending = routeCalls.length > 0;
  const routeCall = {
    from: account.address,
    to: payload.to as `0x${string}`,
    data: payload.data as `0x${string}`,
    value: BigInt(payload.value || "0"),
  };
  routeCalls.push(routeCall);

  try {
    const readCalls = reads.map((r) => r.call);
    const blocks = await simulateBlocks(client, {
      blocks: [
        ...(readCalls.length ? [{ calls: readCalls }] : []),
        { calls: routeCalls },
        ...(readCalls.length ? [{ calls: readCalls }] : []),
      ],
    } as never);

    const routeBlock = readCalls.length ? blocks[1] : blocks[0];
    if (routeBlock.calls.some((c) => c.status !== "success")) {
      return { status: "reverted" };
    }
    if (!readCalls.length)
      return {
        status: "ok",
        deltas: [],
        nativeFeeAllowance: EVM_SIM_NATIVE_FEE_ALLOWANCE,
      };

    const deltas: { asset: string | null; delta: bigint }[] = [];
    reads.forEach((r, i) => {
      const pre = blocks[0].calls[i];
      const post = blocks[2].calls[i];
      if (
        pre?.status === "success" &&
        post?.status === "success" &&
        typeof pre.result === "bigint" &&
        typeof post.result === "bigint"
      ) {
        deltas.push({ asset: r.asset, delta: post.result - pre.result });
      }
    });
    return {
      status: "ok",
      deltas,
      nativeFeeAllowance: EVM_SIM_NATIVE_FEE_ALLOWANCE,
    };
  } catch (err) {
    if (typeof __DEV__ !== "undefined" && __DEV__) {
      console.warn(
        "[evm/simulateBridgeExecution] eth_simulateV1 unavailable, falling back:",
        err,
      );
    }
  }

  // No `eth_simulateV1` on this RPC (Arc's public endpoint answers -32601,
  // live-checked 2026-09-30). A plain `eth_call` still proves the route
  // does not revert, but only when no approval is pending: `eth_call`
  // cannot apply the approve first, so the route would revert on the
  // allowance every time. No balance deltas either way.
  if (approvalPending) return { status: "unsupported" };
  try {
    await client.call({
      account: routeCall.from,
      to: routeCall.to,
      data: routeCall.data,
      value: routeCall.value,
    });
    return {
      status: "ok",
      deltas: [],
      nativeFeeAllowance: EVM_SIM_NATIVE_FEE_ALLOWANCE,
    };
  } catch (err) {
    return isExecutionRevert(err)
      ? { status: "reverted" }
      : { status: "unsupported" };
  }
}

/** A node's "this call reverts" answer, as opposed to a transport failure. */
function isExecutionRevert(err: unknown): boolean {
  const e = err as {
    shortMessage?: unknown;
    details?: unknown;
    message?: unknown;
  } | null;
  const text = [e?.shortMessage, e?.details, e?.message]
    .filter((v): v is string => typeof v === "string")
    .join(" ");
  return /execution reverted|reverted/i.test(text);
}

/**
 * Is `hash` known to any of these clients? A private relay holds a
 * transaction the public mempool never sees, so the relay is asked too.
 */
async function transactionSeen(
  lookups: readonly (() => Promise<unknown>)[],
): Promise<boolean> {
  for (const lookup of lookups) {
    try {
      if (await lookup()) return true;
    } catch {
      // Best effort: try the next client.
    }
  }
  return false;
}

/**
 * Gas headroom below which the user cannot realistically move funds after
 * they arrive. Deliberately generous: the failure mode we are guarding is
 * "bridged a full balance and is now stranded", so a false warning costs
 * one extra tap while a missed one costs the whole position.
 */
const MIN_GAS_WEI = 200_000_000_000_000n; // 0.0002 ETH

/** Suggested top-up, in USD. Small on purpose (§7.5 copy: "Add $2 of ETH"). */
const SUGGESTED_TOP_UP_USD = 2;

/**
 * Chains whose gas token is ALSO an ERC-20 at a fixed system address, so
 * receiving that ERC-20 IS receiving gas. Arc: USDC is the native currency
 * and `0x3600…0000` is its ERC-20 interface on mainnet and testnet (the same
 * address App Kit pins as Arc's `usdcAddress`). A protocol identity constant
 * (swap spec §4.8 category 2), not a support list.
 *
 * Deliberately NOT "is this Arc": bridging EURC to an Arc wallet holding no
 * USDC strands the EURC exactly like any other chain without gas, and the
 * old chain-level check (which also matched any chain whose name starts
 * with "arc") hid that warning.
 */
const GAS_TOKEN_ERC20: Readonly<Record<number, string>> = {
  5042: "0x3600000000000000000000000000000000000000",
  5042002: "0x3600000000000000000000000000000000000000",
};

/** Does receiving `contractAddress` on `chain` deliver its gas token? */
export function deliversGasToken(
  chain: ChainConfig,
  contractAddress: string | null | undefined,
): boolean {
  if (chain.namespace !== EVM_NAMESPACE) return false;
  if (!contractAddress) return true; // the native asset itself
  const gasErc20 = GAS_TOKEN_ERC20[chain.chain.id];
  return !!gasErc20 && gasErc20.toLowerCase() === contractAddress.toLowerCase();
}

/**
 * EVM destination readiness: the precondition is NATIVE GAS.
 *
 * Any valid EVM address can receive any ERC-20, so there is no
 * receive-side blocker here. The strand risk is entirely about being able
 * to MOVE the funds afterwards.
 *
 * Arc uses USDC as its native currency / gas token (§10.1). Bridging USDC
 * to Arc delivers gas itself, so an empty Arc wallet is not at strand risk
 * for USDC. Any OTHER asset (EURC) still needs gas and still warns.
 */
export async function evmCheckBridgeDestinationReadiness({
  chain,
  address,
  contractAddress,
}: BridgeDestinationReadinessArgs): Promise<BridgeReadinessBlocker[]> {
  if (chain.namespace !== EVM_NAMESPACE) return [];

  // An incoming asset that IS the gas token (the native asset, or Arc's
  // USDC through its ERC-20 interface) delivers gas itself: no strand risk
  // (§10.1). Anything else arriving on an empty wallet is stuck.
  if (deliversGasToken(chain, contractAddress)) {
    return [];
  }

  let balance: bigint;
  try {
    balance = await getPublicClient(chain.chain).getBalance({
      address: address as `0x${string}`,
    });
  } catch {
    // A readiness check that cannot run must not invent a blocker — an
    // unnecessary "you have no gas" warning on a healthy account trains
    // users to dismiss the one that matters.
    return [];
  }

  if (balance >= MIN_GAS_WEI) return [];

  const symbol = chain.chain.nativeCurrency.symbol;
  return [
    {
      code: "no_destination_gas",
      message: `You have no ${symbol} on ${chain.chain.name}. You will not be able to move these funds after they arrive.`,
      severity: "warning",
      remedy: { kind: "gas_top_up", suggestedUsd: SUGGESTED_TOP_UP_USD },
    },
  ];
}
