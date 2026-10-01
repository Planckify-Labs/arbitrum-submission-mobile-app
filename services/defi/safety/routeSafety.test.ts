import { beforeEach, describe, expect, it } from "vitest";
import type { TBridgeQuote } from "@/api/types/bridge";
import type { TWallet } from "@/constants/types/walletTypes";
import {
  AssetChainConsistencyCheck,
  RouteParametersCheck,
} from "./checks/layer0-input";
import {
  RouteDestinationHasCodeCheck,
  RouteRouterAllowlistedCheck,
} from "./checks/layer1-identity";
import {
  PriceImpactGateCheck,
  RouteSlippageFloorCheck,
} from "./checks/layer2-economic";
import {
  registerChainSafetyProvider,
  resetSafetyRegistry,
  runSafetyPipeline,
} from "./registry";
import { buildRouteSafetyContext } from "./routeSafetyContext";
import type { ChainSafetyProvider, SafetyContext } from "./types";

describe("Route & Swap Safety Checks (Spec §8.4)", () => {
  const MOCK_LIFI_DIAMOND = "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae";
  const UNKNOWN_ADDRESS = "0x9999999999999999999999999999999999999999";
  const USER_WALLET = "0x3333333333333333333333333333333333333333";

  const mockWallet = {
    address: USER_WALLET,
    namespace: "eip155",
    chainId: 1,
  } as unknown as TWallet;

  const sampleQuote: TBridgeQuote = {
    quoteId: "quote-1",
    provider: "lifi",
    kind: "swap",
    from: {
      chain: "eip155:1",
      address: USER_WALLET,
      token: {
        caip19: "eip155:1/erc20:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        symbol: "USDC",
        decimals: 6,
        chainId: "1",
        address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      },
      amountRaw: "1000000",
    },
    to: {
      chain: "eip155:1",
      address: USER_WALLET,
      token: {
        caip19: "eip155:1/erc20:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
        symbol: "WETH",
        decimals: 18,
        chainId: "1",
        address: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
      },
      amountRaw: "500000000000000000",
    },
    toAmountMinRaw: "497500000000000000",
    slippageBps: 50,
    priceImpact: 0.2, // 0.2% -> 20 bps
    durationSeconds: 15,
    fees: [],
    steps: [],
    receivesNativeAsset: false,
    bridge: {
      key: "lifi",
      name: "LI.FI",
      mechanism: "dex_aggregator",
    },
    execution: {
      kind: "evm_transaction",
      chain: "eip155:1",
      to: MOCK_LIFI_DIAMOND,
      data: "0xabcdef",
      value: "0",
      approval: {
        token: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        spender: MOCK_LIFI_DIAMOND,
        amountRaw: "1000000",
      },
    },
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  };

  function stubSafetyProvider(): ChainSafetyProvider {
    return {
      namespace: "eip155",
      targetExists: async () => true,
      readUnderlying: async () => sampleQuote.from.token.caip19,
      isAllowlisted: async () => true,
      assertChainBinding: () => true,
      hasCode: async (addr: string) => addr !== UNKNOWN_ADDRESS,
      decodeIntent: async () => ({
        destination: MOCK_LIFI_DIAMOND,
        action: "swap",
        assetIn: sampleQuote.from.token.caip19,
        amountIn: 1000000n,
        recipient: USER_WALLET,
        valueNative: 0n,
        spender: MOCK_LIFI_DIAMOND,
        approvalAmount: 1000000n,
        minOut: 497500000000000000n,
        deadline: null,
      }),
      simulate: async () => ({ ok: true }),
      isProtocolHalted: async () => false,
      readPositionBalance: async () => 1000000n,
      readDecimals: async () => 6,
    };
  }

  beforeEach(() => {
    resetSafetyRegistry();
    registerChainSafetyProvider(stubSafetyProvider());
  });

  describe("AssetChainConsistencyCheck", () => {
    it("passes when from and to assets match chain for same-chain swap", async () => {
      const ctx = buildRouteSafetyContext({
        stage: "submit",
        quote: sampleQuote,
        wallet: mockWallet,
        toolInput: {
          chain: "eip155:1",
          from_asset: sampleQuote.from.token.caip19,
          to_asset: sampleQuote.to.token.caip19,
          amount_raw: "1000000",
        },
      });

      const res = await AssetChainConsistencyCheck.run(ctx);
      expect(res.ok).toBe(true);
    });

    it("fails when swap has mismatched asset chain", async () => {
      const ctx = buildRouteSafetyContext({
        stage: "submit",
        quote: sampleQuote,
        wallet: mockWallet,
        toolInput: {
          chain: "eip155:1",
          from_asset:
            "eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // Base token on Eth swap
          to_asset: sampleQuote.to.token.caip19,
          amount_raw: "1000000",
        },
      });

      const res = await AssetChainConsistencyCheck.run(ctx);
      expect(res.ok).toBe(false);
      expect(res.fail).toBe("unsupported_asset");
    });
  });

  describe("PriceImpactGateCheck", () => {
    it("passes for low price impact (< 200 bps / 2%)", async () => {
      const ctx = buildRouteSafetyContext({
        stage: "submit",
        quote: {
          ...sampleQuote,
          priceImpact: 1.5, // 150 bps
        },
        wallet: mockWallet,
      });

      const res = await PriceImpactGateCheck.run(ctx);
      expect(res.ok).toBe(true);
    });

    it("passes with warning for medium price impact (200 - 1000 bps)", async () => {
      const ctx = buildRouteSafetyContext({
        stage: "submit",
        quote: {
          ...sampleQuote,
          priceImpact: 5.0, // 500 bps
        },
        wallet: mockWallet,
      });

      const res = await PriceImpactGateCheck.run(ctx);
      expect(res.ok).toBe(true);
    });

    it("blocks danger price impact (>= 1000 bps) without acknowledgment", async () => {
      const ctx = buildRouteSafetyContext({
        stage: "submit",
        quote: {
          ...sampleQuote,
          priceImpact: 12.0, // 1200 bps
        },
        wallet: mockWallet,
      });

      const res = await PriceImpactGateCheck.run(ctx);
      expect(res.ok).toBe(false);
      expect(res.fail).toBe("price_impact_too_high");
    });

    it("permits danger price impact when acknowledged by price_impact_ack_bps", async () => {
      const ctx = buildRouteSafetyContext({
        stage: "submit",
        quote: {
          ...sampleQuote,
          priceImpact: 12.0, // 1200 bps
        },
        wallet: mockWallet,
        priceImpactAckBps: 1500, // User acknowledged up to 1500 bps
      });

      const res = await PriceImpactGateCheck.run(ctx);
      expect(res.ok).toBe(true);
    });
  });

  describe("RouteRouterAllowlistedCheck", () => {
    it("allows execution targeting pinned LI.FI diamond router", async () => {
      const ctx = buildRouteSafetyContext({
        stage: "submit",
        quote: sampleQuote,
        wallet: mockWallet,
      });

      const res = await RouteRouterAllowlistedCheck.run(ctx);
      expect(res.ok).toBe(true);
    });

    it("blocks execution targeting unverified / unallowlisted router", async () => {
      const badQuote: TBridgeQuote = {
        ...sampleQuote,
        execution: {
          ...sampleQuote.execution,
          to: UNKNOWN_ADDRESS,
        },
      };

      const ctx = buildRouteSafetyContext({
        stage: "submit",
        quote: badQuote,
        wallet: mockWallet,
      });

      const res = await RouteRouterAllowlistedCheck.run(ctx);
      expect(res.ok).toBe(false);
      expect(res.fail).toBe("target_not_allowlisted");
    });
  });

  describe("RouteSlippageFloorCheck", () => {
    it("passes when toAmountMinRaw meets or exceeds the slippage floor", async () => {
      const ctx = buildRouteSafetyContext({
        stage: "submit",
        quote: sampleQuote,
        wallet: mockWallet,
      });

      const res = await RouteSlippageFloorCheck.run(ctx);
      expect(res.ok).toBe(true);
    });

    it("fails when min_receive_raw is missing", async () => {
      const ctx = buildRouteSafetyContext({
        stage: "submit",
        quote: {
          ...sampleQuote,
          toAmountMinRaw: "",
        },
        wallet: mockWallet,
      });

      const res = await RouteSlippageFloorCheck.run(ctx);
      expect(res.ok).toBe(false);
      expect(res.fail).toBe("slippage_too_high");
    });
  });
});
