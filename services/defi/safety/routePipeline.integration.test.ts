/**
 * The swap/bridge route path through the REAL pipeline: real bootstrap, real
 * EVM `decodeIntent`, production-shaped chain resolver. `routeSafety.test.ts`
 * stubs the provider and calls checks one by one, which is how a string
 * chainId and a native-asset mismatch both shipped green.
 */
import { base } from "viem/chains";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TBlockchain } from "@/api/types/blockchain";
import type { TBridgeQuote } from "@/api/types/bridge";

vi.mock("@/hooks/useWallet.helpers", () => ({
  buildChainConfigFromBlockchain: () => ({ namespace: "eip155", chain: base }),
  resolveNamespace: () => "eip155",
}));

import { bootDefiSafety, resetDefiSafetyBootstrap } from "./bootstrap";
import { Eip155SafetyProvider } from "./providers/eip155";
import {
  registerChainSafetyProvider,
  resetSafetyRegistry,
  runSafetyPipeline,
  selectChecks,
} from "./registry";
import { bindRouteSafetyChains } from "./routeChainResolver";
import { buildRouteSafetyContext } from "./routeSafetyContext";

const W = "0x3333333333333333333333333333333333333333";
const LIFI = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const wallet = { address: W, namespace: "eip155", chainId: 8453 } as never;

function quote(opts: { native?: boolean; priceImpact?: number } = {}) {
  const { native = false, priceImpact } = opts;
  return {
    quoteId: "q",
    provider: "lifi",
    kind: "swap",
    from: {
      chain: "eip155:8453",
      address: W,
      amountRaw: "1000000",
      token: {
        caip19: native ? "eip155:8453/slip44:60" : `eip155:8453/erc20:${USDC}`,
        symbol: "X",
        decimals: 6,
        chainId: "8453",
        ...(native ? { isNative: true } : { address: USDC }),
      },
    },
    to: {
      chain: "eip155:8453",
      address: W,
      amountRaw: "1000",
      token: {
        caip19: "eip155:8453/erc20:0x4200000000000000000000000000000000000006",
        symbol: "Y",
        decimals: 6,
        chainId: "8453",
        address: "0x4200000000000000000000000000000000000006",
      },
    },
    toAmountMinRaw: "995",
    slippageBps: 50,
    priceImpact,
    durationSeconds: 5,
    fees: [],
    steps: [],
    receivesNativeAsset: false,
    bridge: { key: "lifi", name: "LI.FI", mechanism: "dex_aggregator" },
    execution: {
      kind: "evm_transaction",
      chain: "eip155:8453",
      to: LIFI,
      data: "0xdeadbeef",
      value: native ? "1000000" : "0",
      ...(native
        ? {}
        : { approval: { token: USDC, spender: LIFI, amountRaw: "1000000" } }),
    },
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  } as unknown as TBridgeQuote;
}

const run = (q: TBridgeQuote, ack?: number) =>
  runSafetyPipeline(
    buildRouteSafetyContext({
      quote: q,
      wallet,
      stage: "submit",
      toolInput: {},
      priceImpactAckBps: ack,
    }),
  );

