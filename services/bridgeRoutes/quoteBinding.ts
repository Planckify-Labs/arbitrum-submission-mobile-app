/**
 * The re-quoted route must be the route the user approved.
 *
 * Spec: docs/swap-capability-spec.md §8.4 (L2 quote binding, T2/T12 "two
 * trust anchors"), bridge spec §7.4, §8.1.
 *
 * `bridge_execute` / `swap_execute` re-quote at signing time, AFTER the
 * approval gate rendered the tool's arguments. Every device-side payload
 * check downstream (`verifyCirclePayload`, `verifyStellarCctpPayload`, the
 * route safety pipeline) compares calldata against the QUOTE, and the quote
 * comes from the backend. Without this check a single backend fault could
 * hand back a quote paying someone else, in another token, and every one of
 * those checks would agree with it. This is the link from what the user
 * approved to what the device verifies.
 */

import type { TBridgeQuote, TCaip2, TCaip19 } from "@/api/types/bridge";
import type { Namespace } from "@/services/chains/types";
import { addressesEqual } from "@/services/walletKit/chainInfo";
import { assetContractFromCaip19, parseCaip2, parseCaip19 } from "./caip";

/**
 * Two CAIP-19 ids name the same asset: same chain, and either both native
 * or the same contract under that chain's own case rule. Representations
 * differ legitimately (a checksummed vs lower-case EVM address, `0x2::sui::SUI`
 * vs its padded form), so a string comparison would refuse good routes.
 */
export function sameAsset(a: TCaip19, b: TCaip19): boolean {
  const pa = parseCaip19(a);
  const pb = parseCaip19(b);
  if (!pa || !pb || pa.chain !== pb.chain) return false;
  const ca = assetContractFromCaip19(a);
  const cb = assetContractFromCaip19(b);
  if (ca === null || cb === null) return ca === cb;
  return addressesEqual(pa.chainNamespace as Namespace, ca, cb);
}

export interface ApprovedRoute {
  fromChain: TCaip2;
  toChain: TCaip2;
  fromAsset: TCaip19;
  toAsset: TCaip19;
  /** The most the user agreed to send, in source atomic units. */
  amountRaw: string;
  /** The signer. */
  fromAddress: string;
  /** Where the user agreed the funds land. */
  toAddress: string;
}

/**
 * The first field on which `quote` disagrees with `approved`, or `null`
 * when it is the approved route. The field name is for `__DEV__` logs only.
 *
 * The amount may come back LOWER than requested (Stellar burns only to the
 * sixth decimal and the quote truncates, bridge spec §5.4.1): sending less
 * than the user approved is safe, sending more never is.
 */
export function quoteBindingMismatch(
  quote: TBridgeQuote,
  approved: ApprovedRoute,
): string | null {
  if (quote.from.chain !== approved.fromChain) return "from_chain";
  if (quote.to.chain !== approved.toChain) return "to_chain";
  if (!sameAsset(quote.from.token.caip19, approved.fromAsset)) {
    return "from_asset";
  }
  if (!sameAsset(quote.to.token.caip19, approved.toAsset)) return "to_asset";

  let quoted: bigint;
  let approvedAmount: bigint;
  try {
    quoted = BigInt(quote.from.amountRaw);
    approvedAmount = BigInt(approved.amountRaw);
  } catch {
    return "amount";
  }
  if (quoted <= 0n || quoted > approvedAmount) return "amount";

  const fromNs = parseCaip2(approved.fromChain)?.namespace as
    | Namespace
    | undefined;
  const toNs = parseCaip2(approved.toChain)?.namespace as Namespace | undefined;
  if (
    !fromNs ||
    !addressesEqual(fromNs, quote.from.address, approved.fromAddress)
  ) {
    return "from_address";
  }
  if (!toNs || !addressesEqual(toNs, quote.to.address, approved.toAddress)) {
    return "to_address";
  }
  return null;
}
