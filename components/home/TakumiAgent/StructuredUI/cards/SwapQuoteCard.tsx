/**
 * SwapQuoteCard — generative UI for same-chain swap quotes.
 *
 * Spec: docs/swap-capability-spec.md §6.1-6.5.
 *
 * Built from the same parts as `BridgeQuoteCard` (`routeCardParts`, spec
 * §6.5 "cards split, renderers shared"), so the two read alike. What the
 * swap card adds is what a swap has and a bridge does not: price impact
 * (§6.1), the venue (§6.2), and how many other routes were checked (§6.3).
 *
 * Renders the payload `swap_quote` returns: the shared route payload
 * (`buildBridgeQuotePayload`), flat, not a nested quote object.
 *
 * The card is disclosure only: execution is gated by the approval proposal
 * (Approve / Reject) that `swap_execute` raises. The one thing that gate
 * cannot carry is an acknowledgement of a warning it never showed, so the
 * warnings that need one (a danger-level price impact, a token that
 * differs from the one named, an output token we cannot vouch for) each
 * carry an inline chip. It records the
 * user's acknowledgement in `routeAck` for this exact route and amount;
 * `swap_execute` reads it from there, never from a tool argument.
 */

import {
  AlertTriangle,
  ArrowDown,
  ArrowLeftRight,
  ChevronDown,
  ChevronUp,
  Clock,
  Info,
} from "lucide-react-native";
import type React from "react";
import { useEffect, useMemo, useState } from "react";
import { Image, Pressable, Text, View } from "react-native";
import type { TBridgeQuote, TBridgeRouteStep } from "@/api/types/bridge";
import SingleLoadingSekeleton from "@/components/common/SingleLoadingSekeleton";
import { useMevProtection } from "@/hooks/useMevProtection";
import { buildDisplaySteps } from "@/services/bridgeRoutes/displaySteps";
import type { TBridgeQuotePayload } from "@/services/bridgeRoutes/quotePayload";
import { getMevProtectionStatus } from "@/services/swap/mevProtection";
import {
  routeAck,
  routeAckKey,
  type SymbolMismatch,
} from "@/services/swap/routeAck";
import { getPriceImpactSeverity } from "@/services/swap/slippage";
import { tapFeedback } from "@/utils/hapticsUtils";
import { agentErrorCopy } from "../agentErrorCopy";
import type { ToolComponentProps } from "../types";
import {
  chainLabel,
  formatDuration,
  formatSlippage,
  formatTokenValue,
  formatUsd,
  noRouteCopy,
} from "./bridgeFormat";
import { ChainIcon } from "./ChainIcon";
import {
  AssetLine,
  BRAND_RED,
  MUTED,
  Row,
  SectionLabel,
  Shell,
  UnverifiedTokenNotice,
  WARN_AMBER,
} from "./routeCardParts";

const GOOD_GREEN = "#059669";

/** Seconds until `expiresAt`, re-rendered every second while it matters. */
function useSecondsLeft(expiresAt: string | undefined, live: boolean) {
  const target = expiresAt ? new Date(expiresAt).getTime() : Number.NaN;
  const compute = () =>
    Number.isFinite(target)
      ? Math.max(0, Math.round((target - Date.now()) / 1000))
      : null;
  const [left, setLeft] = useState<number | null>(compute);
  // A countdown IS a subscription to the clock: the one case an effect
  // is the right tool. Stops at zero and in frozen history.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `compute` closes over `target` only
  useEffect(() => {
    setLeft(compute());
    if (!live || !Number.isFinite(target)) return;
    const id = setInterval(() => {
      const next = compute();
      setLeft(next);
      if (next === 0) clearInterval(id);
    }, 1000);
    return () => clearInterval(id);
  }, [target, live]);
  return left;
}

/**
 * Inline acknowledgement inside a warning banner. Not a submit button: it
 * sends nothing, it only records that the user read this warning.
 */
function AckChip({
  label,
  done,
  onPress,
}: {
  label: string;
  done: boolean;
  onPress?: () => void;
}) {
  if (done) {
    return (
      <Text className="text-[11px] font-semibold text-emerald-700 mt-1.5">
        Acknowledged
      </Text>
    );
  }
  if (!onPress) return null;
  return (
    <Pressable
      onPress={() => {
        tapFeedback();
        onPress();
      }}
      accessibilityRole="button"
      accessibilityLabel={label}
      className="mt-2 self-start rounded-xl border-2 border-light-primary-red bg-light-primary-red/10 px-3 py-1.5 active:opacity-70"
    >
      <Text className="text-[11px] font-bold text-light-matte-black">
        {label}
      </Text>
    </Pressable>
  );
}

