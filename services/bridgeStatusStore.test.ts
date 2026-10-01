import { beforeEach, describe, expect, it, vi } from "vitest";
import { bridgeApi } from "@/api/endpoints/bridge";
import type { TBridgeStatus } from "@/api/types/bridge";
import {
  bridgeStatusStore,
  MAX_POLL_MS,
  pollDelayMs,
  SOURCE_STALL_MS,
} from "./bridgeStatusStore";

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

    // Initial poll, scheduled at once
    await vi.advanceTimersByTimeAsync(0);
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

  const pending = (phase: TBridgeStatus["phase"]): TBridgeStatus => ({
    outcome: null,
    phase,
    sourceTxHash: "0xabc",
  });
  const start = () =>
    bridgeStatusStore.startPolling({
      sourceTxHash: "0xabc",
      fromChain: "eip155:1",
      toChain: "eip155:8453",
    });

  it("backs off: 4 s early, 10 s after two minutes, 30 s after twenty", () => {
    expect(pollDelayMs(0)).toBe(4_000);
    expect(pollDelayMs(3 * 60_000)).toBe(10_000);
    expect(pollDelayMs(25 * 60_000)).toBe(30_000);
  });

  it("never overlaps requests when the backend is slower than the interval", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    vi.mocked(bridgeApi.getStatus).mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 9_000));
      inFlight--;
      return pending("pending_attestation");
    });
    start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(maxInFlight).toBe(1);
  });

  it("flags a transfer never seen on the source chain as stalled", async () => {
    vi.mocked(bridgeApi.getStatus).mockResolvedValue(pending("pending_source"));
    start();
    await vi.advanceTimersByTimeAsync(SOURCE_STALL_MS - 60_000);
    expect(bridgeStatusStore.get("0xabc")?.stalled).toBe(false);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(bridgeStatusStore.get("0xabc")?.stalled).toBe(true);
  });

  it("stops polling for good after the cap, leaving the stalled state", async () => {
    const mock = vi
      .mocked(bridgeApi.getStatus)
      .mockResolvedValue(pending("pending_attestation"));
    start();
    await vi.advanceTimersByTimeAsync(MAX_POLL_MS + 60_000);
    const calls = mock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(mock.mock.calls.length).toBe(calls);
    expect(bridgeStatusStore.get("0xabc")?.stalled).toBe(true);
  });

  it("a request in flight when polling stops does not re-arm it", async () => {
    const mock = vi
      .mocked(bridgeApi.getStatus)
      .mockImplementation(
        () =>
          new Promise((r) =>
            setTimeout(() => r(pending("pending_attestation")), 2_000),
          ),
      );
    const stop = start();
    await vi.advanceTimersByTimeAsync(500); // first request now in flight
    stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mock).toHaveBeenCalledTimes(1);
  });
});
