/**
 * Stellar bridge capability — CAIP ids, execution, destination readiness.
 *
 * Spec: docs/bridge-capability-spec.md §5.1, §5.2, §5.4, §7.5.
 *
 * Docked onto `StellarWalletKit` as optional, presence-checked methods
 * (`feedback_space_docking`).
 *
 * ## Why Stellar is the reason §7.5 exists
 *
 * Every other namespace's destination precondition is "have some gas".
 * Stellar's is a TRUSTLINE plus the XLM base reserve, and a trustline is
 * a hard precondition the recipient must have opted into. Our own code
 * says it best (`services/chains/stellar/trustlineService.ts`):
 *
 *   "no amount of sender-side signing can complete a transfer to an
 *    account that hasn't opted in."
 *
 * That is a different CLASS of problem from missing gas, which is why
 * §10.4 reframed the question from "does the destination need an
 * approve?" to per-namespace readiness. Every primitive we need already
 * exists — `hasTrustline`, `ensureTrustline`, `detectAccountFunded`,
 * `computeMinBalanceStroops`, `BASE_RESERVE_STROOPS` — and
 * `ensureTrustline` works on the caller's OWN wallet, which is exactly
 * our case: one mnemonic, so the Stellar wallet is the user's.
 *
 * Note also that Stellar has NO Fast Transfer and NO Forwarding Service
 * (§2.3, §7.5.1), so the warning path here is mandatory rather than an
 * optimisation.
 */

