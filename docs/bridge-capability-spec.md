# Bridge Capability — Engineering Spec

**Status:** Implemented, all phases (0-5 on 2026-08-04; phase 4 rebuilt
and extended on 2026-09-26, see §5.4 and §5.4.1). Not device-verified.
Stellar mainnet stays behind `CCTP_STELLAR_MAINNET_ENABLED` (§10.6).
**Scope:** 3 repos — `mobile-app`, `api`, `agent-api`.
**Sources verified:** Circle docs (`developers.circle.com`, 2026-08-04 and
2026-09-26), Arc App Kit docs (`docs.arc.io/app-kit`) plus the shipped
`@circle-fin/app-kit@1.15.3` source, the deployed Stellar CCTP contracts'
own Soroban spec, and live `li.quest` v1 API. §2 corrects an earlier EURC
claim that came from secondary sources and was wrong.
**Related:** `docs/defi-strategies-spec.md` (§11 executors, §13 backend),
`docs/defi-pool-level-deposits-spec.md` (registry/docking precedent),
`docs/generative-ui-spec.md` (StructuredUI cards),
`docs/agent-permission-deny-layer-spec.md` (write-tool authorization).
**Supersedes the cross-chain scope of:** `docs/defi-strategies-task/14_lifi_cross_chain_routing_*.md`.

---

## 1. Goal & non-goals

### Goal

Give Takumi Agent a **general-purpose bridge capability**: move any
LI.FI-routable asset between any two supported chains, across namespaces
(`eip155` ↔ `solana` ↔ `sui`), with a disclosure surface that meets the
bar every credible bridge UI meets.

New chains and new assets must dock in **without editing shared code** —
same contract as `WalletKitAdapter` optional capabilities and the DeFi
adapter registry.

### Non-goals

- Replacing `defi_cross_chain_deposit`. It is refactored to *compose*
  the new primitives (§8.3), not deleted.
- Bitcoin. LI.FI supports it (UTXO); we have no BTC wallet. The registry
  leaves room, phase 5 at the earliest.
- Custodial (Circle Wallets) flows. We are non-custodial; see §5.4.

> **Reversed non-goal.** An earlier draft ruled out integrating CCTP
> directly, on the grounds that LI.FI already reaches it. Verification
> against Circle primary source (§2) overturned that: **CCTP reaches
> Stellar and LI.FI does not.** A direct CCTP adapter is now in scope
> as phase 4.

---

## 2. CCTP reality check

**Verified against Circle primary source** (`developers.circle.com`,
`llms.txt` doc index, 2026-08-04).

The investigation that triggered this spec asked "what tokens besides
USDC can CCTP bridge, and to what chains". The answer reframes the work:

> **CCTP bridges USDC. Only USDC.**

CCTP is burn-and-mint. It requires the token *issuer* to hold mint
authority on the destination chain. There is no "extend CCTP to more
tokens" path; that is a category error. CCTP's only axis of extension is
**more chains**.

> ⚠️ **Correction.** An earlier draft of this spec said "USDC and EURC",
> sourced from secondary write-ups. That is **wrong**. Circle's CCTP
> documentation mentions EURC **zero times** across the overview,
> supported-chains, fees, and technical-guide pages, and the EURC page
> itself describes no CCTP path. EURC is a Circle stablecoin, but it is
> not a CCTP asset. Do not plan around bridging it.
>
> This is a live instance of the "verify protocol specs from source"
> rule: three independent secondary sources agreed with each other and
> were all wrong.
>
> ---
>
> 🔄 **Superseded 2026-09-26.** The claim above is correct about
> `TokenMessengerV2` and **no longer complete**. Circle has since shipped
> **CCTP for non-USDC assets** (`/cctp/expanded-assets`), a separate
> product built on the same Iris attestation service, and **EURC is a
> pre-configured token on it**. It is a different entry contract
> (`CrossChainTokenService`), a different fee model (native gas on the
> source rather than deducted from the amount), a different approval
> target (a per-token `TokenManager`) and a much smaller chain set (7 EVM
> chains: Ethereum, Avalanche, OP, Arbitrum, Base, Polygon, Arc).
>
> So: **USDC and EURC are both bridgeable, through two different Circle
> products.** They must be two adapters, never one branch. See
> `docs/swap-capability-spec.md` §4.10 for the full comparison, verified
> against `developers.circle.com` on 2026-09-26.
>
> Note also that **CCTP V1 is being deprecated**: it begins 2026-10-31
> and completes 2026-12-01. **Sui and Noble are V1-only** as of this
> writing (Sui = domain 8), so §10.7's Sui assumptions need revisiting
> before the sunset.

### 2.1 We already have CCTP

Verified live against `li.quest/v1/tools`. LI.FI aggregates CCTP under
four bridge keys:

| Tool key | Mechanism | Chain reach |
|---|---|---|
| `celercircle` | CCTP + Celer (Standard) | 7 EVM |
| `celercirclefast` | CCTP + Celer (Fast) | 7 EVM |
| `mayanMCTP` | CCTP + Mayan | 14, **incl. Solana + Sui** |
| `mayanFastMCTP` | CCTP **v2** + Mayan | 14, **incl. Solana + Sui** |

