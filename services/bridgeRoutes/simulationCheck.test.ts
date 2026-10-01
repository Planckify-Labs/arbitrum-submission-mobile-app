/**
 * Verdicts on pre-sign dry runs (swap spec §8.4 L4). These are what catch
 * opaque router calldata that takes too much or pays out too little.
 */
import { describe, expect, it } from "vitest";
import type { BridgeSimulation } from "@/services/walletKit/types";
import {
  type SimulationExpectations,
  simulationViolation,
} from "./simulationCheck";

const USDC = "0xusdc";
const WETH = "0xweth";
const OTHER = "0xother";
const ok = (
  deltas: { asset: string | null; delta: bigint }[],
): BridgeSimulation => ({
  status: "ok",
  deltas,
  nativeFeeAllowance: 100n,
});
const swap: SimulationExpectations = {
  fromAsset: USDC,
  amountRaw: 1_000n,
  nativeValue: 0n,
  output: { asset: WETH, minRaw: 500n },
  sameAsset: (a, b) => a.toLowerCase() === b.toLowerCase(),
};

describe("simulationViolation", () => {
  it("passes an honest swap", () => {
    expect(
      simulationViolation(
        ok([
          { asset: USDC, delta: -1_000n },
          { asset: WETH, delta: 510n },
        ]),
        swap,
      ),
    ).toBeNull();
  });
  it("is no verdict when the chain cannot simulate", () => {
    expect(simulationViolation({ status: "unsupported" }, swap)).toBeNull();
  });
  it("refuses a route that would revert", () => {
    expect(simulationViolation({ status: "reverted" }, swap)).toBe("reverted");
  });
  it("refuses taking more input than approved", () => {
    expect(
      simulationViolation(
        ok([
          { asset: USDC, delta: -1_001n },
          { asset: WETH, delta: 510n },
        ]),
        swap,
      ),
    ).toBe("input_overspend");
  });
  it("refuses an output below the floor", () => {
    expect(
      simulationViolation(
        ok([
          { asset: USDC, delta: -1_000n },
          { asset: WETH, delta: 499n },
        ]),
        swap,
      ),
    ).toBe("output_below_floor");
  });
  it("refuses draining an unrelated token", () => {
    expect(
      simulationViolation(
        ok([
          { asset: USDC, delta: -1_000n },
          { asset: WETH, delta: 510n },
          { asset: OTHER, delta: -1n },
        ]),
        swap,
      ),
    ).toBe("unexpected_outflow");
  });
  it("allows native gas within the kit's allowance, refuses beyond it", () => {
    expect(
      simulationViolation(
        ok([
          { asset: null, delta: -100n },
          { asset: USDC, delta: -1_000n },
          { asset: WETH, delta: 510n },
        ]),
        swap,
      ),
    ).toBeNull();
    expect(
      simulationViolation(
        ok([
          { asset: null, delta: -101n },
          { asset: USDC, delta: -1_000n },
          { asset: WETH, delta: 510n },
        ]),
        swap,
      ),
    ).toBe("unexpected_outflow");
  });
  it("counts the route's own native value (a bridge messaging fee) as expected", () => {
    const bridge = { ...swap, output: undefined, nativeValue: 5_000n };
    expect(
      simulationViolation(
        ok([
          { asset: null, delta: -5_050n },
          { asset: USDC, delta: -1_000n },
        ]),
        bridge,
      ),
    ).toBeNull();
  });
  it("a native input may spend the amount plus fees", () => {
    const nativeIn = { ...swap, fromAsset: null, nativeValue: 1_000n };
    expect(
      simulationViolation(
        ok([
          { asset: null, delta: -1_090n },
          { asset: WETH, delta: 510n },
        ]),
        nativeIn,
      ),
    ).toBeNull();
    expect(
      simulationViolation(
        ok([
          { asset: null, delta: -1_200n },
          { asset: WETH, delta: 510n },
        ]),
        nativeIn,
      ),
    ).toBe("input_overspend");
  });
});
