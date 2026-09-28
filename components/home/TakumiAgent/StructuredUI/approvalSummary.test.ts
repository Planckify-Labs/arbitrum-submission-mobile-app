import { describe, expect, it } from "vitest";
import { approvalSummaryFromToolInput } from "./approvalSummary";

const BASE = "eip155:8453";
const SOLANA = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const USDC_BASE = `${BASE}/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`;
const DEST = "9YTiQ3afuodm26rhUqzaUsnk2ryyEhXdJ3gXX2beELij";

const bridgeInput = {
  from_chain: BASE,
  to_chain: SOLANA,
  from_asset: USDC_BASE,
  amount_raw: "5000000",
  to_address: DEST,
};

describe("approvalSummaryFromToolInput — bridge", () => {
  /**
   * The destination is what the known-destination envelope asks the user
   * to confirm. An approval that hides it would record a confirmation for
   * an address the user never saw, which is worse than having no envelope.
   */
  it("always shows the destination address", () => {
    const summary = approvalSummaryFromToolInput(bridgeInput, undefined);
    expect(summary).toContain("9YTiQ3");
    expect(summary).toContain("arriving at");
  });

  it("names both chains, not just the asset", () => {
    const summary = approvalSummaryFromToolInput(bridgeInput, undefined);
    expect(summary).toContain("Base");
    expect(summary).toContain("Solana");
  });

  it("renders human-readable testnet names instead of raw CAIP-2 IDs", () => {
    const summary = approvalSummaryFromToolInput(
      {
        from_chain: "eip155:84532",
        to_chain: "eip155:5042002",
        amount_raw: "20000000",
        to_address: "0xc84db8b80b2a30cb4127027ae13ee8a490832146",
      },
      undefined,
      undefined,
      { symbol: "USDC", decimals: 6 },
    );
    expect(summary).toContain("Base Sepolia");
    expect(summary).toContain("Arc Testnet");
    expect(summary).not.toContain("eip155:84532");
    expect(summary).not.toContain("eip155:5042002");
  });

  // "5000000" and "5" are the same argument rendered with and without
  // decimals. Printing the raw one on the screen the user approves
  // against is the bug this guards.
  it("formats the amount when decimals are known", () => {
    const summary = approvalSummaryFromToolInput(
      bridgeInput,
      undefined,
      undefined,
      { symbol: "USDC", decimals: 6 },
    );
    expect(summary).toContain("5 USDC");
    expect(summary).not.toContain("5000000");
  });

  it("omits the amount entirely when decimals are unknown", () => {
    const summary = approvalSummaryFromToolInput(bridgeInput, undefined);
    expect(summary).not.toContain("5000000");
  });

  it("keeps fractional amounts exact", () => {
    const summary = approvalSummaryFromToolInput(
      { ...bridgeInput, amount_raw: "1234567" },
      undefined,
      undefined,
      { symbol: "USDC", decimals: 6 },
    );
    expect(summary).toContain("1.234567 USDC");
  });

  // Model prose must never be the approval text for a value transfer.
  it("ignores the server human_summary for a bridge", () => {
    const summary = approvalSummaryFromToolInput(
      bridgeInput,
      "Totally safe, just a test transfer",
    );
    expect(summary).not.toContain("Totally safe");
  });

  it("still describes the route when the destination is absent", () => {
    const { to_address: _omit, ...noDest } = bridgeInput;
    const summary = approvalSummaryFromToolInput(noDest, undefined);
    expect(summary).toContain("Base");
    expect(summary).toContain("Solana");
    expect(summary).not.toContain("arriving at");
  });
});

const ARC = "eip155:5042";
const swapInput = {
  from_chain: ARC,
  to_chain: ARC,
  from_asset: `${ARC}/erc20:0x3600000000000000000000000000000000000000`,
  to_asset: `${ARC}/erc20:0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1`,
  amount_raw: "1000000",
  to_address: "0xa54FFd258815Ee711bA0d3Dbb7fA786AEA6095Fb",
};

