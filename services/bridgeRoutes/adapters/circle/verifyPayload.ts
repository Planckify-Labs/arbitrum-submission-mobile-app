/**
 * Device-side check that a Circle App Kit payload is the quote the user
 * approved. Pure: no App Kit import, no I/O.
 *
 * Spec: docs/bridge-capability-spec.md §5.4, §7.4, §8.1.
 *
 * The backend sends PARAMETERS (chain names, amount, recipient), not
 * calldata, and App Kit builds the transactions itself against Circle's
 * pinned contracts. That already removes the "backend slips in a
 * different target" risk the calldata providers carry. What remains is
 * that the parameters could disagree with the card the user read, so
 * every one of them is checked against the approved quote, AND the chain
 * names are resolved through App Kit's own chain definitions on the
 * device, so a backend cannot relabel one chain as another.
 */

import type { TBridgeExecutionPayload, TBridgeQuote } from "@/api/types/bridge";
import type { Namespace } from "@/services/chains/types";
import { addressesEqual } from "@/services/walletKit/chainInfo";
import { parseCaip2 } from "../../caip";

export type TCircleBridgePayload = Extract<
  TBridgeExecutionPayload,
  { kind: "circle_app_kit_bridge" }
>;

/** The subset of an App Kit chain definition this check reads. */
export interface CircleChainFacts {
  type: string;
  chainId?: number;
  isTestnet: boolean;
  usdcAddress?: string | null;
  eurcAddress?: string | null;
}

export class CirclePayloadMismatchError extends Error {
  readonly name = "CirclePayloadMismatchError";
  /** Which check failed, for `__DEV__` logs only. Never user-facing. */
  readonly field: string;
  constructor(field: string) {
    super(`circle payload mismatch: ${field}`);
    this.field = field;
  }
}

/** Solana CAIP-2 references (CAIP-30 genesis-hash prefixes). */
const SOLANA_REFERENCE = {
  mainnet: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  testnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
} as const;

function caip2Of(facts: CircleChainFacts): string | null {
  if (facts.type === "evm" && typeof facts.chainId === "number") {
    return `eip155:${facts.chainId}`;
  }
  if (facts.type === "solana") {
    return `solana:${facts.isTestnet ? SOLANA_REFERENCE.testnet : SOLANA_REFERENCE.mainnet}`;
  }
  return null;
}

/** Exact decimal-string → smallest-unit integer. Rejects excess precision. */
export function decimalToRaw(value: string, decimals: number): bigint {
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new CirclePayloadMismatchError("amount_format");
  }
  const [whole, frac = ""] = trimmed.split(".");
  if (frac.length > decimals) {
    throw new CirclePayloadMismatchError("amount_precision");
  }
  return (
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(frac.padEnd(decimals, "0") || "0")
  );
}

/**
 * Throws `CirclePayloadMismatchError` unless `quote.execution` is a Circle
 * payload for `protocol` that matches the quote field for field.
 *
 * `resolveChain` is App Kit's own chain registry on the device (injected
 * so this stays pure and testable).
 */
export function verifyCirclePayload(args: {
  quote: TBridgeQuote;
  protocol: TCircleBridgePayload["protocol"];
  resolveChain: (identifier: string) => CircleChainFacts | null;
}): TCircleBridgePayload {
  const { quote, protocol, resolveChain } = args;
  const payload = quote.execution;
  if (payload.kind !== "circle_app_kit_bridge") {
    throw new CirclePayloadMismatchError("kind");
  }
  if (payload.protocol !== protocol) {
    throw new CirclePayloadMismatchError("protocol");
  }
  if (payload.transferSpeed !== "SLOW" || payload.useForwarder !== true) {
    // Forwarding is what lets the phone hand off after the burn; a payload
    // without it would need a destination signature later.
    throw new CirclePayloadMismatchError("speed_or_forwarding");
  }
  if (payload.chain !== quote.from.chain) {
    throw new CirclePayloadMismatchError("source_chain");
  }

  // Chain names resolved through App Kit's own registry, not trusted.
  const source = resolveChain(payload.sourceChain);
  const destination = resolveChain(payload.destinationChain);
  if (!source || !destination) {
    throw new CirclePayloadMismatchError("unknown_chain");
  }
  if (caip2Of(source) !== quote.from.chain) {
    throw new CirclePayloadMismatchError("source_chain_identity");
  }
  if (caip2Of(destination) !== quote.to.chain) {
    throw new CirclePayloadMismatchError("destination_chain_identity");
  }

  // The token: the quote's source token, AND the one App Kit pins for
  // this product on this chain.
  const pinned =
    payload.protocol === "cctp" ? source.usdcAddress : source.eurcAddress;
  if (
    !pinned ||
    !addressesEqual("eip155", payload.tokenAddress, pinned) ||
    !addressesEqual("eip155", payload.tokenAddress, quote.from.token.address)
  ) {
    throw new CirclePayloadMismatchError("token");
  }

  // The recipient the card showed ("Arrives at", §7.4), compared under the
  // DESTINATION namespace's own case rule.
  const destNamespace = parseCaip2(quote.to.chain)?.namespace as
    | Namespace
    | undefined;
  if (
    !destNamespace ||
    !addressesEqual(destNamespace, payload.recipientAddress, quote.to.address)
  ) {
    throw new CirclePayloadMismatchError("recipient");
  }

  // The amount that leaves the wallet.
  const amountRaw = decimalToRaw(payload.amount, quote.from.token.decimals);
  if (amountRaw !== BigInt(quote.from.amountRaw)) {
    throw new CirclePayloadMismatchError("amount");
  }

  // The floor the user read must be the floor that executes.
  if (payload.protocol === "cctp") {
    if (payload.maxFee === undefined) {
      throw new CirclePayloadMismatchError("max_fee_missing");
    }
    const maxFeeRaw = decimalToRaw(payload.maxFee, quote.from.token.decimals);
    if (amountRaw - maxFeeRaw !== BigInt(quote.toAmountMinRaw)) {
      throw new CirclePayloadMismatchError("floor");
    }
  } else {
    // CCTPx charges its fee in native gas on top: the full amount arrives.
    if (
      BigInt(quote.toAmountMinRaw) !== amountRaw ||
      payload.quote === undefined
    ) {
      throw new CirclePayloadMismatchError("floor");
    }
  }

  return payload;
}
