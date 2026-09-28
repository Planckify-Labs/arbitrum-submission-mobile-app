/**
 * BridgeClaimCard — the approval + receipt surface for `bridge_claim`.
 *
 * Spec: docs/bridge-capability-spec.md §5.4.1, §7.7, §8.1.
 *
 * Stellar has no Circle Forwarding Service, so an EVM → Stellar transfer
 * is attested and then waits for SOMEONE to call
 * `CctpForwarder.mint_and_forward`. That someone is the user's own
 * Stellar wallet. The call moves nothing the burn did not already commit
 * (the recipient and amount are fixed inside the attested message), but
 * it is still a signature the user's wallet makes and pays a network fee
 * for, so it goes through `WriteApprovalGate` like every other write.
 *
 * Copy carries no em-dashes and no raw error text
 * (`feedback_no_emdash_in_ui_copy`, CLAUDE.md user-facing errors).
 */

import { AlertTriangle, ArrowUpRight, Check } from "lucide-react-native";
import type React from "react";
import { Linking, Pressable, Text, View } from "react-native";
import { tapFeedback } from "@/utils/hapticsUtils";
import { agentErrorCopy } from "../agentErrorCopy";
import { approvalSummaryFromToolInput } from "../approvalSummary";
import type { ToolComponentProps } from "../types";
import WriteApprovalGate from "../WriteApprovalGate";
import {
  chainLabel,
  declinedBridgeCopy,
  truncateAddress,
} from "./bridgeFormat";

const BRAND_RED = "#c71c4b";
const MUTED = "#6b7280";
const SUCCESS_GREEN = "#059669";

type BridgeClaimInput = {
  from_chain?: string;
  to_chain?: string;
  source_tx_hash?: string;
  provider?: string;
};

type BridgeClaimOutput = {
  status?: "success" | "failed" | string;
  error?: string;
  reason?: string;
  data?: {
    destination_tx_hash?: string;
    already_received?: boolean;
    explorer_url?: string;
    to_chain?: string;
  };
  user_decision?: "approved" | "rejected";
};

const BridgeClaimCard: React.FC<
  ToolComponentProps<BridgeClaimInput, BridgeClaimOutput>
> = ({
  state,
  input,
  output,
  error,
  mode,
  addToolResult,
  decision,
  onRequestApproval,
}) => {
  const destination = input?.to_chain
    ? chainLabel(input.to_chain)
    : "the destination";
  const toolError = output?.error ?? error;

  const declined = declinedBridgeCopy(toolError);
  if (declined) {
    return (
      <View className="my-1.5 rounded-2xl border border-gray-200 bg-gray-50 px-4 py-3.5">
        <View className="flex-row items-center gap-2">
          <AlertTriangle size={14} color={MUTED} />
          <Text className="text-[10px] font-bold uppercase tracking-wide text-gray-400">
            Not received yet
          </Text>
        </View>
        <Text className="text-sm text-gray-500 mt-1">
          You chose not to receive these funds now. They stay safe and can be
          received later.
        </Text>
      </View>
    );
  }

  if (state === "output-error" || output?.status === "failed") {
    return (
      <View className="my-1.5 rounded-2xl border border-light-primary-red/30 bg-light-primary-red/5 px-4 py-3.5">
        <View className="flex-row items-center gap-2">
          <AlertTriangle size={15} color={BRAND_RED} />
          <Text className="text-xs font-bold uppercase tracking-wide text-light-primary-red">
            Could not receive
          </Text>
        </View>
        <Text className="text-sm text-light-matte-black/80 mt-1.5">
          {agentErrorCopy(toolError, output?.reason)}
        </Text>
        <Text className="text-xs text-gray-500 mt-1.5">
          Your funds are not lost. They are waiting on {destination} and can be
          received later.
        </Text>
      </View>
    );
  }

  if (!output || state === "input-available" || state === "input-streaming") {
    const isLive = mode === "live" && Boolean(addToolResult);
    const summary = approvalSummaryFromToolInput(
      input as Record<string, unknown>,
      undefined,
      `Receive bridged funds on ${destination}`,
    );
    if (
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
    return (
      <View className="my-1.5 rounded-2xl border border-light-matte-black/10 bg-white px-4 py-3.5">
        <Text className="text-[10px] font-bold uppercase tracking-wide text-gray-400">
          {isLive ? "Receiving" : "Not received"}
        </Text>
        <Text className="text-sm text-gray-500 mt-1">{summary}</Text>
      </View>
    );
  }

  const hash = output.data?.destination_tx_hash;
  const explorer = output.data?.explorer_url;
  return (
    <View className="my-1.5 rounded-2xl border border-light-matte-black/10 bg-white px-4 py-3.5">
      <View className="flex-row items-center gap-2">
        <Check size={15} color={SUCCESS_GREEN} />
        <Text className="text-xs font-bold uppercase tracking-wide text-emerald-700">
          Received on {destination}
        </Text>
      </View>
      <Text className="text-sm text-light-matte-black/80 mt-1.5">
        {output.data?.already_received
          ? "These funds had already arrived. Nothing more to do."
          : "Your bridged funds are now in your wallet."}
      </Text>
      {hash ? (
        <Pressable
          disabled={!explorer}
          onPress={() => {
            if (!explorer) return;
            tapFeedback();
            void Linking.openURL(explorer);
          }}
          accessibilityRole={explorer ? "link" : undefined}
          className="flex-row items-center gap-1 mt-2 active:opacity-70"
        >
          <Text className="text-xs text-gray-500">
            Transaction {truncateAddress(hash)}
          </Text>
          {explorer ? <ArrowUpRight size={12} color={MUTED} /> : null}
        </Pressable>
      ) : null}
    </View>
  );
};

export default BridgeClaimCard;
