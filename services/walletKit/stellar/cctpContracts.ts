/**
 * Circle CCTP contracts on Stellar, PINNED ON THE DEVICE.
 *
 * Spec: docs/bridge-capability-spec.md §5.4, §5.4.1.
 *
 * ⚠️ Security-reviewed table. The backend pins the same ids
 * (`api/src/bridge/providers/cctp/stellar-burn-params.ts`), but the phone
 * does not take the backend's word for which contract it is signing
 * against: `stellarSubmitBridgeExecution` refuses any Soroban bridge
 * invocation that is not one of the exact (contract, method) pairs below.
 * A compromised or buggy backend can therefore not turn a bridge payload
 * into, say, a `transfer` of the user's USDC to itself.
 *
 * Sources, verified 2026-09-26: Circle "CCTP Stellar contracts and
 * interfaces" (contract ids), the deployed contracts' own Soroban spec
 * (method signatures), and a testnet round trip in both directions.
 */

import { Asset, Networks } from "@stellar/stellar-base";

export type StellarCctpNetwork = "pubnet" | "testnet";

export const STELLAR_CCTP_CONTRACTS: Record<
  StellarCctpNetwork,
  { tokenMessengerMinter: string; forwarder: string }
> = {
  pubnet: {
    tokenMessengerMinter:
      "CAE2G5Z77UP7GYPYGFOWFGW7C7J6I4YP2AFGSADRKQY62SYUFLPNFTXL",
    forwarder: "CBZL2IH7F6BIDAA3WBNXYKIXSATJGMSW7K5P5MJ6STX5RXN47TZJDF5T",
  },
  testnet: {
    tokenMessengerMinter:
      "CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP",
    forwarder: "CA66Q2WFBND6V4UEB7RD4SAXSVIWMD6RA4X3U32ELVFGXV5PJK4T4VSZ",
  },
};

/** Circle-issued USDC, `CODE:ISSUER`. Issuer strkeys are case-sensitive. */
const STELLAR_USDC_ASSET: Record<StellarCctpNetwork, [string, string]> = {
  pubnet: ["USDC", "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"],
  testnet: ["USDC", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"],
};

/**
 * The USDC Stellar Asset Contract. Derived from the pinned classic asset
 * (a deterministic hash of asset + network), never typed in.
 */
export function stellarUsdcSacId(network: StellarCctpNetwork): string {
  const [code, issuer] = STELLAR_USDC_ASSET[network];
  return new Asset(code, issuer).contractId(
    network === "pubnet" ? Networks.PUBLIC : Networks.TESTNET,
  );
}

/**
 * The only Soroban bridge invocations this wallet will sign.
 *
 *   - `deposit_for_burn_with_hook` on `TokenMessengerMinter`: a
 *     Stellar-source CCTP burn, preceded by a SEP-41 `approve` of the USDC
 *     contract to that same `TokenMessengerMinter` (it pulls with
 *     `transfer_from`).
 *   - `mint_and_forward` on `CctpForwarder`: the claim that completes an
 *     inbound transfer. Permissionless, atomic, and it can only pay the
 *     recipient the burn already named.
 */
export type AllowedStellarBridgeCall =
  | { kind: "burn"; network: StellarCctpNetwork }
  | { kind: "claim"; network: StellarCctpNetwork };

export function classifyStellarBridgeCall(
  network: StellarCctpNetwork,
  contractId: string,
  method: string,
): AllowedStellarBridgeCall | null {
  const pinned = STELLAR_CCTP_CONTRACTS[network];
  if (
    contractId === pinned.tokenMessengerMinter &&
    method === "deposit_for_burn_with_hook"
  ) {
    return { kind: "burn", network };
  }
  if (contractId === pinned.forwarder && method === "mint_and_forward") {
    return { kind: "claim", network };
  }
  return null;
}