// ── Types ─────────────────────────────────────────────────────────────

type SwapQuoteInput = {
  chain?: string;
  from_asset?: string;
  to_asset?: string;
  amount_raw?: string;
};

type RoutablePayload = TBridgeQuotePayload & {
  asset_symbol_mismatch?: SymbolMismatch[];
};

type SwapQuoteOutput = {
  status?: "success" | "failed" | string;
  error?: string;
  reason?: string;
  data?: RoutablePayload | { routable: false; reason?: string };
};

/** The subset of `TBridgeQuote` the shared step builder reads. */
function stepSource(data: RoutablePayload): TBridgeQuote {
  return {
    kind: data.kind,
    provider: data.provider,
    from: data.from,
    to: data.to,
    steps: data.steps as TBridgeRouteStep[],
    venue: data.venue,
  } as TBridgeQuote;
}

// ── Main Card ─────────────────────────────────────────────────────────

export const SwapQuoteCard: React.FC<
  ToolComponentProps<SwapQuoteInput, SwapQuoteOutput>
> = ({ state, input, output, mode = "live" }) => {
  const [expanded, setExpanded] = useState(false);
  // Subscribing keeps the protection row in step with the setting.
  const { mevEnabled } = useMevProtection();

  const data = output?.data;
  const quote = data && data.routable ? (data as RoutablePayload) : null;
  const secondsLeft = useSecondsLeft(quote?.expires_at, mode === "live");
  const ackKey = quote ? routeAckKey(quote) : null;
  const [ack, setAck] = useState(() =>
    ackKey ? routeAck.get(ackKey) : undefined,
  );
  const acknowledge = (next: Parameters<typeof routeAck.record>[1]) => {
    if (!ackKey) return;
    routeAck.record(ackKey, next);
    setAck(routeAck.get(ackKey));
  };

  const chainName = useMemo(() => {
    if (quote?.from?.chainName) return quote.from.chainName;
    if (quote?.from?.chain) return chainLabel(quote.from.chain);
    if (input?.chain) return chainLabel(input.chain);
    return "this network";
  }, [quote?.from?.chain, quote?.from?.chainName, input?.chain]);

  // Loading.
  if (!output || state === "input-available" || state === "input-streaming") {
    return (
      <Shell>
        <View className="flex-row items-center gap-2">
          <SingleLoadingSekeleton width={16} height={16} borderRadius={8} />
          <SectionLabel>Finding the best swap route</SectionLabel>
        </View>
      </Shell>
    );
  }

  // Genuine failure. Curated copy only (CLAUDE.md user-facing errors).
  if (state === "output-error" || output.status === "failed") {
    return (
      <Shell>
        <View className="flex-row items-center gap-2">
          <AlertTriangle size={15} color={BRAND_RED} />
          <Text className="text-xs font-bold uppercase tracking-wide text-light-primary-red">
            Could not quote swap
          </Text>
        </View>
        <Text className="text-sm text-light-matte-black/80 mt-1.5">
          {agentErrorCopy(output.error, output.reason)}
        </Text>
      </Shell>
    );
  }

  // A capability boundary: a plain explanatory state, not an error (§7.6).
  if (!quote) {
    const reason = data && !data.routable ? data.reason : undefined;
    return (
      <Shell>
        <View className="flex-row items-center gap-2">
          <Info size={15} color={MUTED} />
          <SectionLabel>Not available</SectionLabel>
        </View>
        <Text className="text-sm text-light-matte-black/80 mt-1.5">
          {reason === "same_chain" || reason === "chain_not_supported"
            ? `Swaps are not available on ${chainName} yet.`
            : noRouteCopy(reason)}
        </Text>
      </Shell>
    );
  }

  // Absent is UNKNOWN, never 0 (§6.1): no impact line at all.
  const impactPct = quote.price_impact;
  const impactSeverity =
    typeof impactPct === "number" ? getPriceImpactSeverity(impactPct) : null;
  const mismatches = quote.asset_symbol_mismatch ?? [];
  const live = mode === "live";

  // Who the user is trading with, as the adapter names it: "Tower" for a
  // Tower swap, the DEX (e.g. "Kyberswap") for a LI.FI one (§6.2).
  const displaySteps = buildDisplaySteps(stepSource(quote));
  const venue =
    quote.venue?.name ??
    displaySteps.find((step) => step.kind === "swap" && step.venueName)
      ?.venueName;
  const venueLogo = quote.venue?.logoUri;
  // A same-chain swap is one transaction. Providers report its duration as
  // 0 ("no wait"), which must not read as "Unknown".
  const timing =
    typeof quote.duration_seconds === "number" && quote.duration_seconds > 0
      ? formatDuration(quote.duration_seconds)
      : "One transaction";
  const mevStatus = mevEnabled
    ? getMevProtectionStatus(quote.from.chain)
    : { active: false as const };
  const otherRoutes = Math.max(0, (quote.route_options?.length ?? 0) - 1);

  // Effective rate. Decimals of 0 are real (never fall back to 18), and a
  // tiny rate keeps significant digits instead of rounding to "0.0000".
  const fromNum =
    Number(quote.from.amountRaw) / 10 ** (quote.from.token.decimals ?? 18);
  const toNum =
    Number(quote.to.amountRaw) / 10 ** (quote.to.token.decimals ?? 18);
  const rate = fromNum > 0 && toNum > 0 ? toNum / fromNum : null;
  const effectiveRate =
    rate !== null
      ? `1 ${quote.from.token.symbol} ≈ ${
          rate >= 1 ? rate.toFixed(4) : rate.toPrecision(4)
        } ${quote.to.token.symbol}`
      : null;

  return (
    <Shell>
      {/* One chain for both sides: named once, not under each amount. */}
      <View className="flex-row items-center gap-1.5 mb-2">
        <ArrowLeftRight size={13} color={BRAND_RED} />
        <Text className="text-[11px] font-bold uppercase tracking-wide text-light-matte-black">
          Swap on
        </Text>
        <ChainIcon caip2={quote.from.chain} size={12} />
        <Text className="text-[11px] font-semibold text-light-matte-black">
          {chainName}
        </Text>
      </View>
      <AssetLine
        side={quote.from}
        caption="You pay"
        showSourceWallet
        showChain={false}
      />
      <View className="items-center py-1.5">
        <ArrowDown size={16} color={MUTED} />
      </View>
      <AssetLine
        side={quote.to}
        caption="You receive (expected)"
        showChain={false}
      />

      {/* §7.2 the token is not the one the user named */}
      {mismatches.map((m) => (
        <View
          key={m.side}
          className="mt-2.5 rounded-xl border border-amber-300/50 bg-amber-50 px-3 py-2.5"
        >
          <View className="flex-row items-center gap-1.5">
            <AlertTriangle size={13} color={WARN_AMBER} />
            <Text className="text-[11px] font-bold uppercase tracking-wide text-amber-700">
              Check the token
            </Text>
          </View>
          <Text className="text-xs text-light-matte-black/80 mt-1">
            You asked for {m.expected}, but this swap{" "}
            {m.side === "from" ? "spends" : "gives you"} {m.actual}. Make sure
            this is the token you want before you approve.
          </Text>
          <AckChip
            label={`Yes, use ${m.actual}`}
            done={Boolean(ack?.symbolsConfirmed)}
            onPress={
              live ? () => acknowledge({ symbolsConfirmed: true }) : undefined
            }
          />
        </View>
      ))}

      {/* §8.4 L1 a token we cannot vouch for at this address */}
      <UnverifiedTokenNotice
        // A re-quote is a different route: its confirmation starts over.
        key={ackKey ?? "none"}
        side={quote.to}
        ackKey={ackKey}
        live={live}
        verb="this swap gives you"
      />

      {/* §6.1 price impact, severity-coded */}
      {impactSeverity === "danger" ? (
        <View className="mt-2.5 rounded-xl border border-light-primary-red/30 bg-light-primary-red/5 px-3 py-2.5">
          <View className="flex-row items-center gap-1.5">
            <AlertTriangle size={13} color={BRAND_RED} />
            <Text className="text-[11px] font-bold uppercase tracking-wide text-light-primary-red">
              High price impact ({impactPct?.toFixed(2)}%)
            </Text>
          </View>
          <Text className="text-xs text-light-matte-black/80 mt-1">
            This trade moves the pool price a lot, so you get noticeably less
            value back. A smaller amount usually helps.
          </Text>
          <AckChip
            label="I understand the price impact"
            done={
              typeof ack?.impactBps === "number" &&
              typeof impactPct === "number" &&
              ack.impactBps >= Math.ceil(impactPct * 100)
            }
            onPress={
              live && typeof impactPct === "number"
                ? () => acknowledge({ impactBps: impactPct * 100 })
                : undefined
            }
          />
        </View>
      ) : null}

      {/* The protection numbers, always on screen (bridge spec §7.2) */}
      <View className="mt-2.5 rounded-xl bg-gray-50 px-3 py-2">
        <Row
          label="Minimum you receive"
          value={formatTokenValue(quote.to_amount_min_raw, quote.to.token)}
          emphasis
        />
        <Row
          label="Slippage tolerance"
          value={formatSlippage(quote.slippage_bps)}
        />
        {typeof impactPct === "number" ? (
          <Row
            label="Price impact"
            value={`${impactPct.toFixed(2)}%`}
            valueColor={
              impactSeverity === "warn"
                ? WARN_AMBER
                : impactSeverity === "danger"
                  ? BRAND_RED
                  : undefined
            }
          />
        ) : null}
        {effectiveRate ? (
          <Row label="Exchange rate" value={effectiveRate} />
        ) : null}
        {/* A swap has a fee or two, not a bridge's itemised list: shown
            here, marked when it is already taken from the output. */}
        {(quote.fees ?? []).map((fee) => (
          <Row
            key={`${fee.key}-${fee.label}-${fee.amountRaw}`}
            label={fee.included ? `${fee.label} (included)` : fee.label}
            value={
              formatUsd(fee.amountUsd) ??
              formatTokenValue(fee.amountRaw, fee.token)
            }
          />
        ))}
        {secondsLeft !== null ? (
          <Row
            label="Quote valid for"
            value={
              secondsLeft > 0
                ? `${secondsLeft}s`
                : "Expired, it re-prices when you approve"
            }
          />
        ) : null}
        {otherRoutes > 0 ? (
          <Row
            label="Other routes checked"
            value={String(otherRoutes)}
            valueColor={GOOD_GREEN}
          />
        ) : null}
        {mevStatus.active ? (
          <Row
            label="Front-running protection"
            value={mevStatus.relayName ?? "On"}
            valueColor={GOOD_GREEN}
          />
        ) : null}
      </View>

      {/* §6.2 timing and venue */}
      <View className="flex-row items-center gap-2 mt-2.5">
        <Clock size={12} color={MUTED} />
        <Text className="text-[11px] text-gray-500">{timing}</Text>
        {venue ? (
          <>
            <Text className="text-[11px] text-gray-300">·</Text>
            {venueLogo ? (
              <Image
                source={{ uri: venueLogo }}
                style={{ width: 14, height: 14, borderRadius: 7 }}
              />
            ) : null}
            <Text className="text-[11px] font-semibold text-light-matte-black">
              via {venue}
            </Text>
          </>
        ) : null}
      </View>

      {/* The route's steps, behind a disclosure */}
      {displaySteps.length > 0 ? (
        <>
          <Pressable
            onPress={() => {
              tapFeedback();
              setExpanded((v) => !v);
            }}
            accessibilityRole="button"
            accessibilityLabel={expanded ? "Hide route" : "Show route"}
            className="flex-row items-center gap-1 mt-2.5 active:opacity-70"
          >
            <Text className="text-[11px] font-bold text-light-primary-red">
              {expanded ? "Hide route" : "Route"}
            </Text>
            {expanded ? (
              <ChevronUp size={13} color={BRAND_RED} />
            ) : (
              <ChevronDown size={13} color={BRAND_RED} />
            )}
          </Pressable>
          {expanded ? (
            <View className="mt-1">
              {displaySteps.map((step, index) => (
                <Text
                  key={step.key}
                  className="text-[11px] text-gray-500 mt-0.5"
                >
                  {index + 1}. {step.label}
                </Text>
              ))}
            </View>
          ) : null}
        </>
      ) : null}
    </Shell>
  );
};

export default SwapQuoteCard;
