/**
 * Can this account pay for the transfer it is about to send?
 *
 * Pure so it is node-testable and shared by the send screen's live
 * pre-flight and its post-failure explanation. The node requires the
 * sender to hold `value + maxFee` (not the expected fee), so that ceiling
 * is what is compared against, not what the screen displays.
 */

import type { SendErrorCode } from "@/services/errors/sendErrors";

export type FeeCoverage =
  | { covered: true }
  | { covered: false; needed: bigint; have: bigint };

export function checkNativeFeeCoverage(args: {
  nativeBalance: bigint;
  maxFeeNative: bigint;
  /** Native value leaving the account in the same transfer; 0n for a token send. */
  nativeValue: bigint;
}): FeeCoverage {
  const needed = args.nativeValue + args.maxFeeNative;
  if (args.nativeBalance >= needed) return { covered: true };
  return { covered: false, needed, have: args.nativeBalance };
}

/**
 * Some nodes report a fee shortfall as a bare revert or an unnamed error
 * (Monad: "execution reverted"). When the live estimate already showed the
 * account couldn't cover the fee, that is the real cause; say so.
 */
export function refineSendErrorCode(
  code: SendErrorCode,
  coverage: FeeCoverage | null,
): SendErrorCode {
  if (
    coverage &&
    !coverage.covered &&
    (code === "rejected" || code === "unknown")
  ) {
    return "insufficient_fee";
  }
  return code;
}
