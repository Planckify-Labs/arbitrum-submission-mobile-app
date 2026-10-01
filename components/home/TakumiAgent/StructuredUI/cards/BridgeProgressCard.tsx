/**
 * BridgeProgressCard — §7.7, "post-submit: half the UX".
 *
 * Spec: docs/bridge-capability-spec.md §7.7, §7.7.1.
 *
 * A bridge is NOT done when the source tx confirms. CCTP's lifecycle is
 * FOUR steps and Circle's own SDK surfaces them individually, so the card
 * is modelled on that rather than a coarser three-state guess:
 *
 *   1. approve            ERC-20 allowance (EVM only, PRESENCE-CHECKED —
 *                         there is no analogue on Solana/Sui/Stellar)
 *   2. burn               destroy on source
 *   3. fetchAttestation   wait for the burn proof  ← the long one
 *   4. mint               create on destination
 *
 * Step 3 is where the ~15 to 19 minutes of a standard transfer goes. It is
 * the step users will stare at, so it gets honest "waiting" copy and an
 * expected-time range rather than a bare spinner.
 *
 * Non-CCTP LI.FI routes map onto the same shape via a provider-supplied
 * step list, so this card stays provider-agnostic.
 *
 * §7.7.1 is the load-bearing rule: `DONE` does NOT mean success. The
 * terminal state is a FOUR-value enum, and `partial` / `refunded` are
 * OUTCOMES rather than errors, so they get their own plain copy and never
 * route through `agentErrorCopy`.
 *
 * Its mirror at the other end of the lifecycle: NOT DONE does not mean
 * "in flight". A `bridge_execute` reaches a result only by running the
 * executor, so a call with no result never ran, and the branch order
 * below reflects that. Declines are read from the PART-level `error`
 * (a rejection carries no output at all) and must be matched BEFORE the
 * no-result branch, or a transfer the user rejected renders as one being
 * submitted. See `declinedBridgeCopy` / `pendingBridgeCopy`.
 */

import {
  AlertTriangle,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronUp,
  Clock,
  Info,
  RefreshCw,
} from "lucide-react-native";
import type React from "react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Linking, Pressable, Text, View } from "react-native";
import { bridgeApi } from "@/api/endpoints/bridge";
import type { TBlockchain } from "@/api/types/blockchain";
import {
  routeKindOf,
  type TBridgeOutcome,
  type TBridgePhase,
  type TBridgeRouteStep,
  type TBridgeStatus,
  type TBridgeToken,
} from "@/api/types/bridge";
import { useBlockchainsWithStorage } from "@/hooks/useBlockchainsWithStorage";
import { buildChainConfigFromBlockchain } from "@/hooks/useWallet.helpers";
import {
  chainOfAsset,
  chainToCaip2,
  parseCaip2,
} from "@/services/bridgeRoutes/caip";
import { bridgeDestinationChoice } from "@/services/bridgeRoutes/destinationChoice";
import { useBridgeStatus } from "@/services/bridgeStatusStore";
import type { Namespace } from "@/services/chains/types";
import { walletKitRegistry } from "@/services/walletKit/registry";
import { tapFeedback } from "@/utils/hapticsUtils";
import { agentErrorCopy } from "../agentErrorCopy";
import { approvalSummaryFromToolInput, CHAIN_NAMES } from "../approvalSummary";
import { resolveApprovalAssetMeta } from "../resolveAssetMeta";
import type { ToolComponentProps } from "../types";
import WriteApprovalGate from "../WriteApprovalGate";
import { AddWalletErrorAction } from "./AddWalletErrorAction";
import {
  declinedBridgeCopy,
  formatTokenValue,
  outcomeCopy,
  pendingBridgeCopy,
  phaseCopy,
  resolveChainName,
  truncateAddress,
} from "./bridgeFormat";
import { ChainIcon } from "./ChainIcon";

function resolveExplorerTxUrl(
  caip2: string | undefined,
  hash: string | undefined,
  blockchains: TBlockchain[] | undefined,
): string | undefined {
  if (!caip2 || !hash) return undefined;
  for (const b of blockchains ?? []) {
    try {
      const cfg = buildChainConfigFromBlockchain(b);
      if (chainToCaip2(cfg) === caip2) {
        if (walletKitRegistry.has(cfg.namespace)) {
          const kit = walletKitRegistry.get(cfg.namespace);
          const url = kit.buildTxExplorerUrl?.(hash, cfg);
          if (url) return url;
        }
        if (b.blockExplorer) {
          const base = b.blockExplorer.replace(/\/+$/, "");
          return `${base}/tx/${hash}`;
        }
      }
    } catch {
      // ignore
    }
  }
  return undefined;
}

