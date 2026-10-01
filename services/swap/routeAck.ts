/**
 * What the USER confirmed on a quote card, for the execute call to read.
 *
 * Spec: docs/swap-capability-spec.md §6.1, §7.2 (the acknowledgement carries
 * the accepted number, and is never model-supplied), §8.4 L1 (a symbol-hint
 * mismatch, or an output token we cannot vouch for, forces an explicit
 * confirmation).
 *
 * The card records it when the user taps; `swap_execute` / `bridge_execute`
 * read it here and ignore any acknowledgement the model sends as an argument.
 *
 * Keyed by the exact route AND amount, so an acknowledgement given for one
 * swap never covers a different one, and it expires: a confirmation must
 * not outlive the decision it was given for. In memory only.
 */

import type { TBridgeQuote } from "@/api/types/bridge";

export interface RouteAck {
  /** The price impact the user accepted, in bps (a ceiling, not a flag). */
  impactBps?: number;
  /** The user saw and accepted a token that differs from what they asked for. */
  symbolsConfirmed?: boolean;
  /** The user accepted receiving a token we cannot vouch for (§8.4 L1, T8). */
  unverifiedConfirmed?: boolean;
}

interface StoredAck extends RouteAck {
  at: number;
}

/** Ten minutes: longer than any quote TTL, short enough to be this decision. */
export const ROUTE_ACK_TTL_MS = 10 * 60 * 1000;

const acks = new Map<string, StoredAck>();

type RouteKeySource = Pick<TBridgeQuote, "from" | "to">;

/**
 * The route identity: both chains, both tokens (as the backend spelled
 * them, the same on the card's quote and the execute re-quote), and the
 * amount. Case is preserved: folding would conflate base58 mints.
 */
export function routeAckKey(quote: RouteKeySource): string {
  return [
    quote.from.chain,
    quote.from.token.caip19,
    quote.to.chain,
    quote.to.token.caip19,
    quote.from.amountRaw,
  ].join("|");
}

/** `routeAckKey` for a partially-typed payload; `null` if a part is missing. */
export function routeAckKeyOf(side: {
  from?: { chain?: string; token?: { caip19?: string }; amountRaw?: string };
  to?: { chain?: string; token?: { caip19?: string } };
}): string | null {
  const parts = [
    side.from?.chain,
    side.from?.token?.caip19,
    side.to?.chain,
    side.to?.token?.caip19,
    side.from?.amountRaw,
  ];
  return parts.every((p) => typeof p === "string" && p.length > 0)
    ? parts.join("|")
    : null;
}

export const routeAck = {
  /** Merge into any acknowledgement already recorded for this route. */
  record(key: string, ack: RouteAck, now: number = Date.now()): void {
    const prev = this.get(key, now) ?? {};
    const next: StoredAck = { ...prev, at: now };
    if (typeof ack.impactBps === "number" && Number.isFinite(ack.impactBps)) {
      next.impactBps = Math.max(0, Math.ceil(ack.impactBps));
    }
    if (ack.symbolsConfirmed) next.symbolsConfirmed = true;
    if (ack.unverifiedConfirmed) next.unverifiedConfirmed = true;
    acks.set(key, next);
  },
  get(key: string, now: number = Date.now()): RouteAck | undefined {
    const stored = acks.get(key);
    if (!stored) return undefined;
    if (now - stored.at > ROUTE_ACK_TTL_MS) {
      acks.delete(key);
      return undefined;
    }
    const { at: _at, ...ack } = stored;
    return ack;
  },
  clear(key: string): void {
    acks.delete(key);
  },
  __resetForTests(): void {
    acks.clear();
  },
};

// ── Symbol hints (§7.2) ───────────────────────────────────────────────

/**
 * Fold a symbol for comparison: Unicode compatibility form, upper case,
 * the Tether glyph as `T`, whitespace dropped. `USDC.e` stays distinct
 * from `USDC` on purpose: that difference is exactly what the hint exists
 * to catch.
 */
export function foldSymbol(symbol: string): string {
  return symbol
    .normalize("NFKC")
    .toUpperCase()
    .replace(/₮/g, "T")
    .replace(/\s+/g, "");
}

export interface SymbolMismatch {
  side: "from" | "to";
  /** What the model said the user asked for. */
  expected: string;
  /** What the route actually moves. */
  actual: string;
}

/** Where the model's advisory symbol hints disagree with the quoted tokens. */
export function symbolMismatches(
  hints: { from?: string; to?: string },
  quote: RouteKeySource,
): SymbolMismatch[] {
  const out: SymbolMismatch[] = [];
  for (const side of ["from", "to"] as const) {
    const hint = hints[side]?.trim();
    const actual = quote[side].token.symbol;
    if (hint && actual && foldSymbol(hint) !== foldSymbol(actual)) {
      out.push({ side, expected: hint, actual });
    }
  }
  return out;
}

// ── Token provenance (§8.4 L1, T8) ────────────────────────────────────

/**
 * Does the user have to confirm the token this route DELIVERS?
 *
 * A symbol is not an identity: anyone can deploy a token called "USDC",
 * and every asset has its own address on every chain. Only `verified`
 * (the issuer's pin, or our own catalogue, vouched by the backend for that
 * exact contract on that chain) or the chain's native asset passes
 * silently. `unverified` and `unknown` both need the user's tap on the
 * card. Deliberately no USD threshold (the spec allows one): a fake token
 * is worthless at any size, and the price we would gate on comes from the
 * same provider that could not vouch for it.
 */
export function needsTokenConfirmation(quote: {
  to?: { token?: { isNative?: boolean; verification?: string } };
}): boolean {
  const token = quote.to?.token;
  if (!token) return false;
  return token.isNative !== true && token.verification !== "verified";
}