`mayanMCTP` / `mayanFastMCTP` reach: Arbitrum, Avalanche, BSC, Base,
Ethereum, HyperEVM, Hyperliquid, Linea, Monad, OP, Polygon, Solana, Sui,
Unichain.

LI.FI selects CCTP automatically when it is the best USDC route. Our
`LifiClient.getRoute` already reaches all of it.

### 2.2 Where the actual headroom is

LI.FI aggregates **35 bridges**. The 31 non-CCTP ones (Across, Stargate
V2, Relay, Symbiosis, Squid, NEAR Intents, Garden, Eco, …) route
**arbitrary tokens** — ETH, WBTC, USDT, native assets, long-tail ERC-20s.

That is the real answer to "besides USDC", and it needs **zero new
integrations**. It needs us to stop blocking it (§4).

### 2.3 CCTP chain reach (verified)

CCTP V2 covers **28 chains**. Domain IDs are Circle-issued and
deliberately unrelated to public chain IDs:

| Domain | Chain | Domain | Chain | Domain | Chain |
|---|---|---|---|---|---|
| 0 | Ethereum | 12 | Codex | 22 | Plume |
| 1 | Avalanche | 13 | Sonic | 25 | Starknet |
| 2 | OP Mainnet | 14 | World Chain | 26 | Arc (mainnet + testnet) |
| 3 | Arbitrum | 15 | Monad | **27** | **Stellar** |
| 5 | Solana | 16 | Sei | 28 | EDGE |
| 6 | Base | 17 | BNB Smart Chain¹ | 29 | Injective |
| 7 | Polygon PoS | 18 | XDC | 30 | Morph |
| 10 | Unichain | 19 | HyperEVM | 31 | Pharos |
| 11 | Linea | 21 | Ink | 32 | Cronos |

¹ BNB Smart Chain is **USYC only**, not USDC.

Three findings that matter to us:

- **Stellar is domain 27.** CCTP supports it. LI.FI does not. This is
  the whole reason §5.4 exists.
- **Sui is absent from the V2 table.** Per Circle's doc index, "Noble,
  Sui, and Aptos still require V1". So our Sui path stays LI.FI
  (`mayanMCTP`), which is fine and already works.
- Fast Transfer (~8-20s) is source-chain-gated; Standard is ~15-19 min.
  Chains marked N/A are already fast enough that Fast Transfer adds
  nothing. **Stellar has no Fast Transfer.**

---

## 3. What LI.FI actually supports

Verified live, `li.quest/v1/chains?chainTypes=EVM,SVM,UTXO,MVM`.

### 3.1 Reachable

72 chains: **69 EVM**, plus Solana (`SVM`, LI.FI id
`1151111081099710`), Sui (`MVM`, `9270000000000000`), Bitcoin (`UTXO`,
`20000000000001`).

### 3.2 Not reachable

**Stellar is absent from LI.FI entirely.** We ship Stellar
(`project_stellar_chain_support_implemented`).

This does **not** mean Stellar has no bridge path. It means Stellar has
no *LI.FI* path. CCTP reaches Stellar directly (domain 27, §2.3), which
is precisely the case the provider registry exists to absorb: a second
adapter covers what the first cannot, and no shared code learns the
difference. See §5.4.

"No route" remains a first-class state (§7.6) for genuinely unroutable
pairs, e.g. a non-USDC asset on Stellar.

---

## 4. Current blockers (all ours, none LI.FI's)

LI.FI reaches 72 chains and 35 bridges. We narrow that to EVM-only USDC
in five places:

1. **`api/src/strategies/dto/cross-chain-quote.dto.ts`** — every address
   field is `@Matches(/^0x[a-fA-F0-9]{40}$/)` and chain fields are
   `@IsInt()`. A Solana mint or a Sui coin type is *inexpressible*.
2. **`services/agent-executors/defi/writes.ts:1779`** — hard
   `adapter.namespace !== "eip155"` reject.
3. **`services/agent-executors/defi/writes.ts:1817`** — native-asset
   sentinel fires only for the literal string `"ETH"`.
4. **`agent-api/src/agents/defi/tools/propose.ts:175-185`** —
   `from_chain_id` / `to_chain_id` typed `integer`; the schema cannot
   carry a CAIP-2 id.
5. **No standalone bridge tool exists.** `defi_cross_chain_deposit` is
   welded to a DeFi deposit. A user who just wants to move USDC from
   Base to Arbitrum has no path at all.

Plus a data blocker, §6.

---

## 5. Architecture — the docking seam

### 5.1 Identifiers: CAIP-2 / CAIP-19

Chain identity becomes **CAIP-2** (`eip155:8453`, `sui:mainnet`,
`solana:5eykt4Us…`) and asset identity **CAIP-19**, end to end: agent
tool schema → API DTO → executor.

This kills the `0x…{40}` regex problem *generically* rather than adding
a Solana special-case, and it is the format `services/walletconnect/caipMapping.ts`
already speaks.

