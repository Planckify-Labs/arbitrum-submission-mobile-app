/**
 * `swap_*` mobile executors.
 *
 * Spec: docs/swap-capability-spec.md §7.3.
 *
 * Three tools:
 *   - `swap_quote` (read)   — quote same-chain swap via DEX aggregators
 *   - `swap_execute` (WRITE) — execute approved quote with biometric gate
 *   - `swap_status` (read)  — check status of submitted swap
 *
 * Registered under the DeFi agent. Venue choice is the route registry's
 * (the backend stamps the winning provider on the quote); Sui swaps stay on
 * the Intent Engine (`defi_intent_*`, spec §4.5).
 *
 * The interface is split, the engine is shared (§4.4): these dispatch
 * through `bridge_*` as same-chain routes, so re-quote at signing, quote
 * binding, the route safety pipeline, the pre-sign dry run and the
 * approval gate are one implementation for both verbs.
 */

import { bridgeApi } from "@/api/endpoints/bridge";
import type { TBridgeToken } from "@/api/types/bridge";
import type { TToken } from "@/api/types/token";
import { buildChainConfigFromBlockchain } from "@/hooks/useWallet.helpers";
import {
  assetContractFromCaip19,
  assetToCaip19,
  chainToCaip2,
  parseCaip2,
} from "@/services/bridgeRoutes/caip";
import type { Namespace } from "@/services/chains/types";
import { foldSymbol } from "@/services/swap/routeAck";
import { addressesEqual } from "@/services/walletKit/chainInfo";
import {
  type ExecutorContext,
  ExecutorError,
  ExecutorErrorCode,
  type MobileToolExecutor,
  requireString,
  safeExecute,
  type ToolInput,
} from "../types";
import { bridgeExecute, bridgeQuote, bridgeStatus } from "./bridge";

/**
 * Fields a swap never accepts from the model: the recipient is the signer,
 * slippage is a server default, and the price-impact acknowledgement is the
 * user's tap on the card (`routeAck`), not an argument.
 */
function sanitize(input: ToolInput): ToolInput {
  const {
    to_address: _to,
    slippage_bps: _slippage,
    transfer_speed: _speed,
    price_impact_ack_bps: _ack,
    ...rest
  } = input;
  return rest;
}

/**
 * Is `asset` a real token on `chain`? Our own catalogue row, or any route
 * provider that can read it (the backend resolves an exact id on-chain or
 * from a provider's list). `false` only on a definite "no such token";
 * a lookup that cannot run answers `true` and lets the quote decide.
 */
async function isKnownAsset(
  context: ExecutorContext,
  chain: string,
  asset: string,
): Promise<boolean> {
  const contract = assetContractFromCaip19(asset);
  if (contract === null) return true; // the chain's native asset
  const row = context.blockchains.find((b) => {
    if (b.caip2Id === chain) return true;
    return chainToCaip2(buildChainConfigFromBlockchain(b)) === chain;
  });
  const namespace = parseCaip2(chain)?.namespace as Namespace | undefined;
  if (
    namespace &&
    row?.tokens?.some(
      (t) =>
        t.isActive &&
        !!t.contractAddress &&
        addressesEqual(namespace, t.contractAddress, contract),
    )
  ) {
    return true;
  }
  try {
    return (await bridgeApi.searchTokens(chain, asset)).length > 0;
  } catch {
    return true;
  }
}

/**
 * Quote a same-chain swap. Both tokens must exist first: a model that skips
 * `swap_find_token` can type an address from memory (seen live: a made-up
 * "cirBTC" address on Arc that no provider could read), and the user would
 * then be told the swap is "not available" when the truth is "wrong token".
 * `unknown_token` sends the model back to look it up.
 */
export const swapQuote: MobileToolExecutor = (input: ToolInput, context) =>
  safeExecute(async () => {
    const chain = requireString(input, "chain");
    for (const key of ["from_asset", "to_asset"] as const) {
      const asset = requireString(input, key);
      if (!(await isKnownAsset(context, chain, asset))) {
        throw new ExecutorError(
          ExecutorErrorCode.InvalidInput,
          "unknown_token",
        );
      }
    }
    const mappedInput: ToolInput = {
      ...sanitize(input),
      from_chain: chain,
      to_chain: chain,
    };
    return bridgeQuote(mappedInput, context);
  });

export const swapExecute: MobileToolExecutor = (input: ToolInput, context) => {
  const chain = input.chain;
  const mappedInput: ToolInput = {
    ...sanitize(input),
    from_chain: chain,
    to_chain: chain,
    to_address: context.wallet.address,
  };
  return bridgeExecute(mappedInput, context);
};

