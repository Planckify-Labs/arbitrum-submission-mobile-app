/**
 * The device-side allowlist of Soroban bridge calls (bridge spec §5.4.1).
 */

import { describe, expect, it } from "vitest";
import {
  classifyStellarBridgeCall,
  STELLAR_CCTP_CONTRACTS,
  stellarUsdcSacId,
} from "./cctpContracts";

describe("classifyStellarBridgeCall", () => {
  it("allows exactly the pinned burn and the pinned claim, per network", () => {
    for (const network of ["pubnet", "testnet"] as const) {
      const pinned = STELLAR_CCTP_CONTRACTS[network];
      expect(
        classifyStellarBridgeCall(
          network,
          pinned.tokenMessengerMinter,
          "deposit_for_burn_with_hook",
        ),
      ).toEqual({ kind: "burn", network });
      expect(
        classifyStellarBridgeCall(
          network,
          pinned.forwarder,
          "mint_and_forward",
        ),
      ).toEqual({
        kind: "claim",
        network,
      });
    }
  });

  it("refuses a pinned contract with the wrong method, and any other contract", () => {
    const pinned = STELLAR_CCTP_CONTRACTS.pubnet;
    expect(
      classifyStellarBridgeCall("pubnet", pinned.forwarder, "rescue_sep41"),
    ).toBeNull();
    expect(
      classifyStellarBridgeCall(
        "pubnet",
        pinned.tokenMessengerMinter,
        "deposit_for_burn",
      ),
    ).toBeNull();
    expect(
      classifyStellarBridgeCall(
        "pubnet",
        stellarUsdcSacId("pubnet"),
        "transfer",
      ),
    ).toBeNull();
  });

  it("does not let a testnet contract pass on pubnet", () => {
    expect(
      classifyStellarBridgeCall(
        "pubnet",
        STELLAR_CCTP_CONTRACTS.testnet.forwarder,
        "mint_and_forward",
      ),
    ).toBeNull();
  });

  it("derives the pubnet USDC SAC Circle burns", () => {
    expect(stellarUsdcSacId("pubnet")).toBe(
      "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
    );
  });
});
