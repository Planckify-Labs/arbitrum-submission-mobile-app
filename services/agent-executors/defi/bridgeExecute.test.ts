/**
 * `bridge_execute` / `swap_execute` end to end through the executor, with
 * the backend, the wallet kit and the adapter mocked.
 *
 * The properties pinned here are the ones found missing in QA
 * (2026-09-30): the re-quote at signing must be the route the user
 * approved, a token that differs from the one the user named needs their
 * confirmation on the card, a dry run that shows the route misbehaving must
 * stop it, and a failed attempt must not lock the route out.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TBridgeQuote } from "@/api/types/bridge";

const ME = "0x3333333333333333333333333333333333333333";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH = "0x4200000000000000000000000000000000000006";
const ROUTER = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE";
const CHAIN = "eip155:8453";

const getQuote = vi.fn();
const adapterExecute = vi.fn();
const simulate = vi.fn();
const runPipeline = vi.fn();

vi.mock("@/api/endpoints/bridge", () => ({
  bridgeApi: { getQuote: (...a: unknown[]) => getQuote(...a) },
}));
vi.mock("@/hooks/useWallet.helpers", () => ({
  buildChainConfigFromBlockchain: () => ({
    namespace: "eip155",
    chain: { id: 8453 },
  }),
  resolveNamespace: () => "eip155",
}));
vi.mock("@/services/bridgeRoutes/execute", () => ({
  checkBridgeDestinationReadiness: async () => [],
  isQuoteExpired: () => false,
  resolveSourceChain: () => ({ namespace: "eip155", chain: { id: 8453 } }),
}));
vi.mock("@/services/bridgeRoutes/registry", () => ({
  adapterForQuote: () => ({
    key: "lifi",
    execute: (...a: unknown[]) => adapterExecute(...a),
    targetAllowlist: async () => [ROUTER],
  }),
}));
vi.mock("@/services/bridgeStatusStore", () => ({
  bridgeStatusStore: { startPolling: () => () => {} },
}));
vi.mock("@/services/defi/safety/registry", () => ({
  runSafetyPipeline: (...a: unknown[]) => runPipeline(...a),
}));
vi.mock("@/services/defi/safety/routeChainResolver", () => ({
  bindRouteSafetyChains: () => {},
}));
vi.mock("@/services/walletKit/chainInfo", () => ({
  addressesEqual: (_ns: string, a?: string | null, b?: string | null) =>
    !!a && !!b && a.toLowerCase() === b.toLowerCase(),
}));
vi.mock("@/services/walletKit/registry", () => ({
  walletKitRegistry: {
    has: () => true,
    get: () => ({
      caip2For: (c: { chain: { id: number } }) => `eip155:${c.chain.id}`,
      getNativeBalance: async () => 10n ** 18n,
      getTokenBalance: async () => 10n ** 12n,
      simulateBridgeExecution: (...a: unknown[]) => simulate(...a),
    }),
  },
}));
vi.mock("@/services/walletPresence", () => ({
  getWalletForNamespace: () => null,
}));

import { resetInFlightSubmissions } from "@/services/defi/safety/checks/layer4-execution";
import { routeAck, routeAckKey } from "@/services/swap/routeAck";
import { swapExecute } from "./swap";

function freshQuote(over: Partial<Record<string, unknown>> = {}): TBridgeQuote {
  return {
    quoteId: "q",
    provider: "lifi",
    kind: "swap",
    from: {
      chain: CHAIN,
      address: ME,
      amountRaw: "1000000",
      token: {
        caip19: `${CHAIN}/erc20:${USDC}`,
        address: USDC,
        symbol: "USDC",
        decimals: 6,
        verification: "verified",
      },
    },
    to: {
      chain: CHAIN,
      address: ME,
      amountRaw: "400000000000000",
      token: {
        caip19: `${CHAIN}/erc20:${WETH}`,
        address: WETH,
        symbol: "WETH",
        decimals: 18,
        verification: "verified",
      },
    },
    toAmountMinRaw: "398000000000000",
    slippageBps: 50,
    fees: [],
    steps: [],
    receivesNativeAsset: false,
    durationSeconds: 5,
    bridge: { key: "lifi", name: "LI.FI" },
    execution: {
      kind: "evm_transaction",
      chain: CHAIN,
      to: ROUTER,
      data: "0xdeadbeef",
      value: "0",
      approval: { token: USDC, spender: ROUTER, amountRaw: "1000000" },
    },
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...over,
  } as unknown as TBridgeQuote;
}

const context = {
  wallet: { address: ME, namespace: "eip155", chainId: 8453 },
  account: { address: ME },
  blockchains: [{ chainId: 8453 }],
  wallets: [],
} as never;

const input = {
  chain: CHAIN,
  from_asset: `${CHAIN}/erc20:${USDC.toLowerCase()}`,
  to_asset: `${CHAIN}/erc20:${WETH.toLowerCase()}`,
  amount_raw: "1000000",
  min_receive_raw: "398000000000000",
};

const run = (extra: Record<string, unknown> = {}) =>
  swapExecute({ ...input, ...extra }, context) as Promise<{
    status: string;
    error?: string;
    reason?: string;
  }>;

describe("swap_execute through bridge_execute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeAck.__resetForTests();
    resetInFlightSubmissions();
    getQuote.mockResolvedValue({ routable: true, quote: freshQuote() });
    runPipeline.mockResolvedValue({ ok: true, ran: [] });
    simulate.mockResolvedValue({
      status: "ok",
      deltas: [
        { asset: USDC, delta: -1_000_000n },
        { asset: WETH, delta: 399_000_000_000_000n },
      ],
      nativeFeeAllowance: 10n ** 16n,
    });
    adapterExecute.mockResolvedValue({ sourceTxHash: "0xabc" });
  });

  it("signs the approved route", async () => {
    const r = await run();
    expect(r.status).toBe("success");
    expect(adapterExecute).toHaveBeenCalledOnce();
  });

  it("refuses a re-quote that pays someone else", async () => {
    const q = freshQuote() as any;
    q.to.address = "0x000000000000000000000000000000000000dEaD";
    getQuote.mockResolvedValue({ routable: true, quote: q });
    const r = await run();
    expect(r.reason).toBe("bridge_payload_mismatch");
    expect(adapterExecute).not.toHaveBeenCalled();
  });

  it("refuses a re-quote for a different output token", async () => {
    const q = freshQuote() as any;
    q.to.token.caip19 = `${CHAIN}/erc20:0x1111111111111111111111111111111111111111`;
    getQuote.mockResolvedValue({ routable: true, quote: q });
    const r = await run();
    expect(r.reason).toBe("bridge_payload_mismatch");
    expect(adapterExecute).not.toHaveBeenCalled();
  });

  it("needs the user's confirmation for a token that differs from the hint", async () => {
    const blocked = await run({ to_asset_symbol_hint: "USDT" });
    expect(blocked.reason).toBe("asset_symbol_mismatch");
    expect(adapterExecute).not.toHaveBeenCalled();

    routeAck.record(routeAckKey(freshQuote()), { symbolsConfirmed: true });
    const ok = await run({ to_asset_symbol_hint: "USDT" });
    expect(ok.status).toBe("success");
  });

  it.each(["unverified", "unknown"])(
    "needs the user's confirmation to receive a %s token (§8.4 L1)",
    async (verification) => {
      const q = freshQuote() as any;
      q.to.token.verification = verification;
      getQuote.mockResolvedValue({ routable: true, quote: q });
      const blocked = await run();
      expect(blocked.reason).toBe("unverified_token_unconfirmed");
      expect(adapterExecute).not.toHaveBeenCalled();

      // A model-sent flag is not a confirmation.
      const forged = await run({ unverified_confirmed: true });
      expect(forged.reason).toBe("unverified_token_unconfirmed");

      routeAck.record(routeAckKey(q), { unverifiedConfirmed: true });
      const ok = await run();
      expect(ok.status).toBe("success");
    },
  );

  it("an unverified confirmation for one amount does not cover another", async () => {
    const q = freshQuote() as any;
    q.to.token.verification = "unverified";
    getQuote.mockResolvedValue({ routable: true, quote: q });
    routeAck.record(
      routeAckKey({ ...q, from: { ...q.from, amountRaw: "5" } }),
      {
        unverifiedConfirmed: true,
      },
    );
    const r = await run();
    expect(r.reason).toBe("unverified_token_unconfirmed");
  });

  it("receiving the chain's native asset needs no confirmation", async () => {
    const q = freshQuote() as any;
    q.to.token = {
      caip19: `${CHAIN}/slip44:60`,
      symbol: "ETH",
      decimals: 18,
      isNative: true,
      verification: "unknown",
    };
    getQuote.mockResolvedValue({ routable: true, quote: q });
    const r = await run({ to_asset: `${CHAIN}/slip44:60` });
    expect(r.reason).not.toBe("unverified_token_unconfirmed");
  });

  it("reads the price-impact acknowledgement from the card, never from the model", async () => {
    await run({ price_impact_ack_bps: 99_999 });
    const ctx = runPipeline.mock.calls[0][0] as { priceImpactAckBps?: number };
    expect(ctx.priceImpactAckBps).toBeUndefined();

    routeAck.record(routeAckKey(freshQuote()), { impactBps: 1_500 });
    await run();
    const ctx2 = runPipeline.mock.calls[1][0] as { priceImpactAckBps?: number };
    expect(ctx2.priceImpactAckBps).toBe(1_500);
  });

  it("stops a route whose dry run takes more than approved", async () => {
    simulate.mockResolvedValue({
      status: "ok",
      deltas: [
        { asset: USDC, delta: -5_000_000n },
        { asset: WETH, delta: 399_000_000_000_000n },
      ],
      nativeFeeAllowance: 0n,
    });
    const r = await run();
    expect(r.reason).toBe("bridge_payload_mismatch");
    expect(adapterExecute).not.toHaveBeenCalled();
  });

  it("stops a route whose dry run reverts", async () => {
    simulate.mockResolvedValue({ status: "reverted" });
    const r = await run();
    expect(r.reason).toBe("route_simulation_failed");
  });

  it("proceeds on a chain that cannot simulate (the floor still holds)", async () => {
    simulate.mockResolvedValue({ status: "unsupported" });
    expect((await run()).status).toBe("success");
  });

  it("passes a one-route idempotency key, and frees it when signing fails", async () => {
    adapterExecute.mockRejectedValueOnce(new Error("boom"));
    const failed = await run();
    expect(failed.status).not.toBe("success");
    const key = (runPipeline.mock.calls[0][0] as { submissionKey?: string })
      .submissionKey;
    expect(key).toMatch(/^route:/);
    // The real idempotency check would refuse a second attempt only if the
    // key were still held; the executor must have released it.
    const { IdempotencyCheck } = await import(
      "@/services/defi/safety/checks/layer4-execution"
    );
    const again = await IdempotencyCheck.run({ submissionKey: key } as never);
    expect(again.ok).toBe(true);
  });

  it("never lets the model name a swap recipient", async () => {
    await run({ to_address: "0x000000000000000000000000000000000000dEaD" });
    const req = getQuote.mock.calls[0][0] as { toAddress: string };
    expect(req.toAddress).toBe(ME);
  });

  it("refuses a chain the app has no active row for, before quoting", async () => {
    const r = (await swapExecute(
      {
        ...input,
        chain: "eip155:999",
        from_asset: `eip155:999/erc20:${USDC}`,
        to_asset: `eip155:999/erc20:${WETH}`,
      },
      context,
    )) as { reason?: string };
    expect(r.reason).toBe("chain_not_enabled");
    expect(getQuote).not.toHaveBeenCalled();
  });

  it("requires the floor the user read", async () => {
    const r = (await swapExecute(
      { ...input, min_receive_raw: undefined },
      context,
    )) as {
      reason?: string;
    };
    expect(r.reason).toBe("min_receive_required");
  });
});