### 5.2 `BridgeRouteAdapter` registry

Mirrors `services/defi/registry.ts` exactly (register / get / list, no
central switch).

```ts
export interface BridgeRouteAdapter {
  key: string;                       // "lifi"
  supports(from: Caip2, to: Caip2): boolean;
  toProviderChainId(c: Caip2): string | number | null;
  toProviderAsset(a: Caip19): string | null;
  quote(req: BridgeQuoteRequest): Promise<BridgeQuote>;
  execute(q: BridgeQuote, ctx: ExecCtx): Promise<BridgeSubmission>;
  status(ref: BridgeRef): Promise<BridgeStatus>;
  /** Per-namespace preconditions on the destination. See §7.5. */
  checkDestinationReadiness(to: Caip2, addr: string): Promise<Blocker[]>;
  // optional capabilities, presence-checked (space docking)
  gasTopUp?(req: GasTopUpRequest): Promise<BridgeQuote>;
}
```

`supports()` is the whole seam. Adding Bitcoin, or a non-LI.FI provider
later (a direct CCTP adapter, a Stellar bridge when one exists), is
**registering an adapter**. No enum edit, no branch in shared code, and
`pnpm check:chains` stays green because nothing under `components/`,
`hooks/`, `app/` learns a namespace string.

The CAIP-2 ↔ provider-chain-id mapping (`eip155:8453` → `8453`,
`solana:…` → `1151111081099710`, `sui:mainnet` → `9270000000000000`)
lives **inside** the adapter. That table is LI.FI's private numbering and
must never leak upward.

### 5.3 Support matrix is queried, never hardcoded

`GET /bridge/support` on the API, backed by cached `li.quest/v1/chains`,
`/v1/tools`, `/v1/connections`.

Consequence: **Circle adding a CCTP domain, or LI.FI adding a bridge,
lights up for us with no deploy and no code change.** This is the direct
answer to "easy to extend for the future". It is also why §2's
unverifiable domain table does not block us.

Cache TTL 1h, stale-while-revalidate. A cold/failed fetch degrades to
"we could not check routes right now", never to a wrong "unsupported".

### 5.4 Circle providers: Arc App Kit for USDC/EURC, raw CCTP for Stellar (phase 4)

> **Rebuilt 2026-09-26.** The Stellar-only scoping below (§10.5) was
> overtaken by two facts: LI.FI lists Arc mainnet but serves no route on
> it, and routing USDC through LI.FI costs 25 bps on a rail Circle runs
> for free. Phase 4 now registers THREE Circle adapters. The original
> text follows this box and is kept for its reasoning.
>
> | Adapter | Asset | Built on | Reach | Mechanism |
> |---|---|---|---|---|
> | `circle-cctp` | USDC | **Arc App Kit** (`@circle-fin/app-kit`) | App Kit's bridge chains: EVM sources, EVM + Solana destinations | CCTP V2 + Forwarding Service |
> | `circle-cctpx` | EURC | **Arc App Kit** | chains App Kit marks `cctpx` (Ethereum, Avalanche, OP, Arbitrum, Base, Polygon, Arc) | CCTP for non-USDC, always forwarded |
> | `cctp` | USDC | raw contract calls | EVM ⇄ Stellar, both directions | CCTP V2; Stellar has no Forwarding Service |
>
> **Why App Kit.** Circle's Arc docs send builders to App Kit for
> bridging ("App Kit wraps CCTP"). It owns the approve → burn →
> attestation → mint lifecycle, the fee quote, the CCTPx signed quote and
> Solana ATA creation. Bridge Kit is folded into it; we install the core
> package. The api calls `AppKit.estimateBridge()` (read-only, with a Viem
> adapter around an account that throws on every signature). The device
> uses only the `@circle-fin/app-kit/bridge` + `/context` subpaths and
> `@circle-fin/adapter-viem-v2` (Metro bundles those, not the 2.5 MB
> index), in exactly one file:
> `services/bridgeRoutes/adapters/circle/appKitBridge.ts`.
>
> **Why on-device execution is safe on a 15-minute transfer.** App Kit's
> `bridge()` awaits the whole lifecycle in-process. Every Circle payload
> sets `useForwarder: true`, so Circle submits the destination mint and
> nothing after the burn needs the phone. The device resolves at the
> point of no return, App Kit's `bridge.burn` event (`bridge.transfer` for
> CCTPx), and hands the hash to `bridge_status`, which polls Iris
> (`forwardState`) from the backend. This replaces the remote-signing
> backend job sketched in swap spec §4.11: forwarding removes the only
> reason that job existed, and without forwarding it would still have
> needed a destination signature 15 minutes later.
>
> **What the device checks before signing.** The backend sends parameters,
> never calldata, and App Kit builds the calls against Circle's pinned
> contracts. The phone still verifies every parameter against the quote
> the user approved, and resolves chain names through App Kit's own
> registry (`resolveChainIdentifier`) so a backend cannot relabel one
> chain as another (`verifyPayload.ts`). The EVM signer is issued for the
> source chain only.
>
> **Routing.** Both App Kit adapters declare `supportsAsset`, so the
> registry sorts them ahead of LI.FI for USDC/EURC; LI.FI stays the
> fallback when they decline (estimate failure, a destination without
> Forwarding Service, a source whose Standard attestation exceeds an
> hour: Linea is 6-32 h). Standard speed always; Fast is never selected
> silently. The fee on screen is the fee that executes: the burn's
> `maxFee` is pinned to the quoted forwarding fee, and Circle spends
> unused headroom as destination priority fee, so expected == minimum.
>
> **Verified live, 2026-09-26:** Base → Arc quote (5 USDC → 4.982262 after
> a 0.017738 delivery fee); Arc → Base EURC quote (full amount arrives,
> 0.057 USDC native fee on top); and an end-to-end App Kit transfer Arc
> Testnet → Base Sepolia driven exactly as the device drives it (burn
> event at +6.8 s, forwarded mint at +31.7 s, 1.94535 USDC received as
> quoted).

