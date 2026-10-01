import type {
  AgentMessage,
  AgentMessagePart,
} from "@/services/agent-messages/types";

/** Tools whose result is the canonical progress card for a transfer. */
const EXECUTE_TOOLS: ReadonlySet<string> = new Set([
  "bridge_execute",
  "swap_execute",
  "defi_cross_chain_deposit",
]);

/** Status polls that share that card and must never duplicate it. */
const STATUS_TOOLS: ReadonlySet<string> = new Set([
  "bridge_status",
  "swap_status",
]);

export const BRIDGE_PROGRESS_TOOLS: ReadonlySet<string> = new Set([
  ...EXECUTE_TOOLS,
  ...STATUS_TOOLS,
]);

/**
 * Extracts a normalized lowercase source transaction hash from a bridge tool part
 * (either from its output or its input).
 */
export function extractBridgeSourceTxHash(
  part: AgentMessagePart,
): string | null {
  if (part.type !== "tool") return null;
  if (!BRIDGE_PROGRESS_TOOLS.has(part.toolName)) return null;

  const output = part.output as Record<string, unknown> | undefined;
  const input = part.input as Record<string, unknown> | undefined;
  const outputData = output?.data as Record<string, unknown> | undefined;

  const candidate =
    outputData?.source_tx_hash ??
    outputData?.sourceTxHash ??
    outputData?.tx_hash ??
    output?.source_tx_hash ??
    output?.sourceTxHash ??
    output?.tx_hash ??
    input?.source_tx_hash ??
    input?.sourceTxHash ??
    input?.tx_hash;

  if (typeof candidate === "string" && candidate.trim().length > 0) {
    return candidate.trim().toLowerCase();
  }
  return null;
}

/**
 * Suppresses redundant bridge progress cards across messages in a conversation.
 *
 * Requirements:
 *  1. Exactly ONE BridgeProgressCard per bridge transfer across turns.
 *  2. Priority is given to `bridge_execute` (or `defi_cross_chain_deposit`) as
 *     the canonical execution card for a sourceTxHash.
 *  3. Subsequent `bridge_status` tool calls for the same transfer are suppressed
 *     because the canonical card already updates in real time via `bridgeStatusStore`.
 *  4. If multiple `bridge_status` calls exist without an execute card, only the first
 *     one renders; subsequent duplicates are suppressed.
 */
export function computeSuppressedBridgeToolCallIds(
  messages: AgentMessage[],
): Set<string> {
  const suppressed = new Set<string>();

  // Track the single canonical toolCallId chosen to render each bridge hash.
  const canonicalByHash = new Map<string, string>();

  // Pass 1: Give first priority to execution cards (bridge_execute / defi_cross_chain_deposit)
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type !== "tool") continue;
      if (!BRIDGE_PROGRESS_TOOLS.has(part.toolName)) continue;

      if (EXECUTE_TOOLS.has(part.toolName)) {
        const hash = extractBridgeSourceTxHash(part);
        if (hash) {
          if (!canonicalByHash.has(hash)) {
            canonicalByHash.set(hash, part.toolCallId);
          } else {
            // Already have a canonical execute card for this hash
            suppressed.add(part.toolCallId);
          }
        }
      }
    }
  }

  // Pass 2: For status cards, suppress if an execute card exists or if an earlier
  // status card already claimed this hash.
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type !== "tool") continue;
      if (!BRIDGE_PROGRESS_TOOLS.has(part.toolName)) continue;

      if (STATUS_TOOLS.has(part.toolName)) {
        const hash = extractBridgeSourceTxHash(part);
        if (hash) {
          if (canonicalByHash.has(hash)) {
            suppressed.add(part.toolCallId);
          } else {
            // First time seeing this hash and no execute card exists
            canonicalByHash.set(hash, part.toolCallId);
          }
        }
      }
    }
  }

  return suppressed;
}

/**
 * Within a single message, suppress any sibling `bridge_status` when a `bridge_execute`
 * is present, or suppress duplicate `bridge_status` calls.
 */
export function computeSuppressedBridgePartsInMessage(
  message: AgentMessage,
): Set<string> {
  const suppressed = new Set<string>();
  const bridgeParts: Array<{
    toolCallId: string;
    toolName: string;
    hash: string | null;
    index: number;
  }> = [];

  message.parts.forEach((part, index) => {
    if (part.type !== "tool") return;
    if (!BRIDGE_PROGRESS_TOOLS.has(part.toolName)) return;
    bridgeParts.push({
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      hash: extractBridgeSourceTxHash(part),
      index,
    });
  });

  if (bridgeParts.length <= 1) return suppressed;

  const hasExecute = bridgeParts.some((p) => EXECUTE_TOOLS.has(p.toolName));

  const seenHashes = new Set<string>();
  let hasRenderedStatusWithoutHash = false;

  for (const p of bridgeParts) {
    if (EXECUTE_TOOLS.has(p.toolName)) {
      if (p.hash) seenHashes.add(p.hash);
      continue;
    }

    if (STATUS_TOOLS.has(p.toolName)) {
      // If message already has an execute card, suppress all sibling status cards
      if (hasExecute) {
        suppressed.add(p.toolCallId);
        continue;
      }

      if (p.hash) {
        if (seenHashes.has(p.hash)) {
          suppressed.add(p.toolCallId);
        } else {
          seenHashes.add(p.hash);
        }
      } else {
        if (hasRenderedStatusWithoutHash) {
          suppressed.add(p.toolCallId);
        } else {
          hasRenderedStatusWithoutHash = true;
        }
      }
    }
  }

  return suppressed;
}
