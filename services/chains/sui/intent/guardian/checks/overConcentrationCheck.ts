/**
 * Over-concentration risk check (spec §5.2).
 *
 * Flags when a single action deploys too large a share of the wallet's
 * holdings of the input asset — "after this, ~Y% of your funds sit in one
 * place." Computed from the resolved raw input amount vs the live balance
 * of that coin (no USD pricing needed), so it fires honestly on the demo's
 * "swap 90% of my SUI now". Withdrawals reduce concentration → never flag.
 *
 * The balance reader is injected for unit testing; production reads live.
 * Conservative rounding (SI-6): the share is rounded UP toward flagging.
 */

import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { createSuiGrpcJsonRpcTransport } from "@/services/chains/sui/grpcTransport";
import { formatRiskCopy } from "../copy";
import type {
  RiskCheck,
  RiskCheckArgs,
  RiskFlag,
  Severity,
} from "../riskCheck";

/** Returns the wallet's raw balance of `compiled.inputCoinType`, or null. */
export type InputBalanceReader = (
  args: RiskCheckArgs,
) => Promise<bigint | null>;

/** Share ceilings — above warn flags a heads-up; above block is un-signable. */
const WARN_CEILING_PCT = 70;
const BLOCK_CEILING_PCT = 90;

export const liveInputBalanceReader: InputBalanceReader = async (args) => {
  const { compiled, ctx, client } = args;
  if (!compiled.inputCoinType) return null;
  try {
    // Reuse the executor's shared client when present (one RPC connection per
    // preview); only construct one when called standalone.
    const rpc =
      client ??
      new SuiJsonRpcClient({
        transport: createSuiGrpcJsonRpcTransport(ctx.chain.network),
        network: ctx.chain.network,
      });
    const { totalBalance } = await rpc.getBalance({
      owner: ctx.wallet.address,
      coinType: compiled.inputCoinType,
    });
    return BigInt(totalBalance);
  } catch {
    return null;
  }
};

export function createOverConcentrationCheck(
  readBalance: InputBalanceReader = liveInputBalanceReader,
): RiskCheck {
  return {
    code: "concentration.high",
    async run(args): Promise<RiskFlag | null> {
      const { intent, compiled } = args;
      // Withdrawing money OUT of a venue lowers concentration.
      if (intent.action === "withdraw") return null;
      if (!compiled.inputCoinType || compiled.inputAmountRaw === undefined) {
        return null;
      }

      // Prefer the balance the executor already read for its affordability
      // gate (one RPC round-trip per preview instead of two). `null` = that
      // read failed (no flag); `undefined` = not provided → read live here
      // (the unit-test path that injects a reader).
      const balance =
        args.inputBalanceRaw !== undefined
          ? args.inputBalanceRaw
          : await readBalance(args);
      if (balance === null || balance <= 0n) return null;

      // Share of holdings this action consumes, rounded UP (conservative).
      // Cap at 100 for display; >100 means insufficient funds (the dry-run
      // catches that separately).
      const rawPct = (Number(compiled.inputAmountRaw) / Number(balance)) * 100;
      if (!Number.isFinite(rawPct) || rawPct < WARN_CEILING_PCT) return null;

      const shown = Math.min(100, Math.ceil(rawPct));
      const severity: Severity = rawPct >= BLOCK_CEILING_PCT ? "block" : "warn";
      const copy = formatRiskCopy({
        code: "concentration.high",
        severity,
        params: { pct: shown },
      });
      return { code: "concentration.high", severity, ...copy };
    },
  };
}
