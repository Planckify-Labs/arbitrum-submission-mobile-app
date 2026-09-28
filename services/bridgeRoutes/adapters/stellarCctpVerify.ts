/**
 * Device-side check of a CCTP ⇄ Stellar payload against the approved quote.
 *
 * Spec: docs/bridge-capability-spec.md §5.4.1, §10.6.
 *
 * ⚠️ These routes are raw contract calls (App Kit does not reach Stellar),
 * so the backend DOES hand the device calldata. §5.4.1 is the reason this
 * file exists: a wrong `mintRecipient`, `destinationCaller` or hook on an
 * EVM → Stellar burn strands funds PERMANENTLY. So before anything is
 * signed, the phone decodes the payload itself and proves it matches the
 * card, against contract ids pinned on the device
 * (`services/walletKit/stellar/cctpContracts.ts`), not the backend's word.
 *
 * Layouts verified 2026-09-26 against Circle's "CCTP on Stellar"
 * reference, the deployed contracts' own Soroban spec, a mainnet golden
 * vector, and a testnet round trip in both directions.
 */

import { StrKey, scValToNative, xdr } from "@stellar/stellar-base";
import { decodeFunctionData } from "viem";
import type { TBridgeQuote } from "@/api/types/bridge";
import {
  STELLAR_CCTP_CONTRACTS,
  type StellarCctpNetwork,
} from "@/services/walletKit/stellar/cctpContracts";
import { parseCaip2 } from "../caip";

const STELLAR_DOMAIN = 27;

/** Circle's Forwarding Service hook, version 0, no payload. */
const FORWARDING_HOOK_V0 =
  "636374702d666f72776172640000000000000000000000000000000000000000";

