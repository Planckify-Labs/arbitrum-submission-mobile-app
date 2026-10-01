/**
 * Layer 1 — target identity and provenance (spec §11 Layer 1).
 *
 * "Is this the *real* contract?" — the core of the whole safety ask. Every
 * check here is **provider-backed**: written once against
 * `ChainSafetyProvider`, so it covers a new chain the moment that chain's
 * provider is registered, with no edit to the check itself.
 *
 * Layer 1 normally runs at backend resolve time (`validation.ts` is its
 * server-side twin). Running it again on device is not redundancy for its own
 * sake — it is the second of the two independent trust anchors (§11.1): a
 * compromised backend cannot hand the device a target the device would not
 * itself accept.
 */

import { getChainSafetyProvider } from "../registry";
import { pinnedRouterFor } from "../routeTargets";
import { NO_TARGET_TO_VERIFY, type SafetyCheck } from "../types";

/**
 * `EXTCODESIZE > 0` on EVM, "object exists with the expected type" on Sui,
 * "account exists and is owned by the expected program" on Solana. One check,
 * one meaning: there is something executable at the destination.
 */
export const TargetHasCodeCheck: SafetyCheck = {
  id: "target-has-code",
  layer: 1,
  appliesTo: { requiresTarget: true },
  run: async (ctx) => {
    if (!ctx.target) return NO_TARGET_TO_VERIFY;
    const provider = getChainSafetyProvider(ctx.namespace);
    if (!provider) {
      // No provider ⇒ we cannot verify anything about this chain's targets.
      // §11.3: a chain with a partial provider is read-only/Manual, never
      // "in-app".
      return {
        ok: false,
        fail: "unsupported_chain",
        detail: `no safety provider registered for ${ctx.namespace}`,
      };
    }
    const exists = await provider.targetExists(ctx.target, ctx.chainId);
    return exists
      ? { ok: true }
      : {
          ok: false,
          fail: "target_not_a_contract",
          detail: "destination is not deployed code",
        };
  },
};

/**
 * The target's own identity read must agree with the underlying the pool says
 * it deposits: `vault.asset()`, `comet.baseToken()`, `params.loanToken`,
 * `coins[index]`, a Sui `coinType`, an SPL `mint`.
 *
 * This is what catches a look-alike that passes every structural check but
 * takes a different token.
 */
export const UnderlyingMatchesCheck: SafetyCheck = {
  id: "underlying-matches",
  layer: 1,
  appliesTo: { requiresTarget: true },
  run: async (ctx) => {
    if (!ctx.target) return NO_TARGET_TO_VERIFY;
    const provider = getChainSafetyProvider(ctx.namespace);
    if (!provider) return { ok: true }; // reported by target-has-code
    const actual = await provider.readUnderlying(ctx.target, ctx.chainId);
    if (actual === null) {
      return {
        ok: false,
        fail: "target_not_a_contract",
        detail: "could not read the target's underlying asset",
      };
    }
    if (actual.toLowerCase() !== ctx.underlyingExpected.toLowerCase()) {
      return {
        ok: false,
        fail: "decoded_intent_mismatch",
        detail: "target's underlying does not match the pool's asset",
      };
    }
    return { ok: true };
  },
};

/**
 * Singleton / router allowlist (§11 Layer 1, §12 Q7). For kinds whose
 * destination is a singleton — an Aave-style Pool, the Morpho contract, a
 * Comet market, a Pendle/Solidly/Balancer router — the address MUST be a
 * pinned, code-reviewed constant, never "whatever the API returned".
 *
 * Per-vault addresses are legitimately API-sourced; the provider returns true
 * for those and they are admitted by the identity checks above instead.
 */
export const TargetAllowlistedCheck: SafetyCheck = {
  id: "target-allowlisted",
  layer: 1,
  appliesTo: { requiresTarget: true },
  run: async (ctx) => {
    if (!ctx.target) return NO_TARGET_TO_VERIFY;
    const provider = getChainSafetyProvider(ctx.namespace);
    if (!provider) return { ok: true }; // reported by target-has-code
    const allowed = await provider.isAllowlisted(ctx.target, ctx.chainId);
    return allowed
      ? { ok: true }
      : {
          ok: false,
          fail: "target_not_allowlisted",
          detail: "destination is not a pinned singleton for its kind",
        };
  },
};

