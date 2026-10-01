/**
 * Run from mobile-app root:
 *   node --test --experimental-strip-types \
 *        --import ./services/walletKit/evm/_test-resolver.mjs \
 *        services/walletKit/chainSupport.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { TBlockchain } from "@/api/types/blockchain";
import {
  CHAIN_LOCKDOWN_ACTIVE,
  filterSupportedBlockchains,
  isChainIdSupported,
  isNamespaceSupported,
  LOCKDOWN_CHAIN_IDS,
  LOCKDOWN_DEFAULT_CHAIN_ID,
} from "./chainSupport.ts";

const row = (chainId: number | null, type: string): TBlockchain =>
  ({ chainId, type, isEVM: type === "EVM" }) as unknown as TBlockchain;

describe("chain lockdown (Arbitrum + Robinhood)", () => {
  it("is on by default for this build", () => {
    assert.equal(CHAIN_LOCKDOWN_ACTIVE, true);
  });

  it("allows Arbitrum One, Arbitrum Sepolia, Robinhood mainnet and testnet", () => {
    for (const id of [42161, 421614, 4663, 46630]) {
      assert.equal(isChainIdSupported(id), true, `chain ${id}`);
    }
    assert.equal(LOCKDOWN_CHAIN_IDS.length, 4);
  });

  it("hides every other chain id, including Monad and Ethereum", () => {
    for (const id of [1, 137, 56, 143, 10143, 5042002, null, undefined]) {
      assert.equal(isChainIdSupported(id), false, `chain ${id}`);
    }
  });

  it("only the eip155 namespace is surfaced", () => {
    assert.equal(isNamespaceSupported("eip155"), true);
    for (const ns of ["solana", "sui", "stellar"] as const) {
      assert.equal(isNamespaceSupported(ns), false, ns);
    }
  });

  it("defaults to Arbitrum One, which is itself allowed", () => {
    assert.equal(LOCKDOWN_DEFAULT_CHAIN_ID, 42161);
    assert.equal(isChainIdSupported(LOCKDOWN_DEFAULT_CHAIN_ID), true);
  });

  it("filters a /blockchains feed down to the four chains", () => {
    const feed = [
      row(1, "EVM"),
      row(42161, "EVM"),
      row(421614, "EVM"),
      row(4663, "EVM"),
      row(46630, "EVM"),
      row(143, "EVM"),
      row(null, "SOLANA"),
    ];
    assert.deepEqual(
      filterSupportedBlockchains(feed).map((b) => b.chainId),
      [42161, 421614, 4663, 46630],
    );
  });
});
