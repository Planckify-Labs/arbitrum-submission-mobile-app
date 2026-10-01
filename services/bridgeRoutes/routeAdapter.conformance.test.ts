import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/constants/configs/ky", () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

import { lifiBridgeAdapter } from "./adapters/lifiAdapter";
import { towerBridgeAdapter } from "./adapters/towerAdapter";
import {
  registerBridgeAdapter,
  resetBridgeAdapters,
  resolveBridgeAdapters,
} from "./registry";

describe("Route Adapter Conformance Suite", () => {
  beforeEach(() => {
    resetBridgeAdapters();
    registerBridgeAdapter(towerBridgeAdapter);
    registerBridgeAdapter(lifiBridgeAdapter);
  });

  describe("Adapter Topology Declarations (Phase 1 / §4.2)", () => {
    it("tower declares swap-only capability", () => {
      expect(towerBridgeAdapter.kinds).toEqual(["swap"]);
    });

    it("lifi declares both swap and bridge capabilities", () => {
      expect(lifiBridgeAdapter.kinds).toContain("swap");
      expect(lifiBridgeAdapter.kinds).toContain("bridge");
    });
  });

  describe("Arc Swap Routing (Special requirement: Tower on Arc)", () => {
    const ARC_MAINNET = "eip155:5042";
    const ARC_TESTNET = "eip155:5042002";
    const ETH_MAINNET = "eip155:1";
    const BASE = "eip155:8453";

    it("Tower supports same-chain swaps on Arc mainnet and testnet", () => {
      expect(towerBridgeAdapter.supports(ARC_MAINNET, ARC_MAINNET)).toBe(true);
      expect(towerBridgeAdapter.supports(ARC_TESTNET, ARC_TESTNET)).toBe(true);
    });

    it("Tower refuses cross-chain routes and non-Arc same-chain swaps", () => {
      expect(towerBridgeAdapter.supports(ARC_MAINNET, ETH_MAINNET)).toBe(false);
      expect(towerBridgeAdapter.supports(ETH_MAINNET, ETH_MAINNET)).toBe(false);
      expect(towerBridgeAdapter.supports(BASE, BASE)).toBe(false);
    });

    it("LI.FI carries no chain list: it answers Arc too, as the fallback", () => {
      expect(lifiBridgeAdapter.supports(ARC_MAINNET, ARC_MAINNET)).toBe(true);
      expect(lifiBridgeAdapter.supports(ARC_TESTNET, ARC_TESTNET)).toBe(true);
    });

    it("LI.FI supports same-chain swaps on non-Arc EVM, Solana, and Sui chains", () => {
      expect(lifiBridgeAdapter.supports(ETH_MAINNET, ETH_MAINNET)).toBe(true);
      expect(lifiBridgeAdapter.supports(BASE, BASE)).toBe(true);
      expect(
        lifiBridgeAdapter.supports(
          "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
          "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        ),
      ).toBe(true);
      expect(lifiBridgeAdapter.supports("sui:mainnet", "sui:mainnet")).toBe(
        true,
      );
    });

    it("LI.FI supports cross-chain bridging", () => {
      expect(lifiBridgeAdapter.supports(ETH_MAINNET, BASE)).toBe(true);
    });
  });

  describe("Registry Resolution (resolveBridgeAdapters)", () => {
    const ARC_MAINNET = "eip155:5042";
    const ETH_MAINNET = "eip155:1";
    const BASE = "eip155:8453";

    it("tries Tower first for an Arc swap, with LI.FI as the fallback", () => {
      const adapters = resolveBridgeAdapters(ARC_MAINNET, ARC_MAINNET, "swap");
      expect(adapters.map((a) => a.key)).toEqual(["tower", "lifi"]);
    });

    it("resolves LI.FI for non-Arc same-chain swap", () => {
      const adapters = resolveBridgeAdapters(BASE, BASE, "swap");
      expect(adapters.map((a) => a.key)).toEqual(["lifi"]);
    });

    it("resolves LI.FI for cross-chain bridge and excludes Tower", () => {
      const adapters = resolveBridgeAdapters(ETH_MAINNET, BASE, "bridge");
      const keys = adapters.map((a) => a.key);
      expect(keys).toContain("lifi");
      expect(keys).not.toContain("tower");
    });
  });
});