const BRAND_RED = "#c71c4b";
const MUTED = "#6b7280";
const SUCCESS_GREEN = "#059669";
const WARN_AMBER = "#b45309";

type BridgeProgressInput = {
  from_chain?: string;
  to_chain?: string;
  source_tx_hash?: string;
  // Present only on a `bridge_execute` call (schema-required there,
  // absent from `bridge_status`) — the signal this card uses to tell
  // "awaiting approval to submit" apart from "polling an existing
  // submission's status".
  from_asset?: string;
  to_asset?: string;
  amount_raw?: string;
  to_address?: string;
  min_receive_raw?: string;
};

type BridgeProgressData = {
  outcome?: TBridgeOutcome | null;
  phase?: TBridgePhase;
  current_step_key?: string;
  source_tx_hash?: string;
  destination_tx_hash?: string;
  received_token?: TBridgeToken;
  received_amount_raw?: string;
  refund_chain?: string;
  explorer_url?: string;
  from_chain?: string;
  to_chain?: string;
  provider?: string;
  /** Backend-resolved display names, so the card never derives one. */
  from_chain_name?: string;
  to_chain_name?: string;
  /** Present when this payload came from `bridge_execute`. */
  steps?: TBridgeRouteStep[];
  duration_range_seconds?: [number, number];
  to?: {
    token?: TBridgeToken;
    amountRaw?: string;
    chain?: string;
    chainName?: string;
  };
  from?: {
    chain?: string;
    chainName?: string;
    token?: TBridgeToken;
    amountRaw?: string;
  };
  bridge?: { key?: string; name?: string };
  /**
   * Attested and waiting for the user's own destination wallet to receive
   * it (CCTP into Stellar has no Forwarding Service, §5.4.1). The claim
   * itself is `bridge_claim`, a gated write.
   */
  claim_required?: boolean;
};

type BridgeProgressOutput = {
  status?: "success" | "failed" | string;
  error?: string;
  reason?: string;
  data?: BridgeProgressData;
  /** Set by the approval gate below, read by `handleAddToolResult`. */
  user_decision?: "approved" | "rejected";
};

/**
 * The canonical lifecycle. `approve` is PRESENCE-CHECKED against the
 * quote's own step list rather than assumed (§7.7, §10.4): only EVM
 * ERC-20 sources have one.
 */
const PHASE_ORDER: TBridgePhase[] = [
  "pending_source",
  "pending_attestation",
  "pending_destination",
  "settled",
];

function phaseIndex(phase: TBridgePhase | undefined): number {
  const idx = PHASE_ORDER.indexOf(phase ?? "pending_source");
  return idx === -1 ? 0 : idx;
}

type DisplayStep = {
  key: string;
  label: string;
  done: boolean;
  active: boolean;
  hint?: string;
};

/**
 * A same-chain route is a swap (Tower on Arc): one transaction that is
 * final when its receipt lands. It has no attestation or delivery leg, so
 * showing the bridge's four steps would promise a wait that never comes.
 */
function isSwap(data: BridgeProgressData): boolean {
  // `bridge_status` carries flat chain ids; `bridge_execute` carries the
  // quote's `from` / `to` sides.
  const from = data.from_chain ?? data.from?.chain;
  const to = data.to_chain ?? data.to?.chain;
  return !!from && !!to && routeKindOf(from, to) === "swap";
}

/**
 * The swap legs the adapter reported, one per real venue (swap spec §6.4:
 * render what the route did, never a collapsed guess). Fee-collection
 * (`protocol`) steps are fees, not legs, and are not rendered as rows.
 */
function swapLegs(data: BridgeProgressData): { key: string; venue?: string }[] {
  return (data.steps ?? [])
    .filter((s) => s.kind === "swap")
    .map((s) => ({ key: s.key, venue: s.provider?.name }));
}

