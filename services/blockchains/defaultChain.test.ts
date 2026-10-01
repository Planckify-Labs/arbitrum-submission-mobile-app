/**
 * Run from mobile-app root:
 *   node --test --experimental-strip-types \
 *     --import ./services/walletKit/evm/_test-resolver.mjs \
 *     services/blockchains/defaultChain.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { TBlockchain } from "@/api/types/blockchain";
import { pickOnboardingDefaultChainId } from "./defaultChain.ts";

const row = (chainId: number | null, extra: Partial<TBlockchain> = {}) =>
  ({ chainId, isActive: true, isTestnet: false, ...extra }) as TBlockchain;

describe("pickOnboardingDefaultChainId", () => {
  it("prefers Arc mainnet wherever it sits in the feed", () => {
    assert.equal(
      pickOnboardingDefaultChainId([row(1), row(137), row(5042)]),
      5042,
    );
  });

  it("falls back to the first mainnet row when Arc is absent", () => {
    assert.equal(
      pickOnboardingDefaultChainId([
        row(null),
        row(11155111, { isTestnet: true }),
        row(137),
        row(1),
      ]),
      137,
    );
  });

  it("ignores an inactive or testnet Arc row", () => {
    assert.equal(
      pickOnboardingDefaultChainId([
        row(5042, { isActive: false }),
        row(5042, { isTestnet: true }),
        row(1),
      ]),
      1,
    );
  });

  it("uses a testnet only when nothing else is selectable", () => {
    assert.equal(
      pickOnboardingDefaultChainId([row(5042002, { isTestnet: true })]),
      5042002,
    );
  });

  it("returns undefined for an empty feed", () => {
    assert.equal(pickOnboardingDefaultChainId([]), undefined);
  });
});
