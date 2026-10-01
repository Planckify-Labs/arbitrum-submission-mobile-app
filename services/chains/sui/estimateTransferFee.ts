/**
 * Pre-send fee estimate for a Sui transfer, via a dry run of the exact PTB
 * the send path builds (`transferService.ts` / `coinTransferService.ts`).
 *
 * Sui charges `computationCost + storageCost - storageRebate`; only a dry
 * run knows the storage terms, so there is no honest closed-form guess
 * (the 0.05 SUI reserve in `estimateMaxTransferable` is a ceiling, not a
 * price). Throws when the dry run can't be produced, so the caller shows
 * "estimate unavailable" instead of a made-up number.
 */

import type { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";

export type SuiFeeClient = SuiJsonRpcClient;

/** Sui coin types are `0x..::module::NAME`; the SUI coin is the gas coin. */
function asBigInt(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(v);
  if (typeof v === "string" && /^-?\d+$/.test(v)) return BigInt(v);
  return 0n;
}

export async function estimateSuiTransferFeeMist(args: {
  client: SuiFeeClient;
  from: string;
  to: string;
  /** Amount in the sent asset's smallest unit. */
  amount: bigint;
  /** Coin type of the non-native asset; omitted for SUI. */
  coinType?: string;
}): Promise<bigint> {
  const { client, from, to, coinType } = args;
  const tx = new Transaction();
  tx.setSender(from);

  if (coinType) {
    const { data: coins } = await client.getCoins({ owner: from, coinType });
    if (!coins || coins.length === 0) {
      throw new Error("no coin objects to price against");
    }
    const total = coins.reduce((sum, c) => sum + BigInt(c.balance), 0n);
    // A dry run can't split more than the sender holds; the fee doesn't
    // depend on the amount, so clamp rather than fail.
    const amount = args.amount > 0n && args.amount <= total ? args.amount : 1n;
    const [primary, ...rest] = coins.map((c) => tx.object(c.coinObjectId));
    if (rest.length > 0) tx.mergeCoins(primary, rest);
    const [out] = tx.splitCoins(primary, [tx.pure.u64(amount)]);
    tx.transferObjects([out], tx.pure.address(to));
  } else {
    const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(1n)]);
    tx.transferObjects([coin], tx.pure.address(to));
  }

  const bytes = await tx.build({ client });
  const res = await client.dryRunTransactionBlock({
    transactionBlock: bytes,
  });
  const effects = res.effects as unknown as {
    status?: { status?: string };
    gasUsed?: Record<string, unknown>;
  };
  if (effects.status?.status !== "success" || !effects.gasUsed) {
    throw new Error("dry run did not succeed");
  }
  const g = effects.gasUsed;
  const net =
    asBigInt(g.computationCost) +
    asBigInt(g.storageCost) -
    asBigInt(g.storageRebate);
  // Rebates can exceed storage for a mutate-only tx; the sender still pays
  // computation, so never report below it.
  const floor = asBigInt(g.computationCost);
  return net > floor ? net : floor;
}
