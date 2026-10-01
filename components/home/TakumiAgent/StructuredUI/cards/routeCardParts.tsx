/**
 * Shared pieces of the route cards (`BridgeQuoteCard`, `SwapQuoteCard`).
 *
 * Spec: docs/swap-capability-spec.md §6.5 ("cards split, renderers
 * shared"). The two cards differ in what they disclose (destination and
 * readiness for a bridge, price impact and venue for a swap) but must look
 * and read the same, so the shell, rows, asset lines and fee breakdown live
 * here once. The bridge card's look is the reference.
 */

import { ShieldAlert, ShieldQuestion, Wallet } from "lucide-react-native";
import type React from "react";
import { useState } from "react";
import { Image, Pressable, Text, View } from "react-native";
import type {
  TBridgeFee,
  TBridgeRouteStep,
  TBridgeToken,
} from "@/api/types/bridge";
import { useTokenIdentity } from "@/hooks/queries/useTokenIdentity";
import { useBlockchainsWithStorage } from "@/hooks/useBlockchainsWithStorage";
import { useWallet } from "@/hooks/useWallet";
import { parseCaip2 } from "@/services/bridgeRoutes/caip";
import { needsTokenConfirmation, routeAck } from "@/services/swap/routeAck";
import { addressesEqual } from "@/services/walletKit/chainInfo";
import { tapFeedback } from "@/utils/hapticsUtils";
import {
  chainLabel,
  formatTokenAmount,
  formatTokenValue,
  formatUsd,
  partitionFees,
  truncateAddress,
} from "./bridgeFormat";
import { ChainIcon } from "./ChainIcon";

export const BRAND_RED = "#c71c4b";
export const MUTED = "#6b7280";
export const WARN_AMBER = "#b45309";

export type QuoteSide = {
  chain?: string;
  /** Backend-resolved display name, so the card never derives one. */
  chainName?: string;
  token?: TBridgeToken;
  address?: string;
  amountRaw?: string;
  amountUsd?: string;
};

// ── shells ────────────────────────────────────────────────────────────

export function Shell({ children }: { children: React.ReactNode }) {
  return (
    <View className="my-1.5 rounded-2xl border border-light-matte-black/10 bg-white px-4 py-3.5">
      {children}
    </View>
  );
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <Text className="text-[10px] font-bold uppercase tracking-wide text-gray-400">
      {children}
    </Text>
  );
}

export function Row({
  label,
  value,
  emphasis,
  valueColor,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
  valueColor?: string;
}) {
  return (
    <View className="flex-row items-center justify-between py-1">
      <Text className="text-xs text-gray-500 flex-1 pr-3">{label}</Text>
      <Text
        className={
          emphasis
            ? "text-xs font-bold text-light-matte-black"
            : "text-xs font-semibold text-light-matte-black"
        }
        style={valueColor ? { color: valueColor } : undefined}
      >
        {value}
      </Text>
    </View>
  );
}

// ── token identity ────────────────────────────────────────────────────

