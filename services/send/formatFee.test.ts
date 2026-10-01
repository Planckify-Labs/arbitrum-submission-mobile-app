import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decimalsFromOneUnit, formatFeeAmount } from "./formatFee.ts";

describe("formatFeeAmount", () => {
  it("keeps two significant digits for sub-unit fees", () => {
    assert.equal(formatFeeAmount(21_000_000_000_000n, 18), "0.000021");
    assert.equal(formatFeeAmount(5_000n, 9), "0.000005");
    assert.equal(formatFeeAmount(123_456n, 9), "0.00012");
  });

  it("trims trailing zeros", () => {
    assert.equal(formatFeeAmount(100n, 7), "0.00001");
    assert.equal(formatFeeAmount(10_000_000n, 7), "1");
  });

  it("shows larger fees with up to four decimals", () => {
    assert.equal(formatFeeAmount(1_234_567_000_000_000_000n, 18), "1.2345");
  });

  it("handles zero and dust", () => {
    assert.equal(formatFeeAmount(0n, 18), "0");
    assert.equal(formatFeeAmount(1n, 18), "<0.00000001");
  });
});

describe("decimalsFromOneUnit", () => {
  it("reads decimals from 10^d", () => {
    assert.equal(decimalsFromOneUnit(10n ** 18n), 18);
    assert.equal(decimalsFromOneUnit(10_000_000n), 7);
  });
});