function buildSteps(
  data: BridgeProgressData,
  fromChainName: string,
  toChainName: string,
): DisplayStep[] {
  const hasApprove = (data.steps ?? []).some((s) => s.kind === "approve");
  const steps: DisplayStep[] = [];

  const current = phaseIndex(data.phase);
  const isComplete = data.outcome === "completed" || data.phase === "settled";

  if (isSwap(data)) {
    if (hasApprove) {
      steps.push({
        key: "approve",
        label: "Allowed your token to be swapped",
        done: true,
        active: false,
      });
    }
    // One transaction settles every leg at once, so they share a state.
    const legs = swapLegs(data);
    for (const leg of legs.length > 0 ? legs : [{ key: "swap" }]) {
      const where = leg.venue ? `via ${leg.venue}` : `on ${fromChainName}`;
      steps.push({
        key: `swap-${leg.key}`,
        label: isComplete ? `Swapped ${where}` : `Swapping ${where}`,
        done: isComplete,
        active: !isComplete,
      });
    }
    return steps;
  }

  if (hasApprove) {
    steps.push({
      key: "approve",
      label: "Approved the bridge to move your token",
      done: true,
      active: false,
    });
  }

  const burnDone = isComplete || current > 0;
  steps.push({
    key: "burn",
    label: burnDone
      ? `Sent from ${fromChainName}`
      : `Sending from ${fromChainName}`,
    done: burnDone,
    active: !isComplete && current === 0,
  });

  const range = data.duration_range_seconds;
  const attestDone = isComplete || current > 1;
  steps.push({
    key: "attestation",
    label: attestDone
      ? "Transfer confirmed"
      : "Waiting for the transfer to be confirmed",
    done: attestDone,
    active: !isComplete && current === 1,
    hint: range
      ? `Usually ${Math.round(range[0] / 60)} to ${Math.round(range[1] / 60)} minutes`
      : "This is the slowest step and can take several minutes",
  });

  steps.push({
    key: "mint",
    label: isComplete
      ? `Delivered on ${toChainName}`
      : `Delivering on ${toChainName}`,
    done: isComplete,
    active: !isComplete && current === 2,
  });

  return steps;
}

/**
 * One node of the vertical stepper. The connector below each node is
 * coloured by whether THIS step is done, so the filled part of the rail
 * always ends at the step currently in flight.
 */