/**
 * New-pool anomaly circuit-breaker (§11.6 #6b). Distinct from the APY-drift
 * check, which watches a KNOWN pool move: this one refuses a pool whose
 * numbers were never plausible. "Too good to be true" is a signal, and the
 * honest response is Manual-until-reviewed rather than a fast deposit.
 *
 * Chain-agnostic: it reads catalogue metadata, not chain state.
 */
const IMPLAUSIBLE_APY_PCT = 1000;
const MIN_CREDIBLE_TVL_USD = 50_000;

export const PoolAnomalyCheck: SafetyCheck = {
  id: "pool-anomaly",
  layer: 1,
  // Deposit-only (§11 SafetyAction): this is a "too good to be true, don't
  // put new money in" circuit-breaker. Applying it to withdraw would block
  // exactly the users who most need to leave a pool whose numbers just went
  // implausible — a depeg or a TVL crater is a reason to let funds OUT
  // faster, never a reason to trap them.
  appliesTo: { stages: ["presign"], actions: ["deposit"] },
  run: async (ctx) => {
    const apy = ctx.cachedApy ?? ctx.expectedApy;
    if (typeof apy === "number" && apy > IMPLAUSIBLE_APY_PCT) {
      return {
        ok: false,
        fail: "pool_anomaly_flagged",
        detail: "APY is implausibly high",
      };
    }
    if (
      typeof ctx.tvlUsdSnapshot === "number" &&
      ctx.tvlUsdSnapshot > 0 &&
      ctx.tvlUsdSnapshot < MIN_CREDIBLE_TVL_USD
    ) {
      return {
        ok: false,
        fail: "pool_anomaly_flagged",
        detail: "pool TVL is below the credible floor",
      };
    }
    return { ok: true };
  },
};

/**
 * Route router allowlist check (§8.4 Layer 1).
 * Verifies that the router destination and approval spender match the pinned
 * router allowlist or adapter-declared allowlist.
 */
export const RouteRouterAllowlistedCheck: SafetyCheck = {
  id: "route-router-allowlisted",
  layer: 1,
  appliesTo: { actions: ["swap", "bridge"], stages: ["submit"] },
  run: async (ctx) => {
    if (!ctx.routeDestination) return { ok: true };

    const destLower = ctx.routeDestination.toLowerCase();
    // Provider- and chain-scoped: one provider's router is not another's.
    const pinned = pinnedRouterFor(ctx.routeQuote?.provider, ctx.chainId);
    const allowedTargets = new Set([
      ...(pinned ? [pinned] : []),
      ...(ctx.routeAllowedTargets?.map((t) => t.toLowerCase()) ?? []),
    ]);

    if (!allowedTargets.has(destLower)) {
      return {
        ok: false,
        fail: "target_not_allowlisted",
        detail: "route destination is not an allowlisted router",
      };
    }

    if (ctx.routeSpender) {
      const spenderLower = ctx.routeSpender.toLowerCase();
      const allowedSpenders = new Set([
        ...(pinned ? [pinned] : []),
        destLower,
        ...(ctx.routeAllowedSpenders?.map((s) => s.toLowerCase()) ?? []),
      ]);

      if (!allowedSpenders.has(spenderLower)) {
        return {
          ok: false,
          fail: "target_not_allowlisted",
          detail:
            "route approval spender is not an allowlisted router or spender",
        };
      }
    }

    return { ok: true };
  },
};

/**
 * Route destination bytecode check (§8.4 Layer 1).
 * Verifies that the destination address is deployed contract code, not an EOA.
 */
export const RouteDestinationHasCodeCheck: SafetyCheck = {
  id: "route-destination-has-code",
  layer: 1,
  appliesTo: { actions: ["swap", "bridge"], stages: ["submit"] },
  run: async (ctx) => {
    if (!ctx.routeDestination) return { ok: true };

    const provider = getChainSafetyProvider(ctx.namespace);
    if (!provider) return { ok: true };

    if (provider.hasCode) {
      const hasCode = await provider.hasCode(ctx.routeDestination, ctx.chainId);
      if (!hasCode) {
        return {
          ok: false,
          fail: "target_not_a_contract",
          detail: "destination router is not deployed code",
        };
      }
    }

    return { ok: true };
  },
};

export const LAYER1_CHECKS: readonly SafetyCheck[] = [
  TargetHasCodeCheck,
  UnderlyingMatchesCheck,
  TargetAllowlistedCheck,
  PoolAnomalyCheck,
  RouteRouterAllowlistedCheck,
  RouteDestinationHasCodeCheck,
];
