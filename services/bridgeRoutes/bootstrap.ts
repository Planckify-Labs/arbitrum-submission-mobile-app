/**
 * Bridge adapter registration.
 *
 * Spec: docs/bridge-capability-spec.md §5.2.
 *
 * The ONLY place that knows the adapter set. Adding a provider (Bitcoin,
 * a Stellar-native bridge when one exists) is one `register` call plus
 * the adapter file — no enum edit, no branch in shared code, and nothing
 * under `components/`, `hooks/`, or `app/` learns a namespace string.
 *
 * Mirrors `services/defi/bootstrap.ts`, and is idempotent for the same
 * reason: Fast Refresh and test harnesses re-import modules freely.
 */

import { cctpStellarBridgeAdapter } from "./adapters/cctpStellarAdapter";
import {
  circleCctpBridgeAdapter,
  circleCctpxBridgeAdapter,
} from "./adapters/circle/circleAdapters";
import {
  evmAppKitSigner,
  registerAppKitSigner,
} from "./adapters/circle/signers";
import { lifiBridgeAdapter } from "./adapters/lifiAdapter";
import { towerBridgeAdapter } from "./adapters/towerAdapter";
import { listBridgeAdapters, registerBridgeAdapter } from "./registry";

let booted = false;

export function bootstrapBridgeAdapters(): void {
  if (booted && listBridgeAdapters().length > 0) return;

  // Registration order is the tie-break when several adapters answer a
  // route: specialists first, the generalist (`lifi`) last. Mirrors the
  // backend, which stamps the chosen provider on every quote anyway.

  // `tower` — same-chain swaps on the chains Tower serves.
  registerBridgeAdapter(towerBridgeAdapter);

  // `circle-cctp` / `circle-cctpx` — USDC and EURC through Circle's Arc
  // App Kit, run on the device with the user's signer (§5.4). The backend
  // prefers them over LI.FI for those assets; LI.FI stays the fallback.
  registerBridgeAdapter(circleCctpBridgeAdapter);
  registerBridgeAdapter(circleCctpxBridgeAdapter);
  // App Kit needs a signer per source namespace. Only EVM today (App
  // Kit's Viem adapter); a Solana source docks with one more line here.
  registerAppKitSigner("eip155", evmAppKitSigner);

  // `cctp` — USDC between EVM and Stellar, both directions, as raw CCTP
  // calls: App Kit does not reach Stellar (§3.2, §5.4).
  registerBridgeAdapter(cctpStellarBridgeAdapter);

  // `lifi` — any asset, EVM + Solana + Sui. Misses Stellar. Last.
  registerBridgeAdapter(lifiBridgeAdapter);

  booted = true;
}