/** The EVM chain id inside a CAIP-2, or `undefined` for any other kind. */
function numericChainId(caip2: string | undefined): number | undefined {
  const reference = caip2 ? parseCaip2(caip2)?.reference : undefined;
  const n = Number(reference);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * Icons from our own token catalogue (`Token.logoUrl`, Alchemy images), from
 * the chain list the app already caches:
 *
 *  - `exact`: this contract on this chain;
 *  - `asset`: the same asset by symbol on ANY chain. An icon belongs to the
 *    asset, not to one deployment, so it is fine for display; chain-specific
 *    metadata (decimals, contract) never comes from here. Only offered for a
 *    token we vouch for, so a lookalike cannot borrow the real asset's face.
 */
function useCatalogueLogos(
  chain: string | undefined,
  address: string | undefined,
  symbol: string | undefined,
): { exact: string | null; asset: string | null } {
  const { data: blockchains } = useBlockchainsWithStorage({ isActive: true });
  const rows = blockchains ?? [];
  const wanted = address?.toLowerCase();
  const exact =
    chain && wanted
      ? (rows
          .find((b) => b.caip2Id === chain)
          ?.tokens?.find(
            (t) => (t.contractAddress ?? "").toLowerCase() === wanted,
          )?.logoUrl ?? null)
      : null;
  const folded = symbol?.toUpperCase();
  let asset: string | null = null;
  if (folded) {
    for (const row of rows) {
      const hit = row.tokens?.find(
        (t) => t.logoUrl && t.symbol.toUpperCase() === folded,
      );
      if (hit?.logoUrl) {
        asset = hit.logoUrl;
        break;
      }
    }
  }
  return { exact, asset };
}

/**
 * Token icon (left) + symbol. Icon sources, first that has one:
 *
 *  1. Alchemy's token metadata (`useTokenIdentity`, via our backend and the
 *     rpc proxy, cached a day). Alchemy only carries logos on some chains
 *     (Ethereum yes; Arc and Base return none, checked 2026-10-01);
 *  2. our own token catalogue's stored logo for this contract;
 *  3. the asset's logo from the quote (filled by the backend from any
 *     provider that has one, e.g. LI.FI);
 *  4. the same asset's catalogue logo on another chain, verified tokens
 *     only (an icon is the asset's, not the deployment's).
 *
 * With none, or if the image fails to load, the symbol stands alone. Pure
 * decoration: the contract address stays on the card next to it.
 */
export function TokenSymbol({
  token,
  chain,
}: {
  token: TBridgeToken | undefined;
  chain: string | undefined;
}) {
  const contract = token && !token.isNative ? token.address : undefined;
  const identity = useTokenIdentity(numericChainId(chain), contract);
  const catalogue = useCatalogueLogos(chain, contract, token?.symbol);
  const [failed, setFailed] = useState<string[]>([]);
  const logo = [
    identity.logo,
    catalogue.exact,
    token?.logoUri ?? null,
    token?.verification === "verified" ? catalogue.asset : null,
  ].find(
    (candidate): candidate is string =>
      !!candidate && !failed.includes(candidate),
  );

  return (
    <View className="flex-row items-center gap-1">
      {logo ? (
        <Image
          source={{ uri: logo }}
          // A broken image falls through to the next source, then to none.
          onError={() => setFailed((prev) => [...prev, logo])}
          style={{ width: 16, height: 16, borderRadius: 8 }}
          accessibilityIgnoresInvertColors
        />
      ) : null}
      <Text className="text-sm font-semibold text-light-matte-black">
        {token?.symbol ?? ""}
      </Text>
    </View>
  );
}

// ── what am I moving ──────────────────────────────────────────────────

/**
 * Which of the user's wallets is PAYING. Names the wallet when the address
 * matches one on the device ("Main Wallet"), otherwise shows the bare
 * address, which is itself the useful signal.
 */
export function SourceWallet({
  address,
  chain,
}: {
  address: string | undefined;
  chain: string | undefined;
}) {
  const { wallets } = useWallet();
  const namespace = chain ? parseCaip2(chain)?.namespace : undefined;
  if (!address) return null;

  const match = namespace
    ? wallets.find(
        (w) =>
          w.namespace === namespace &&
          addressesEqual(namespace, w.address, address),
      )
    : undefined;

  return (
    <View className="flex-row items-center gap-1 mt-0.5">
      <Wallet size={11} color={MUTED} />
      <Text className="text-[11px] text-gray-500">
        From {match?.name ? `${match.name} ` : ""}
        <Text className="text-gray-400">{truncateAddress(address)}</Text>
      </Text>
    </View>
  );
}

export function AssetLine({
  side,
  caption,
  showSourceWallet,
  showChain = true,
}: {
  side: QuoteSide | undefined;
  caption: string;
  /** Only the paying side; the destination is shown on its own. */
  showSourceWallet?: boolean;
  /**
   * Off for a swap: both sides sit on one chain, which the swap card names
   * once in its header instead of under each amount.
   */
  showChain?: boolean;
}) {
  const token = side?.token;
  const usd = formatUsd(side?.amountUsd);
  return (
    <View>
      <SectionLabel>{caption}</SectionLabel>
      <View className="flex-row items-center gap-1.5 mt-0.5">
        <Text className="text-lg font-bold text-light-matte-black">
          {formatTokenAmount(side?.amountRaw, token?.decimals)}
        </Text>
        <TokenSymbol token={token} chain={side?.chain} />
        {usd ? <Text className="text-[11px] text-gray-400">{usd}</Text> : null}
      </View>
      <View className="flex-row items-center gap-1 mt-0.5">
        {showChain ? (
          <>
            <ChainIcon caip2={side?.chain} size={12} />
            <Text className="text-[11px] text-gray-500">
              {side?.chainName ?? chainLabel(side?.chain)}
            </Text>
          </>
        ) : null}
        {token && !token.isNative ? (
          // USDC vs USDC.e are DIFFERENT assets: the contract is what stops
          // a silent mispick (bridge spec §7.1). The "Token" label keeps a
          // bare `0x…` from reading as somebody's wallet.
          <Text className="text-[10px] text-gray-400">
            Token {truncateAddress(token.address)}
          </Text>
        ) : null}
        {token?.verification === "unverified" ? (
          <View className="flex-row items-center gap-0.5">
            <ShieldQuestion size={11} color={WARN_AMBER} />
            <Text className="text-[10px] font-semibold text-amber-700">
              Unverified
            </Text>
          </View>
        ) : null}
      </View>
      {showSourceWallet ? (
        <SourceWallet address={side?.address} chain={side?.chain} />
      ) : null}
    </View>
  );
}

// ── token provenance ──────────────────────────────────────────────────

/**
 * The route delivers a token we cannot vouch for (swap spec §8.4 L1, T8):
 * not the issuer's pin, not in our catalogue, not the chain's native asset.
 * A real contract can carry any symbol, so the name proves nothing; the
 * address is the identity, and it is shown IN FULL because a lookalike
 * copies exactly the first and last characters a truncated one shows.
 *
 * Neither a silent pass nor a hard block: the user checks the address and
 * confirms here (recorded in `routeAck` for this route and amount), and
 * `bridge_execute` refuses until they have. Sends nothing itself.
 */
export function UnverifiedTokenNotice({
  side,
  ackKey,
  live,
  verb,
}: {
  side: QuoteSide | undefined;
  ackKey: string | null;
  live: boolean;
  /** "this swap gives you" / "this transfer delivers". */
  verb: string;
}) {
  const [confirmed, setConfirmed] = useState(
    () => (ackKey ? routeAck.get(ackKey)?.unverifiedConfirmed : false) ?? false,
  );
  const token = side?.token;
  if (!token || !needsTokenConfirmation({ to: { token } })) return null;
  const chain = side?.chainName ?? chainLabel(side?.chain);
  return (
    <View className="mt-2.5 rounded-xl border border-amber-300/50 bg-amber-50 px-3 py-2.5">
      <View className="flex-row items-center gap-1.5">
        <ShieldAlert size={13} color={WARN_AMBER} />
        <Text className="text-[11px] font-bold uppercase tracking-wide text-amber-700">
          Unverified token
        </Text>
      </View>
      <Text className="text-xs text-light-matte-black/80 mt-1">
        We can't verify the {token.symbol} {verb}. Anyone can create a token
        with any name, so check that this is the right address on {chain}:
      </Text>
      <Text
        selectable
        className="text-[11px] font-semibold text-light-matte-black mt-1"
      >
        {token.address}
      </Text>
      {confirmed ? (
        <Text className="text-[11px] font-semibold text-emerald-700 mt-1.5">
          Confirmed. You can approve it now.
        </Text>
      ) : live && ackKey ? (
        <Pressable
          onPress={() => {
            tapFeedback();
            routeAck.record(ackKey, { unverifiedConfirmed: true });
            setConfirmed(true);
          }}
          accessibilityRole="button"
          accessibilityLabel={`Confirm the ${token.symbol} address`}
          className="mt-2 self-start rounded-xl border-2 border-light-primary-red bg-light-primary-red/10 px-3 py-1.5 active:opacity-70"
        >
          <Text className="text-[11px] font-bold text-light-matte-black">
            I checked, use this {token.symbol}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

// ── fees and route ────────────────────────────────────────────────────

export function FeeBreakdown({ fees }: { fees: TBridgeFee[] | undefined }) {
  const { deducted, onTop } = partitionFees(fees);
  if (deducted.length === 0 && onTop.length === 0) return null;

  return (
    <View className="mt-2">
      {deducted.length > 0 ? (
        <>
          <SectionLabel>Taken from what you receive</SectionLabel>
          {deducted.map((fee) => (
            <Row
              key={`${fee.key}-${fee.label}-${fee.amountRaw}`}
              label={fee.label}
              value={
                formatUsd(fee.amountUsd) ??
                formatTokenValue(fee.amountRaw, fee.token)
              }
            />
          ))}
        </>
      ) : null}
      {onTop.length > 0 ? (
        <View className={deducted.length > 0 ? "mt-1.5" : undefined}>
          <SectionLabel>Paid on top</SectionLabel>
          {onTop.map((fee) => (
            <Row
              key={`${fee.key}-${fee.label}-${fee.amountRaw}`}
              label={fee.label}
              value={
                formatUsd(fee.amountUsd) ??
                formatTokenValue(fee.amountRaw, fee.token)
              }
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

export function RouteSteps({
  steps,
}: {
  steps: TBridgeRouteStep[] | undefined;
}) {
  const meaningful = (steps ?? []).filter(
    (s) => s.kind === "swap" || s.kind === "burn",
  );
  if (meaningful.length <= 1) return null;
  return (
    <View className="mt-2">
      <SectionLabel>Route</SectionLabel>
      {meaningful.map((step, index) => (
        <Text key={step.key} className="text-[11px] text-gray-500 mt-0.5">
          {index + 1}. {step.label}
        </Text>
      ))}
    </View>
  );
}
