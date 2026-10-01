import { describe, expect, it } from "vitest";
import { containsEndpointLeak, scrubToolFailure } from "./leakGuard";

describe("containsEndpointLeak", () => {
  it.each([
    "Request timed out: GET https://dev.api.takumipay.xyz/redeem/01M3",
    "failed to fetch address book: Request timed out.",
    "HTTP request failed.\n\nURL: https://eth-mainnet.g.alchemy.com/v2/key",
    "connect ECONNREFUSED 10.0.0.4:8080",
    "dev.api.takumipay.xyz",
    '{"code":"stt_not_configured"}',
    "GET /redeem/abc",
  ])("flags %s", (s) => expect(containsEndpointLeak(s)).toBe(true));

  it.each([
    "no connected wallet",
    "intent_expired",
    "token_list_unavailable",
    "chain_id 1 is not supported by this wallet",
    "cadence must be weekly or monthly",
  ])("allows %s", (s) => expect(containsEndpointLeak(s)).toBe(false));
});

describe("scrubToolFailure", () => {
  it("drops a leaking reason and keeps the code", () => {
    const out = scrubToolFailure({
      status: "failed",
      error: "network_error",
      reason: "Request timed out: GET https://dev.api.takumipay.xyz/x",
    });
    expect(out).toEqual({ status: "failed", error: "network_error" });
  });

  it("replaces a leaking error with unknown_error", () => {
    const out = scrubToolFailure({
      status: "failed",
      error: "https://dev.api.takumipay.xyz/x",
    });
    expect(out.error).toBe("unknown_error");
  });

  it("never touches successful results", () => {
    const ok = { status: "success", data: { url: "https://x.test" } };
    expect(scrubToolFailure(ok)).toBe(ok);
  });
});