#### Original phase-4 text (2026-08-04)

> **Scope decision (§10.5).** The `cctp` adapter serves **only routes
> touching Stellar**. It is deliberately *not* a general EVM provider.
>
> LI.FI already aggregates CCTP and picks it when it is the best USDC
> route (§2.1), so an EVM-capable `cctp` adapter would add an
> arbitration problem without adding a single new capability. Scoping to
> Stellar makes `supports()` deterministic, removes the "optimise for
> cost or time?" question entirely, and confines phase 4's risk
> (§5.4.1) to one chain.

The registry earns its keep immediately, because **no single provider
covers our four namespaces**:

| Provider | Assets | Reaches | Misses |
|---|---|---|---|
| `lifi` | Any | 72 chains, EVM + Solana + Sui | **Stellar** |
| `cctp` | USDC only | 28 chains incl. **Stellar** | Sui (V1 only), any non-USDC |

`supports()` resolves the overlap: USDC on an EVM↔EVM pair may be served
by either, and the registry picks on cost/time; USDC to Stellar is
`cctp`-only; ETH or a long-tail token is `lifi`-only.

Circle ships **Bridge Kit** (`@circle-fin/bridge-kit`), which
orchestrates the full CCTP lifecycle (approve → burn → fetchAttestation
→ mint) behind one `kit.bridge()` call, and is itself adapter-shaped
(Viem, Solana Kit, wagmi, Circle Wallets). **Bridge operations need no
API key.** That maps cleanly onto `BridgeRouteAdapter`.

⚠️ **But Bridge Kit's self-custody adapters cover EVM and Solana only.**
Confirmed three ways: its only quickstarts are "between EVM chains" and
"between Solana and EVM"; every release note through 2026-03 adds EVM
chains only (Monad, EDGE, Morph); and Circle's own skill states support
as "between EVM chains, between EVM chains and Solana, and between any
two chains **on Circle Wallets**" — the last being custodial, and
therefore not an option for us.

**The one chain we need CCTP for is the one Bridge Kit cannot serve
non-custodially.** Phase 4 must assume raw CCTP contract calls on
Soroban, not the SDK. Scope accordingly.

Note also that Bridge Kit has been folded into **Arc App Kit** as of
2026-03-17 and its docs migrated, so pin versions and expect churn.
(Superseded above: App Kit still reaches EVM + Solana only, so Stellar
stays raw, but every other Circle-issued route now goes through it. The
package is pinned at 1.15.3 in both repos.)

#### 5.4.1 Stellar CCTP hazards ⚠️

Two Stellar-specific behaviours, both capable of **permanent,
unrecoverable loss of funds**:

1. **`CctpForwarder` is mandatory.** CCTP messages carry only a raw
   32-byte payload with no strkey type identifier, so the protocol
   cannot tell a `G` account from a `C` contract and **assumes the
   recipient is a contract**. On the source burn, **both `mintRecipient`
   and `destinationCaller` must be set to the `CctpForwarder` contract
   address**, with the real recipient encoded as a strkey in hook data.
   - Wrong `destinationCaller` → forwarder cannot complete the transfer.
   - `mintRecipient` set to a user or muxed address → USDC never reaches
     the forwarder.
   - Either way Circle's docs state funds are **permanently stuck and
     cannot be recovered.**
2. **Stellar USDC has 7 decimals**, every other CCTP chain has 6.

Both are exactly the bug class in `feedback_address_case_per_encoding`:
per-encoding address semantics that shared code must not flatten. Phase 4
carries a mandatory testnet dry-run before any mainnet path ships, and
the decimals must come from the adapter, never a constant.

