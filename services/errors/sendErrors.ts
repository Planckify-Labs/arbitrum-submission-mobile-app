/**
 * User-facing classification for the plain send screen (`app/send.tsx`).
 *
 * Hard rule (CLAUDE.md "User-facing errors"): the UI never renders
 * `err.message`. This maps whatever the chain adapters throw onto a small
 * closed set of codes with hand-written copy, and the copy is written for
 * someone who has never heard the words gas, token, or chain (Monad
 * Metropolis strategy doc: "judge harshly on any point of friction that
 * reveals 'this is crypto'"). The raw error goes to `__DEV__` logs only.
 *
 * Chain-agnostic on purpose: the patterns cover viem (EVM), Solana, Sui
 * and Stellar wording, so this file needs no namespace branch and the
 * send screen keeps passing `pnpm check:chains`. Pure, node-testable.
 */

export type SendErrorCode =
  | "insufficient_fee"
  | "still_processing"
  | "insufficient_balance"
  | "fee_too_low"
  | "pending_transfer"
  | "below_minimum"
  | "rejected"
  | "user_cancelled"
  | "network"
  | "unknown";

export type SendErrorCopy = { title: string; message: string };

/**
 * Figures the screen already computed (live fee estimate, balance) so the
 * fee-shortfall copy can say "you need X, you have Y" instead of a generic
 * line. Pre-formatted display strings, never raw error text.
 */
export type SendErrorDetail = {
  feeNeeded?: string;
  feeHave?: string;
  /**
   * Native send where the balance covers the amount but not amount + fee:
   * the fix is a smaller amount, not "add funds".
   */
  leaveRoomForFee?: boolean;
};

function textOf(err: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    const rec = cur as {
      name?: unknown;
      message?: unknown;
      shortMessage?: unknown;
      details?: unknown;
      cause?: unknown;
    };
    for (const v of [rec.name, rec.shortMessage, rec.message, rec.details]) {
      if (typeof v === "string") parts.push(v);
    }
    cur = rec.cause;
  }
  if (parts.length === 0 && typeof err === "string") parts.push(err);
  return parts.join(" | ");
}

export function classifySendError(err: unknown): SendErrorCode {
  const text = textOf(err);
  if (!text) return "unknown";

  if (/cancel|rejected the request|user denied|4001/i.test(text)) {
    return "user_cancelled";
  }

  // A transfer still in flight from this account: a nonce / sequence
  // clash, or a resubmission the node treats as a replacement. Checked
  // before the fee patterns because "replacement transaction underpriced"
  // contains "underpriced".
  if (
    /nonce too low|NonceTooLow|nonce has already been used|already known|replacement transaction underpriced|ReplacementUnderpriced|tx_bad_seq|SequenceNumberRace/i.test(
      text,
    )
  ) {
    return "pending_transfer";
  }

  // The fee WAS offered but the network wants more than we bid (the fee
  // market moved between pricing and submitting) or the gas limit was too
  // small. The account may well be able to afford a fresh attempt.
  // viem: FeeCapTooLow / "max fee per gas less than block base fee" /
  // IntrinsicGasTooLow / out of gas. Stellar: tx_insufficient_fee.
  if (
    /max fee per gas less than block base fee|fee cap less than block base fee|FeeCapTooLow|TipAboveFeeCap|underpriced|tx_insufficient_fee|intrinsic gas too low|IntrinsicGasTooLow|out of gas|OutOfGas/i.test(
      text,
    )
  ) {
    return "fee_too_low";
  }

  // Native balance can't cover value + fee (or fee alone when sending a
  // token). viem: InsufficientFundsError / "insufficient funds for gas *
  // price + value". Solana: "insufficient lamports". Sui: InsufficientGas.
  // Stellar: tx_insufficient_balance.
  if (
    /InsufficientFundsError|insufficient funds for gas|insufficient funds for transfer|insufficient lamports|InsufficientGas|tx_insufficient_balance|gas required exceeds allowance/i.test(
      text,
    )
  ) {
    return "insufficient_fee";
  }

  // The transfer would leave an account under the chain's minimum balance
  // (Solana rent exemption, Stellar reserve / new-account minimum).
  if (
    /insufficient funds for rent|InsufficientFundsForRent|AccountNotRentExempt|op_low_reserve|tx_below_min_balance|InsufficientCreateAmount/i.test(
      text,
    )
  ) {
    return "below_minimum";
  }

  // The asset being sent is short. ERC-20 reverts, Sui coin balance,
  // Stellar op_underfunded, SPL "insufficient funds" on a token account.
  if (
    /exceeds balance|transfer amount exceeds|InsufficientCoinBalance|op_underfunded|insufficient funds|insufficient balance|not enough/i.test(
      text,
    )
  ) {
    return "insufficient_balance";
  }

  if (
    /network request failed|fetch failed|timeout|timed out|ECONN|ENOTFOUND|HttpRequestError|TimeoutError|rate limit|429|503|502/i.test(
      text,
    )
  ) {
    return "network";
  }

  // The network took the transfer and refused it, with no reason that
  // names the cause. Some chains (Monad) report a fee shortfall this way,
  // so the screen cross-checks it against the live fee estimate.
  if (
    /execution reverted|ExecutionReverted|reverted|tx_failed|op_no_destination|Simulation failed|TransactionExpired/i.test(
      text,
    )
  ) {
    return "rejected";
  }

  return "unknown";
}

