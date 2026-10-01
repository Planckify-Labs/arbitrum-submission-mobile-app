/**
 * `useTransferFee` — the live network-fee quote for the send screen.
 *
 * Re-prices every `REFRESH_MS` while the screen is open (fee markets move
 * between the moment someone types an amount and the moment they tap Send)
 * and immediately when the recipient, asset, chain or amount changes
 * (amount debounced so typing doesn't hammer the RPC).
 *
 * Who pays the fee follows the same policy as the send itself:
 * `resolveGasPayment` decides stablecoin-abstracted vs native, so the
 * number shown is in the coin that will actually be charged. Chain-specific
 * pricing lives in each kit's optional `estimateTransferFee`; this hook
 * presence-checks it and never branches on namespace.
 */

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { TToken } from "@/api/types/token";
import type { ChainConfig } from "@/constants/configs/chainConfig";
import type { TWallet } from "@/constants/types/walletTypes";
import { resolveGasPayment } from "@/services/gasAbstraction/resolveGasPayment";
import type { GasFeeTokenPreference } from "@/services/gasAbstraction/types";
import type { WalletKitAdapter } from "@/services/walletKit/types";
import { chainCacheKey } from "./useWallet.helpers";

const REFRESH_MS = 12_000;
const AMOUNT_DEBOUNCE_MS = 400;

export type TransferFeeQuote =
  /** Fee is paid in the chain's native coin. `maxFeeNative` is what the account must hold. */
  | { mode: "native"; feeNative: bigint; maxFeeNative: bigint }
  /** Fee is paid in a stablecoin through the relayer. */
  | { mode: "abstracted"; feeAtoms: bigint; symbol: string; decimals: number }
  /** Stablecoin fee applies but the account can't cover amount + fee in it. */
  | {
      mode: "blocked";
      feeAtoms: bigint;
      symbol: string;
      decimals: number;
      needed: bigint;
      have: bigint;
    };

export interface UseTransferFeeArgs {
  kit: WalletKitAdapter;
  chain: ChainConfig;
  wallet: TWallet | undefined;
  /**
   * A recipient the kit has validated, or null. With none, the fee is
   * priced against the sender's own address so it shows immediately;
   * `isProvisional` tells the UI it is not yet exact.
   */
  recipient: string | null;
  /** Amount in the sent asset's smallest unit; null while empty or unparsable. */
  amountRaw: bigint | null;
  token: TToken | undefined;
  nativeBalance: bigint;
  preferredGasToken: GasFeeTokenPreference;
  enabled: boolean;
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

export function useTransferFee(args: UseTransferFeeArgs) {
  const {
    kit,
    chain,
    wallet,
    recipient,
    token,
    nativeBalance,
    preferredGasToken,
    enabled,
  } = args;
  const amountRaw = useDebounced(args.amountRaw, AMOUNT_DEBOUNCE_MS);

  const isToken = token?.isNativeCurrency === false && !!token.contractAddress;
  const contractAddress = isToken ? token?.contractAddress : undefined;
  const decimals = token?.decimals ?? 18;
  const canQuote = enabled && !!wallet?.address && !!kit.estimateTransferFee;
  const to = recipient ?? wallet?.address ?? null;

  // Everything except the amount; a change here is a different question,
  // so its previous answer must not linger as a placeholder.
  const scope = [
    "transferFee",
    chainCacheKey(chain),
    wallet?.address,
    to,
    contractAddress ?? "native",
    preferredGasToken,
  ];

  const query = useQuery<TransferFeeQuote>({
    queryKey: [...scope, amountRaw?.toString() ?? "none"],
    enabled: canQuote,
    refetchInterval: REFRESH_MS,
    // The app default keeps queries for 7 days (persistence); a fee quote
    // is worthless in a minute.
    gcTime: 60_000,
    // Always re-price on a key change. The app default (60s stale) would
    // show a cached quote when the user flips the gas setting back to one
    // they used a moment ago, instead of fetching under the new setting.
    staleTime: 0,
    // Keep the last number on screen while a new amount re-prices so the
    // row doesn't flash empty on every keystroke, but only within the same
    // scope: a new chain / asset / recipient must not show the old fee.
    placeholderData: (prev, prevQuery) =>
      prevQuery && scope.every((part, i) => prevQuery.queryKey[i] === part)
        ? prev
        : undefined,
    queryFn: async (): Promise<TransferFeeQuote> => {
      // `canQuote` guarantees these; narrow for the compiler.
      if (!wallet || !to || !kit.estimateTransferFee) {
        throw new Error("fee quote not ready");
      }
      const tokenArg = contractAddress
        ? { contractAddress, decimals }
        : undefined;

      if (tokenArg) {
        // A zero amount can't be quoted by the relayer; the fee barely
        // depends on it, so price a single atom until one is entered.
        const amount = amountRaw && amountRaw > 0n ? amountRaw : 1n;
        const plan = await resolveGasPayment({
          wallet,
          chain,
          intent: {
            to,
            tokenAddress: tokenArg.contractAddress,
            amount,
            decimals,
            memo: "takumipay-send",
          },
          preferredGasToken,
        });
        if (__DEV__) {
          console.log("[transferFee] plan", {
            preferredGasToken,
            mode: plan.mode,
          });
        }
        if (plan.mode === "abstracted") {
          return {
            mode: "abstracted",
            feeAtoms: plan.quote.feeAmount,
            symbol: plan.quote.feeToken.symbol,
            decimals: plan.quote.feeToken.decimals,
          };
        }
        if (plan.mode === "blocked") {
          return {
            mode: "blocked",
            feeAtoms: plan.needed > amount ? plan.needed - amount : 0n,
            symbol: plan.feeToken.symbol,
            decimals: plan.feeToken.decimals,
            needed: plan.needed,
            have: plan.have,
          };
        }
      }

      // Nodes won't price a native transfer the sender can't fund; the fee
      // doesn't depend on the amount, so clamp to what is held.
      const requested = amountRaw ?? 0n;
      const amount = tokenArg
        ? requested
        : requested > nativeBalance
          ? nativeBalance
          : requested;
      if (__DEV__) {
        console.log("[transferFee] native quote", {
          preferredGasToken,
          isToken: !!tokenArg,
        });
      }
      const est = await kit.estimateTransferFee({
        chain,
        from: wallet.address,
        to,
        amount,
        token: tokenArg,
      });
      return {
        mode: "native",
        feeNative: est.feeNative,
        maxFeeNative: est.maxFeeNative,
      };
    },
  });

  return {
    quote: query.data ?? null,
    /** First load, nothing to show yet. */
    isLoading: canQuote && query.isPending,
    /** Couldn't price it and have nothing older to show. */
    isUnavailable: canQuote && query.isError && query.data === undefined,
    /** The kit can't price transfers at all (capability missing). */
    isSupported: !!kit.estimateTransferFee,
    /** Priced against the sender's own address because no valid recipient yet. */
    isProvisional: !recipient,
    updatedAt: query.dataUpdatedAt,
    refetch: query.refetch,
  };
}
