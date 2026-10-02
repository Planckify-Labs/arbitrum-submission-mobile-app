/**
 * Run from mobile-app root:
 *   node --test --experimental-strip-types \
 *        --import ./services/walletKit/evm/_test-resolver.mjs \
 *        services/tokens/tokenSupport.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { filterSupportedTokens, isTokenSupported } from "./tokenSupport.ts";

const USDG_ARBITRUM = "0x004B506865409877C9fA29bfb1ebA929984B9bbC";

describe("stablecoin lockdown (USDG only)", () => {
  it("keeps USDG at its real address on every surfaced chain", () => {
    for (const address of [
      USDG_ARBITRUM,
      "0xFFC95faa3d63Cde504a05B567C600B78C0b41892",
      "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
      "0x7E955252E15c84f5768B83c41a71F9eba181802F",
    ]) {
      assert.equal(
        isTokenSupported({
          symbol: "USDG",
          contractAddress: address,
          isStablecoin: true,
        }),
        true,
        address,
      );
    }
  });

  it("hides a lookalike named USDG at the wrong address", () => {
    assert.equal(
      isTokenSupported({
        symbol: "USDG",
        contractAddress: "0x000000000000000000000000000000000000dEaD",
      }),
      false,
    );
  });

  it("hides every other stablecoin, flagged or recognised by symbol", () => {
    for (const symbol of ["USDC", "USDT", "DAI", "USDC.e", "PYUSD", "EURC"]) {
      assert.equal(isTokenSupported({ symbol, isStablecoin: true }), false);
      assert.equal(isTokenSupported({ symbol }), false, `${symbol} (no flag)`);
    }
    // A flagged stablecoin with an unknown symbol is still hidden.
    assert.equal(
      isTokenSupported({ symbol: "XYZUSD", isStablecoin: true }),
      false,
    );
  });

  it("always keeps the native token, even if it looks like a stablecoin", () => {
    assert.equal(
      isTokenSupported({ symbol: "ETH", isNativeCurrency: true }),
      true,
    );
    assert.equal(
      isTokenSupported({ symbol: "USDC", isNativeCurrency: true }),
      true,
    );
  });

  it("leaves non-stablecoins alone", () => {
    for (const symbol of ["WETH", "ARB", "LINK", "TSLA"]) {
      assert.equal(isTokenSupported({ symbol, isStablecoin: false }), true);
    }
  });

  it("filters a mixed list down to native + USDG + non-stablecoins", () => {
    const list = [
      { symbol: "ETH", isNativeCurrency: true },
      { symbol: "USDC", isStablecoin: true },
      { symbol: "USDT", isStablecoin: true },
      { symbol: "USDG", isStablecoin: true, contractAddress: USDG_ARBITRUM },
      { symbol: "WETH", isStablecoin: false },
    ];
    assert.deepEqual(
      filterSupportedTokens(list).map((t) => t.symbol),
      ["ETH", "USDG", "WETH"],
    );
  });
});
