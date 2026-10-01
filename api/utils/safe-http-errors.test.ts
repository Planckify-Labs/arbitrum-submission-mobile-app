import ky, { HTTPError, TimeoutError } from "ky";
import { describe, expect, it } from "vitest";
import {
  ApiTimeoutError,
  fetchWithSafeTimeout,
  scrubHttpErrorMessage,
} from "./safe-http-errors";

const URL_RE = /https?:\/\/|takumipay|\/redeem/i;

describe("safe-http-errors", () => {
  it("timeout error is a TimeoutError with no URL in the message", async () => {
    const hang = () => new Promise<Response>(() => {});
    const client = ky.create({
      prefixUrl: "https://dev.api.takumipay.xyz",
      timeout: false,
      fetch: fetchWithSafeTimeout(hang, 20),
    });
    const err = await client
      .get("redeem/abc")
      .json()
      .catch((e) => e);
    expect(err).toBeInstanceOf(ApiTimeoutError);
    expect(err).toBeInstanceOf(TimeoutError);
    expect(err.name).toBe("TimeoutError");
    expect(err.message).not.toMatch(URL_RE);
  });

  it("GET timeouts are not retried", async () => {
    let calls = 0;
    const hang = () => {
      calls++;
      return new Promise<Response>(() => {});
    };
    const client = ky.create({
      prefixUrl: "https://x.test",
      timeout: false,
      retry: { limit: 2, methods: ["get"] },
      fetch: fetchWithSafeTimeout(hang, 20),
    });
    await client
      .get("a")
      .json()
      .catch(() => {});
    expect(calls).toBe(1);
  });

  it("scrubs the URL from HTTPError messages but keeps the status", async () => {
    const client = ky.create({
      prefixUrl: "https://dev.api.takumipay.xyz",
      retry: 0,
      hooks: { beforeError: [scrubHttpErrorMessage] },
      fetch: async () => new Response("{}", { status: 500 }),
    });
    const err = await client
      .get("redeem/abc")
      .json()
      .catch((e) => e);
    expect(err).toBeInstanceOf(HTTPError);
    expect(err.message).not.toMatch(URL_RE);
    expect(err.response.status).toBe(500);
  });
});
