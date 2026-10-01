/**
 * The re-quote at signing must be the route the user approved (swap spec
 * §8.4 L2, T2/T12). Every downstream payload check compares against the
 * QUOTE, so a backend that returned a different recipient or token would
 * otherwise pass all of them.
 */
import { describe, expect, it, vi } from "vitest";
import type { TBridgeQuote } from "@/api/types/bridge";

// The real rule dispatches through the wallet-kit registry; this stands in
// with the same per-encoding behaviour (hex folds, base58 does not).
vi.mock("@/services/walletKit/chainInfo", () => ({
  addressesEqual: (ns: string, a?: string | null, b?: string | null) =>
    !!a &&
    !!b &&
    (ns === "eip155" || ns === "sui"
      ? a.toLowerCase() === b.toLowerCase()
      : a === b),
}));
vi.mock("@/services/walletKit/registry", () => ({
  walletKitRegistry: { has: () => false, get: () => undefined },
}));

import { quoteBindingMismatch, sameAsset } from "./quoteBinding";

const ME = "0x3333333333333333333333333333333333333333";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH = "0x4200000000000000000000000000000000000006";

function quote(over: Record<string, unknown> = {}): TBridgeQuote {
  return {
    from: {
      chain: "eip155:8453",
      address: ME,
      amountRaw: "1000000",
      token: { caip19: `eip155:8453/erc20:${USDC}` },
    },
    to: {
      chain: "eip155:42161",
      address: ME,
      amountRaw: "999000",
      token: {
        caip19: "eip155:42161/erc20:0xaf88d065e77c8cc2239327c5edb3a432268e5831",
      },
    },
    ...over,
  } as unknown as TBridgeQuote;
}

const approved = {
  fromChain: "eip155:8453",
  toChain: "eip155:42161",
  fromAsset: `eip155:8453/erc20:${USDC.toLowerCase()}`,
  toAsset: "eip155:42161/erc20:0xAF88d065e77c8cC2239327C5EDb3A432268e5831",
  amountRaw: "1000000",
  fromAddress: ME,
  toAddress: ME,
};

describe("sameAsset", () => {
  it("folds EVM hex case but not the chain", () => {
    expect(
      sameAsset(
        `eip155:8453/erc20:${USDC}`,
        `eip155:8453/erc20:${USDC.toLowerCase()}`,
      ),
    ).toBe(true);
    expect(
      sameAsset(`eip155:8453/erc20:${USDC}`, `eip155:1/erc20:${USDC}`),
    ).toBe(false);
  });
  it("treats every spelling of the native asset as one asset", () => {
    expect(
      sameAsset(
        "sui:mainnet/coin:0x2::sui::SUI",
        "sui:mainnet/coin:0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI",
      ),
    ).toBe(true);
    expect(sameAsset("eip155:1/slip44:60", `eip155:1/erc20:${WETH}`)).toBe(
      false,
    );
  });
  it("never folds a base58 mint", () => {
    const mint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    expect(
      sameAsset(
        `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:${mint}`,
        `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:${mint.toLowerCase()}`,
      ),
    ).toBe(false);
  });
});

describe("quoteBindingMismatch", () => {
  it("accepts the approved route", () => {
    expect(quoteBindingMismatch(quote(), approved)).toBeNull();
  });

  it("refuses a quote that pays someone else", () => {
    const q = quote() as any;
    q.to.address = "0x000000000000000000000000000000000000dEaD";
    expect(quoteBindingMismatch(q, approved)).toBe("to_address");
  });

  it("refuses a substituted output token", () => {
    const q = quote() as any;
    q.to.token.caip19 = `eip155:42161/erc20:${WETH}`;
    expect(quoteBindingMismatch(q, approved)).toBe("to_asset");
  });

  it("refuses a substituted input token", () => {
    const q = quote() as any;
    q.from.token.caip19 = `eip155:8453/erc20:${WETH}`;
    expect(quoteBindingMismatch(q, approved)).toBe("from_asset");
  });

  it("refuses more than the approved amount, allows a truncated one", () => {
    const more = quote() as any;
    more.from.amountRaw = "1000001";
    expect(quoteBindingMismatch(more, approved)).toBe("amount");
    const less = quote() as any;
    less.from.amountRaw = "999990";
    expect(quoteBindingMismatch(less, approved)).toBeNull();
  });

  it("refuses a different chain or a different signer", () => {
    const q = quote() as any;
    q.to.chain = "eip155:10";
    expect(quoteBindingMismatch(q, approved)).toBe("to_chain");
    const r = quote() as any;
    r.from.address = "0x4444444444444444444444444444444444444444";
    expect(quoteBindingMismatch(r, approved)).toBe("from_address");
  });
});