describe("approvalSummaryFromToolInput — same-chain swap", () => {
  // "Bridge from Arc to Arc" would describe a move that is not happening.
  it("reads as a swap on one chain, not a bridge", () => {
    const summary = approvalSummaryFromToolInput(
      swapInput,
      undefined,
      undefined,
      { symbol: "USDC", decimals: 6, toSymbol: "EURC" },
    );
    expect(summary).toBe("Swap 1 USDC to EURC on Arc");
  });

  it("still names the chain when the payout symbol is unknown", () => {
    const summary = approvalSummaryFromToolInput(
      swapInput,
      undefined,
      undefined,
      { symbol: "USDC", decimals: 6 },
    );
    expect(summary).toBe("Swap 1 USDC on Arc");
  });

  // Arc's gas token is USDC. Naming it "ETH" on an approval would name
  // the wrong asset.
  it("names native Arc USDC as USDC without the catalogue", () => {
    const summary = approvalSummaryFromToolInput(
      { ...swapInput, from_asset: `${ARC}/slip44:60` },
      undefined,
    );
    expect(summary).toContain("USDC");
    expect(summary).not.toContain("ETH");
  });

  it("ignores the server human_summary for a swap", () => {
    const summary = approvalSummaryFromToolInput(
      swapInput,
      "Totally safe, just a test swap",
    );
    expect(summary).not.toContain("Totally safe");
  });
});

describe("approvalSummaryFromToolInput — non-bridge writes", () => {
  it("renders a send with its recipient", () => {
    const summary = approvalSummaryFromToolInput(
      { to: "0x1234567890abcdef1234567890abcdef12345678", amount: "1.5" },
      undefined,
    );
    expect(summary).toContain("Send");
    expect(summary).toContain("1.5");
    expect(summary).toContain("0x1234");
  });

  it("labels an allowance as Approve and names the spender", () => {
    const summary = approvalSummaryFromToolInput(
      { spender: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" },
      undefined,
    );
    expect(summary).toContain("Approve");
    expect(summary).toContain("0xabcd");
  });

  it("falls back to the server summary only when there are no facts", () => {
    expect(
      approvalSummaryFromToolInput({ plan_id: "p1" }, "Run the saved plan"),
    ).toBe("Run the saved plan");
  });
});

describe("approvalSummaryFromToolInput — DeFi", () => {
  const deposit = {
    protocol_slug: "aave-v3",
    chain_id: 8453,
    asset_symbol: "CBBTC",
    amount_raw: "200000000",
    pool_id: "89bc7c4c-d71c-435c-ab28-56c803d51320",
  };

  /**
   * The user picked "Aave V3" off the opportunities card, so that is the name
   * they must be asked to approve — not the DeFiLlama slug, and not the word
   * "Transaction", which was all this surface said before.
   */
  it("names the venue and chain a person recognises", () => {
    const summary = approvalSummaryFromToolInput(deposit, undefined);
    expect(summary).toContain("Deposit");
    expect(summary).toContain("CBBTC");
    expect(summary).toContain("Aave V3");
    expect(summary).toContain("Base");
    expect(summary).not.toContain("aave-v3");
    expect(summary).not.toBe("This action");
  });

  it("states the real amount once the token's decimals are known", () => {
    const summary = approvalSummaryFromToolInput(
      deposit,
      undefined,
      undefined,
      {
        symbol: "cbBTC",
        decimals: 8,
      },
    );
    expect(summary).toContain("2 cbBTC");
  });

  it("omits an amount it cannot scale rather than showing smallest units", () => {
    // "200000000" on an approval screen reads as a completely different
    // deposit from the 2 the user asked for.
    expect(approvalSummaryFromToolInput(deposit, undefined)).not.toContain(
      "200000000",
    );
  });

  it("ignores model prose when the input carries facts", () => {
    const summary = approvalSummaryFromToolInput(
      deposit,
      "A harmless test transaction",
    );
    expect(summary).not.toContain("harmless");
  });

  it("calls a rebalance a move, from the same facts", () => {
    const summary = approvalSummaryFromToolInput(
      {
        protocol_slug: "morpho-blue",
        from_asset_symbol: "USDC",
        amount_raw: "1000000",
      },
      undefined,
    );
    expect(summary).toContain("Move");
    expect(summary).toContain("Morpho");
  });
});

describe("approvalSummaryFromToolInput — bridge_claim", () => {
  // Completing a transfer already sent must never read as sending again.
  it("states where the funds land and which transfer it finishes", () => {
    const summary = approvalSummaryFromToolInput(
      {
        from_chain: "eip155:8453",
        to_chain: "stellar:pubnet",
        source_tx_hash:
          "0xbd3c48ac5b6198524e674289e5b851bccc8d983279ffadc76ad77952381db10a",
      },
      "Bridge funds",
    );
    expect(summary).toContain("Receive");
    expect(summary).toContain("Stellar");
    expect(summary).not.toContain("Bridge");
  });
});
