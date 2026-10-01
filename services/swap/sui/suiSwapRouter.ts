/**
 * Sui swap router (spec §4.5) — the `swap` entry point the compiler calls.
 *
 * Mirrors the removed EVM aggregator's `getSwapRoute` shape: takes the
 * resolved pair + amount, runs the network-gated venue selector, and
 * returns a finished `sui-ptb` route (with `expectedOut` / `priceImpact`
 * for the guardian). Throws a typed `SuiSwapError` — never a raw SDK/RPC
 * string — which the executor maps to friendly copy.
 */

import {
  SuiSwapError,
  type SuiSwapRoute,
  type SuiSwapRouteParams,
  type SuiSwapVenue,
} from "./types";
import { selectSwapRoute } from "./venueSelector";

export async function getSuiSwapRoute(
  params: SuiSwapRouteParams,
  venues?: SuiSwapVenue[],
): Promise<SuiSwapRoute> {
  const route = await selectSwapRoute(params, venues);
  if (!route) {
    throw new SuiSwapError(
      "no_swap_route",
      `no swap route for ${params.fromSymbol}->${params.toSymbol} on ${params.chain.network}`,
    );
  }
  return route;
}
