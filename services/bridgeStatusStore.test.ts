import { beforeEach, describe, expect, it, vi } from "vitest";
import { bridgeApi } from "@/api/endpoints/bridge";
import type { TBridgeStatus } from "@/api/types/bridge";
import { bridgeStatusStore } from "./bridgeStatusStore";

vi.mock("@/api/endpoints/bridge", () => ({
  bridgeApi: {
    getStatus: vi.fn(),
  },
}));

describe("bridgeStatusStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    bridgeStatusStore.clear();
  });

  it("normalizes txHash when getting and updating", () => {
    const status: TBridgeStatus = {
      outcome: null,
      phase: "pending_attestation",
      sourceTxHash: "0xAbCdEf",
    };

    bridgeStatusStore.update("0xAbCdEf", status, {
      fromChain: "eip155:84532",
      toChain: "eip155:5042002",
    });

    expect(bridgeStatusStore.get("0xabcdef")).toBeDefined();
    expect(bridgeStatusStore.get("0xabcdef")?.status.phase).toBe(
      "pending_attestation",
    );
  });

  it("polls in background and updates status on response", async () => {
    const mockStatusPending: TBridgeStatus = {
      outcome: null,
      phase: "pending_attestation",
      sourceTxHash: "0x123",
    };
    const mockStatusComplete: TBridgeStatus = {
      outcome: "completed",
      phase: "settled",
      sourceTxHash: "0x123",
      destinationTxHash: "0x456",
    };

    const getStatusMock = vi.mocked(bridgeApi.getStatus);
    getStatusMock
      .mockResolvedValueOnce(mockStatusPending)
      .mockResolvedValueOnce(mockStatusComplete);

    let notificationCount = 0;
    const unsub = bridgeStatusStore.subscribe(() => {
      notificationCount++;
    });

    bridgeStatusStore.startPolling({
      sourceTxHash: "0x123",
      fromChain: "eip155:84532",
      toChain: "eip155:5042002",
      provider: "circle",
    });

    // Initial immediate poll (microtask)
    await Promise.resolve();
    await Promise.resolve();
    expect(getStatusMock).toHaveBeenCalledWith({
      fromChain: "eip155:84532",
      toChain: "eip155:5042002",
      txHash: "0x123",
      provider: "circle-cctp", // normalized
    });

    expect(bridgeStatusStore.get("0x123")?.status.phase).toBe(
      "pending_attestation",
    );

    // Second poll tick (4s)
    await vi.advanceTimersByTimeAsync(4000);
    expect(getStatusMock).toHaveBeenCalledTimes(2);
    expect(bridgeStatusStore.get("0x123")?.status.outcome).toBe("completed");

    // Once completed, polling should have stopped
    await vi.advanceTimersByTimeAsync(8000);
    expect(getStatusMock).toHaveBeenCalledTimes(2);

    expect(notificationCount).toBeGreaterThanOrEqual(2);
    unsub();
  });
});
