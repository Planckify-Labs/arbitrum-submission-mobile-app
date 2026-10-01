/**
 * Bridge adapter registry.
 *
 * Spec: docs/bridge-capability-spec.md §5.2.
 *
 * Mirrors `services/defi/registry.ts`: register / get / list, no central
 * switch. Nothing here knows how many adapters exist or what they are
 * called.
 */

import { routeKindOf, type TCaip2, type TRouteKind } from "@/api/types/bridge";
import type { BridgeRouteAdapter, RouteAdapter } from "./types";

const adapters = new Map<string, RouteAdapter>();

export function registerBridgeAdapter(a: RouteAdapter): void {
  adapters.set(a.key, a);
}

export const registerRouteAdapter = registerBridgeAdapter;

export function getBridgeAdapter(key: string): RouteAdapter | null {
  return adapters.get(key) ?? null;
}

export const getRouteAdapter = getBridgeAdapter;

export function listBridgeAdapters(): RouteAdapter[] {
  return [...adapters.values()];
}

export const listRouteAdapters = listBridgeAdapters;

/** Test-only: drop every registration so suites start clean. */
export function resetBridgeAdapters(): void {
  adapters.clear();
}

export const resetRouteAdapters = resetBridgeAdapters;

/**
 * Adapters that can serve this route. Empty means a CAPABILITY BOUNDARY
 * (§7.6) — the card renders a plain explanatory state, not an error.
 */
export function resolveBridgeAdapters(
  from: TCaip2,
  to: TCaip2,
  kind?: TRouteKind,
): RouteAdapter[] {
  const targetKind = kind ?? routeKindOf(from, to);
  return listBridgeAdapters().filter((a) => {
    if (a.kinds && !a.kinds.includes(targetKind)) return false;
    return a.supports(from, to);
  });
}

export const resolveRouteAdapters = resolveBridgeAdapters;

/**
 * Pick the adapter that produced a quote, falling back to route
 * resolution when the caller has no provider key (e.g. a status poll
 * restored from history).
 */
export function adapterForQuote(
  provider: string | undefined,
  from: TCaip2,
  to: TCaip2,
  kind?: TRouteKind,
): RouteAdapter | null {
  if (provider) {
    const direct = getBridgeAdapter(provider);
    if (direct) return direct;
  }
  return resolveBridgeAdapters(from, to, kind)[0] ?? null;
}