describe("route path through the real safety pipeline", () => {
  beforeEach(() => {
    resetSafetyRegistry();
    resetDefiSafetyBootstrap();
    bootDefiSafety();
    // hasCode would hit the network; everything else is the real provider.
    registerChainSafetyProvider({
      ...Eip155SafetyProvider,
      hasCode: async () => true,
    });
    bindRouteSafetyChains([{ chainId: 8453 } as TBlockchain]);
  });

  it("lets an ERC-20 swap through (chain resolves from a string reference)", async () => {
    expect((await run(quote())).ok).toBe(true);
  });

  it("lets a native-input swap through", async () => {
    expect((await run(quote({ native: true }))).ok).toBe(true);
  });

  it("refuses a chain the app has no row for", async () => {
    bindRouteSafetyChains([]);
    const r = await run(quote());
    expect(r.ok).toBe(false);
  });

  it("blocks a 32% price impact unless acknowledged at least that high", async () => {
    const q = quote({ priceImpact: 32 });
    const blocked = await run(q);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.fail).toBe("price_impact_too_high");
    expect((await run(q, 3000)).ok).toBe(false);
    expect((await run(q, 3200)).ok).toBe(true);
  });

  it("does not run the address-provenance check on the route path, but does on withdraw", () => {
    const ids = (action: "withdraw" | "swap") =>
      selectChecks({
        action,
        stage: "presign",
        namespace: "eip155",
      } as never).map((c) => c.id);
    expect(ids("withdraw")).toContain("no-llm-supplied-address");
    expect(ids("swap")).not.toContain("no-llm-supplied-address");
  });

  it("does not falsely block a quote that declares no slippage", async () => {
    const q = { ...quote(), slippageBps: undefined } as unknown as TBridgeQuote;
    expect((await run(q)).ok).toBe(true);
  });

  describe("router allowlist is per chain and per provider", () => {
    const onChain = (
      id: number,
      to: string,
      provider = "lifi",
    ): TBridgeQuote => {
      const q = quote() as any;
      q.provider = provider;
      q.from.chain = `eip155:${id}`;
      q.to.chain = `eip155:${id}`;
      q.execution.chain = `eip155:${id}`;
      q.execution.to = to;
      q.execution.approval.spender = to;
      return q as TBridgeQuote;
    };
    const run2 = (q: TBridgeQuote, chainId: number) =>
      runSafetyPipeline(
        buildRouteSafetyContext({
          quote: q,
          wallet: { address: W, namespace: "eip155", chainId } as never,
          stage: "submit",
          toolInput: {},
        }),
      );

    it("accepts zkSync's own LI.FI diamond and refuses the mainnet one there", async () => {
      bindRouteSafetyChains([{ chainId: 324 } as TBlockchain]);
      const zk = "0x341e94069f53234fE6DabeF707aD424830525715";
      expect((await run2(onChain(324, zk), 324)).ok).toBe(true);
      const wrong = await run2(onChain(324, LIFI), 324);
      expect(wrong.ok).toBe(false);
      if (!wrong.ok) expect(wrong.fail).toBe("target_not_allowlisted");
    });

    it("accepts Tower's live executor on Arc, and refuses it if it has no code (testnet)", async () => {
      const tower = "0xeB8940752Fa12944d3b2D736d51fA36E4dA32BC8";
      bindRouteSafetyChains([{ chainId: 5042 } as TBlockchain]);
      const q = onChain(5042, tower, "tower");
      expect((await run2(q, 5042)).ok).toBe(true);
      // Live probe 2026-09-30: eth_getCode(executor) on Arc testnet is "0x".
      registerChainSafetyProvider({
        ...Eip155SafetyProvider,
        hasCode: async () => false,
      });
      const r = await run2(q, 5042);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.fail).toBe("target_not_a_contract");
    });

    it("refuses Tower's executor when the quote came from another provider", async () => {
      const tower = "0xeB8940752Fa12944d3b2D736d51fA36E4dA32BC8";
      const r = await run2(onChain(8453, tower, "lifi"), 8453);
      expect(r.ok).toBe(false);
    });
  });

  describe("regressions found in QA (2026-09-30)", () => {
    const TOKEN_MESSENGER = "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d";

    it("lets a CCTP EVM -> Stellar burn through when the adapter pins TokenMessenger", async () => {
      const q = quote() as any;
      q.provider = "cctp";
      q.kind = "bridge";
      q.to.chain = "stellar:pubnet";
      q.execution.to = TOKEN_MESSENGER;
      q.execution.approval.spender = TOKEN_MESSENGER;
      const r = await runSafetyPipeline(
        buildRouteSafetyContext({
          quote: q,
          wallet,
          stage: "submit",
          toolInput: {},
          allowedTargets: [TOKEN_MESSENGER],
        }),
      );
      expect(r.ok).toBe(true);
    });

    it("still refuses a CCTP burn to anything but the pinned TokenMessenger", async () => {
      const q = quote() as any;
      q.provider = "cctp";
      q.kind = "bridge";
      q.to.chain = "stellar:pubnet";
      const evil = "0x000000000000000000000000000000000000bEEF";
      q.execution.to = evil;
      q.execution.approval.spender = evil;
      const r = await runSafetyPipeline(
        buildRouteSafetyContext({
          quote: q,
          wallet,
          stage: "submit",
          toolInput: {},
          allowedTargets: [TOKEN_MESSENGER],
        }),
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.fail).toBe("target_not_allowlisted");
    });

    it("does not gate a cross-chain bridge on its fee-driven 'impact'", async () => {
      const q = quote({ priceImpact: 12 }) as any;
      q.kind = "bridge";
      q.to.chain = "eip155:42161";
      expect((await run(q)).ok).toBe(true);
    });

    it("refuses the same route submitted twice while the first is in flight", async () => {
      const ctx = () =>
        buildRouteSafetyContext({
          quote: quote(),
          wallet,
          stage: "submit",
          toolInput: {},
          submissionKey: "route:qa-double-tap",
        });
      expect((await runSafetyPipeline(ctx())).ok).toBe(true);
      const second = await runSafetyPipeline(ctx());
      expect(second.ok).toBe(false);
      if (!second.ok) expect(second.fail).toBe("duplicate_submission");
    });
  });
});
