/**
 * Device-side check of CCTP ⇄ Stellar payloads (bridge spec §5.4.1).
 *
 * The EVM → Stellar fixture carries the hook from a REAL successful
 * mainnet transfer (tx b2424716…3f53): zero magic, version 0, length 56,
 * then the recipient strkey as UTF-8.
 */

import { Address, nativeToScVal, StrKey, xdr } from "@stellar/stellar-base";
import { encodeFunctionData } from "viem";
import { describe, expect, it } from "vitest";
import type { TBridgeQuote } from "@/api/types/bridge";
import { STELLAR_CCTP_CONTRACTS } from "@/services/walletKit/stellar/cctpContracts";
import {
  type EvmCctpFactsResolver,
  StellarCctpMismatchError,
  verifyStellarCctpPayload as verifyWith,
} from "./stellarCctpVerify";

const GOLDEN_RECIPIENT =
  "GAMNA2Q6NTZSUBLMEXLTIXYORE7OXJJBMEGIX7T2OXDAKIA7CCKN4RJV";
const GOLDEN_HOOK =
  "0x000000000000000000000000000000000000000000000000000000000000003847414d4e413251364e545a5355424c4d45584c544958594f5245374f584a4a424d454749583754324f5844414b49413743434b4e34524a56";
const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const TOKEN_MESSENGER = "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d";
const EVM_ME = "0x3304E22DDaa22bCdC5fCa2269b418046aE7b566A";
/** Circle's pins, as App Kit's registry would answer them for Base. */
const PINS: EvmCctpFactsResolver = (chainId) =>
  chainId === 8453
    ? { tokenMessenger: TOKEN_MESSENGER, usdc: BASE_USDC }
    : null;
const verifyStellarCctpPayload = (q: TBridgeQuote) => verifyWith(q, PINS);
const FORWARDER_BYTES =
  `0x${Buffer.from(StrKey.decodeContract(STELLAR_CCTP_CONTRACTS.pubnet.forwarder)).toString("hex")}` as `0x${string}`;

const ABI = [
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

function inbound(
  over: {
    mintRecipient?: `0x${string}`;
    destinationCaller?: `0x${string}`;
    hook?: `0x${string}`;
    amount?: bigint;
    recipient?: string;
  } = {},
): TBridgeQuote {
  const data = encodeFunctionData({
    abi: ABI,
    functionName: "depositForBurnWithHook",
    args: [
      over.amount ?? 1_000_000n,
      27,
      over.mintRecipient ?? FORWARDER_BYTES,
      BASE_USDC,
      over.destinationCaller ?? FORWARDER_BYTES,
      0n,
      2000,
      over.hook ?? (GOLDEN_HOOK as `0x${string}`),
    ],
  });
  return {
    from: {
      chain: "eip155:8453",
      address: EVM_ME,
      amountRaw: "1000000",
      token: { address: BASE_USDC },
    },
    to: {
      chain: "stellar:pubnet",
      address: over.recipient ?? GOLDEN_RECIPIENT,
      amountRaw: "10000000",
      token: {},
    },
    execution: {
      kind: "evm_transaction",
      chain: "eip155:8453",
      to: TOKEN_MESSENGER,
      data,
      value: "0",
      approval: {
        token: BASE_USDC,
        spender: TOKEN_MESSENGER,
        amountRaw: "1000000",
      },
    },
  } as unknown as TBridgeQuote;
}

function field(fn: () => void): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(StellarCctpMismatchError);
    return (err as StellarCctpMismatchError).field;
  }
  return "none";
}

describe("verifyStellarCctpPayload — EVM → Stellar pins", () => {
  it("refuses a call to anything but Circle's TokenMessenger", () => {
    const q = inbound() as any;
    const evil = "0x000000000000000000000000000000000000bEEF";
    q.execution.to = evil;
    q.execution.approval.spender = evil;
    expect(field(() => verifyStellarCctpPayload(q))).toBe("token_messenger");
  });

  it("refuses an EVM chain Circle's registry does not know", () => {
    const q = inbound() as any;
    q.from.chain = "eip155:999999";
    expect(field(() => verifyStellarCctpPayload(q))).toBe("evm_chain_unknown");
  });

  it("refuses a burn token that is not the chain's USDC", () => {
    const other = "0x1111111111111111111111111111111111111111";
    const resolver: EvmCctpFactsResolver = () => ({
      tokenMessenger: TOKEN_MESSENGER,
      usdc: other,
    });
    expect(field(() => verifyWith(inbound(), resolver))).toBe("burn_token");
  });
});

