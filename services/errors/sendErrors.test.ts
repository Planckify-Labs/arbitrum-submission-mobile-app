import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifySendError, sendErrorCopy } from "./sendErrors.ts";

describe("classifySendError", () => {
  it("maps a viem insufficient-funds error (fresh wallet, no native)", () => {
    const err = Object.assign(
      new Error(
        "insufficient funds for gas * price + value: address 0xabc have 0 want 80000000000000",
      ),
      { name: "InsufficientFundsError" },
    );
    assert.equal(classifySendError(err), "insufficient_fee");
  });

  it("finds the code inside a viem cause chain", () => {
    const err = new Error("Execution reverted", {
      cause: new Error("ERC20: transfer amount exceeds balance"),
    });
    assert.equal(classifySendError(err), "insufficient_balance");
  });

  it("maps Solana / Sui / Stellar fee wording to insufficient_fee", () => {
    assert.equal(
      classifySendError(
        new Error("Transfer: insufficient lamports 0, need 5000"),
      ),
      "insufficient_fee",
    );
    assert.equal(
      classifySendError(new Error("InsufficientGas")),
      "insufficient_fee",
    );
    assert.equal(
      classifySendError(new Error("tx_insufficient_balance")),
      "insufficient_fee",
    );
  });

  it("separates a fee bid that was too low from an account that can't pay", () => {
    for (const msg of [
      "tx_insufficient_fee",
      "max fee per gas less than block base fee",
      "intrinsic gas too low",
      "out of gas",
    ]) {
      assert.equal(classifySendError(new Error(msg)), "fee_too_low", msg);
    }
  });

  it("maps an in-flight transfer clash, not a fee problem", () => {
    for (const msg of [
      "nonce too low",
      "replacement transaction underpriced",
      "already known",
      "tx_bad_seq",
    ]) {
      assert.equal(classifySendError(new Error(msg)), "pending_transfer", msg);
    }
  });

  it("maps minimum-balance failures", () => {
    for (const msg of [
      "Transaction results in an account (1) with insufficient funds for rent",
      "op_low_reserve",
    ]) {
      assert.equal(classifySendError(new Error(msg)), "below_minimum", msg);
    }
  });

  it("maps a bare revert to rejected, but names a cause when one is given", () => {
    assert.equal(
      classifySendError(new Error("execution reverted")),
      "rejected",
    );
    assert.equal(
      classifySendError(
        new Error("execution reverted: ERC20: transfer amount exceeds balance"),
      ),
      "insufficient_balance",
    );
  });

  it("maps user cancellation", () => {
    assert.equal(
      classifySendError(new Error("User rejected the request")),
      "user_cancelled",
    );
    assert.equal(
      classifySendError({ code: 4001, message: "4001" }),
      "user_cancelled",
    );
  });

  it("maps network failures", () => {
    assert.equal(
      classifySendError(new Error("Network request failed")),
      "network",
    );
    assert.equal(
      classifySendError(
        Object.assign(new Error("x"), { name: "HttpRequestError" }),
      ),
      "network",
    );
  });

  it("falls back to unknown", () => {
    assert.equal(classifySendError(null), "unknown");
    assert.equal(classifySendError(new Error("something odd")), "unknown");
  });
});

describe("sendErrorCopy", () => {
  it("never leaks crypto vocabulary", () => {
    const banned =
      /\bgas\b|\bMON\b|\btoken\b|\bchain\b|\bwallet\b|\brpc\b|\bnonce\b|0x/i;
    for (const code of [
      "insufficient_fee",
      "insufficient_balance",
      "still_processing",
      "fee_too_low",
      "pending_transfer",
      "below_minimum",
      "rejected",
      "user_cancelled",
      "network",
      "unknown",
    ] as const) {
      const { title, message } = sendErrorCopy(code, "AUSD");
      assert.doesNotMatch(`${title} ${message}`, banned, code);
    }
  });

  it("says how much the fee shortfall is when the screen knows", () => {
    const { message } = sendErrorCopy("insufficient_fee", "ETH", {
      feeNeeded: "0.0004 ETH",
      feeHave: "0.0001 ETH",
    });
    assert.match(message, /0\.0004 ETH/);
    assert.match(message, /0\.0001 ETH/);
  });

  it("tells the sender to lower the amount when only the fee headroom is missing", () => {
    const { message } = sendErrorCopy("insufficient_fee", "ETH", {
      feeNeeded: "0.0004 ETH",
      leaveRoomForFee: true,
    });
    assert.match(message, /Lower it/);
    assert.match(message, /0\.0004 ETH/);
  });

  it("names the chosen asset for a balance shortfall", () => {
    assert.match(sendErrorCopy("insufficient_balance", "AUSD").message, /AUSD/);
  });
});
