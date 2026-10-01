/**
 * Solana bridge capability — CAIP ids, execution, destination readiness.
 *
 * Spec: docs/bridge-capability-spec.md §5.1, §5.2, §7.5.
 *
 * Docked onto `SolanaWalletKit` as optional, presence-checked methods
 * (`feedback_space_docking`).
 *
 * Solana's destination precondition is NOT gas in the EVM sense: the
 * account needs an associated token account for the incoming mint, and
 * that account needs rent. That is exactly why §10.4 reframed the problem
 * from "does the destination need an approve?" to per-namespace
 * readiness — the EVM answer does not generalise.
 */

import {
  address,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  getBase64EncodedWireTransaction,
  isSolanaError,
  type KeyPairSigner,
  partiallySignTransaction,
  type Signature,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  sendAndConfirmTransactionFactory,
} from "@solana/kit";
import {
  findAssociatedTokenPda,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import type { ChainConfig } from "@/constants/configs/chainConfig";
import {
  base64ToTransaction,
  bytesToBase58,
} from "@/services/chains/solana/codec";
import { getSolanaSignerForWallet } from "@/services/walletService";
import {
  type BridgeDestinationReadinessArgs,
  BridgePayloadUnsupportedError,
  type BridgeReadinessBlocker,
  type BridgeSimulation,
  type SimulateBridgeExecutionArgs,
  type SubmitBridgeExecutionArgs,
} from "../types";

const SOLANA_NAMESPACE = "solana" as const;

/**
 * CAIP-2 references for Solana are the first 32 chars of the cluster's
 * genesis hash, per the CAIP-30 Solana namespace definition.
 */
const CLUSTER_CAIP2_REFERENCE: Record<string, string> = {
  "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
};

/** SLIP-44 coin type for SOL. */
const SLIP44_SOL = "501";

export function solanaCaip2For(chain: ChainConfig): string | null {
  if (chain.namespace !== SOLANA_NAMESPACE) return null;
  const reference = CLUSTER_CAIP2_REFERENCE[chain.cluster];
  return reference ? `${SOLANA_NAMESPACE}:${reference}` : null;
}

export function solanaToAssetCaip19(
  chain: ChainConfig,
  contractAddress?: string | null,
): string | null {
  const caip2 = solanaCaip2For(chain);
  if (!caip2) return null;
  if (!contractAddress) return `${caip2}/slip44:${SLIP44_SOL}`;
  // Base58 mints are CASE-SENSITIVE — never fold them
  // (`feedback_address_case_per_encoding`).
  return `${caip2}/token:${contractAddress}`;
}

/**
 * Sign and submit the provider-serialised Solana transaction.
 *
 * LI.FI hands back an already-built versioned transaction, so we sign
 * over the existing message bytes rather than rebuilding instructions —
 * rewriting them would invalidate the route the quote was priced against.
 */
export async function solanaSubmitBridgeExecution({
  wallet,
  chain,
  payload,
}: SubmitBridgeExecutionArgs): Promise<string> {
  if (payload.kind !== "serialized_transaction") {
    throw new BridgePayloadUnsupportedError(payload.kind);
  }
  if (chain.namespace !== SOLANA_NAMESPACE) {
    throw new BridgePayloadUnsupportedError(payload.kind);
  }
  if (payload.encoding !== "base64") {
    throw new BridgePayloadUnsupportedError(payload.kind);
  }

  // The wallet bound to THIS intent, never a home-screen fallback
  // (`feedback_dapp_bridge_isolation`).
  const signer: KeyPairSigner | null = await getSolanaSignerForWallet(wallet);
  if (!signer) {
    throw new Error("SolanaWalletKit.submitBridgeExecution: no signer");
  }

  const tx = base64ToTransaction(payload.payload);
  const signed = await partiallySignTransaction([signer.keyPair], tx);

  const rpc = createSolanaRpc(chain.rpcUrl);
  const wire = getBase64EncodedWireTransaction(signed);

  // The signature IS the transaction id, and it is known before anything
  // is sent. Taking it first means a failure after broadcast can still be
  // reconciled against the chain instead of reported as "nothing happened".
  const signatureBytes = signed.signatures[signer.address];
  if (!signatureBytes) {
    throw new Error(
      "SolanaWalletKit.submitBridgeExecution: signature slot not filled",
    );
  }
  const signature = bytesToBase58(signatureBytes);

  try {
    if (chain.rpcSubscriptionsUrl) {
      const rpcSubscriptions = createSolanaRpcSubscriptions(
        chain.rpcSubscriptionsUrl,
      );
      const sendAndConfirm = sendAndConfirmTransactionFactory({
        rpc,
        rpcSubscriptions,
      });
      await sendAndConfirm(signed as Parameters<typeof sendAndConfirm>[0], {
        commitment: "confirmed",
      });
    } else {
      await rpc
        .sendTransaction(wire, { encoding: "base64", skipPreflight: false })
        .send();
    }
  } catch (err) {
    // Rejected in preflight: never broadcast, nothing moved.
    if (
      isSolanaError(
        err,
        SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
      )
    ) {
      throw err;
    }
    // Anything else (a confirmation timeout, a dropped subscription) may
    // have happened AFTER the transaction went out. Reporting failure then
    // invites a retry that bridges the funds twice, so ask the chain first.
    if (await signatureLanded(rpc, signature)) return signature;
    throw err;
  }

  return signature;
}

/** Fees plus rent for the token accounts a route may create: 0.05 SOL. */
const SOLANA_SIM_NATIVE_FEE_ALLOWANCE = 50_000_000n;

/**
 * Dry-run the provider's transaction (unsigned; signature verification is
 * off and the blockhash replaced, which is what `simulateTransaction`
 * supports for exactly this) and report the signer's change in SOL and in
 * each watched mint.
 *
 * Token balances are read from the owner's accounts for each mint: the
 * ones that exist now, plus the associated-token addresses under both
 * token programs, since a swap may create the receiving account.
 */
export async function solanaSimulateBridgeExecution({
  wallet,
  chain,
  payload,
  watch,
}: SimulateBridgeExecutionArgs): Promise<BridgeSimulation> {
  if (
    payload.kind !== "serialized_transaction" ||
    payload.encoding !== "base64" ||
    chain.namespace !== SOLANA_NAMESPACE
  ) {
    return { status: "unsupported" };
  }
  try {
    const rpc = createSolanaRpc(chain.rpcUrl);
    const owner = address(wallet.address);

    // Pre-state: SOL, then every candidate token account per watched mint.
    const { value: lamportsPre } = await rpc.getBalance(owner).send();
    const tracked: { asset: string; account: string; pre: bigint }[] = [];
    for (const asset of watch) {
      if (asset === null) continue;
      const mint = address(asset);
      const candidates = new Map<string, bigint>();
      const { value: existing } = await rpc
        .getTokenAccountsByOwner(owner, { mint }, { encoding: "jsonParsed" })
        .send();
      for (const acc of existing) {
        const amount = (
          acc.account.data as {
            parsed?: { info?: { tokenAmount?: { amount?: string } } };
          }
        ).parsed?.info?.tokenAmount?.amount;
        candidates.set(acc.pubkey, BigInt(amount ?? "0"));
      }
      for (const tokenProgram of [
        TOKEN_PROGRAM_ADDRESS,
        TOKEN_2022_PROGRAM_ADDRESS,
      ]) {
        const [ata] = await findAssociatedTokenPda({
          mint,
          owner,
          tokenProgram,
        });
        if (!candidates.has(ata)) candidates.set(ata, 0n);
      }
      for (const [account, pre] of candidates) {
        tracked.push({ asset, account, pre });
      }
    }

    const { value } = await rpc
      .simulateTransaction(
        payload.payload as never,
        {
          encoding: "base64",
          sigVerify: false,
          replaceRecentBlockhash: true,
          accounts: {
            encoding: "jsonParsed",
            addresses: [owner, ...tracked.map((t) => address(t.account))],
          },
        } as never,
      )
      .send();
    const result = value as {
      err: unknown;
      accounts?: ({
        lamports?: bigint | number;
        data?: { parsed?: { info?: { tokenAmount?: { amount?: string } } } };
      } | null)[];
    };
    if (result.err) return { status: "reverted" };
    const post = result.accounts ?? [];

    const deltas: { asset: string | null; delta: bigint }[] = [];
    if (watch.includes(null) && post[0]?.lamports !== undefined) {
      deltas.push({
        asset: null,
        delta: BigInt(post[0].lamports) - BigInt(lamportsPre),
      });
    }
    const byMint = new Map<string, bigint>();
    tracked.forEach((t, i) => {
      const account = post[i + 1];
      const amount = account?.data?.parsed?.info?.tokenAmount?.amount;
      const after = amount !== undefined ? BigInt(amount) : 0n;
      byMint.set(t.asset, (byMint.get(t.asset) ?? 0n) + (after - t.pre));
    });
    for (const [asset, delta] of byMint) deltas.push({ asset, delta });
    return {
      status: "ok",
      deltas,
      nativeFeeAllowance: SOLANA_SIM_NATIVE_FEE_ALLOWANCE,
    };
  } catch (err) {
    if (typeof __DEV__ !== "undefined" && __DEV__) {
      console.warn(
        "[solana/simulateBridgeExecution] dry run unavailable:",
        err,
      );
    }
    return { status: "unsupported" };
  }
}

const LANDED_POLL_ATTEMPTS = 15;
const LANDED_POLL_INTERVAL_MS = 2_000;

/**
 * Did `signature` land successfully? Polls briefly, since a transaction
 * that was sent a moment ago may not be visible yet. A landed-but-failed
 * transaction moved nothing and answers `false`.
 */
async function signatureLanded(
  rpc: ReturnType<typeof createSolanaRpc>,
  signature: string,
): Promise<boolean> {
  for (let i = 0; i < LANDED_POLL_ATTEMPTS; i++) {
    try {
      const { value } = await rpc
        .getSignatureStatuses([signature as Signature], {
          searchTransactionHistory: true,
        })
        .send();
      const status = value[0];
      if (status) return status.err === null;
    } catch {
      // Keep polling: this is a best-effort reconciliation.
    }
    await new Promise((r) => setTimeout(r, LANDED_POLL_INTERVAL_MS));
  }
  return false;
}

/**
 * Rent for a token account is ~0.00204 SOL; a little SOL on top covers the
 * fee to move the funds afterwards.
 */
const MIN_LAMPORTS = 5_000_000n; // 0.005 SOL

const SUGGESTED_TOP_UP_USD = 2;

/**
 * Solana destination readiness.
 *
 * Two distinct blockers, not one:
 *   - No associated token account for the incoming mint, and not enough
 *     SOL to create one. The transfer itself can create the ATA, but only
 *     if rent is available.
 *   - No SOL at all, so the user cannot move the funds afterwards.
 */
export async function solanaCheckBridgeDestinationReadiness({
  chain,
  address: destination,
  contractAddress,
}: BridgeDestinationReadinessArgs): Promise<BridgeReadinessBlocker[]> {
  if (chain.namespace !== SOLANA_NAMESPACE) return [];

  const rpc = createSolanaRpc(chain.rpcUrl);

  let lamports: bigint;
  try {
    const { value } = await rpc.getBalance(address(destination)).send();
    lamports = BigInt(value);
  } catch {
    // A check that cannot run must not invent a blocker — a false "no SOL"
    // on a healthy account trains users to dismiss the real one.
    return [];
  }

  const blockers: BridgeReadinessBlocker[] = [];

  if (contractAddress) {
    let hasTokenAccount = false;
    try {
      const { value: accounts } = await rpc
        .getTokenAccountsByOwner(
          address(destination),
          { mint: address(contractAddress) },
          { encoding: "jsonParsed" },
        )
        .send();
      hasTokenAccount = accounts.length > 0;
    } catch {
      // Treat an unreadable account list as "present" rather than warning
      // on incomplete information.
      hasTokenAccount = true;
    }

    if (!hasTokenAccount && lamports < MIN_LAMPORTS) {
      blockers.push({
        code: "missing_token_account",
        message:
          "This Solana account has not held this token before and has no SOL to set it up. The transfer may not arrive.",
        severity: "blocking",
        remedy: { kind: "gas_top_up", suggestedUsd: SUGGESTED_TOP_UP_USD },
      });
    }
  }

  if (lamports < MIN_LAMPORTS && blockers.length === 0) {
    blockers.push({
      code: "no_destination_gas",
      message:
        "You have no SOL on Solana. You will not be able to move these funds after they arrive.",
      severity: "warning",
      remedy: { kind: "gas_top_up", suggestedUsd: SUGGESTED_TOP_UP_USD },
    });
  }

  return blockers;
}