describe("verifyStellarCctpPayload — EVM → Stellar", () => {
  it("accepts the golden mainnet layout", () => {
    expect(field(() => verifyStellarCctpPayload(inbound()))).toBe("none");
  });

  it("refuses a burn minting to the user instead of the pinned forwarder (permanent loss)", () => {
    const user =
      `0x${Buffer.from(StrKey.decodeEd25519PublicKey(GOLDEN_RECIPIENT)).toString("hex")}` as `0x${string}`;
    expect(
      field(() =>
        verifyStellarCctpPayload(
          inbound({ mintRecipient: user, destinationCaller: user }),
        ),
      ),
    ).toBe("mint_recipient_not_forwarder");
    expect(
      field(() =>
        verifyStellarCctpPayload(
          inbound({ destinationCaller: `0x${"00".repeat(32)}` }),
        ),
      ),
    ).toBe("destination_caller_not_forwarder");
  });

  it("refuses the old Forwarding-Service-magic hook", () => {
    const bad = Buffer.from(GOLDEN_HOOK.slice(2), "hex");
    bad.write("cctp-forward", 0, "ascii");
    expect(
      field(() =>
        verifyStellarCctpPayload(inbound({ hook: `0x${bad.toString("hex")}` })),
      ),
    ).toBe("hook_magic");
  });

  it("refuses a hook naming someone other than the card's recipient", () => {
    expect(
      field(() =>
        verifyStellarCctpPayload(
          inbound({
            recipient:
              "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
          }),
        ),
      ),
    ).toBe("hook_recipient");
  });

  it("refuses an amount other than the approved one", () => {
    expect(
      field(() => verifyStellarCctpPayload(inbound({ amount: 9_000_000n }))),
    ).toBe("amount");
  });
});

describe("verifyStellarCctpPayload — Stellar → EVM", () => {
  const caller = GOLDEN_RECIPIENT;
  function outbound(
    over: {
      recipient?: string;
      hook?: string;
      destinationCaller?: Uint8Array;
      amount?: bigint;
    } = {},
  ): TBridgeQuote {
    const recipientBytes = Buffer.alloc(32);
    Buffer.from((over.recipient ?? EVM_ME).slice(2), "hex").copy(
      recipientBytes,
      12,
    );
    const args = [
      new Address(caller).toScVal(),
      nativeToScVal(over.amount ?? 12_345_670n, { type: "i128" }),
      xdr.ScVal.scvU32(6),
      xdr.ScVal.scvBytes(recipientBytes),
      new Address(STELLAR_CCTP_CONTRACTS.pubnet.forwarder).toScVal(),
      xdr.ScVal.scvBytes(
        Buffer.from(over.destinationCaller ?? new Uint8Array(32)),
      ),
      nativeToScVal(545_770n, { type: "i128" }),
      xdr.ScVal.scvU32(2000),
      xdr.ScVal.scvBytes(
        Buffer.from(
          over.hook ??
            "636374702d666f72776172640000000000000000000000000000000000000000",
          "hex",
        ),
      ),
    ].map((v) => v.toXDR("base64"));
    return {
      from: {
        chain: "stellar:pubnet",
        address: caller,
        amountRaw: "12345670",
        token: {},
      },
      to: {
        chain: "eip155:8453",
        address: EVM_ME,
        amountRaw: "1179953",
        token: {},
      },
      execution: {
        kind: "soroban_invoke",
        chain: "stellar:pubnet",
        contractId: STELLAR_CCTP_CONTRACTS.pubnet.tokenMessengerMinter,
        method: "deposit_for_burn_with_hook",
        argsXdrBase64: args,
      },
    } as unknown as TBridgeQuote;
  }

  it("accepts a forwarded burn to the card's EVM recipient", () => {
    expect(field(() => verifyStellarCctpPayload(outbound()))).toBe("none");
  });

  it("refuses a different EVM recipient, amount, caller restriction or hook", () => {
    expect(
      field(() =>
        verifyStellarCctpPayload(
          outbound({ recipient: "0x000000000000000000000000000000000000dEaD" }),
        ),
      ),
    ).toBe("mint_recipient");
    expect(
      field(() => verifyStellarCctpPayload(outbound({ amount: 99_000_000n }))),
    ).toBe("amount");
    expect(
      field(() =>
        verifyStellarCctpPayload(
          outbound({ destinationCaller: new Uint8Array(32).fill(1) }),
        ),
      ),
    ).toBe("destination_caller");
    expect(
      field(() =>
        verifyStellarCctpPayload(outbound({ hook: "00".repeat(32) })),
      ),
    ).toBe("hook");
  });

  it("refuses a Soroban call to anything but the pinned TokenMessengerMinter", () => {
    const q = outbound();
    (q.execution as { contractId: string }).contractId =
      STELLAR_CCTP_CONTRACTS.pubnet.forwarder;
    expect(field(() => verifyStellarCctpPayload(q))).toBe("outbound_kind");
  });
});
