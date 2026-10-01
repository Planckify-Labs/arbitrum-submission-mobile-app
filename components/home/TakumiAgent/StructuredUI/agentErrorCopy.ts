/**
 * agentErrorCopy — the single mapping from an agent tool failure to
 * user-facing copy.
 *
 * A failed `ToolResult` carries two curated strings (see
 * `services/agent-executors/types.ts`):
 *   - `error`  — the COARSE code from the closed `ExecutorErrorCode` taxonomy
 *                (`stale_precondition`, `insufficient_funds`, …). The agent
 *                branches on this; it changes rarely.
 *   - `reason` — the OPTIONAL granular sub-reason (`intent_expired`,
 *                `quote_stale`, `amount_below_minimum`, …). Open per-tool
 *                detail, set from the thrown `ExecutorError.message`.
 *
 * Every failure card runs both through here so it can be specific WITHOUT ever
 * rendering a raw code (CLAUDE.md user-facing-errors). Lookup prefers the more
 * specific `reason`, then falls back to the coarse `error`, then a friendly
 * generic line. New protocols get sensible copy for free: their failures land
 * on an existing coarse code, and a bespoke `reason` only needs an entry here
 * if it deserves more specific wording than its code's default.
 *
 * All copy is hand-written — no raw runtime / response text reaches the user.
 */

import type { Namespace } from "@/services/chains/types";
import {
  type DefiErrorCode,
  defiErrorCopy,
} from "@/services/defi/errors/defiErrors";

const COPY: Record<string, string> = {
  // --- coarse ExecutorErrorCode taxonomy --------------------------------
  stale_precondition:
    "Conditions changed before this could run. Let me re-check and prepare a fresh plan.",
  insufficient_funds:
    "You don't have enough balance for this, including a little for gas.",
  network_error: "The network is busy right now. Please try again in a moment.",
  unsupported_chain: "That isn't available on this network yet.",
  wallet_type_cannot_execute: "This wallet can't sign transactions.",
  not_implemented: "That isn't supported here yet.",
  invalid_input: "I couldn't read that request. Try rephrasing what you want.",

  // --- missing-wallet family --------------------------------------------
  // These reasons were all being thrown with no entry here, so they fell
  // through to their coarse code and told the user "That isn't available
  // on this network yet." The network was always fine; the user simply
  // held no key on it, which is both a different problem and a fixable
  // one. `wallet_cannot_execute` was worse still: its coarse code is
  // `invalid_input`, so a missing signer rendered as "I couldn't read
  // that request."
  wallet_not_evm:
    "This action needs an Ethereum wallet. Add one, then try again.",
  wallet_not_solana:
    "This action needs a Solana wallet. Add one, then try again.",
  wallet_not_sui: "This action needs a Sui wallet. Add one, then try again.",
  wallet_not_stellar:
    "This action needs a Stellar wallet. Add one, then try again.",
  wallet_cannot_execute:
    "This wallet can't sign that transaction. Switch to one that can, or add a wallet for this chain.",

  // --- granular reasons (more specific than their coarse code) ----------
  // stale_precondition family
  intent_expired: "That plan expired. Let me prepare a fresh one.",
  intent_no_longer_safe:
    "The on-chain situation moved since I prepared this. Let me re-check and offer a safer plan.",
  quote_stale:
    "The price moved while preparing this. Let me get a fresh quote.",
  // swap / route safety reasons
  price_impact_too_high:
    "This swap would move the price a lot. Review the price impact on the card and confirm it there, or try a smaller amount.",
  provider_disabled:
    "That swap route is paused right now. Please try again later.",
  bridge_payload_mismatch:
    "I couldn't verify this route, so I didn't sign it. Please get a fresh quote.",
  quote_floor_invalid:
    "This quote doesn't guarantee a safe minimum, so I didn't sign it. Please get a fresh quote.",
  min_receive_required:
    "I need the minimum amount shown on the quote before swapping. Let me get a fresh quote.",
  asset_symbol_mismatch:
    "This route uses a different token than the one you named. Check the token on the quote card and confirm it there first.",
  unverified_token_unconfirmed:
    "We can't verify the token you'd receive. Check its address on the quote card and confirm it there first.",
  chain_not_enabled: "We do not support that network yet.",
  unknown_token:
    "I couldn't find that token on this network. Let me look it up and try again.",
  route_already_submitted:
    "This transfer is already being sent. Check your activity before trying again.",
  route_simulation_failed:
    "This route would fail if sent, so I didn't sign it. Let me get a fresh quote.",
  counterparty_blocked:
    "I can't send funds through this route. Please try a different one.",
  // insufficient_funds family
  insufficient_balance:
    "You don't have enough balance for this, including a little for gas.",
  // stablecoin-gas family (`transfer_erc20` via `resolveGasPayment`). The
  // token is whichever the user picked in Gas Settings, so the copy names
  // the setting rather than a hardcoded symbol.
  insufficient_fee_token_for_gas:
    "You don't have enough of your chosen gas token to cover this transfer plus the network fee. Top it up, or switch the fee currency to native in Gas Settings.",
  relayed_transfer_failed:
    "I couldn't send this with the fee paid in your chosen gas token. Please try again, or switch the fee currency to native in Gas Settings.",
  // invalid_input family
  invalid_intent: "I couldn't read that plan. Try rephrasing what you want.",
  unsupported_asset: "That asset isn't available on this network.",
  no_onchain_balance: "You don't hold that asset on this network.",
  no_wallet_on_destination_chain:
    "You don't have a wallet on the destination chain yet. Set one up, then try again.",
  // Recovery is a re-quote, which fills in the destination the card shows.
  destination_not_confirmed:
    "Let me price this again so you can see exactly which wallet it lands in before you approve.",
  invalid_to_address_format:
    "That doesn't look like a valid address for the destination chain.",
  destination_not_ready:
    "The destination wallet isn't ready to receive this yet.",
  destination_missing_trustline:
    "The destination wallet needs to accept this asset first. Add a trustline for it, then try again.",
  // swap-specific reasons surfaced by the Sui Intent preview path
  amount_below_minimum:
    "That amount is below the minimum for this swap. Try a larger amount.",
  no_swap_route: "I couldn't find a swap route for that pair right now.",
  unsupported_pair: "That token pair isn't available to swap here.",
};