import {
  Address,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-base";
import type { ChainConfig } from "@/constants/configs/chainConfig";
import {
  BASE_RESERVE_STROOPS,
  computeMinBalanceStroops,
  detectAccountFunded,
} from "@/services/chains/stellar/accountState";
import { getHorizonClient } from "@/services/chains/stellar/horizonClient";
import { invokeSorobanContract } from "@/services/chains/stellar/sorobanInvoke";
import { getSorobanRpcClient } from "@/services/chains/stellar/sorobanRpcClient";
import { hasTrustline } from "@/services/chains/stellar/trustlineService";
import { getStellarSignerForWallet } from "@/services/walletService";
import {
  type BridgeDestinationReadinessArgs,
  BridgePayloadUnsupportedError,
  type BridgeReadinessBlocker,
  type SubmitBridgeExecutionArgs,
} from "../types";
import {
  classifyStellarBridgeCall,
  type StellarCctpNetwork,
  stellarUsdcSacId,
} from "./cctpContracts";

const STELLAR_NAMESPACE = "stellar" as const;

/**
 * Internal `ChainConfig.network` → CAIP-2 reference.
 *
 * This is the one namespace where the CAIP-2 wire reference diverges from
 * the app's internal value: CAIP-28 says `pubnet`, NOT `mainnet`. Getting
 * this wrong routes to a chain id nothing recognises.
 */
function caipReference(network: "mainnet" | "testnet"): "pubnet" | "testnet" {
  return network === "mainnet" ? "pubnet" : "testnet";
}

export function stellarCaip2For(chain: ChainConfig): string | null {
  return chain.namespace === STELLAR_NAMESPACE
    ? `${STELLAR_NAMESPACE}:${caipReference(chain.network)}`
    : null;
}

/**
 * CAIP-19 asset namespace for a Stellar classic asset.
 *
 * CAIP-19 constrains `asset_namespace` to `[-a-z0-9]{3,8}` (verified
 * against the CAIP-19 spec), so the descriptive `credit_alphanum4` /
 * `credit_alphanum12` names are NOT legal: they carry an underscore and
 * exceed 8 characters. There is no registered Stellar CAIP-19 profile at
 * time of writing, so we use the grammar-valid `asset` and document it
 * here rather than emit an id that fails its own spec.
 */
const STELLAR_ASSET_NAMESPACE = "asset";

/**
 * Internal `CODE:ISSUER` ⇄ CAIP-19 `CODE-ISSUER`.
 *
 * The app's `contractAddress` column carries Stellar assets as
 * `CODE:ISSUER`, but CAIP-19's `asset_reference` grammar is
 * `[-.%a-zA-Z0-9]{1,128}` and excludes the colon. `CODE-ISSUER` is both
 * grammar-valid AND Stellar's own canonical display form (the one
 * stellar.expert uses), so the round trip is lossless: asset codes are
 * alphanumeric only, so the FIRST hyphen is always the separator.
 *
 * Keeping this translation inside the Stellar kit is the point: no shared
 * code has to know that Stellar encodes assets differently from everyone
 * else.
 */
export function stellarToAssetCaip19(
  chain: ChainConfig,
  contractAddress?: string | null,
): string | null {
  const caip2 = stellarCaip2For(chain);
  if (!caip2) return null;
  if (!contractAddress) return `${caip2}/native`;

  // The issuer strkey is CASE-SENSITIVE, so it passes through verbatim
  // (`feedback_address_case_per_encoding`).
  const idx = contractAddress.indexOf(":");
  const reference =
    idx > 0
      ? `${contractAddress.slice(0, idx)}-${contractAddress.slice(idx + 1)}`
      : contractAddress;
  return `${caip2}/${STELLAR_ASSET_NAMESPACE}:${reference}`;
}

/**
 * The reverse of {@link stellarToAssetCaip19}: CAIP-19 back to the
 * `CODE:ISSUER` shape `sendTokenTransfer` / `hasTrustline` expect.
 * Returns `null` for the native asset, matching the "no contract" signal
 * those APIs already use.
 */
export function stellarFromAssetCaip19(asset: string): string | null {
  const slash = asset.indexOf("/");
  if (slash < 0) return null;
  const tail = asset.slice(slash + 1);
  if (tail === "native" || tail.startsWith("slip44:")) return null;

  const colon = tail.indexOf(":");
  if (colon < 0) return null;
  const reference = tail.slice(colon + 1);
  const hyphen = reference.indexOf("-");
  return hyphen > 0
    ? `${reference.slice(0, hyphen)}:${reference.slice(hyphen + 1)}`
    : reference;
}

/**
 * Ledgers a SEP-41 allowance stays valid (~83 minutes at 5 s a ledger).
 * The burn that consumes it is the very next transaction, so a short
 * window leaves no standing allowance behind if that burn never lands.
 */
const APPROVAL_LEDGER_WINDOW = 1_000;

function decodeArgs(argsXdrBase64: readonly string[]): xdr.ScVal[] {
  return argsXdrBase64.map((b64) => xdr.ScVal.fromXDR(b64, "base64"));
}

/**
 * Sign and submit a Soroban bridge invocation (`soroban_invoke`).
 *
 * Exactly two calls are accepted, both CCTP and both against contracts
 * PINNED ON THE DEVICE (`cctpContracts.ts`), never the backend's say-so:
 *
 *   - a Stellar-SOURCE burn, `deposit_for_burn_with_hook` on Circle's
 *     `TokenMessengerMinter`, preceded by the SEP-41 `approve` it needs
 *     (the contract pulls the USDC with `transfer_from`). The approve must
 *     name the pinned USDC contract and the pinned minter, the burn's
 *     `caller` must be this wallet, and both must move the same amount.
 *   - an inbound transfer's claim, `mint_and_forward` on `CctpForwarder`.
 *     Stellar has no Forwarding Service, so the user's own wallet collects
 *     the funds; the call is permissionless and can only pay the
 *     recipient the burn already named.
 *
 * Anything else is a `BridgePayloadUnsupportedError`. No restore callback
 * is passed, so archived contract state fails with a curated error rather
 * than spending XLM the user was not asked about.
 */
export async function stellarSubmitBridgeExecution({
  wallet,
  chain,
  payload,
}: SubmitBridgeExecutionArgs): Promise<string> {
  if (payload.kind !== "soroban_invoke") {
    throw new BridgePayloadUnsupportedError(payload.kind);
  }
  // The payload names its network. Signing a pubnet payload with a
  // testnet config (or the reverse) builds for the wrong passphrase.
  const caip2 = stellarCaip2For(chain);
  if (
    chain.namespace !== STELLAR_NAMESPACE ||
    !caip2 ||
    caip2 !== payload.chain
  ) {
    throw new BridgePayloadUnsupportedError(payload.kind);
  }
  const network: StellarCctpNetwork =
    chain.network === "mainnet" ? "pubnet" : "testnet";

  const call = classifyStellarBridgeCall(
    network,
    payload.contractId,
    payload.method,
  );
  if (!call) {
    throw new BridgePayloadUnsupportedError(payload.kind);
  }

  // The wallet bound to THIS intent, never a home-screen fallback
  // (`feedback_dapp_bridge_isolation`).
  const signer = await getStellarSignerForWallet(wallet);
  if (!signer) {
    throw new Error("StellarWalletKit.submitBridgeExecution: no signer");
  }

  const args = decodeArgs(payload.argsXdrBase64);
  const rpc = getSorobanRpcClient(chain);
  const horizon = getHorizonClient(chain);

  if (call.kind === "claim") {
    if (payload.approval || args.length !== 2) {
      throw new BridgePayloadUnsupportedError(payload.kind);
    }
  } else {
    const usdcSac = stellarUsdcSacId(network);
    const minter = payload.contractId;
    const approval = payload.approval;
    if (
      !approval ||
      approval.token !== usdcSac ||
      approval.spender !== minter ||
      args.length !== 9
    ) {
      throw new BridgePayloadUnsupportedError(payload.kind);
    }
    // deposit_for_burn_with_hook(caller, amount, domain, mint_recipient,
    // burn_token, destination_caller, max_fee, min_finality, hook_data):
    // the signer burns ITS OWN pinned USDC, for exactly the approved sum.
    const caller = scValToNative(args[0]);
    const amount = scValToNative(args[1]);
    const burnToken = scValToNative(args[4]);
    if (
      caller !== signer.publicKey() ||
      burnToken !== usdcSac ||
      typeof amount !== "bigint" ||
      amount !== BigInt(approval.amountRaw)
    ) {
      throw new BridgePayloadUnsupportedError(payload.kind);
    }

    const { sequence } = await rpc.getLatestLedger();
    // SEP-41 `approve(from, spender, amount, expiration_ledger)`.
    await invokeSorobanContract({
      rpc,
      horizon,
      signer,
      contractId: approval.token,
      method: "approve",
      args: [
        new Address(signer.publicKey()).toScVal(),
        new Address(approval.spender).toScVal(),
        nativeToScVal(amount, { type: "i128" }),
        nativeToScVal(sequence + APPROVAL_LEDGER_WINDOW, { type: "u32" }),
      ],
    });
  }

  return invokeSorobanContract({
    rpc,
    horizon,
    signer,
    contractId: payload.contractId,
    method: payload.method,
    args,
  });
}

/**
 * Headroom above the account's computed minimum balance. Adding a
 * trustline consumes one more base reserve (0.5 XLM), so an account
 * sitting exactly at its floor cannot opt in even though it "has" XLM.
 */
const TRUSTLINE_HEADROOM_STROOPS = BASE_RESERVE_STROOPS + 1_000_000n;

const SUGGESTED_TOP_UP_USD = 2;

/**
 * Stellar destination readiness.
 *
 * Three distinct blockers, in dependency order:
 *   1. The account does not exist on the ledger at all.
 *   2. It exists but has no trustline to the incoming asset. Without one
 *      the transfer CANNOT complete — this is `blocking`, not a warning.
 *   3. It has a trustline but is at its reserve floor, so it cannot
 *      afford another subentry or a fee.
 *
 * Copy is hand-written and carries no em-dashes (`feedback_no_emdash_in_ui_copy`).
 */
export async function stellarCheckBridgeDestinationReadiness({
  chain,
  address,
  contractAddress,
  assetCaip19,
}: BridgeDestinationReadinessArgs): Promise<BridgeReadinessBlocker[]> {
  if (chain.namespace !== STELLAR_NAMESPACE) return [];

  const horizon = getHorizonClient(chain);

  let funded: boolean;
  try {
    funded = await detectAccountFunded(horizon, address);
  } catch {
    // A check that cannot run must not invent a blocker: warning on
    // incomplete information trains users to dismiss the real warning.
    return [];
  }

  if (!funded) {
    return [
      {
        code: "account_not_funded",
        message:
          "This Stellar account has not been created yet. It needs a small amount of XLM before it can hold any asset.",
        severity: "blocking",
        remedy: {
          kind: "fund_account",
          minimumRaw: (BASE_RESERVE_STROOPS * 2n).toString(),
          symbol: "XLM",
        },
      },
    ];
  }

  if (contractAddress) {
    const idx = contractAddress.indexOf(":");
    if (idx > 0 && idx < contractAddress.length - 1) {
      const code = contractAddress.slice(0, idx);
      const issuer = contractAddress.slice(idx + 1);

      let trusts: boolean;
      try {
        trusts = await hasTrustline(horizon, address, code, issuer);
      } catch {
        return [];
      }

      if (!trusts) {
        return [
          {
            code: "missing_trustline",
            message: `This account has not set up ${code} yet. Funds cannot arrive until a trustline is added, which locks 0.5 XLM as a reserve.`,
            severity: "blocking",
            remedy: {
              kind: "establish_trustline",
              asset:
                assetCaip19 ??
                stellarToAssetCaip19(chain, contractAddress) ??
                contractAddress,
            },
          },
        ];
      }
    }
  }

  // Trustline present. Check there is room above the reserve floor to
  // actually move the funds afterwards.
  try {
    const account = await horizon.loadAccount(address);
    const native = account.balances.find((b) => b.asset_type === "native");
    const balanceStroops = native
      ? BigInt(Math.round(Number.parseFloat(native.balance) * 10_000_000))
      : 0n;
    const minBalance = computeMinBalanceStroops(account);
    if (balanceStroops < minBalance + TRUSTLINE_HEADROOM_STROOPS) {
      return [
        {
          code: "no_destination_gas",
          message:
            "This Stellar account is at its minimum XLM reserve. You will not be able to move these funds after they arrive.",
          severity: "warning",
          remedy: { kind: "gas_top_up", suggestedUsd: SUGGESTED_TOP_UP_USD },
        },
      ];
    }
  } catch {
    return [];
  }

  return [];
}
