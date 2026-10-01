/**
 * Verdict on a pre-sign dry run of a route (swap spec §8.4 L4
 * `simulate-before-sign`).
 *
 * The strongest general control, because it does not need to understand
 * the calldata: whatever an opaque router does, it shows up in the
 * signer's balances. Asserted against the dry run:
 *
 *   - the input asset leaves by at most the approved amount,
 *   - native value leaves by at most what the route sends plus the kit's
 *     stated fee allowance,
 *   - no other asset the kit could see leaves at all,
 *   - on a same-chain swap, the output arrives at or above the floor.
 *
 * `unsupported` is not a verdict: the chain could not dry-run, and the
 * other layers (quote binding, the router allowlist, `toAmountMin`) stand.
 * Simulation is defence in depth, never a licence to skip the floor (§8.6).
 */

import type { BridgeSimulation } from "@/services/walletKit/types";

export type SimulationViolation =
  | "reverted"
  | "input_overspend"
  | "unexpected_outflow"
  | "output_below_floor";

export interface SimulationExpectations {
  /** The input asset (contract / mint / coin type), `null` when native. */
  fromAsset: string | null;
  amountRaw: bigint;
  /** Native value the route transaction itself carries (EVM `value`). */
  nativeValue: bigint;
  /** Same-chain swaps only: the output asset and its guaranteed floor. */
  output?: { asset: string | null; minRaw: bigint };
  /** The source chain's own address rule for comparing asset ids. */
  sameAsset: (a: string, b: string) => boolean;
}

function matches(
  asset: string | null,
  target: string | null,
  sameAsset: SimulationExpectations["sameAsset"],
): boolean {
  if (asset === null || target === null) return asset === target;
  return sameAsset(asset, target);
}

export function simulationViolation(
  sim: BridgeSimulation,
  exp: SimulationExpectations,
): SimulationViolation | null {
  if (sim.status === "unsupported") return null;
  if (sim.status === "reverted") return "reverted";

  const allowance = sim.nativeFeeAllowance;
  for (const { asset, delta } of sim.deltas) {
    if (delta >= 0n) continue;
    const spent = -delta;
    if (matches(asset, exp.fromAsset, exp.sameAsset)) {
      const cap = exp.amountRaw + (asset === null ? allowance : 0n);
      if (spent > cap) return "input_overspend";
      continue;
    }
    if (asset === null) {
      if (spent > exp.nativeValue + allowance) return "unexpected_outflow";
      continue;
    }
    if (exp.output && matches(asset, exp.output.asset, exp.sameAsset)) {
      // The output asset going DOWN is caught by the floor check below.
      continue;
    }
    return "unexpected_outflow";
  }

  if (exp.output) {
    const out = sim.deltas.find((d) =>
      matches(d.asset, exp.output?.asset ?? null, exp.sameAsset),
    );
    if (out) {
      // A native output also pays the dry run's fee from the same balance.
      const slack = exp.output.asset === null ? allowance : 0n;
      if (out.delta + slack < exp.output.minRaw) return "output_below_floor";
    }
  }
  return null;
}