> ⚠️ **Correction, 2026-09-26: the first implementation got the hook wrong,
> and missed a step.** Circle has since published the Stellar layout
> (`/cctp/references/stellar`), confirmed byte for byte against a real
> mainnet transfer (tx `b2424716…3f53`):
>
> | Bytes | Field | Was (wrong) | Is |
> |---|---|---|---|
> | 0-23 | magic | `cctp-forward` (the Forwarding Service's) | **all zero** |
> | 24-27 | version | 0 | 0 |
> | 28-31 | length L | 32 | L = strkey length (56) |
> | 32.. | recipient | 32 raw key bytes | **the strkey STRING, UTF-8** |
>
> Three more facts the build now encodes:
>
> 3. **Someone must claim.** With no Forwarding Service on Stellar, an
>    attested burn sits unminted until `CctpForwarder.mint_and_forward(
>    message, attestation)` is called. Anyone may call it, and it pays the
>    recipient named in the burn, atomically. The user's own Stellar
>    wallet claims through the new `bridge_claim` write tool, and the
>    transfer is `completed` only when the MessageTransmitter reports the
>    nonce used (`is_nonce_used`), never on attestation alone.
> 4. **Stellar → EVM now exists.** `deposit_for_burn_with_hook` on the
>    Stellar `TokenMessengerMinter`, argument layout read from the
>    deployed contract's own spec, carrying Circle's Forwarding Service
>    hook so Circle mints on the EVM side. It pulls with `transfer_from`,
>    so it needs a SEP-41 `approve` first (a simulation without it fails
>    "not enough allowance to spend"). Stellar burns only through the
>    sixth decimal, so the quote truncates rather than silently leaving
>    dust.
> 5. **The device verifies Stellar payloads itself** (these ARE calldata):
>    `stellarCctpVerify.ts` decodes both directions against pinned ids,
>    and the Stellar kit signs only two (contract, method) pairs
>    (`walletKit/stellar/cctpContracts.ts`).
>
> **Testnet dry-run (§10.6), both directions, passed 2026-09-26:**
> Stellar → Arc Testnet (20 USDC, burn `32e1f21a…`, forwarded mint
> `0xed74119d…`, 19.980088 received as quoted) and Arc Testnet → Stellar
> (5 USDC, burn `0xbd3c48ac…`, claim `2d876f77…`, +5.0000000 received,
> status flipped to `completed` via the nonce check). Mainnet remains a
> deliberate `CCTP_STELLAR_MAINNET_ENABLED=true` decision, not a default.

### 5.5 Circle Gateway — considered, rejected

Circle also ships **Gateway**: a non-custodial unified USDC balance with
instant (<500 ms) crosschain spend and a 7-day trustless withdrawal.
Superficially it looks like a better bridge.

Rejected for our purposes, for three reasons:

1. **It does not reach Stellar or Sui.** Mainnet coverage is EVM plus
   Solana. It therefore solves none of the gap that motivates §5.4.
2. **It is not a bridge, it is a balance model.** Funds must be
   pre-deposited into a Gateway Wallet contract to earn the instant
   property. That is a custody-shaped UX change for our users, not a
   drop-in route.
3. **USDC only**, so it does nothing for the any-token goal.

Worth revisiting if we ever want chain-abstracted USDC spending as a
product feature in its own right. It is not a substitute for §5.

> ⚠️ Circle's own footgun here mirrors §5.4.1: a plain ERC-20 transfer
> to the Gateway Wallet contract **loses the funds**. Deposits must go
> through `deposit()`. If we ever adopt Gateway, that gets the same
> preflight-assertion treatment.

---

## 6. Prerequisite: widen the quote payload

**The UX in §7 is blocked on this.** `LifiQuote`
(`api/src/strategies/external/lifi.client.ts:35-47`) keeps 8 fields and
discards everything a bridge confirmation must show. Verified against a
real quote (Base→Arbitrum USDC):

| Needed | LI.FI field | Kept today |
|---|---|---|
| Minimum received | `estimate.toAmountMin` | **No** |
| Slippage | `action.slippage` | **No** |
| Fee itemisation + `included` | `estimate.feeCosts[]` | **No** |
| Gas cost | `estimate.gasCosts[]` | **No** |
| Token decimals/symbol/price | `action.fromToken`/`toToken` | **No** |
| Token verification status | `verificationStatus` | **No** |
| Route steps | `includedSteps` | **No** |
| Bridge logo | `toolDetails.logoURI` | **No** |
| Destination address | `action.toAddress` | **No** |
| Bridge name | `toolDetails.name` | Yes |
| Duration | `estimate.executionDuration` | Yes |

Two are urgent:

- **`toAmountMin`** is the worst-case guarantee. Without it there is no
  protection number on screen at all.
- **`feeCosts[].included`** says whether a fee is already deducted from
  the output or charged on top. Ignoring it means we either double-count
  or under-report fees.

Also: we return `toAmount` **without decimals**, so every call site
formats by guesswork.

That is not theoretical. **Stellar USDC is 7 decimals; USDC everywhere
else is 6** (§5.4.1). A shared `USDC_DECIMALS = 6` constant would
misprice every Stellar amount by 10x. `BridgeQuote` carries per-token
decimals explicitly, sourced from the adapter.

---

## 7. UX contract — what must be on screen

A bridge is the highest-disclosure operation in the wallet: it is
**asynchronous, cross-address, and irreversible mid-flight**. The card
must answer five questions.

### 7.1 What am I moving?

Amount + symbol + chain, source and destination, with the **token
contract disambiguated**. USDC vs USDC.e on Arbitrum are different
assets; `services/agent-executors/defi/writes.ts:1711` already carries a
"prefer canonical over .e" comment, so we are one silent mispick from a
user landing in the wrong asset.

State **native vs wrapped** on the destination. This is the entire user-
visible point of CCTP and must be said plainly ("You receive native
USDC").

### 7.2 What do I get?

- Expected output **and minimum received** (`toAmountMin`).
- Slippage tolerance, as a visible number.
- **Itemised** fees: bridge fee, integrator fee, source gas, destination
  gas — each marked deducted-from-output or charged-on-top.
- Effective rate, so a 3% haircut is visible.

### 7.3 How long, and who am I trusting?

- Estimated duration, as a range when the provider gives one.
- **Which bridge**, by name and logo. This is the mechanism disclosure:
  burn-and-mint vs liquidity pool vs intent/filler are different trust
  models and users are entitled to know which one they are in.
- Route breakdown when multi-step.
- Token verification status.

### 7.4 Where is it landing? ⚠️

**The destination address must be shown explicitly, with the wallet it
belongs to.**

For same-namespace bridges the address usually matches, so this reads as
noise. For **Base → Solana it is a completely different address**,
derived from the same mnemonic (`useWallet.helpers.ts` derives one EVM +
one Solana + one Sui wallet). The user has never seen that address in
this context. Hiding it is how funds go missing.

This also inherits the **dApp bridge isolation** rule: the bridge card
renders and signs from the wallet bound to the intent, never from
`activeWallet` as a fallback.

### 7.5 Destination readiness ⚠️

**Decided (§10.4):** "does the destination need an approve?" was the
wrong framing. The general problem is **per-namespace preconditions on
the destination**, of which gas is only the EVM case:

| Namespace | Precondition | Remedy |
|---|---|---|
| EVM | native gas | `gasTopUp?()` |
| Solana | ATA exists + rent | create ATA |
| Sui | native gas | `gasTopUp?()` |
| **Stellar** | **USDC trustline** + XLM base reserve | `ensureTrustline()` |

The Stellar case is a different class of problem. A trustline is a
**hard precondition the recipient must have opted into**; no amount of
sender-side signing can complete a transfer without it. Our own code
says it best (`services/chains/stellar/trustlineService.ts`):

> "no amount of sender-side signing can complete a transfer to an
> account that hasn't opted in."

**We already have every primitive**: `hasTrustline()`,
`ensureTrustline()`, `detectAccountFunded()`,
`computeMinBalanceStroops()`, `BASE_RESERVE_STROOPS`. `ensureTrustline`
only works on the caller's own wallet, which is exactly our case (one
mnemonic, the Stellar wallet is the user's).

So `checkDestinationReadiness()` (§5.2) returns a list of blockers, each
with a remedy, and the card renders them uniformly. Adding a namespace
means implementing that one method, not editing the card.

Bridging a full balance to a chain where the user cannot receive or
cannot move funds **strands them**. Check at quote time.

When it is zero or dust, the card renders a warning row offering **both
paths inline** (decided: convenience *and* safety, not a dead-end
warning):

```
 ⚠  No gas on Arbitrum
    You will not be able to move these funds after they arrive.

    [ Add $2 of ETH ]   [ I will top up later ]
```

- **Add gas** routes a small slice via LI.FI `gasZipBridge`
  (`gasTopUp?()`, §5.2 optional capability). It is a **second
  transaction** and appears as its own line in the fee breakdown. It is
  never silent.
- **Later** proceeds and records the warning as acknowledged, so the
  progress card can resurface it on arrival.

Neither option is preselected. Copy carries no em-dashes.

#### 7.5.1 CCTP routes may not need this at all

Circle's **Forwarding Service** (`useForwarder: true`) has Circle's own
infrastructure fetch the attestation and submit the destination mint.
The user therefore needs **no destination-chain gas and no destination
wallet interaction**, which dissolves the strand problem for routes that
support it.

It carries a per-transfer fee that varies by route, so it is a real
tradeoff, not free, and belongs in the §7.2 fee breakdown.

Availability is per-chain and **not universal**: notably **Stellar has
no Forwarding Service**, so the §7.5 warning and top-up path remain
mandatory there. `gasTopUp?()` presence-checking already expresses this
correctly, an adapter that can forward simply reports no strand risk.

**Now the default for every Circle route except Stellar** (§5.4): both
App Kit adapters always forward, and App Kit's chain definitions carry
`forwarderSupported.destination`, so a destination without it (X Layer,
Plasma, Cronos and others) is not offered by `circle-cctp` and falls back
to LI.FI. Stellar inbound ends in a user-signed claim instead (§5.4.1).

### 7.6 No route available

When `supports()` returns false for the pair (any Stellar leg, or an
unroutable asset), render a plain explanatory state, not an error card.
It is a **capability boundary**, not a failure. No raw provider text.

### 7.7 Post-submit: half the UX

A bridge is **not done when the source tx confirms**.

CCTP's lifecycle is **four** steps, and Circle's own SDK surfaces them
individually. We model the progress card on that rather than a coarser
three-state guess:

1. `approve` — ERC-20 allowance (EVM only; no analogue on Solana/Sui/Stellar)
2. `burn` — destroy on source
3. `fetchAttestation` — wait for Circle to sign the burn proof ← **the long one**
4. `mint` — create on destination

Step 3 is where the ~15-19 min of a Standard transfer goes (~8-20s
Fast). It is the step users will stare at, so it gets the honest
"waiting for attestation" copy and an expected-time range, not a bare
spinner.

Non-CCTP LI.FI routes map onto the same shape with a provider-supplied
step list (`includedSteps`), so the card stays provider-agnostic. Step 1
is presence-checked, not assumed (§10.4).

Both tx hashes surfaced. A stalled leg needs a stated recovery path,
never a spinner forever.

There is **no existing analogue** for this card; it is net-new work.

#### 7.7.1 `DONE` does not mean success ⚠️

**Decided (§10.3).** LI.FI's real taxonomy, from its API docs:

| status | substatus |
|---|---|
| `PENDING` | `WAIT_SOURCE_CONFIRMATIONS`, `WAIT_DESTINATION_TRANSACTION`, `BRIDGE_NOT_AVAILABLE`, `CHAIN_NOT_AVAILABLE` |
| `DONE` | `COMPLETED`, **`PARTIAL`**, **`REFUNDED`** |
| `FAILED` | `UNKNOWN_ERROR`, `REFUND_IN_PROGRESS` |

`DONE` has **three** outcomes, and two of them are not what the user
asked for:

- **`PARTIAL`** — full value received, but **in a different token**.
- **`REFUNDED`** — funds returned on the *source* chain.

Treating `DONE` as success renders a "completed" card to a user holding
a token they never asked for. So the terminal state is a **four-value
enum**, never a boolean:

```ts
type BridgeOutcome = "completed" | "partial" | "refunded" | "failed";
```

`partial` and `refunded` are **outcomes, not errors**. They must not go
through `agentErrorCopy` (§8.5); they need their own plain explanatory
copy naming the token actually received, or the chain the refund landed
on.

CCTP has no equivalent: burn-and-mint is atomic per message, so it only
produces `completed` or `failed`. The adapter normalises both providers
onto the same enum, and the card stays provider-agnostic.

---

## 8. Agent integration

### 8.1 Facts-first is mandatory

Per `project_facts_first_approval_summary`, the card renders facts from
tool args via `StructuredUI/approvalSummary.ts`; the model's
`human_summary` is **fallback-only, never the primary approval text**.

An LLM paraphrasing "you'll get about 99.75 USDC" is not an acceptable
substitute for a rendered `toAmountMin`. Every number in §7 comes from
the quote payload.

### 8.2 Quote staleness

A user can read an agent message minutes later and approve a dead route.
That is exactly the `stale_precondition` recovery class in
`project_agent_tool_error_standard`. The quote carries an issued-at +
TTL; the card shows freshness and offers re-quote rather than submitting
a stale route.

### 8.3 Tools

| Tool | Capability | Notes |
|---|---|---|
| `bridge_get_support` | read | Queryable matrix (§5.3) |
| `bridge_quote` | read | Returns full `BridgeQuote` (§6) |
| `bridge_execute` | **write** | Approval card, facts-first |
| `bridge_status` | read | Drives `BridgeProgressCard`; returns `claim_required` when the destination waits on the user |
| `bridge_claim` | **write** | Stellar leg of CCTP into Stellar (`mint_and_forward`), own card and gate (§5.4.1) |

`defi_cross_chain_deposit` is refactored to compose `bridge_quote` +
`bridge_execute`, keeping its current name and contract.

**Registration is not optional and is enforced.** Per
`feedback_registry_parity_enforcement`:

- add all five to `agent-api/src/tools/registry.ts`;
- mirror in `services/agent-executors/expectedMobileTools.ts`;
- add `bridge_execute` and `bridge_claim` to **`MOBILE_WRITE_TOOLS`** — `authorizeToolCall`
  fails closed on a known-write mislabeled as read
  (`services/agentSession/authorizeToolCall.ts:118`), which is the
  agent-drain defense;
- `registryParity.test.ts` + `pnpm check:agents` must pass.

### 8.4 Slippage policy

**Decided: fixed server-side default, disclosed, not user-adjustable and
not model-supplied.**

Per route class: tight for stablecoin/CCTP routes, looser for volatile
assets. Rendered on the card next to minimum-received. Keeping it out of
the model's hands follows facts-first: a safety-critical number must not
be under LLM control.

### 8.5 Errors

`agentErrorCopy` for all failure cards. No raw provider text, no HTTP
status, no `err.message` reaching users
(`feedback_user_facing_errors`). Raw detail goes to `__DEV__` logs.
`DefiError` already does this correctly in `LifiClient` and is the model
to follow.

---

## 9. Phasing

| Phase | Deliverable | Unblocks | Status |
|---|---|---|---|
| **0** | Widen `LifiQuote` → `BridgeQuote` (§6) | Everything | ✅ 2026-08-04 |
| **1** | `BridgeRouteAdapter` + LI.FI adapter + CAIP-2 DTO (§5) | Non-USDC, non-EVM | ✅ 2026-08-04 |
| **2** | `bridge_*` tools + parity registration (§8.3) | Agent access | ✅ 2026-08-04; `bridge_claim` 2026-09-26 |
| **3** | `BridgeQuoteCard` + `BridgeProgressCard` (§7) | User-facing | ✅ 2026-08-04; `BridgeClaimCard` 2026-09-26 |
| **4** | Circle adapters: App Kit USDC/EURC + raw Stellar both ways (§5.4) | **Arc, EURC, Stellar** | ✅ 2026-09-26, testnet dry-run passed; Stellar mainnet flag-gated |
| **5** | `gasTopUp` optional capability (§7.5) | Strand protection | ✅ built; UI parked (`GAS_TOP_UP_ENABLED=false`) |

Phases 1-3 ship a complete bridge for EVM + Solana + Sui via LI.FI.
Phase 4 is a separate, higher-risk workstream (§5.4.1 hazards, no usable
SDK) and should not block the rest.

Phase 0 is a pure widening and ships independently — it improves the
existing `defi_cross_chain_deposit` card before any new surface exists.

`BridgeQuoteCard` extends the `SwapQuoteCard` pattern
(`components/home/TakumiAgent/StructuredUI/cards/SwapQuoteCard.tsx`, 298
lines, already has HeaderRow + accept/reject). Both follow the card
design language in `feedback_agent_tool_card_design`.

---

## 10. Resolved decisions

All open questions from the first draft are closed. Recorded here with
reasoning so the *why* survives.

1. **EURC** — ~~dropped. CCTP does not support it (§2).~~ Superseded
   2026-09-26: EURC moves through Circle's CCTP for non-USDC assets, a
   separate product, and ships as its own adapter `circle-cctpx` (§5.4).
2. **Fee take** — `integratorFee` stays **0** for now. We have no bridge
   volume yet, and the user already pays bridge fee + gas + slippage;
   adding bps on top worsens the rate exactly when we are building
   trust. Trivial to switch on later. **If it is ever set, it must
   appear in the §7.2 breakdown**, never silently.
3. **Destination-leg failure** — resolved as §7.7.1. `DONE` carries
   three outcomes; terminal state is a four-value enum, and
   `partial`/`refunded` are outcomes rather than errors.
4. **Approval semantics** — reframed and resolved as §7.5. The general
   problem is destination *readiness* per namespace, not `approve`.
   Expressed as one adapter method; Stellar's trustline primitives
   already exist in our codebase.
5. **Overlap policy** — dissolved by scoping the `cctp` adapter to
   Stellar-only (§5.4). With no overlap there is nothing to arbitrate.
   *Reopened 2026-09-26:* `circle-cctp` now overlaps LI.FI on USDC by
   design. Resolved by the registry's existing specificity rule (an
   adapter that answers `supportsAsset` sorts first), with LI.FI as the
   fallback, never by an arbitration branch.
6. **Stellar CCTP validation** — make invalid states unconstructible
   rather than relying on call-site discipline. Phase 4 ships:
   - a pure builder for the burn params that **cannot** emit a wrong
     combination by construction;
   - unit tests asserting `mintRecipient == destinationCaller ==
     CctpForwarder` and `decimals == 7`;
   - a mandatory **testnet dry-run** before any mainnet path.

   `mint_and_forward` is atomic and non-custodial (Circle docs), so risk
   concentrates in constructing the *source* burn, not the Stellar leg.
   Cheap insurance against permanent, unrecoverable loss (§5.4.1).
7. **Arc** — ~~no special handling needed; mainnet routes via `lifi`
   automatically~~. **Wrong in practice** (found 2026-09-11): LI.FI lists
   Arc mainnet but every quote returns "Chain 5042 is not supported".
   Arc mainnet is CCTP domain 26 with Forwarding Service, and reaches us
   through `circle-cctp` / `circle-cctpx` (§5.4). No Arc-specific code:
   Arc is a row in App Kit's chain list like any other.

### 10.1 Still genuinely unknown

- **Sui USDC after 2026-12-01.** Sui is CCTP V1 only, V1 is switched off
  on 2026-12-01, and App Kit does not list Sui. Sui USDC stays on LI.FI
  (`mayanMCTP`) until Circle ships Sui on V2; check before 2026-10-31.
- **Arc destination gas warning.** ~~The EVM readiness check warns "no gas"
  on an empty Arc wallet even though the arriving USDC is Arc's gas.~~
  **Resolved:** `evmCheckBridgeDestinationReadiness` recognizes Arc
  (`chainId: 5042` / `5042002`, `nativeCurrency.symbol === "USDC"`) and
  native transfers, suppressing the false warning because the arriving
  USDC delivers native gas directly.

- **Demand for USDC on Stellar.** Phase 4's priority depends on user
  demand we cannot see from the code. The shipped Play Store build
  predates Stellar entirely
  (`project_playstore_build_predates_stellar`), so there is no usage
  signal yet. Revisit once Stellar ships to production users.