/**
 * `assetSymbol` is the asset the user chose to send (they picked it, so
 * showing it back is not jargon). Everything else stays generic.
 */
export function sendErrorCopy(
  code: SendErrorCode,
  assetSymbol?: string,
  detail?: SendErrorDetail,
): SendErrorCopy {
  switch (code) {
    case "insufficient_fee":
      if (detail?.leaveRoomForFee && detail.feeNeeded) {
        return {
          title: "Leave room for the network fee",
          message: `This amount leaves too little for the network fee (about ${detail.feeNeeded}). Lower it a little, or tap MAX, then try again. No money was sent.`,
        };
      }
      return {
        title: "Can't cover the network fee",
        message:
          detail?.feeNeeded && detail.feeHave
            ? `This transfer needs about ${detail.feeNeeded} for the network fee, but this account only has ${detail.feeHave}. Add a little more, then try again. No money was sent.`
            : "This account can't cover the small network fee for this transfer. Add a little balance to it first, then try again. No money was sent.",
      };
    case "still_processing":
      return {
        title: "Still processing",
        message:
          "This transfer is taking longer than usual and may still go through. Check Activity before trying again so you don't send it twice.",
      };
    case "fee_too_low":
      return {
        title: "Network fee changed",
        message:
          "The network got busier while we were sending, so the fee we offered wasn't enough. No money was sent. Please try again.",
      };
    case "pending_transfer":
      return {
        title: "Another transfer is processing",
        message:
          "A transfer from this account is still going through. Wait a moment for it to finish, then try again. No money was sent.",
      };
    case "below_minimum":
      return {
        title: "Amount can't be sent",
        message:
          "This transfer would leave an account below the minimum balance the network requires. Try a different amount. No money was sent.",
      };
    case "rejected":
      return {
        title: "Transfer was declined",
        message:
          "The network declined this transfer. No money was sent. Check the details and try again.",
      };
    case "insufficient_balance":
      return {
        title: "Not enough to send",
        message: assetSymbol
          ? `You don't have enough ${assetSymbol} for this amount. Lower the amount and try again.`
          : "You don't have enough for this amount. Lower the amount and try again.",
      };
    case "user_cancelled":
      return {
        title: "Transfer cancelled",
        message: "No money was sent. Try again whenever you're ready.",
      };
    case "network":
      return {
        title: "Connection problem",
        message:
          "We couldn't reach the network. Check your connection and try again.",
      };
    default:
      return {
        title: "Couldn't send",
        message:
          "Something went wrong and no money was sent. Please try again.",
      };
  }
}