function StepRow({ step, isLast }: { step: DisplayStep; isLast: boolean }) {
  return (
    <View className="flex-row gap-3">
      <View className="w-5 items-center">
        {step.done ? (
          <View className="h-5 w-5 items-center justify-center rounded-full bg-emerald-500">
            <Check size={11} color="#ffffff" strokeWidth={3} />
          </View>
        ) : step.active ? (
          <View className="h-5 w-5 items-center justify-center rounded-full border-2 border-light-primary-red bg-light-primary-red/10">
            <View className="h-2 w-2 rounded-full bg-light-primary-red" />
          </View>
        ) : (
          <View className="h-5 w-5 rounded-full border-2 border-gray-200 bg-white" />
        )}
        {isLast ? null : (
          <View
            className={`my-0.5 w-0.5 flex-1 rounded-full ${
              step.done ? "bg-emerald-300" : "bg-gray-200"
            }`}
          />
        )}
      </View>
      <View className={`flex-1 pt-px ${isLast ? "" : "pb-3"}`}>
        <Text
          className={`text-[13px] ${
            step.done
              ? "text-light-matte-black/70"
              : step.active
                ? "font-semibold text-light-matte-black"
                : "text-gray-400"
          }`}
        >
          {step.label}
        </Text>
        {step.active && step.hint ? (
          <View className="flex-row items-center gap-1 mt-0.5">
            <Clock size={11} color={MUTED} />
            <Text className="text-[11px] text-gray-500">{step.hint}</Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

/** One end of the route summary: amount (when known) over chain. */
function RouteEnd({
  amount,
  caip2,
  chainName,
  align,
}: {
  amount?: string;
  caip2?: string;
  chainName: string;
  align: "left" | "right";
}) {
  const right = align === "right";
  return (
    <View className={`flex-1 ${right ? "items-end" : "items-start"}`}>
      {amount ? (
        <Text
          numberOfLines={1}
          className="text-sm font-bold text-light-matte-black"
        >
          {amount}
        </Text>
      ) : null}
      <View className={`flex-row items-center gap-1 ${amount ? "mt-0.5" : ""}`}>
        <ChainIcon caip2={caip2} size={14} />
        <Text
          numberOfLines={1}
          className={
            amount
              ? "text-[11px] text-gray-500"
              : "text-xs font-semibold text-light-matte-black"
          }
        >
          {chainName}
        </Text>
      </View>
    </View>
  );
}

function TxLink({
  label,
  hash,
  url,
  chain,
}: {
  label: string;
  hash: string | undefined;
  url?: string;
  chain?: string;
}) {
  if (!hash) return null;
  const openable = Boolean(url);
  return (
    <Pressable
      disabled={!openable}
      onPress={() => {
        if (!url) return;
        tapFeedback();
        void Linking.openURL(url);
      }}
      accessibilityRole={openable ? "link" : "text"}
      accessibilityLabel={`${label} ${hash}`}
      className="flex-row items-center justify-between py-2 active:opacity-70"
    >
      <View className="flex-1 flex-row items-center gap-1.5 pr-2">
        <ChainIcon caip2={chain} size={14} />
        <Text numberOfLines={1} className="text-xs text-gray-500">
          {label}
        </Text>
      </View>
      <View className="flex-row items-center gap-1">
        <Text className="text-xs font-semibold text-light-matte-black">
          {truncateAddress(hash)}
        </Text>
        {openable ? <ArrowUpRight size={13} color={BRAND_RED} /> : null}
      </View>
    </Pressable>
  );
}

const BridgeProgressCard: React.FC<
  ToolComponentProps<BridgeProgressInput, BridgeProgressOutput>
> = ({
  state,
  input,
  output,
  error,
  onUserPrompt,
  mode,
  addToolResult,
  decision,
  onRequestApproval,
}) => {
  // Re-read on every mutation of the pick so a live approval card reacts
  // the moment the user switches wallets on the quote card above it.
  useSyncExternalStore(
    bridgeDestinationChoice.subscribe,
    bridgeDestinationChoice.getVersion,
  );
  // A settled transfer folds its (all-ticked) steps away by default; the
  // route and both tx links are the receipt that matters by then.
  const [stepsOpen, setStepsOpen] = useState(false);
  // Raw tool args carry `amount_raw` in smallest units; without decimals
  // the approval would read "Bridge 5000000".
  const { data: blockchains } = useBlockchainsWithStorage({ isActive: true });
  const assetMeta = resolveApprovalAssetMeta(
    blockchains,
    input as Record<string, unknown>,
  );

  const rawData = output?.data ?? {};
  const inputRecord = input as Record<string, unknown> | undefined;
  const rawDataRecord = rawData as Record<string, unknown> | undefined;

  const fromChain =
    rawData.from_chain ??
    rawData.from?.chain ??
    (rawDataRecord?.fromChain as string | undefined) ??
    (rawData.from?.token?.caip19
      ? (chainOfAsset(rawData.from.token.caip19) ?? undefined)
      : undefined) ??
    input?.from_chain ??
    (inputRecord?.fromChain as string | undefined) ??
    (inputRecord?.chain as string | undefined) ??
    (input?.from_asset
      ? (chainOfAsset(input.from_asset) ?? undefined)
      : undefined) ??
    (typeof inputRecord?.fromAsset === "string"
      ? (chainOfAsset(inputRecord.fromAsset) ?? undefined)
      : undefined);

  const toChain =
    rawData.to_chain ??
    rawData.to?.chain ??
    (rawDataRecord?.toChain as string | undefined) ??
    (rawData.to?.token?.caip19
      ? (chainOfAsset(rawData.to.token.caip19) ?? undefined)
      : undefined) ??
    input?.to_chain ??
    (inputRecord?.toChain as string | undefined) ??
    (inputRecord?.chain as string | undefined) ??
    (input?.to_asset
      ? (chainOfAsset(input.to_asset) ?? undefined)
      : undefined) ??
    (typeof inputRecord?.toAsset === "string"
      ? (chainOfAsset(inputRecord.toAsset) ?? undefined)
      : undefined);

  const fromChainFallback =
    rawData.from_chain_name ??
    rawData.from?.chainName ??
    (rawDataRecord?.fromChainName as string | undefined) ??
    (inputRecord?.from_chain_name as string | undefined) ??
    (inputRecord?.fromChainName as string | undefined);

  const toChainFallback =
    rawData.to_chain_name ??
    rawData.to?.chainName ??
    (rawDataRecord?.toChainName as string | undefined) ??
    (inputRecord?.to_chain_name as string | undefined) ??
    (inputRecord?.toChainName as string | undefined);

  const fromChainName = resolveChainName(
    fromChain,
    fromChainFallback,
    blockchains,
    "Source chain",
  );

  const toChainName = resolveChainName(
    toChain,
    toChainFallback,
    blockchains,
    "Destination chain",
  );

  const sourceTxHash = (
    rawData.source_tx_hash ??
    input?.source_tx_hash ??
    (rawDataRecord?.sourceTxHash as string | undefined)
  )?.trim();

  const rawProvider =
    rawData.provider ??
    (rawData.bridge?.key === "cctp" ? "circle-cctp" : rawData.bridge?.key);
  const provider = rawProvider === "circle" ? "circle-cctp" : rawProvider;

  const initialStatus: TBridgeStatus | undefined =
    rawData.outcome !== undefined || rawData.phase !== undefined
      ? {
          outcome: rawData.outcome ?? null,
          phase: rawData.phase ?? "pending_source",
          currentStepKey: rawData.current_step_key,
          sourceTxHash: rawData.source_tx_hash,
          destinationTxHash: rawData.destination_tx_hash,
          receivedToken: rawData.received_token,
          receivedAmountRaw: rawData.received_amount_raw,
          refundChain: rawData.refund_chain as any,
          explorerUrl: rawData.explorer_url,
        }
      : undefined;

  const { status: liveStatus, record: liveRecord } = useBridgeStatus(
    sourceTxHash,
    {
      fromChain,
      toChain,
      provider,
      initialStatus,
    },
  );

  const destinationTxHash =
    liveStatus?.destinationTxHash ?? rawData.destination_tx_hash;

  // The user's own pick overrides the model's `to_address`, which is built
  // from conversation history and still names the previous wallet right
  // after a switch. The executor resolves the SAME way, so approving what
  // is on screen is approving what signs — no drift, and no chat round
  // trip needed to re-sync the model.
  const chosenDestination = bridgeDestinationChoice.get(input.to_chain);
  const approvalInput = chosenDestination
    ? { ...input, to_address: chosenDestination }
    : input;

  // The tool's own error code. A DECLINE carries it at the PART level with
  // no output payload at all, so reading `output.error` alone misses every
  // rejection.
  const toolError = output?.error ?? error;

  /*
    Declines are checked FIRST, ahead of the no-result branch below.

    `rejectDeclined` (services/agentSession/dispatcher.ts) records a
    rejection by upserting `state: "output-error"` with `error:
    "user_declined"` and NO output object. The no-result branch below
    opens with `!output`, so it used to swallow that state and paint
    "Submitting transfer / Sending from <chain>" over a transfer the user
    had just rejected by hand. Same for the deny path's
    `permission_denied`. Order is load-bearing here, not stylistic.
  */
  const declined = declinedBridgeCopy(toolError);
  if (declined) {
    return (
      <View className="my-1.5 rounded-2xl border border-gray-200 bg-gray-50 px-4 py-3.5">
        <View className="flex-row items-center gap-2">
          <AlertTriangle size={14} color={MUTED} />
          <Text className="text-[10px] font-bold uppercase tracking-wide text-gray-400">
            {declined.title}
          </Text>
        </View>
        <Text className="text-sm text-gray-500 mt-1">{declined.body}</Text>
      </View>
    );
  }

  // A genuine tool failure (network, wallet). Curated copy only. Also
  // ahead of the no-result branch: an executor failure posts `error` on
  // the part, and may post no output either.
  if (state === "output-error" || output?.status === "failed") {
    return (
      <View className="my-1.5 rounded-2xl border border-light-primary-red/30 bg-light-primary-red/5 px-4 py-3.5">
        <View className="flex-row items-center gap-2">
          <AlertTriangle size={15} color={BRAND_RED} />
          <Text className="text-xs font-bold uppercase tracking-wide text-light-primary-red">
            Transfer not sent
          </Text>
        </View>
        <Text className="text-sm text-light-matte-black/80 mt-1.5">
          {agentErrorCopy(toolError, output?.reason)}
        </Text>
        {/* Also serves `defi_cross_chain_deposit`, whose missing-wallet
            failure is the most likely one to land here. The reason names
            no chain, so pass the one the transfer was headed for. */}
        <AddWalletErrorAction
          error={toolError}
          reason={output?.reason}
          destinationNamespace={
            input?.to_chain
              ? (parseCaip2(input.to_chain)?.namespace as Namespace | undefined)
              : undefined
          }
        />
      </View>
    );
  }

  // No result yet. Nothing has been submitted on ANY path that reaches
  // here: an approved `bridge_execute` only ever leaves this state by
  // posting a result.
  if (!output || state === "input-available" || state === "input-streaming") {
    // Only `bridge_execute` (schema-required `amount_raw`) moves funds and
    // needs a gate; `bridge_status` shares this card for its post-submit
    // polling and must stay non-interactive — it never sets `amount_raw`.
    const isExecuteCall = typeof input.amount_raw === "string";
    // The approval surface is live only while this message is the
    // streaming one. Once the turn ends — cleanly, on an SSE error, or by
    // being restored from history — the callback is gone and the call can
    // never be approved, so it can never have been submitted.
    const isLive = mode === "live" && Boolean(addToolResult);
    const summary = approvalSummaryFromToolInput(
      approvalInput as Record<string, unknown>,
      undefined,
      undefined,
      assetMeta,
    );

    if (
      isExecuteCall &&
      isLive &&
      (state === "input-available" || state === "input-streaming") &&
      addToolResult
    ) {
      return (
        <WriteApprovalGate
          decision={decision}
          summary={summary}
          onApprove={() =>
            addToolResult({ status: "success", user_decision: "approved" })
          }
          onReject={() =>
            addToolResult({ status: "failed", user_decision: "rejected" })
          }
          onRequestApproval={onRequestApproval}
        />
      );
    }

    const pending = pendingBridgeCopy({ isExecute: isExecuteCall, isLive });
    const interrupted = pending.tone === "interrupted";

    return (
      <View
        className={`my-1.5 rounded-2xl border px-4 py-3.5 ${
          interrupted
            ? "border-gray-200 bg-gray-50"
            : "border-light-matte-black/10 bg-white"
        }`}
      >
        <View className="flex-row items-center gap-2">
          {interrupted ? <AlertTriangle size={14} color={MUTED} /> : null}
          <Text className="text-[10px] font-bold uppercase tracking-wide text-gray-400">
            {pending.title}
          </Text>
        </View>
        <Text className="text-sm text-gray-500 mt-1">{pending.body}</Text>
        {/*
          Name the transfer that did not happen, so an interrupted card in
          scrollback is still a legible receipt. No retry affordance: the
          card cannot prove a duplicate would be a duplicate, and the turn
          error above already carries its own "Try again".
        */}
        {interrupted && isExecuteCall ? (
          <Text className="text-xs text-gray-400 mt-1.5">{summary}</Text>
        ) : null}
      </View>
    );
  }

  const outcome =
    liveStatus?.outcome !== undefined
      ? liveStatus.outcome
      : (rawData.outcome ?? null);
  const phase = liveStatus?.phase ?? rawData.phase ?? "pending_source";

  const data: BridgeProgressData = {
    ...rawData,
    from_chain: fromChain,
    to_chain: toChain,
    from_chain_name: fromChainName,
    to_chain_name: toChainName,
    source_tx_hash: sourceTxHash,
    destination_tx_hash: destinationTxHash,
    outcome,
    phase,
    current_step_key: liveStatus?.currentStepKey ?? rawData.current_step_key,
    received_token: liveStatus?.receivedToken ?? rawData.received_token,
    received_amount_raw:
      liveStatus?.receivedAmountRaw ?? rawData.received_amount_raw,
    refund_chain: liveStatus?.refundChain ?? rawData.refund_chain,
    explorer_url: liveStatus?.explorerUrl ?? rawData.explorer_url,
    claim_required: liveStatus
      ? Boolean(liveStatus.destinationAction)
      : (rawData.claim_required ?? false),
  };

  const steps = buildSteps(data, fromChainName, toChainName);

  const swap = isSwap(data);
  const refundChainName = data.refund_chain
    ? resolveChainName(data.refund_chain, undefined, blockchains, fromChainName)
    : undefined;
  const copy = outcomeCopy(outcome, {
    receivedSymbol: data.received_token?.symbol,
    refundChainLabel: refundChainName,
    swap,
  });

  const tone =
    outcome === "completed"
      ? {
          card: "border-emerald-200",
          badge: "bg-emerald-50",
          color: SUCCESS_GREEN,
        }
      : outcome === "failed"
        ? {
            card: "border-light-primary-red/30",
            badge: "bg-light-primary-red/10",
            color: BRAND_RED,
          }
        : outcome === "partial" || outcome === "refunded"
          ? {
              card: "border-amber-300/60",
              badge: "bg-amber-50",
              color: WARN_AMBER,
            }
          : {
              card: "border-light-matte-black/10",
              badge: "bg-light-primary-red/10",
              color: BRAND_RED,
            };

  const sourceExplorerUrl = resolveExplorerTxUrl(
    fromChain,
    sourceTxHash,
    blockchains,
  );
  const destExplorerUrl = resolveExplorerTxUrl(
    toChain,
    destinationTxHash,
    blockchains,
  );

  // Amounts for the route summary. What actually arrived beats the
  // quoted amount once the status reports it.
  const sentAmount = data.from?.amountRaw
    ? formatTokenValue(data.from.amountRaw, data.from.token)
    : undefined;
  const receivedAmount =
    data.received_amount_raw && data.received_token
      ? formatTokenValue(data.received_amount_raw, data.received_token)
      : data.to?.amountRaw && data.to.token
        ? formatTokenValue(data.to.amountRaw, data.to.token)
        : undefined;

  const activeStep = steps.find((s) => s.active);
  const subtitle = outcome
    ? data.bridge?.name
      ? `via ${data.bridge.name}`
      : undefined
    : (activeStep?.hint ??
      (data.bridge?.name ? `via ${data.bridge.name}` : undefined));
  const showSteps = !outcome || (outcome === "completed" && stepsOpen);
  const hasTx = Boolean(sourceTxHash || destinationTxHash);

  return (
    <View
      className={`my-1.5 rounded-2xl border bg-white px-3.5 py-3 ${tone.card}`}
    >
      {/* Header: status badge + title. */}
      <View className="flex-row items-center gap-3">
        <View
          className={`h-9 w-9 items-center justify-center rounded-full ${tone.badge}`}
        >
          {outcome === "completed" ? (
            <Check size={18} color={tone.color} strokeWidth={2.75} />
          ) : outcome === "failed" ? (
            <AlertTriangle size={17} color={tone.color} />
          ) : outcome ? (
            <Info size={17} color={tone.color} />
          ) : (
            <Clock size={17} color={tone.color} />
          )}
        </View>
        <View className="flex-1">
          <Text className="text-[11px] font-bold uppercase tracking-wide text-gray-400">
            {swap ? "Swap" : "Bridge"}
          </Text>
          <Text className="text-[15px] font-bold text-light-matte-black">
            {outcome ? copy.title : phaseCopy(data.phase, swap)}
          </Text>
        </View>
      </View>
      {subtitle ? (
        <Text className="text-[11px] text-gray-500 mt-1 ml-12">{subtitle}</Text>
      ) : null}

      {/* Route summary: what left where, and what lands where. */}
      <View className="mt-3 flex-row items-center rounded-xl bg-gray-50 px-3 py-2.5">
        <RouteEnd
          amount={sentAmount}
          caip2={fromChain}
          chainName={fromChainName}
          align="left"
        />
        <View className="mx-2 h-7 w-7 items-center justify-center rounded-full border border-light-matte-black/10 bg-white">
          <ArrowRight size={13} color={BRAND_RED} />
        </View>
        <RouteEnd
          amount={receivedAmount}
          caip2={toChain}
          chainName={toChainName}
          align="right"
        />
      </View>

      {/*
        §7.7.1 — `partial` and `refunded` are OUTCOMES, not errors. They
        get their own plain copy naming the token actually received or the
        chain the refund landed on, and never route through agentErrorCopy.
      */}
      {copy.body ? (
        <Text className="text-sm text-light-matte-black/80 mt-2.5">
          {copy.body}
        </Text>
      ) : null}

      {outcome === "partial" && data.received_amount_raw ? (
        <Text className="text-xs font-semibold text-light-matte-black mt-1">
          Received{" "}
          {formatTokenValue(data.received_amount_raw, data.received_token)}
        </Text>
      ) : null}

      {/* The lifecycle. Live while in flight; folded away once settled. */}
      {showSteps ? (
        <View className="mt-3 px-0.5">
          {steps.map((step, i) => (
            <StepRow
              key={step.key}
              step={step}
              isLast={i === steps.length - 1}
            />
          ))}
        </View>
      ) : null}
      {outcome === "completed" ? (
        <Pressable
          onPress={() => {
            tapFeedback();
            setStepsOpen((v) => !v);
          }}
          accessibilityRole="button"
          accessibilityLabel={stepsOpen ? "Hide steps" : "Show steps"}
          className="flex-row items-center gap-1 mt-2.5 self-start active:opacity-70"
        >
          <Text className="text-[11px] font-bold text-light-primary-red">
            {stepsOpen ? "Hide steps" : "Show steps"}
          </Text>
          {stepsOpen ? (
            <ChevronUp size={13} color={BRAND_RED} />
          ) : (
            <ChevronDown size={13} color={BRAND_RED} />
          )}
        </Pressable>
      ) : null}

      {/* Both tx hashes surfaced (§7.7). */}
      {hasTx ? (
        <View className="mt-3 rounded-xl border border-light-matte-black/10 px-3 py-0.5">
          <TxLink
            label={`Sent on ${fromChainName}`}
            hash={sourceTxHash}
            url={data.explorer_url ?? sourceExplorerUrl}
            chain={fromChain}
          />
          {sourceTxHash && destinationTxHash ? (
            <View className="h-px bg-light-matte-black/5" />
          ) : null}
          <TxLink
            label={`Received on ${toChainName}`}
            hash={destinationTxHash}
            url={destExplorerUrl}
            chain={toChain}
          />
        </View>
      ) : null}

      {/* Taking far longer than it should, and not waiting on a claim:
          say so plainly and give the user something to do, never a
          spinner forever (§7.7). */}
      {!outcome && !data.claim_required && liveRecord?.stalled ? (
        <View className="mt-3 rounded-xl border border-amber-300/60 bg-amber-50 px-3 py-2.5">
          <View className="flex-row items-start gap-2">
            <View className="pt-0.5">
              <AlertTriangle size={13} color={WARN_AMBER} />
            </View>
            <Text className="flex-1 text-xs text-light-matte-black/80">
              {data.phase === "pending_source"
                ? `This is taking much longer than usual, and the transaction has not shown up on ${fromChainName} yet. It may not have gone through. Check the link above before trying again.`
                : "This is taking much longer than usual. Your funds are not lost: transfers like this can still settle. Check the link above for the latest."}
            </Text>
          </View>
          {onUserPrompt && sourceTxHash ? (
            <Pressable
              onPress={() => {
                tapFeedback();
                onUserPrompt(`Check the status of my transfer ${sourceTxHash}`);
              }}
              accessibilityRole="button"
              accessibilityLabel="Check status again"
              className="mt-2.5 self-start flex-row items-center gap-1.5 rounded-xl border-2 border-light-primary-red bg-light-primary-red/10 px-3 py-1.5 active:opacity-70"
            >
              <RefreshCw size={12} color={BRAND_RED} />
              <Text className="text-[11px] font-bold text-light-matte-black">
                Check status again
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {!outcome && data.claim_required ? (
        <View className="mt-3 rounded-xl bg-light-primary-red/5 px-3 py-2.5">
          <Text className="text-xs text-light-matte-black/80">
            Your funds are ready. Receive them with your {toChainName} wallet to
            finish this transfer. Until then they stay safe and waiting.
          </Text>
          {onUserPrompt ? (
            <Pressable
              onPress={() => {
                tapFeedback();
                onUserPrompt(
                  `Receive my bridged funds on ${toChainName} for transfer ${sourceTxHash ?? ""}`.trim(),
                );
              }}
              accessibilityRole="button"
              accessibilityLabel="Receive funds"
              className="mt-2.5 flex-row items-center justify-center gap-1.5 rounded-full bg-light-primary-red px-4 py-2.5 active:opacity-80"
            >
              <Text className="text-xs font-bold text-white">
                Receive on {toChainName}
              </Text>
              <ArrowRight size={14} color="#ffffff" />
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
};

export default BridgeProgressCard;