const DEPOSIT_FOR_BURN_WITH_HOOK_ABI = [
  {
    type: "function",
    name: "depositForBurnWithHook",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "destinationDomain", type: "uint32" },
      { name: "mintRecipient", type: "bytes32" },
      { name: "burnToken", type: "address" },
      { name: "destinationCaller", type: "bytes32" },
      { name: "maxFee", type: "uint256" },
      { name: "minFinalityThreshold", type: "uint32" },
      { name: "hookData", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

export class StellarCctpMismatchError extends Error {
  readonly name = "StellarCctpMismatchError";
  readonly field: string;
  constructor(field: string) {
    super(`stellar cctp payload mismatch: ${field}`);
    this.field = field;
  }
}

function networkOf(caip2: string): StellarCctpNetwork | null {
  const parsed = parseCaip2(caip2);
  if (parsed?.namespace !== "stellar") return null;
  if (parsed.reference === "pubnet") return "pubnet";
  if (parsed.reference === "testnet") return "testnet";
  return null;
}

function hex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function fromHex(value: string): Uint8Array {
  const body = value.startsWith("0x") ? value.slice(2) : value;
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** The recipient strkey carried by a `CctpForwarder` hook, validated. */
function recipientFromForwarderHook(hookHex: string): string {
  const bytes = fromHex(hookHex);
  if (bytes.length < 32) throw new StellarCctpMismatchError("hook_short");
  // Zero magic: `cctp-forward` here would ask Circle's relayer to forward,
  // and Stellar has no Forwarding Service.
  if (!bytes.subarray(0, 24).every((b) => b === 0)) {
    throw new StellarCctpMismatchError("hook_magic");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(24, false) !== 0) {
    throw new StellarCctpMismatchError("hook_version");
  }
  const length = view.getUint32(28, false);
  if (bytes.length !== 32 + length) {
    throw new StellarCctpMismatchError("hook_length");
  }
  let recipient = "";
  for (const b of bytes.subarray(32)) recipient += String.fromCharCode(b);
  if (
    !StrKey.isValidEd25519PublicKey(recipient) &&
    !StrKey.isValidContract(recipient)
  ) {
    throw new StellarCctpMismatchError("hook_recipient_invalid");
  }
  return recipient;
}

/**
 * EVM → Stellar: `depositForBurnWithHook` must burn the quoted USDC
 * amount, with BOTH `mintRecipient` and `destinationCaller` equal to the
 * pinned `CctpForwarder`, and a hook that names the quote's recipient.
 */
function verifyInbound(quote: TBridgeQuote, network: StellarCctpNetwork): void {
  const ex = quote.execution;
  if (ex.kind !== "evm_transaction" || !ex.approval) {
    throw new StellarCctpMismatchError("inbound_kind");
  }
  let decoded: ReturnType<
    typeof decodeFunctionData<typeof DEPOSIT_FOR_BURN_WITH_HOOK_ABI>
  >;
  try {
    decoded = decodeFunctionData({
      abi: DEPOSIT_FOR_BURN_WITH_HOOK_ABI,
      data: ex.data as `0x${string}`,
    });
  } catch {
    throw new StellarCctpMismatchError("inbound_calldata");
  }
  const [
    amount,
    domain,
    mintRecipient,
    burnToken,
    destinationCaller,
    ,
    ,
    hookData,
  ] = decoded.args;

  const forwarder = `0x${hex(StrKey.decodeContract(STELLAR_CCTP_CONTRACTS[network].forwarder))}`;
  if (domain !== STELLAR_DOMAIN) throw new StellarCctpMismatchError("domain");
  if (mintRecipient.toLowerCase() !== forwarder) {
    throw new StellarCctpMismatchError("mint_recipient_not_forwarder");
  }
  if (destinationCaller.toLowerCase() !== forwarder) {
    throw new StellarCctpMismatchError("destination_caller_not_forwarder");
  }
  if (recipientFromForwarderHook(hookData) !== quote.to.address) {
    throw new StellarCctpMismatchError("hook_recipient");
  }
  if (amount !== BigInt(quote.from.amountRaw)) {
    throw new StellarCctpMismatchError("amount");
  }
  if (burnToken.toLowerCase() !== quote.from.token.address.toLowerCase()) {
    throw new StellarCctpMismatchError("burn_token");
  }
  if (
    ex.approval.spender.toLowerCase() !== ex.to.toLowerCase() ||
    ex.approval.token.toLowerCase() !== burnToken.toLowerCase() ||
    BigInt(ex.approval.amountRaw) !== amount
  ) {
    throw new StellarCctpMismatchError("approval");
  }
}

/**
 * Stellar → EVM: `deposit_for_burn_with_hook` must burn the quoted amount
 * to the quote's EVM recipient, with no destination caller and Circle's
 * Forwarding Service hook (so Circle mints on the EVM side). The contract
 * and the USDC token are checked by the Stellar kit against its pins.
 */
function verifyOutbound(
  quote: TBridgeQuote,
  network: StellarCctpNetwork,
): void {
  const ex = quote.execution;
  if (
    ex.kind !== "soroban_invoke" ||
    ex.contractId !== STELLAR_CCTP_CONTRACTS[network].tokenMessengerMinter ||
    ex.method !== "deposit_for_burn_with_hook" ||
    ex.argsXdrBase64.length !== 9
  ) {
    throw new StellarCctpMismatchError("outbound_kind");
  }
  const args = ex.argsXdrBase64.map((b64) =>
    scValToNative(xdr.ScVal.fromXDR(b64, "base64")),
  );
  const [caller, amount, domain, mintRecipient, , destinationCaller, , , hook] =
    args as [
      string,
      bigint,
      number,
      Uint8Array,
      string,
      Uint8Array,
      bigint,
      number,
      Uint8Array,
    ];

  if (caller !== quote.from.address)
    throw new StellarCctpMismatchError("caller");
  if (amount !== BigInt(quote.from.amountRaw)) {
    throw new StellarCctpMismatchError("amount");
  }
  if (domain === STELLAR_DOMAIN) throw new StellarCctpMismatchError("domain");
  const expectedRecipient = `000000000000000000000000${quote.to.address.slice(2).toLowerCase()}`;
  if (hex(mintRecipient) !== expectedRecipient) {
    throw new StellarCctpMismatchError("mint_recipient");
  }
  if (!destinationCaller.every((b) => b === 0)) {
    throw new StellarCctpMismatchError("destination_caller");
  }
  if (hex(hook) !== FORWARDING_HOOK_V0) {
    throw new StellarCctpMismatchError("hook");
  }
}

/** Throws `StellarCctpMismatchError` unless the payload matches the quote. */
export function verifyStellarCctpPayload(quote: TBridgeQuote): void {
  const toStellar = networkOf(quote.to.chain);
  const fromStellar = networkOf(quote.from.chain);
  if (toStellar && !fromStellar) return verifyInbound(quote, toStellar);
  if (fromStellar && !toStellar) return verifyOutbound(quote, fromStellar);
  throw new StellarCctpMismatchError("route");
}
