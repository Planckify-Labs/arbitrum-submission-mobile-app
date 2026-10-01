/**
 * Last line of defence against backend / RPC endpoints reaching a user or
 * the LLM. Call sites are still expected to emit curated copy; this catches
 * the ones that forget (a library error message, a template that embeds
 * `err.message`). Raw detail belongs in `__DEV__` logs only.
 */

const URL_SCHEME = /\b[a-z][a-z0-9+.-]{1,15}:\/\//i;
const HOST_WITH_TLD =
  /\b(?:[a-z0-9-]+\.)+(?:xyz|com|io|net|org|dev|app|co|id|ai|cloud|finance|network|so|fi|sh|me)\b(?::\d+)?/i;
const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/;
const HTTP_VERB_PATH = /\b(?:GET|POST|PUT|PATCH|DELETE|HEAD)\s+\/?\S+/;
const LIBRARY_PHRASES =
  /request (?:timed out|failed)|status code|HTTP request failed|Request body|\bURL:|Docs:|Version: viem|stack|\bat \S+ \(/i;
const STRUCTURED_BLOB = /[{}[\]]/;

/** True when `text` looks like it carries an endpoint, URL, or library dump. */
export function containsEndpointLeak(text: string): boolean {
  return (
    URL_SCHEME.test(text) ||
    HOST_WITH_TLD.test(text) ||
    IPV4.test(text) ||
    HTTP_VERB_PATH.test(text) ||
    LIBRARY_PHRASES.test(text) ||
    STRUCTURED_BLOB.test(text)
  );
}

const URL_TOKEN = /\b[a-z][a-z0-9+.-]{1,15}:\/\/\S*/gi;
const HOST_TOKEN = new RegExp(HOST_WITH_TLD.source + "(?:\\/\\S*)?", "gi");

/**
 * Lighter-touch variant for surfaces that must keep the rest of the message
 * (EIP-1193 errors handed to a dApp): swaps only URLs / hostnames for a
 * placeholder so our RPC and API endpoints never leave the app.
 */
export function redactEndpoints(text: string): string {
  return text
    .replace(URL_TOKEN, "[redacted]")
    .replace(HOST_TOKEN, "[redacted]");
}

const MAX_CURATED_LENGTH = 120;

const isCurated = (text: string): boolean =>
  text.length <= MAX_CURATED_LENGTH && !containsEndpointLeak(text);

type TFailureShape = { status?: unknown; error?: unknown; reason?: unknown };

/**
 * Scrubs the free-text fields of a failed tool result. `error` falls back to
 * the generic code, `reason` is dropped. Successful results and result
 * payloads (`data`) are never touched.
 */
export function scrubToolFailure<T extends TFailureShape>(result: T): T {
  if (result.status !== "failed") return result;
  let next = result;
  if (typeof result.error === "string" && !isCurated(result.error)) {
    next = { ...next, error: "unknown_error" };
  }
  if (typeof result.reason === "string" && !isCurated(result.reason)) {
    const { reason: _dropped, ...rest } = next;
    next = rest as T;
  }
  return next;
}
