/**
 * Facts-first approval summaries — prompt-injection defense for every
 * agent write card.
 *
 * `human_summary` / `description` on a write tool's input are authored by
 * the MODEL, and the model can be steered by injected content it read
 * earlier in the turn (token names, pool names, dApp copy, memos). The
 * approval gate (WriteApprovalGate → PreviewCard / ApprovalSheet) renders
 * exactly one summary string, so if that string comes from the model, an
 * injected prompt can describe a drain as something harmless and the
 * user approves a lie.
 *
 * Rule enforced here: when the tool input carries structured facts
 * (recipient, amount, asset), the summary is BUILT FROM THE FACTS and the
 * model's prose is ignored. Model prose is only used when there are no
 * facts to show (e.g. a tool whose input is a free-form plan id), where
 * it is cosmetic rather than authoritative.
 */

import { prettyProtocol } from "@/services/defi/opportunityDisplay";

export function truncateAddress(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/**
 * Human label for a CAIP-2 chain id, by TABLE LOOKUP.
 *
 * `eip155:8453` on an approval sheet tells the user nothing. Unlike the
 * bridge cards, this surface sees only raw tool ARGS and has no
 * backend-resolved display name to read, so it keeps a small static map.
 *
 * Deliberately a lookup and not a set of namespace comparisons: shared UI
 * must not branch on the chain family (CLAUDE.md hard rule, enforced by
 * `pnpm check:chains`). An unknown chain falls back to the CAIP-2 id,
 * which is honest rather than wrong.
 */
// Also the last-resort fallback for `bridgeFormat.ts`'s `chainLabel` when
// the backend's own resolved name is unavailable (cold LI.FI chains cache
// - see lifi.adapter.ts `chainNameFor`). One table, so the approval gate
// and the display cards never disagree on a chain's name.
export const CHAIN_NAMES: Record<string, string> = {
  // Mainnets
  "eip155:1": "Ethereum",
  "eip155:10": "OP Mainnet",
  "eip155:56": "BNB Chain",
  "eip155:137": "Polygon",
  "eip155:8453": "Base",
  "eip155:42161": "Arbitrum",
  "eip155:43114": "Avalanche",
  "eip155:59144": "Linea",
  "eip155:5042": "Arc",
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": "Solana",
  "sui:mainnet": "Sui",
  "stellar:pubnet": "Stellar",

  // Testnets
  "eip155:84532": "Base Sepolia",
  "eip155:421614": "Arbitrum Sepolia",
  "eip155:11155111": "Ethereum Sepolia",
  "eip155:11155420": "OP Sepolia",
  "eip155:80002": "Polygon Amoy",
  "eip155:59141": "Linea Sepolia",
  "eip155:43113": "Avalanche Fuji",
  "eip155:97": "BNB Chain Testnet",
  "eip155:5042002": "Arc Testnet",
  "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1": "Solana Devnet",
  "sui:testnet": "Sui Testnet",
  "sui:devnet": "Sui Devnet",
  "stellar:testnet": "Stellar Testnet",
};

/**
 * EVM chains whose native coin is not ETH but still wears `slip44:60`.
 * Arc's gas token is USDC: calling it "ETH" on an approval would name
 * the wrong asset.
 */
const NATIVE_SYMBOL_BY_CHAIN: Record<string, string> = {
  "eip155:5042": "USDC",
  "eip155:5042002": "USDC",
};

function chainName(caip2: string): string {
  if (CHAIN_NAMES[caip2]) return CHAIN_NAMES[caip2];
  if (caip2.startsWith("eip155:")) {
    return `EVM Chain ${caip2.slice("eip155:".length)}`;
  }
  return caip2;
}

/**
 * Last path segment of a CAIP-19 is the contract / mint / coin type, not
 * a symbol, so there is no symbol to recover for a token asset. Native
 * assets DO carry one structurally, and naming them beats showing a raw
 * `slip44:60`.
 */
function assetSymbolFromCaip19(asset: string | undefined): string | undefined {
  if (!asset) return undefined;
  const nativeOverride = NATIVE_SYMBOL_BY_CHAIN[asset.split("/")[0]];
  if (nativeOverride && asset.includes("/slip44:")) return nativeOverride;
  if (asset.includes("/slip44:60")) return "ETH";
  if (asset.includes("/slip44:501")) return "SOL";
  if (asset.endsWith("::sui::SUI")) return "SUI";
  if (asset.includes("/native")) return "XLM";
  return undefined;
}

/**
 * Smallest-units → human amount, but ONLY when the decimals are actually
 * known. Returns `undefined` otherwise so the caller omits the number
 * entirely: on an approval screen, no amount is recoverable ("check the
 * card"), while a wrong amount is actively dangerous — "5000000" and "5"
 * are the same argument rendered with and without this information.
 *
 * bigint arithmetic, not `Number`: a 78-digit raw amount loses precision
 * through a float, and this string is what the user approves against.
 */
export function formatSmallestUnits(
  amountRaw: string | undefined,
  decimals: number | undefined,
): string | undefined {
  if (!amountRaw || typeof decimals !== "number" || decimals < 0) {
    return undefined;
  }
  if (!/^[0-9]+$/.test(amountRaw)) return undefined;

  let value: bigint;
  try {
    value = BigInt(amountRaw);
  } catch {
    return undefined;
  }

  const base = 10n ** BigInt(decimals);
  const whole = (value / base).toLocaleString("en-US");
  const fraction = value % base;
  if (decimals === 0 || fraction === 0n) return whole;

  const trimmed = fraction
    .toString()
    .padStart(decimals, "0")
    .slice(0, 6)
    .replace(/0+$/, "");
  return trimmed ? `${whole}.${trimmed}` : whole;
}

export type ApprovalFacts = {
  /** Leading verb, defaults to "Send". */
  action?: string;
  /** Human-readable amount, verbatim from the tool args. */
  amount?: string;
  /** Asset label (symbol / code); derived from args, never model prose. */
  asset?: string;
  /** Recipient / spender address, verbatim from the tool args. */
  to?: string;
  /** Optional trusted label rendered next to the address, e.g. a name. */
  toLabel?: string;
  /**
   * Trailing clause appended verbatim, e.g. "from Base to Solana" for a
   * bridge. Built from tool args like everything else here, never prose.
   */
  suffix?: string;
};

type ModelProse = {
  human_summary?: unknown;
  description?: unknown;
};

function nonEmptyString(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

/**
 * Build the approval-gate line. Facts win; model prose is a fallback for
 * fact-less inputs only; `fallback` is the terminal default.
 */
export function factsFirstSummary(
  facts: ApprovalFacts,
  prose: ModelProse,
  fallback: string,
): string {
  const amount = nonEmptyString(facts.amount);
  const to = nonEmptyString(facts.to);

  const suffix = nonEmptyString(facts.suffix);

  if (amount || to || suffix) {
    const action = nonEmptyString(facts.action) ?? "Send";
    const asset = nonEmptyString(facts.asset);
    const parts: string[] = [action];
    if (amount) parts.push(asset ? `${amount} ${asset}` : amount);
    else if (asset) parts.push(asset);
    if (to) {
      const addr = truncateAddress(to);
      const label = nonEmptyString(facts.toLabel);
      parts.push(label ? `to ${label} (${addr})` : `to ${addr}`);
    }
    if (suffix) parts.push(suffix);
    return parts.join(" ");
  }

  return (
    nonEmptyString(prose.human_summary) ??
    nonEmptyString(prose.description) ??
    fallback
  );
}

/**
 * Generic facts-first summary for an arbitrary write-tool input, used by
 * the surfaces that see every tool (the run-down PreviewCard and the
 * ApprovalSheet) rather than a per-tool card. Probes the union of fact
 * fields the write executors accept across namespaces; falls back to the
 * server's `human_summary` only when the input carries no facts at all.
 */
export function approvalSummaryFromToolInput(
  input: Record<string, unknown>,
  serverSummary: string | undefined,
  fallback = "This action",
  /**
   * Token metadata the raw tool args cannot carry. Amounts arrive as
   * SMALLEST UNITS, so without decimals the only honest options are to
   * omit the number or print "5000000" for 5 USDC. Callers that can reach
   * the token catalogue (see `resolveAssetMeta`) supply it so the
   * approval can state the real amount. `toSymbol` names the asset a
   * same-chain swap pays out, which the args carry only as a CAIP-19.
   */
  assetMeta?: { symbol?: string; decimals?: number; toSymbol?: string },
): string {
  const str = (k: string): string | undefined =>
    typeof input[k] === "string" && (input[k] as string).trim().length > 0
      ? (input[k] as string)
      : undefined;

  const spender = str("spender");
  const to = str("to") ?? spender ?? str("destination") ?? str("recipient");

  // Bridge writes (bridge-capability-spec §8.1). A bridge's identity is
  // the ROUTE, not a recipient — but the DESTINATION ADDRESS is still
  // load-bearing and must appear: it is what the known-destination
  // envelope asks the user to confirm, and an approval that hides the
  // address would record a confirmation for something never seen.
  const fromChain = str("from_chain");
  const toChain = str("to_chain");
  // `bridge_claim`: completes a transfer that was ALREADY sent (bridge
  // spec §5.4.1). It moves nothing the burn did not commit, and carries
  // no amount, so the facts are where it lands and which transfer it
  // finishes. Without this branch it would read "Bridge from X to Y",
  // i.e. describe sending money a second time.
  const sourceTxHash = str("source_tx_hash");
  if (fromChain && toChain && sourceTxHash && !str("amount_raw")) {
    return factsFirstSummary(
      {
        action: "Receive",
        suffix: `your bridged funds on ${chainName(toChain)} (transfer ${truncateAddress(sourceTxHash)})`,
      },
      {},
      `Receive bridged funds on ${chainName(toChain)}`,
    );
  }
  if (fromChain && toChain) {
    const symbol =
      assetMeta?.symbol ?? assetSymbolFromCaip19(str("from_asset"));
    const amount = formatSmallestUnits(str("amount_raw"), assetMeta?.decimals);
    // A same-chain route is a swap (Tower on Arc). The payout lands in the
    // signing wallet itself, so there is no destination to call out, and
    // "Bridge from Arc to Arc" would describe something that is not
    // happening.
    if (fromChain === toChain) {
      const toSymbol =
        assetMeta?.toSymbol ?? assetSymbolFromCaip19(str("to_asset"));
      const where = `on ${chainName(fromChain)}`;
      return factsFirstSummary(
        {
          action: "Swap",
          amount,
          asset: symbol,
          suffix: toSymbol ? `to ${toSymbol} ${where}` : where,
        },
        {},
        `Swap ${where}`,
      );
    }
    const toAddress = str("to_address");
    const route = `from ${chainName(fromChain)} to ${chainName(toChain)}`;
    return factsFirstSummary(
      {
        action: "Bridge",
        amount,
        asset: symbol,
        suffix: toAddress
          ? `${route}, arriving at ${truncateAddress(toAddress)}`
          : route,
      },
      {},
      `Bridge ${route}`,
    );
  }

  // DeFi writes (`defi_deposit`, `defi_withdraw`, `defi_rebalance`). None of
  // their facts live in the fields probed above — the amount is
  // `amount_raw`, the asset is `asset_symbol`, the counterparty is a POOL
  // rather than an address — so this input used to carry no facts at all.
  // That had two costs: the approval line fell through to the model's own
  // prose (exactly what this module exists to prevent), and the card read
  // "Transaction", which tells a user nothing about the thing they are
  // being asked to approve.
  const protocolSlug = str("protocol_slug");
  const depositSymbol = str("asset_symbol");
  const moveSymbol = str("from_asset_symbol");
  // `defi_withdraw`'s `protocol_slug`/`asset_symbol` are OPTIONAL display
  // hints (never routing — see writes.ts `assertWithdrawHintsMatchPosition`),
  // present alongside `position_id`. Their presence, not the chain family,
  // is what tells "Withdraw" apart from "Deposit" here — chain-agnostic by
  // construction, same as the `chainName()` CAIP-2 lookup below.
  const isWithdraw = !!str("position_id");
  if (protocolSlug && (depositSymbol || moveSymbol)) {
    const venue = prettyProtocol(protocolSlug);
    const chainId = input.chain_id;
    const chain =
      typeof chainId === "number" ? chainName(`eip155:${chainId}`) : undefined;
    const preposition = isWithdraw ? "from" : "into";
    const where = chain
      ? `${preposition} ${venue} on ${chain}`
      : `${preposition} ${venue}`;
    const action = moveSymbol ? "Move" : isWithdraw ? "Withdraw" : "Deposit";
    return factsFirstSummary(
      {
        action,
        // Smallest units without decimals stays omitted rather than printed
        // raw — "200000000" would read as a wildly different amount than the
        // 2 the user asked for.
        amount: formatSmallestUnits(str("amount_raw"), assetMeta?.decimals),
        asset: assetMeta?.symbol ?? moveSymbol ?? depositSymbol,
        suffix: where,
      },
      {},
      `${action} ${where}`,
    );
  }

  const nativeAmount =
    str("amount_xlm") ?? str("amount_sol") ?? str("amount_sui");
  const nativeAsset = str("amount_xlm")
    ? "XLM"
    : str("amount_sol")
      ? "SOL"
      : str("amount_sui")
        ? "SUI"
        : undefined;

  const coinTail = str("coin_type")?.split("::").pop();
  const amount = nativeAmount ?? str("amount") ?? str("token_amount");
  const asset =
    nativeAsset ??
    str("symbol") ??
    str("token_symbol") ??
    str("code") ??
    coinTail;

  return factsFirstSummary(
    {
      action: spender ? "Approve" : "Send",
      amount,
      asset,
      to,
      toLabel: spender ? str("spender_name") : undefined,
    },
    { human_summary: serverSummary },
    serverSummary && serverSummary.trim().length > 0 ? serverSummary : fallback,
  );
}