export const swapStatus: MobileToolExecutor = (input: ToolInput, context) => {
  const chain = input.chain;
  const mappedInput: ToolInput = {
    ...input,
    from_chain: chain,
    to_chain: chain,
    source_tx_hash: input.tx_hash,
  };
  return bridgeStatus(mappedInput, context);
};

/** At most this many matches go back to the model. */
const FIND_TOKEN_LIMIT = 8;

/**
 * `swap_find_token` (read): resolve a symbol or name to CAIP-19 ids on one
 * chain, so the model never guesses a contract address from memory.
 *
 * Two sources, in order:
 *  1. the API-driven token rows the app already holds (swap spec §4.9: the
 *     tools read the same list the cards render from);
 *  2. the route providers' own token lists, through the backend, when no
 *     row matches. A token PAIR needs no row of ours (§4.6): cirBTC on Arc
 *     had none, so the agent told users it was unsupported while Tower,
 *     LI.FI and App Kit could all route it.
 *
 * Every result says whether we vouch for it (`verified`); the quote card
 * shows an unverified token as such.
 *
 * When a chain lists its gas token twice, as the native asset AND as an
 * ERC-20 interface with the same symbol (Arc's USDC), only the contract
 * form is returned: that is the swappable one. Decided by the data, not
 * by a chain id.
 */
export const swapFindToken: MobileToolExecutor = (input, context) =>
  safeExecute(async () => {
    const chain = requireString(input, "chain");
    const query = requireString(input, "query").trim();
    if (!query) {
      throw new ExecutorError(ExecutorErrorCode.InvalidInput, "empty_query");
    }

    const row = context.blockchains.find((b) => {
      if (b.caip2Id === chain) return true;
      return chainToCaip2(buildChainConfigFromBlockchain(b)) === chain;
    });
    if (!row) {
      return {
        status: "success" as const,
        data: { chain, tokens: [], reason: "chain_not_enabled" },
      };
    }
    const config = buildChainConfigFromBlockchain(row);

    const folded = foldSymbol(query);
    const lowered = query.toLowerCase();
    const active = (row.tokens ?? []).filter((t) => t.isActive);
    const contractSymbols = new Set(
      active.filter((t) => t.contractAddress).map((t) => foldSymbol(t.symbol)),
    );
    const rank = (t: TToken): number => {
      const sym = foldSymbol(t.symbol);
      if (sym === folded) return 0;
      if (sym.startsWith(folded)) return 1;
      if (t.name.toLowerCase().includes(lowered)) return 2;
      return -1;
    };
    const tokens = active
      .filter(
        (t) =>
          !(
            !t.contractAddress &&
            t.isNativeCurrency &&
            contractSymbols.has(foldSymbol(t.symbol))
          ),
      )
      .map((t) => ({ t, r: rank(t) }))
      .filter(({ r }) => r >= 0)
      .sort((a, b) => a.r - b.r)
      .slice(0, FIND_TOKEN_LIMIT)
      .flatMap(({ t }) => {
        const caip19 = assetToCaip19(
          config,
          t.isNativeCurrency && !t.contractAddress ? null : t.contractAddress,
        );
        return caip19
          ? [
              {
                caip19,
                symbol: t.symbol,
                name: t.name,
                decimals: t.decimals,
                is_native: t.isNativeCurrency && !t.contractAddress,
                is_stablecoin: t.isStablecoin,
              },
            ]
          : [];
      });

    if (tokens.length > 0) {
      return {
        status: "success" as const,
        data: {
          chain,
          tokens: tokens.map((t) => ({
            ...t,
            verified: true,
            source: "catalogue",
          })),
        },
      };
    }

    // No row: ask the providers (via the backend).
    let found: TBridgeToken[] = [];
    try {
      found = await bridgeApi.searchTokens(chain, query);
    } catch (err) {
      if (__DEV__) console.warn("[swap/findToken] provider search failed", err);
      throw new ExecutorError(ExecutorErrorCode.NetworkError);
    }
    return {
      status: "success" as const,
      data: {
        chain,
        tokens: found.slice(0, FIND_TOKEN_LIMIT).map((t) => ({
          caip19: t.caip19,
          symbol: t.symbol,
          name: t.name ?? t.symbol,
          decimals: t.decimals,
          is_native: Boolean(t.isNative),
          verified: t.verification === "verified",
          source: "provider",
        })),
      },
    };
  });

export const SWAP_EXECUTORS: Record<string, MobileToolExecutor> = {
  swap_find_token: swapFindToken,
  swap_quote: swapQuote,
  swap_execute: swapExecute,
  swap_status: swapStatus,
};