const FALLBACK =
  "I couldn't complete that right now. Try again in a moment, or adjust the amount.";

/**
 * The capability facades build their reason by interpolating the active
 * namespace (`no native send route for namespace solana`), so these can't
 * be keyed in `COPY` directly. They all mean the same thing to a user.
 */
const ROUTE_REASON_PREFIXES = [
  "no native send route for namespace",
  "no token send route for namespace",
  "no route for namespace",
];

const ROUTE_REASON_COPY =
  "This wallet's chain can't do that. Switch chains, or add a wallet that can.";

/**
 * Reasons that name their own namespace, so a card can offer to add the
 * right wallet without knowing anything about the tool that failed.
 */
const NAMESPACE_BY_REASON: Record<string, Namespace> = {
  wallet_not_evm: "eip155",
  wallet_not_solana: "solana",
  wallet_not_sui: "sui",
  wallet_not_stellar: "stellar",
};

/** An offer the failure card can render as a button. */
export type AgentErrorAction = { kind: "add_wallet"; namespace: Namespace };

/**
 * Resolve `(error, reason)` to friendly copy. Prefers the granular `reason`,
 * then the coarse `error`, then a generic fallback.
 */
export function agentErrorCopy(
  error: string | undefined,
  reason?: string | undefined,
): string {
  if (reason) {
    const exact = COPY[reason];
    if (exact) return exact;
    if (ROUTE_REASON_PREFIXES.some((p) => reason.startsWith(p))) {
      return ROUTE_REASON_COPY;
    }
    // The DeFi executors set `reason` to a `DefiErrorCode`, and every one of
    // those already has hand-written copy that the Strategies screen shows.
    // Reuse it instead of dropping the user onto the generic line: "This pool
    // is paused right now" beats "I couldn't complete that right now", and it
    // keeps the two surfaces saying the same thing about the same failure.
    const defi = defiErrorCopy[reason as DefiErrorCode];
    if (defi) return defi.body;
  }
  return (error && COPY[error]) || FALLBACK;
}

/**
 * The short headline for a failure, when the surface has room for one.
 * Cards that show only a line of text ignore this.
 */
export function agentErrorTitle(reason?: string | undefined): string | null {
  if (!reason) return null;
  return defiErrorCopy[reason as DefiErrorCode]?.title ?? null;
}

/**
 * The action, if any, that would clear this failure — currently only
 * "add a wallet on chain X".
 *
 * Kept separate from `agentErrorCopy` rather than folded into a single
 * return object so the many cards that just render a line of text stay
 * unchanged. Cards that can host a button call this too.
 *
 * `destinationNamespace` is for failures whose chain lives in the tool's
 * payload rather than in the reason string (a bridge knows its
 * `to_chain`; the reason `no_wallet_on_destination_chain` does not).
 */
export function agentErrorAction(
  error: string | undefined,
  reason?: string | undefined,
  destinationNamespace?: Namespace,
): AgentErrorAction | null {
  if (reason) {
    const named = NAMESPACE_BY_REASON[reason];
    if (named) return { kind: "add_wallet", namespace: named };
    if (reason === "no_wallet_on_destination_chain" && destinationNamespace) {
      return { kind: "add_wallet", namespace: destinationNamespace };
    }
  }
  // `wallet_cannot_execute` deliberately offers nothing: it can mean a
  // watch-only wallet just as easily as a missing one, and we'd be
  // guessing which chain to point at.
  void error;
  return null;
}
