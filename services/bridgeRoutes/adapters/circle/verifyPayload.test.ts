/**
 * Device-side check that a Circle App Kit payload is the quote the user
 * approved (bridge spec §5.4, §8.1). Fixtures mirror what the backend's
 * `circle-cctp` / `circle-cctpx` adapters produced live on 2026-09-26.
 */

import { describe, expect, it } from "vitest";
import type { TBridgeQuote } from "@/api/types/bridge";
import {
  type CircleChainFacts,
  CirclePayloadMismatchError,
  decimalToRaw,
  verifyCirclePayload,
} from "./verifyPayload";

const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ARC_USDC = "0x3600000000000000000000000000000000000000";
const ARC_EURC = "0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1";
const BASE_EURC = "0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42";
const ME = "0x3304E22DDaa22bCdC5fCa2269b418046aE7b566A";

/** App Kit's own chain registry, as `resolveChainIdentifier` returns it. */
const REGISTRY: Record<string, CircleChainFacts> = {
  Base: {
    type: "evm",
    chainId: 8453,
    isTestnet: false,
    usdcAddress: BASE_USDC,
    eurcAddress: BASE_EURC,
  },
  Arc: {
    type: "evm",
    chainId: 5042,
    isTestnet: false,
    usdcAddress: ARC_USDC,
    eurcAddress: ARC_EURC,
  },
  Polygon: {
    type: "evm",
    chainId: 137,
    isTestnet: false,
    usdcAddress: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
  },
  Solana: {
    type: "solana",
    isTestnet: false,
    usdcAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  },
};
const resolveChain = (id: string) => REGISTRY[id] ?? null;

function usdcQuote(
  overrides: Partial<Record<string, unknown>> = {},
): TBridgeQuote {
  const token = (address: string, chain: string) => ({
    caip19: `${chain}/erc20:${address.toLowerCase()}`,
    chain,
    address,
    symbol: "USDC",
    decimals: 6,
    isNative: false,
    verification: "verified" as const,
  });
  return {
    quoteId: "q",
    provider: "circle-cctp",
    from: {
      chain: "eip155:8453",
      token: token(BASE_USDC, "eip155:8453"),
      address: ME,
      amountRaw: "5000000",
    },
    to: {
      chain: "eip155:5042",
      token: token(ARC_USDC, "eip155:5042"),
      address: ME,
      amountRaw: "4982262",
    },
    toAmountMinRaw: "4982262",
    slippageBps: 0,
    fees: [],
    receivesNativeAsset: true,
    durationSeconds: 1260,
    bridge: { key: "cctp", name: "Circle CCTP", mechanism: "burn_mint" },
    steps: [],
    execution: {
      kind: "circle_app_kit_bridge",
      chain: "eip155:8453",
      protocol: "cctp",
      sourceChain: "Base",
      destinationChain: "Arc",
      token: "USDC",
      tokenAddress: BASE_USDC,
      amount: "5",
      recipientAddress: ME,
      transferSpeed: "SLOW",
      useForwarder: true,
      maxFee: "0.017738",
      ...overrides,
    },
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  } as TBridgeQuote;
}

function expectMismatch(
  quote: TBridgeQuote,
  field: string,
  protocol: "cctp" | "cctpx" = "cctp",
) {
  try {
    verifyCirclePayload({ quote, protocol, resolveChain });
  } catch (err) {
    expect(err).toBeInstanceOf(CirclePayloadMismatchError);
    expect((err as CirclePayloadMismatchError).field).toBe(field);
    return;
  }
  throw new Error(`expected a ${field} mismatch`);
}

describe("verifyCirclePayload", () => {
  it("accepts the live Base → Arc USDC quote as signed", () => {
    const payload = verifyCirclePayload({
      quote: usdcQuote(),
      protocol: "cctp",
      resolveChain,
    });
    expect(payload.amount).toBe("5");
  });

  it("refuses the other product's payload (EURC flow handed a USDC quote)", () => {
    expectMismatch(usdcQuote(), "protocol", "cctpx");
  });

  it("refuses a payload without forwarding: the phone would have to sign a mint later", () => {
    expectMismatch(usdcQuote({ useForwarder: false }), "speed_or_forwarding");
    expectMismatch(usdcQuote({ transferSpeed: "FAST" }), "speed_or_forwarding");
  });

  it("refuses a chain name the backend relabelled", () => {
    // "Polygon" is a real Circle chain, but it is not the quote's source.
    expectMismatch(
      usdcQuote({ sourceChain: "Polygon" }),
      "source_chain_identity",
    );
    expectMismatch(
      usdcQuote({ destinationChain: "Base" }),
      "destination_chain_identity",
    );
    expectMismatch(usdcQuote({ sourceChain: "Atlantis" }), "unknown_chain");
  });

  it("refuses a token App Kit does not pin as USDC on that chain", () => {
    expectMismatch(usdcQuote({ tokenAddress: BASE_EURC }), "token");
  });

  it("refuses a recipient other than the one the card showed", () => {
    expectMismatch(
      usdcQuote({
        recipientAddress: "0x000000000000000000000000000000000000dEaD",
      }),
      "recipient",
    );
  });

  it("refuses an amount other than the approved one", () => {
    expectMismatch(usdcQuote({ amount: "50" }), "amount");
  });

  it("refuses a fee cap that would deliver less than the floor on the card", () => {
    expectMismatch(usdcQuote({ maxFee: "1" }), "floor");
    expectMismatch(usdcQuote({ maxFee: undefined }), "max_fee_missing");
  });

  it("accepts an EURC payload whose full amount arrives and carries the signed quote", () => {
    const q = usdcQuote({
      protocol: "cctpx",
      token: "EURC",
      sourceChain: "Arc",
      destinationChain: "Base",
      chain: "eip155:5042",
      tokenAddress: ARC_EURC,
      maxFee: undefined,
      quote: { signedQuote: "0x01" },
    });
    q.provider = "circle-cctpx";
    q.from = {
      ...q.from,
      chain: "eip155:5042",
      token: {
        ...q.from.token,
        address: ARC_EURC,
        chain: "eip155:5042",
        symbol: "EURC",
      },
    };
    q.to = { ...q.to, chain: "eip155:8453", amountRaw: "5000000" };
    q.toAmountMinRaw = "5000000";
    expect(
      verifyCirclePayload({ quote: q, protocol: "cctpx", resolveChain }).token,
    ).toBe("EURC");
    expectMismatch(
      { ...q, execution: { ...q.execution, quote: undefined } } as TBridgeQuote,
      "floor",
      "cctpx",
    );
  });

  it("parses amounts exactly and refuses excess precision", () => {
    expect(decimalToRaw("0.017738", 6)).toBe(17_738n);
    expect(decimalToRaw("5", 6)).toBe(5_000_000n);
    expect(() => decimalToRaw("0.0000001", 6)).toThrow(
      CirclePayloadMismatchError,
    );
  });
});
