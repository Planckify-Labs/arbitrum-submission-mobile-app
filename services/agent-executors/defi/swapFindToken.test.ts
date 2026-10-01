/**
 * `swap_find_token`: symbols to CAIP-19 from the API-driven token rows
 * (swap spec §4.9), so the model never guesses a contract address.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/useWallet.helpers", () => ({
  buildChainConfigFromBlockchain: (row: { chainId: number }) => ({
    namespace: "eip155",
    chain: { id: row.chainId },
  }),
}));
vi.mock("@/services/walletKit/registry", () => ({
  walletKitRegistry: {
    has: () => true,
    get: () => ({
      caip2For: (c: { chain: { id: number } }) => `eip155:${c.chain.id}`,
      toAssetCaip19: (
        c: { chain: { id: number } },
        contract?: string | null,
      ) =>
        contract
          ? `eip155:${c.chain.id}/erc20:${contract.toLowerCase()}`
          : `eip155:${c.chain.id}/slip44:60`,
    }),
  },
}));

// `swap.ts` also exports the quote/execute executors; keep their RN-heavy
// graph out of this pure lookup test, same stubs as bridgeExecute.test.ts.
const searchTokens = vi.fn(
  async (_chain: string, _query: string) => [] as unknown[],
);
vi.mock("@/api/endpoints/bridge", () => ({
  bridgeApi: { searchTokens: (c: string, q: string) => searchTokens(c, q) },
}));
vi.mock("@/services/bridgeStatusStore", () => ({ bridgeStatusStore: {} }));
vi.mock("@/services/defi/safety/registry", () => ({
  runSafetyPipeline: vi.fn(),
}));
vi.mock("@/services/defi/safety/routeChainResolver", () => ({
  bindRouteSafetyChains: () => {},
}));
vi.mock("@/services/walletPresence", () => ({
  getWalletForNamespace: () => null,
}));

import { swapFindToken } from "./swap";

const token = (symbol: string, contractAddress: string | null, extra = {}) => ({
  id: symbol,
  name: `${symbol} coin`,
  symbol,
  decimals: 6,
  blockchainId: "arc",
  contractAddress,
  logoUrl: null,
  isStablecoin: true,
  isActive: true,
  isNativeCurrency: false,
  createdAt: "",
  updatedAt: "",
  ...extra,
});

const context = {
  wallet: { address: "0x1", namespace: "eip155" },
  blockchains: [
    {
      chainId: 5042,
      caip2Id: "eip155:5042",
      tokens: [
        token("USDC", "0x3600000000000000000000000000000000000000"),
        token("USDC", null, { isNativeCurrency: true, decimals: 18 }),
        token("USDT0", "0x1111111111111111111111111111111111111111"),
        token("OLD", "0x2222222222222222222222222222222222222222", {
          isActive: false,
        }),
      ],
    },
  ],
} as never;

const find = (chain: string, query: string) =>
  swapFindToken({ chain, query }, context) as Promise<{
    data: {
      tokens: { caip19: string; symbol: string; is_native: boolean }[];
      reason?: string;
    };
  }>;

describe("swap_find_token", () => {
  it("returns the swappable ERC-20 form when a chain lists its gas token twice", async () => {
    const { data } = await find("eip155:5042", "usdc");
    expect(data.tokens).toEqual([
      expect.objectContaining({
        caip19: "eip155:5042/erc20:0x3600000000000000000000000000000000000000",
        is_native: false,
      }),
    ]);
  });

  it("matches the Tether glyph and prefixes, and skips inactive rows", async () => {
    expect(
      (await find("eip155:5042", "USD₮")).data.tokens.map((t) => t.symbol),
    ).toEqual(["USDT0"]);
    expect((await find("eip155:5042", "OLD")).data.tokens).toEqual([]);
  });

  it("answers a chain the app does not serve as a boundary, not an error", async () => {
    const { data } = await find("eip155:1", "USDC");
    expect(data.tokens).toEqual([]);
    expect(data.reason).toBe("chain_not_enabled");
  });

  it("falls back to the providers when no row matches (cirBTC on Arc)", async () => {
    searchTokens.mockResolvedValueOnce([
      {
        caip19: "eip155:5042/erc20:0x171A4217b86A807A64eB94757Db6849fb4bDbAA0",
        symbol: "cirBTC",
        name: "Circle BTC",
        decimals: 8,
        verification: "unverified",
      },
    ]);
    const { data } = await find("eip155:5042", "cirBTC");
    expect(searchTokens).toHaveBeenCalledWith("eip155:5042", "cirBTC");
    expect(data.tokens).toEqual([
      expect.objectContaining({
        symbol: "cirBTC",
        verified: false,
        source: "provider",
      }),
    ]);
  });

  it("prefers our own rows, and marks them verified", async () => {
    searchTokens.mockClear();
    const { data } = await find("eip155:5042", "USDC");
    expect(searchTokens).not.toHaveBeenCalled();
    expect(data.tokens[0]).toEqual(
      expect.objectContaining({ verified: true, source: "catalogue" }),
    );
  });
});
