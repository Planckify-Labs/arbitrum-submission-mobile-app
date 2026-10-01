import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkNativeFeeCoverage, refineSendErrorCode } from "./feeCoverage.ts";

describe("checkNativeFeeCoverage", () => {
  it("covers a token send when the balance meets the fee ceiling", () => {
    assert.deepEqual(
      checkNativeFeeCoverage({
        nativeBalance: 100n,
        maxFeeNative: 100n,
        nativeValue: 0n,
      }),
      { covered: true },
    );
  });

  it("counts the native value being sent on top of the fee", () => {
    assert.deepEqual(
      checkNativeFeeCoverage({
        nativeBalance: 100n,
        maxFeeNative: 10n,
        nativeValue: 95n,
      }),
      { covered: false, needed: 105n, have: 100n },
    );
  });
});

describe("refineSendErrorCode", () => {
  const short = { covered: false, needed: 2n, have: 1n } as const;

  it("turns an unexplained failure into a fee shortfall when the account was short", () => {
    assert.equal(refineSendErrorCode("rejected", short), "insufficient_fee");
    assert.equal(refineSendErrorCode("unknown", short), "insufficient_fee");
  });

  it("leaves specific causes alone", () => {
    assert.equal(refineSendErrorCode("network", short), "network");
    assert.equal(refineSendErrorCode("fee_too_low", short), "fee_too_low");
  });

  it("does nothing without a known shortfall", () => {
    assert.equal(refineSendErrorCode("rejected", null), "rejected");
    assert.equal(
      refineSendErrorCode("rejected", { covered: true }),
      "rejected",
    );
  });
});
