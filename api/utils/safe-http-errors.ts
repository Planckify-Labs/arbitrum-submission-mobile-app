import type { HTTPError } from "ky";
import { TimeoutError } from "ky";

/**
 * ky builds `TimeoutError` / `HTTPError` messages as
 * `Request timed out: GET https://<api host>/<path>`, which leaked the API
 * origin and endpoint to users wherever a screen rendered `error.message`.
 * Everything here keeps those errors machine-classifiable (same class, same
 * `name`, `response.status`) while guaranteeing the message carries no URL.
 */

const TIMEOUT_MESSAGE = "Request timed out.";

export class ApiTimeoutError extends TimeoutError {
  constructor() {
    // ky's constructor interpolates `request.url` into the message; hand it
    // an empty stub so the URL never exists, then replace the message.
    super({ method: "", url: "" } as Request);
    this.message = TIMEOUT_MESSAGE;
  }
}

type TFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Replaces ky's built-in timeout (its error cannot be intercepted via hooks)
 * with one that throws `ApiTimeoutError`. Being a `TimeoutError` subclass,
 * ky still treats it as non-retriable. Pair with ky's `timeout: false`.
 */
export const fetchWithSafeTimeout =
  (baseFetch: TFetch, timeoutMs: number): TFetch =>
  (input, init) => {
    const controller = new AbortController();
    const upstream = init?.signal;
    if (upstream) {
      if (upstream.aborted) controller.abort();
      else
        upstream.addEventListener("abort", () => controller.abort(), {
          once: true,
        });
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ApiTimeoutError());
      }, timeoutMs);
    });

    return Promise.race([
      baseFetch(input, { ...init, signal: controller.signal }),
      timeout,
    ]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
  };

/** ky `beforeError` hook: strips the URL from `HTTPError.message`. */
export const scrubHttpErrorMessage = (error: HTTPError): HTTPError => {
  error.message = "Request failed.";
  return error;
};
