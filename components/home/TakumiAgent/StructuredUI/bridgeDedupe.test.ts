import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@/services/agent-messages/types";
import {
  computeSuppressedBridgePartsInMessage,
  computeSuppressedBridgeToolCallIds,
  extractBridgeSourceTxHash,
} from "./bridgeDedupe";

describe("bridgeDedupe", () => {
  describe("extractBridgeSourceTxHash", () => {
    it("extracts from output.data.source_tx_hash", () => {
      const part = {
        type: "tool" as const,
        toolCallId: "call-1",
        toolName: "bridge_execute",
        state: "output-available" as const,
        input: {},
        output: {
          data: {
            source_tx_hash: "0xABC123",
          },
        },
      };
      expect(extractBridgeSourceTxHash(part)).toBe("0xabc123");
    });

    it("extracts from input.source_tx_hash for bridge_status", () => {
      const part = {
        type: "tool" as const,
        toolCallId: "call-2",
        toolName: "bridge_status",
        state: "input-available" as const,
        input: {
          source_tx_hash: "0xDEF456",
        },
      };
      expect(extractBridgeSourceTxHash(part)).toBe("0xdef456");
    });

    it("returns null for non-bridge tools", () => {
      const part = {
        type: "tool" as const,
        toolCallId: "call-3",
        toolName: "send_native_token",
        state: "output-available" as const,
        input: {},
        output: { tx_hash: "0x123" },
      };
      expect(extractBridgeSourceTxHash(part)).toBeNull();
    });
  });

  describe("computeSuppressedBridgeToolCallIds (across messages)", () => {
    it("suppresses subsequent bridge_status when bridge_execute exists for same hash", () => {
      const messages: AgentMessage[] = [
        {
          id: "msg-1",
          role: "assistant",
          createdAt: "2026-09-28T00:00:00Z",
          parts: [
            {
              type: "tool",
              toolCallId: "exec-1",
              toolName: "bridge_execute",
              state: "output-available",
              input: {},
              output: { data: { source_tx_hash: "0xabc" } },
            },
          ],
        },
        {
          id: "msg-2",
          role: "assistant",
          createdAt: "2026-09-28T00:00:05Z",
          parts: [
            {
              type: "tool",
              toolCallId: "status-1",
              toolName: "bridge_status",
              state: "output-available",
              input: { source_tx_hash: "0xabc" },
              output: { data: { source_tx_hash: "0xabc" } },
            },
          ],
        },
        {
          id: "msg-3",
          role: "assistant",
          createdAt: "2026-09-28T00:00:10Z",
          parts: [
            {
              type: "tool",
              toolCallId: "status-2",
              toolName: "bridge_status",
              state: "output-available",
              input: { source_tx_hash: "0xabc" },
              output: { data: { source_tx_hash: "0xabc" } },
            },
          ],
        },
      ];

      const suppressed = computeSuppressedBridgeToolCallIds(messages);
      expect(suppressed.has("exec-1")).toBe(false);
      expect(suppressed.has("status-1")).toBe(true);
      expect(suppressed.has("status-2")).toBe(true);
    });

    it("suppresses duplicate bridge_status across messages when no execute card exists", () => {
      const messages: AgentMessage[] = [
        {
          id: "msg-1",
          role: "assistant",
          createdAt: "2026-09-28T00:00:00Z",
          parts: [
            {
              type: "tool",
              toolCallId: "status-1",
              toolName: "bridge_status",
              state: "output-available",
              input: { source_tx_hash: "0xdef" },
              output: { data: { source_tx_hash: "0xdef" } },
            },
          ],
        },
        {
          id: "msg-2",
          role: "assistant",
          createdAt: "2026-09-28T00:00:05Z",
          parts: [
            {
              type: "tool",
              toolCallId: "status-2",
              toolName: "bridge_status",
              state: "output-available",
              input: { source_tx_hash: "0xdef" },
              output: { data: { source_tx_hash: "0xdef" } },
            },
          ],
        },
      ];

      const suppressed = computeSuppressedBridgeToolCallIds(messages);
      expect(suppressed.has("status-1")).toBe(false);
      expect(suppressed.has("status-2")).toBe(true);
    });

    it("does not suppress different bridge transactions", () => {
      const messages: AgentMessage[] = [
        {
          id: "msg-1",
          role: "assistant",
          createdAt: "2026-09-28T00:00:00Z",
          parts: [
            {
              type: "tool",
              toolCallId: "exec-1",
              toolName: "bridge_execute",
              state: "output-available",
              input: {},
              output: { data: { source_tx_hash: "0x111" } },
            },
          ],
        },
        {
          id: "msg-2",
          role: "assistant",
          createdAt: "2026-09-28T00:00:05Z",
          parts: [
            {
              type: "tool",
              toolCallId: "exec-2",
              toolName: "bridge_execute",
              state: "output-available",
              input: {},
              output: { data: { source_tx_hash: "0x222" } },
            },
          ],
        },
      ];

      const suppressed = computeSuppressedBridgeToolCallIds(messages);
      expect(suppressed.has("exec-1")).toBe(false);
      expect(suppressed.has("exec-2")).toBe(false);
    });
  });

  describe("computeSuppressedBridgePartsInMessage (within single message)", () => {
    it("suppresses sibling bridge_status when bridge_execute is in the same message", () => {
      const message: AgentMessage = {
        id: "msg-1",
        role: "assistant",
        createdAt: "2026-09-28T00:00:00Z",
        parts: [
          {
            type: "tool",
            toolCallId: "exec-1",
            toolName: "bridge_execute",
            state: "output-available",
            input: {},
            output: { data: { source_tx_hash: "0xabc" } },
          },
          {
            type: "tool",
            toolCallId: "status-1",
            toolName: "bridge_status",
            state: "output-available",
            input: { source_tx_hash: "0xabc" },
            output: { data: { source_tx_hash: "0xabc" } },
          },
        ],
      };

      const suppressed = computeSuppressedBridgePartsInMessage(message);
      expect(suppressed.has("exec-1")).toBe(false);
      expect(suppressed.has("status-1")).toBe(true);
    });
  });
});
