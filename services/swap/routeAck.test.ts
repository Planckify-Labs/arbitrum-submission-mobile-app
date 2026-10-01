/**
 * The user's confirmations on a quote card (swap spec §6.1, §7.2): bound to
 * one route and amount, expiring, never model-supplied.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { TBridgeQuote } from "@/api/types/bridge";
import {
  foldSymbol,
  needsTokenConfirmation,
  ROUTE_ACK_TTL_MS,
  routeAck,
  routeAckKey,
  symbolMismatches,
} from "./routeAck";

const q = (amountRaw: string, fromSym = "USDC", toSym = "EURC") =>
  ({
    from: {
      chain: "eip155:5042",
      amountRaw,
      token: { caip19: "eip155:5042/erc20:0xA", symbol: fromSym },
    },
    to: {
      chain: "eip155:5042",
      token: { caip19: "eip155:5042/erc20:0xB", symbol: toSym },
    },
  }) as unknown as TBridgeQuote;

describe("routeAck", () => {
  beforeEach(() => routeAck.__resetForTests());

  it("binds to the amount: an ack for 10 never covers 1000", () => {
    routeAck.record(routeAckKey(q("10")), { impactBps: 1200 });
    expect(routeAck.get(routeAckKey(q("10")))?.impactBps).toBe(1200);
    expect(routeAck.get(routeAckKey(q("1000")))).toBeUndefined();
  });

  it("expires", () => {
    routeAck.record("k", { symbolsConfirmed: true }, 0);
    expect(routeAck.get("k", ROUTE_ACK_TTL_MS - 1)?.symbolsConfirmed).toBe(
      true,
    );
    expect(routeAck.get("k", ROUTE_ACK_TTL_MS + 1)).toBeUndefined();
  });

  it("merges confirmations recorded separately", () => {
    routeAck.record("k", { symbolsConfirmed: true });
    routeAck.record("k", { impactBps: 1500.2 });
    expect(routeAck.get("k")).toEqual({
      symbolsConfirmed: true,
      impactBps: 1501,
    });
  });
});

describe("symbol hints", () => {
  it("folds case and the Tether glyph, keeps USDC.e distinct", () => {
    expect(foldSymbol("usd₮0")).toBe(foldSymbol("USDT0"));
    expect(foldSymbol("USDC.e")).not.toBe(foldSymbol("USDC"));
  });

  it("reports only real mismatches, per side", () => {
    expect(symbolMismatches({ from: "usdc", to: "EURC" }, q("1"))).toEqual([]);
    expect(symbolMismatches({ to: "USDC" }, q("1", "USDC", "USDC.e"))).toEqual([
      { side: "to", expected: "USDC", actual: "USDC.e" },
    ]);
    expect(symbolMismatches({}, q("1"))).toEqual([]);
  });
});

describe("needsTokenConfirmation (§8.4 L1)", () => {
  const to = (token: object) => ({ to: { token } });

  it("passes only a vouched token or the native asset", () => {
    expect(needsTokenConfirmation(to({ verification: "verified" }))).toBe(
      false,
    );
    expect(
      needsTokenConfirmation(to({ isNative: true, verification: "unknown" })),
    ).toBe(false);
  });

  it("asks for anything else, whatever its symbol says", () => {
    expect(
      needsTokenConfirmation(
        to({ symbol: "USDC", verification: "unverified" }),
      ),
    ).toBe(true);
    expect(needsTokenConfirmation(to({ verification: "unknown" }))).toBe(true);
    expect(needsTokenConfirmation(to({}))).toBe(true);
  });

  it("records the confirmation alongside the others", () => {
    routeAck.__resetForTests();
    routeAck.record("k", { symbolsConfirmed: true });
    routeAck.record("k", { unverifiedConfirmed: true });
    expect(routeAck.get("k")).toEqual({
      symbolsConfirmed: true,
      unverifiedConfirmed: true,
    });
  });
});
