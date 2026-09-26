# Swap Capability — Engineering Spec

**Status:** Proposed (Tower/Arc slice already shipped, see §2.3).
**Scope:** 3 repos — `mobile-app`, `api`, `agent-api`.
**Sources verified:** live `li.quest` v1 API and live `tower.exchange`
public API, both probed 2026-09-11 / 2026-09-23 with real keys.
`docs.tower.exchange/openapi.json` is authoritative over the rendered
docs site: two endpoints (`GET /tokens`, `GET /chains`) exist only there.
**Related:** `docs/bridge-capability-spec.md` (the registry this extends),
`docs/sui-overflow-2026-phase1-intent-engine-spec.md` (the Sui swap path),
`docs/generative-ui-spec.md` (StructuredUI cards),
`docs/defi-pool-level-deposits-spec.md` (registry/docking precedent).

---

## 1. Goal & non-goals

### Goal

**Swap any token for any token, on any chain we can sign for, through
whichever provider serves that route best.** The same ambition the bridge
capability has for moving value between chains, applied to transforming
value within one.

Concretely, the seam must make all of these "register an adapter", never
"edit a branch":

- a new provider (Tower, Jupiter, 0x, a Sui venue),
- a new chain for an existing provider,
- a new token pair, including pairs no registry row covers,
- a provider that serves *both* swap and bridge (LI.FI, Tower).

### Non-goals

- **Limit orders, DCA, or recurring swaps.** `project_defi_dca_v1` ships
  reminders, never unattended execution. Tower's Recurring Orders are a
  custodial scheduler on their side and are out of scope for the same
  reason their `/bridge` is (§3.2).
- **The model picking a DEX.** Venue selection is ours, always. Already
  the rule on Sui (`venueSelector.ts`) and it stays the rule everywhere.
- **User-adjustable slippage from chat.** Slippage is a server-side
  default per route class, disclosed on the card, never LLM-supplied
  (bridge spec §8.4). A safety-critical number stays out of model control.
- **Bitcoin.** Routable by LI.FI, unsignable by us. Same non-goal as the
  bridge spec §1.

---

## 2. Where we are today

Three different shapes implement one user-facing verb. That is the
problem this spec exists to fix.

### 2.1 Sui swap — real, shipped, intent-based

The only swap path that has ever worked end to end.

- **Tools:** `defi_intent_preview` (read) / `defi_intent_execute` (write),
  `services/agent-executors/defi/intentExecutors.ts:809`. Swap is an
  *action* (`swap`, `swap_and_supply`), not a tool.
- **Flow:** NL goal → `services/chains/sui/intent/compileIntentToPtb.ts:123`
  calls `getSuiSwapRoute` → `services/swap/sui/venueSelector.ts` walks
  `SWAP_PRIORITY` for the network (mainnet `cetus` then `deepbook`;
  testnet/devnet `deepbook` only), quotes each venue that supports it,
  best `expectedOut` wins, ties to earlier priority → a finished
  `sui-ptb` (base64 BCS) plus `expectedOut` and `priceImpact` → guardian
  checks → PTB cached in `intentStore` by id → `defi_intent_execute`
  loads it, **re-runs the guardian**, signs.
- **Venue docking:** `SuiSwapVenue { supports(network), getRoute() }`.
  Adding a venue is one line in `SWAP_PRIORITY`.
- **Errors:** typed `SuiSwapError` (`no_swap_route`,
  `amount_below_minimum`, `unsupported_pair`). A venue may throw an
  actionable reason; the selector preserves the first one and re-throws
  it only when no venue produces a route, so the user gets "below the
  pool minimum" instead of a generic failure.

**What this path gets right, and what §4 should inherit:** priority-ordered
multi-venue quoting, best-output arbitration, `priceImpact` as a
first-class output, and a guardian that re-checks at signing time.

### 2.2 EVM swap — never existed

Scaffolding pointing at a missing endpoint:

- `services/swap/aggregator.ts:36` POSTs to `${API_URL}/swap/route`.
  **There is no swap module in `api` at all.** That endpoint 404s.
- Its only consumer, `components/swap/SwapInterface.tsx`, is **orphaned**
  (nothing imports or mounts it) and broken by construction: `fromToken`
  and `toToken` are `useState("")` with no setters, so the query's
  `enabled` guard can never be satisfied.
- `services/swap/mevProtection.ts` is referenced only by that orphan.
- No swap screen under `app/`.

One live export hides in there: `getPriceImpactSeverity`, used by the Sui
guardian at
`services/chains/sui/intent/guardian/checks/highSlippageCheck.ts:15`.

### 2.3 Arc swap — shipped on the bridge surface (Tower)

Commit `3b97c68` (mobile), `ebcd4f1` (api), `908f001` (agent-api).

Tower is registered as a **same-chain `BridgeRouteAdapter`**. A swap on
Arc therefore flows through `bridge_quote` → `bridge_execute` →
`bridge_status`, reusing the bridge quote card, the re-quote at signing,
the EVM approval + transaction dispatch, and the progress card.

The cards carry swap-aware branches: `isSwap()` in
`BridgeProgressCard.tsx` collapses four phases to "approve + Swapped on
Arc", `outcomeCopy` says "Swap complete", and `approvalSummary.ts` reads
"Swap 1 USDC to EURC on Arc" rather than "Bridge from Arc to Arc".

**This was the right call for v1** and it proved the registry absorbs a
same-chain route with no namespace branching. It is not the right
long-term home, for reasons in §2.4.

### 2.4 The three-shapes problem

| Chain | Surface | Tool | Venue choice | Price impact shown |
|---|---|---|---|---|
| Sui | Intent Engine | `defi_intent_*` | `venueSelector` | yes (guardian) |
| EVM | (dead scaffolding) | none | none | n/a |
| Arc | Bridge registry | `bridge_*` | Tower's, + our fallback | **no** |

Three costs, all real:

1. **Semantic overload.** `same_chain` was a no-route *reason* meaning
   "you cannot bridge to yourself". It is now a valid route on Arc, and
   the copy had to be reinterpreted to mean "single-chain swaps are not
   available on that network".
2. **The prompt carries the routing.** `agent-api`
   `src/agents/defi/systemPrompt.ts:49` has to tell the model "on Arc, a
   swap is `bridge_quote` with both chains the same, and NEVER
   `defi_intent_*`". That rule grows a clause per chain.
3. **The bridge card structurally cannot show swap facts.** Price impact,
   winning venue, and route alternatives have nowhere to live, because a
   bridge does not have them. Tower returns `priceImpact`, `dexName` and
   `routeOptions` today and we discard all three.

---

## 3. Provider reality check (verified, not assumed)

### 3.1 LI.FI — permissionless, and already a swap provider

- **No API key required.** `li.quest` public endpoints work anonymously;
  `LIFI_API_KEY` is empty in `api/.env` and the adapter passes it only
  when set (`lifi.adapter.ts:122`). A key raises rate limits, nothing
  else. Every probe in this spec ran without one.
- **Same-chain quotes work.** A same-chain Arc Testnet USDC→EURC quote
  returned a real route (tool `fly`) with `transactionRequest` populated.
  LI.FI is a swap aggregator on ~70 EVM chains plus Solana and Sui.
- **We refuse to ask.** `lifi.adapter.ts` `supports()` opens with
  `if (from === to) return false`, and so does the mobile half. We have
  had multi-chain swap coverage available, unasked, the whole time.
- **Arc mainnet is dark.** `li.quest/v1/chains` lists Arc (`5042`) and
  Arc Testnet (`5042002`), but every quote against `5042` returns
  `"Chain 5042 is not supported"`, and testnet↔Base-Sepolia bridging
  returns no routes. `docs/bridge-capability-spec.md:677` ("Arc mainnet
  routes via `lifi` automatically") is **wrong in practice**. Tower is
  what covers Arc, not LI.FI.

### 3.2 Tower — swap is sound, bridge is custodial

Live-probed with a `sk_test_` server key. The live API diverges from the
published docs in ways that matter:

- **Swap is genuinely non-custodial.** `/swap/quote` → `/swap/build-tx`
  returns nullable `approval` plus `swap {to, data, value, gasLimit,
  chainId}` for `TowerSwapExecutor`. The device signs. Correct shape.
- **Amounts are normalized to 1e18** (`amountScale: "normalized_1e18"`).
  Real token units live in the `*Raw` / `*Native` fields alongside
  `inputTokenDecimals` / `outputTokenDecimals`. **Always read `Raw`.**
- **Env is selected by the key, not the request.** A `sk_test_` key
  defaults to routing **Arc mainnet (5042)**. An undocumented body field
  `chainId: 5042002` is required to get testnet quotes.
- **Silent token rewriting.** A request naming the *testnet* EURC address
  `0x89B5…` is answered with *mainnet* EURC
  `0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1`. The adapter **must assert
  the response's input/output token equals the request and fail closed.**
- **Testnet build-tx targets a codeless executor.**
  `0xeB8940752Fa12944d3b2D736d51fA36E4dA32BC8` has 6392 bytes on mainnet
  and **no code on Arc Testnet**. Signing it would no-op the swap and
  approve a codeless spender. Hence the `eth_getCode` guard at
  `tower.adapter.ts:332` and the executor allowlist.
- **Default route often fails to build.** The best route is frequently
  KyberSwap, whose `build-tx` returns `500 BUILD_TX_FAILED "Forbidden"`.
  The adapter falls back through `routeOptions` (`MAX_BUILD_FALLBACKS`).
- **Fee is 30 bps**, not the documented 25, taken in the input token.
- **`POST /bridge` cannot be used.** It takes an amount and a recipient
  and returns a `transactionHash` immediately: no quote, no unsigned
  transaction, no signing step, `senderAddress` optional, no status
  endpoint. Nothing moves a user's USDC without their signature, so it
  executes from a Tower-held wallet. **Custodial, therefore out.** The
  outstanding questions sent to Tower are tracked in §11.2.

### 3.3 What follows

The fastest route to broad swap coverage is **not** a new provider. It is
letting the adapters we already run answer same-chain questions, and
giving the answer somewhere honest to render.

---

## 4. Architecture — one route seam, two topologies

### 4.1 The core claim

A swap and a bridge are the same machine with different topology.

Shared, already built, already hardened:

- quote with a minimum-received floor and a TTL,
- re-quote at signing time and refuse a stale route,
- facts-first approval card + `WriteApprovalGate`,
- chain-owned signing via `WalletKitAdapter.submitBridgeExecution`,
- ERC-20 allowance handling (the one namespace that has the concept),
- curated error codes, never raw provider text.

Genuinely different:

| | Swap (same-chain) | Bridge (cross-chain) |
|---|---|---|
| Topology | `from.chain === to.chain` | different chains |
| Terminal state | receipt of one tx | 4-value outcome after attestation |
| Destination address | the sender | a **different** address per namespace |
| Readiness blockers | none (you already hold gas) | gas / ATA / trustline |
| Facts to show | price impact, venue, route hops | mechanism, duration, destination |

Tower already proved topology can be a *property of the route* rather
than a separate stack. The refactor generalises that instead of special
casing it.

### 4.2 `RouteAdapter`: rename, don't rebuild

Rename the seam from `BridgeRouteAdapter` to `RouteAdapter`, and let each
adapter declare the topologies it serves:

```ts
export type RouteKind = "swap" | "bridge";

export interface RouteAdapter {
  key: string;

  /** Topologies this adapter serves. Presence-checked, never branched on. */
  kinds: readonly RouteKind[];

  /** Can this adapter serve from → to? Same-chain is a legal question. */
  supports(from: Caip2, to: Caip2): boolean;

  supportsAsset?(from: Caip19, to: Caip19): boolean;

  quote(req: RouteQuoteRequest): Promise<RouteQuote>;
  status(ref: RouteRef): Promise<RouteStatus>;
  resolveToken(asset: Caip19): Promise<RouteToken | null>;
  listSupportedChains(): Promise<RouteSupportedChain[]>;
  listTools(): Promise<string[]>;

  // optional, presence-checked (space docking, §4.6)
  gasTopUp?(req: GasTopUpRequest): Promise<RouteQuote>;
  /** Alternative venues for the same pair, for a venue picker (§6.3). */
  listRouteOptions?(req: RouteQuoteRequest): Promise<RouteOption[]>;
  /** Contracts this provider may legitimately return. Absent = fail closed. */
  targetAllowlist?(chain: Caip2): Promise<readonly string[]>;
  /** Provider-side simulation, when it beats ours. */
  simulate?(q: RouteQuote): Promise<SimulationResult>;
  /** Provider-side calldata decoding, for §8.4 L4. */
  decodeCall?(q: RouteQuote): Promise<DecodedIntent | null>;
  /** Private-relay submission, when the provider offers one (§9.2). */
  privateSubmit?(raw: string, chain: Caip2): Promise<string>;
  /** Serving stale cached data, so callers never claim freshness. */
  isDegraded?(): boolean;
}
```

`kind` is **derived, never supplied**: `from.chain === to.chain ? "swap"
: "bridge"`. One helper, `routeKindOf(quote)`, replaces every ad-hoc
`isSwap()` in the cards.

This is a rename plus one field. `lifi`, `cctp`, and `tower` keep their
implementations. Nothing about signing, readiness, or the registry
changes.

### 4.3 Arbitration when several adapters answer

`resolveBridgeAdapters` already sorts `supportsAsset` specificity first
(`api/src/bridge/registry.ts:104`). Extend it for the real multi-provider
case a swap surface creates:

1. Filter by `kinds` including the requested topology.
2. Filter by `supports` / `supportsAsset`.
3. Sort specific-before-general (unchanged).
4. **Quote the top N in parallel (N = 2 initially) and keep the best
   `toAmountMin`**, not the best `toAmount`. The guaranteed floor is what
   the user is actually promised; ranking on the optimistic number
   rewards the provider with the loosest slippage.
5. On a build failure, fall through to the next candidate. Tower already
   does this internally across `routeOptions`; the registry does it
   across providers.

This is the Sui `venueSelector` pattern, lifted to the provider level.
Ties break to earlier priority, exactly as `selectSwapRoute` does.

### 4.4 One engine, two surfaces — the split rule

**Share the engine. Split the interface.** This is the central structural
decision of this spec, and it resolves the tension in §2.4.

| Layer | Shared or split | Why |
|---|---|---|
| Provider adapters (`lifi`, `tower`, `cctp`, Sui venues) | **shared**, one registry | A provider that serves both topologies implements `supports()` once. Duplicating it would create two sources of truth for the same capability. |
| Quote / TTL / re-quote / signing / allowance | **shared**, one core | This is hardened, audited code. A second copy is a second place for a staleness or allowance bug. |
| Agent tools | **split** | §7.1 |
| Approval + progress cards | **split** | §6.6 |
| Error vocabulary | **split at the leaves** | Shared codes where the failure is shared, distinct codes where it is not (§7.4). |

The mistake to avoid in both directions:

- **Splitting too deep** gives you two execution paths, and the second one
  will drift on exactly the safety properties (`toAmountMin` enforcement,
  quote expiry, `WriteApprovalGate`) that took the longest to get right.
- **Sharing too shallow** is where we are now: one tool and one card doing
  double duty, with `isSwap()` conditionals multiplying and the routing
  rule living in prompt prose (§2.4).

The line sits exactly at the point where a human sees the difference. A
user asking to swap does not care that the machinery is shared; they care
that the screen says "Swap", shows price impact, and does not warn about a
destination wallet that is their own.

### 4.5 Non-EVM swaps keep their compiler

Sui swaps must **not** be forced through `RouteAdapter`. The Sui path
produces a BCS-encoded PTB that the guardian re-checks and the intent
store caches by id; that is a genuinely different execution contract, not
a variation on `{to, data, value}`.

Instead, dock Sui as a `RouteAdapter` whose `quote()` returns a
`serialized_transaction` execution payload wrapping the compiled PTB,
and whose `status()` reads the digest. The venue selector stays exactly
where it is, behind that adapter. The agent then reaches Sui swaps
through the *same* tool as every other chain, and `defi_intent_*` keeps
serving what it is uniquely good at: multi-step goals like
`swap_and_supply`.

Phased in §9; not required for the coverage win in phase 1.

### 4.6 Space docking — adding an aggregator must stay a one-file change

The registry exists so that growth is **registration, never modification**
(`feedback_space_docking`). Aggregators are the fastest-moving part of this
domain: new ones launch, existing ones add chains weekly, and any of them
can be killed by an incident. The seam has to absorb that without a
refactor each time.

#### The contract

A new aggregator is **one adapter file plus one `register` call.** It must
require zero edits to: the registry, the service, the tools, the cards,
the executors, the wire types, or any `switch`. If adding a provider
requires touching a second file beyond registration and its ops config,
the seam is wrong and the seam gets fixed, not the caller.

#### Required vs optional surface

Required (an adapter cannot function without these):

```
key · kinds · supports · quote · status
resolveToken · listSupportedChains · listTools
```

Optional, **presence-checked, never branched on** — absence is a
meaningful signal, not an omission to work around:

| Capability | Absence means | Used by |
|---|---|---|
| `supportsAsset?` | routes arbitrary tokens | arbitration (§4.3) |
| `gasTopUp?` | cannot, or need not, top up destination gas | bridge spec §7.5 |
| `listRouteOptions?` | single route only, no venue picker | §6.3 |
| `simulate?` | fall back to the chain's own simulation | §8.4 L4 |
| `decodeCall?` | fall back to simulation-only verification | §8.4 L4 |
| `targetAllowlist?` | **fail closed**: routes cannot be verified | §8.4 L1 |
| `privateSubmit?` | no private relay; public mempool applies | §9.2 |
| `isDegraded?` | cannot report staleness, so we do not claim freshness | bridge spec §5.3 |

`targetAllowlist?` is deliberately the one whose absence is **restrictive
rather than permissive**. Every other missing capability degrades a
feature; a missing allowlist degrades *safety*, so it must block rather
than wave through (§8.4 L1).

#### What each kind of growth costs

| Adding | Work | Touches |
|---|---|---|
| A new aggregator (Jupiter, 0x, Odos) | one adapter + one `register` | 2 files |
| A new chain for an existing aggregator | **nothing** | 0 files, it is queried (bridge spec §5.3) |
| A new token pair | **nothing** | 0 files |
| A new namespace (Stellar swap) | a `RouteAdapter` + that namespace's `ChainSafetyProvider` | 2 files |
| A new optional capability | add an optional method + presence-check at the one call site | 2 files |
| Disabling a provider in an incident | ops config flag (§8.4 L3) | 0 files, no release |

The middle two rows are the point of the whole design. Because the
support matrix is queried rather than hardcoded, a provider adding a chain
or a pair lights up for us **with no deploy**.

#### Conformance suite

Every adapter, in every repo, must pass one shared test suite
(`routeAdapter.conformance.spec.ts`) asserting the properties the rest of
the system relies on:

1. `supports()` is consistent with `kinds` (a swap-only adapter never
   returns true for two different chains, and vice versa).
2. Chain and asset identifiers crossing the boundary are CAIP-2 / CAIP-19;
   no provider-private numbering leaks upward.
3. `resolveToken` returns real `decimals`, never a constant.
4. A quote carries `issuedAt`, `expiresAt`, and a usable `toAmountMin`.
5. Failures are curated codes; no raw provider text escapes.
6. No quote resolves to a target outside `targetAllowlist` when declared,
   and a declared-but-empty allowlist fails closed.

A new adapter is "done" when it passes this suite, not when it returns a
quote. That is what keeps "register an adapter" from quietly meaning
"register an adapter and audit six call sites".

#### Where provider knowledge is allowed to live

Inside the adapter, and nowhere else: private chain ids, tool keys, status
vocabularies, fee quirks, the 1e18 normalization, the undocumented
`chainId` body field. Callers speak CAIP ids, `RouteQuote`, and the
four-value outcome. Every one of §3.2's Tower quirks is contained this way
today, and that containment is the reason a second Arc provider would cost
one file.

### 4.7 Chain reach is OURS, intersected with the provider's

**A route may only be offered for a chain we support.** Provider reach is
an upper bound on what is possible, never the definition of what we
offer. The two must be intersected, and our side is the API-driven
`Blockchain` table, not a list in code.

#### The bug this fixes

`BridgeService.getSupport()` collects `adapter.listSupportedChains()` from
every adapter and returns the union, **with no intersection against our
own chains**. LI.FI reports ~70 chains, so the support matrix advertises
~70 chains. The only filter is a hardcoded Bitcoin exclusion in
`lifi.adapter.ts:411`, and that special case is itself the evidence: it is
a one-off for the single chain someone remembered we cannot sign for. The
general rule was never written.

Consequences today, in order of severity:

1. **Silent strand risk on the destination side.**
   `checkBridgeDestinationReadiness` opens with
   `findChainByCaip2(...); if (!chain) return [];`
   (`bridgeRoutes/execute.ts:124`). That `[]` is correct as written — an
   unknown answer must not be rendered as a confident blocker — but it
   means bridging **to** a chain we do not have a row for skips readiness
   entirely. No gas check, no account check, no trustline check. The user
   lands funds on a chain the wallet cannot display, with no warning.
2. **Source side fails late and opaquely.** `resolveSourceChain` returns
   null and the executor throws `source_chain_not_configured`, after the
   user has already read a quote and tapped approve.
3. **The matrix promises what the app cannot render.** No token metadata,
   no icon, no explorer, no balance row
   (`reference_chain_icon_from_native_token`).

#### The rule

```
offered(chain) =
      provider_reports(chain)                  // upper bound
  AND blockchain_row_exists(chain)             // API-driven, isActive
  AND walletkit_registered(namespace(chain))   // we can sign for it
```

All three are **queried at runtime**, none hardcoded:

- `provider_reports` is the adapter's `listSupportedChains()`, already
  cached and stale-tolerant (bridge spec §5.3).
- `blockchain_row_exists` is the `Blockchain` table, `isActive = true`,
  matched by `chainId` / `chainSlug`. This is the same source `GET
  /blockchains` serves to the app, so **the matrix and the app's chain
  list can never disagree.**
- `walletkit_registered` is `walletKitRegistry`, which is what actually
  determines whether a signature is possible at all.

Chains are API-driven by design (`feedback_x402_api_driven`: config that
can change must be updatable without a release). Intersecting here keeps
that property end to end: **adding a chain is a database row, and it
lights up for bridging and swapping the moment a provider serves it, with
no deploy.** Removing one is equally instant, which matters during an
incident.

#### Consequences of the rule

- The Bitcoin special case is **deleted**. Bitcoin has no `Blockchain`
  row, so the general rule already excludes it. Any future
  provider-reaches-it-but-we-cannot-sign case is handled without another
  special case, which is the whole point.
- `getSupport()` gains a dependency on the blockchains service. That is a
  join, not a hardcode, and it is the only correct place for it: the
  backend already owns the chain registry.
- **A cold or failed chain-row read must degrade to `degraded: true`**,
  never to an empty matrix. "We could not check routes right now" is a
  legitimate state; "we support nothing" is a lie that breaks the app
  (bridge spec §5.3).
- `no_route_found` gains a sibling reason, `chain_not_enabled`, so the
  card can say "we do not support that network yet" rather than implying
  the pair is unroutable. A capability boundary, not a failure (bridge
  spec §7.6).

#### Where this is enforced

Both trust anchors, because either alone is insufficient (§8.4):

- **Backend**, in `getSupport()` and in `quote()`, so an unsupported chain
  never produces a quote at all.
- **Device**, in `resolveBridgeAdapters` / the executor, against the chain
  list the app already holds. A compromised or stale backend cannot get
  the device to sign for a chain the device does not know.

### 4.8 No hardcoded chain lists — hard rule, with an audit

**API-driven means no hardcoded chain support, anywhere, at any layer.**
Not in an adapter, not in a tool schema, not in a prompt, not in a
constant named `*_CHAINS`. A chain becomes supported by existing as a
`Blockchain` row, and by nothing else.

This is the same discipline as `feature_x402_api_driven` and the same
reason the bridge support matrix is queried rather than declared
(bridge spec §5.3): configuration that changes without our involvement
must not require a release to track.

#### Three categories, only one of which is a violation

| Category | Example | Verdict |
|---|---|---|
| **Chain support list** | "this adapter serves Arc mainnet + testnet" | **violation**, must be queried |
| **Protocol identity constant** | Solana's CAIP-2 ↔ LI.FI numeric id | allowed, inside the adapter |
| **Security allowlist** | `TOWER_EXECUTORS_<chainId>` router addresses | **required**, deliberately pinned (§8.4 L1) |

The distinction is intent. A support list answers "do we offer this?" and
must track reality. A security allowlist answers "is this contract the one
we reviewed?" and must **not** track reality, because tracking whatever
the API says is precisely the attack. Pinning is the control there, and it
is reviewed out of band.

#### Audit: current violations

| # | Hardcode | Where | Fix |
|---|---|---|---|
| B11 | `ARC_CHAINS = new Set(["eip155:5042", "eip155:5042002"])` | `services/bridgeRoutes/adapters/towerAdapter.ts:38` | derive from the app's chain list + backend `supports()` |
| B12 | `ARC_CHAINS: Record<Caip2, ArcChain>` and `ARC_USDC_ERC20` | `api` `tower.adapter.ts:68,79` | query Tower's own `GET /chains` and `GET /tokens`, intersect per §4.7 |
| B10 | Bitcoin special case | `api` `lifi.adapter.ts:411` | deleted by §4.7's rule |
| B13 | `L2_CHAIN_IDS` set, `chainId === 1` | `services/swap/mevProtection.ts:11,22` | a per-chain capability flag on the chain row, not a literal set (§9.2) |
| B14 | Chain ids and token addresses written into the model's prompt | `agent-api` `systemPrompt.ts:49-52` | §4.9 |
| B15 | `toBridgeSteps` derives step `kind` from a chain-crossing heuristic instead of LI.FI's own `includedSteps[].type`; a same-chain quote's fee-collection step is mislabeled `"Swap via Integrator Fee"` (live-verified). Currently invisible only because both cards discard step labels and synthesize their own | `api` `lifi.mapping.ts` `toBridgeSteps`; `BridgeProgressCard.tsx` `isSwap()`/`buildSteps` | medium (dead today, real once §6.4 lands) |

B12 is the instructive one. **Tower publishes `GET /chains` and `GET
/tokens`**, with a `supportedFeatures` array per chain. The adapter
hardcodes Arc anyway. Querying those endpoints, filtering to chains whose
`supportedFeatures` include `swaps`, then intersecting with our
`Blockchain` rows (§4.7) means the day Tower adds a chain we already have
a row for, it works with no deploy. That is the behaviour §4.6 promises
and the adapter currently does not deliver.

The same reasoning retires `ARC_USDC_ERC20`: token metadata comes from
`/tokens` and from our own token rows, carrying real `decimals`, never a
constant (§5 invariant 2).

#### Guardrail

`pnpm check:chains` already fails the build when shared code branches on a
namespace string. Extend it, or add a sibling check, to fail on
**chain-id literals outside the allowed categories**: a numeric chain id
or a `eip155:<n>` string appearing in `services/`, `components/`,
`hooks/`, `app/`, or in any prompt file, unless the file is on an
explicit allowlist with a stated reason (the security-allowlist and
protocol-identity categories above).

Without a guardrail this rule decays. Every hardcode in the audit above
was added by someone who knew the rule and had a good local reason.

### 4.9 The tools must read the same list

A chain list that the tools do not consult is decoration.

**Today the model is told chain ids in prose.**
`agent-api/src/agents/defi/systemPrompt.ts:49-52` names Arc `5042` and
`5042002` and then inlines USDC and EURC contract addresses and decimals
for both. That is a hardcoded chain-and-token registry living in a system
prompt, which is the worst copy of it: it cannot be updated without a
deploy, it is invisible to `check:chains`, and a model can misread it.

The rule:

1. **Tool schemas never enumerate chains.** `chain` is a CAIP-2 string,
   validated against the live list at execution time, not an enum baked
   into the schema.
2. **The prompt names no chain ids and no token addresses.** It describes
   the *capability* ("to swap on any supported chain, call `swap_quote`")
   and points at `get_supported_chains`
   (`services/agent-executors/wallet/reads.ts:330`), which already exists
   and already reads the API-driven list.
3. **The executor validates against the same list the card renders from.**
   `useBlockchainsWithStorage({ isActive: true })` on the device, the
   `Blockchain` table on the backend: one source, both anchors (§4.7).
4. **An unsupported chain is a capability boundary**, answered with
   `chain_not_enabled` and plain copy, never an error card and never a
   model apology invented from prompt text.

The payoff is the one this whole spec is aimed at: **adding a chain
becomes a database row.** The adapters pick it up because they query, the
tools accept it because they validate against the live list, the prompt
needs no edit because it never named a chain, and the cards render it
because chain metadata was always API-driven
(`reference_chain_icon_from_native_token`). No release, on any of the
three repos.

### 4.10 Asset-first routing: CCTP for Circle stablecoins, aggregators for the rest

**Verified against Circle primary docs 2026-09-26** (`developers.circle.com`
`llms.txt`, `/cctp.md`, `/cctp/expanded-assets.md`,
`supported-chains-and-domains.md`, `fees.md`,
`migration-from-v1-to-v2.md`).

USDC and EURC are the assets this product moves most, and for both of them
going through an aggregator means paying a spread to reach a protocol we
can call directly. The routing rule:

| Asset | Path | Entry contract |
|---|---|---|
| **USDC** | CCTP (V2) | `TokenMessengerV2.depositForBurn` |
| **EURC** | CCTP for non-USDC | `CrossChainTokenService.crossChainTransfer` |
| Everything else | LI.FI / Tower / venue adapters | provider-specific |

#### ⚠️ USDC and EURC are two different products, not one branch

This is the single most misread fact in this area, and it has now produced
**two** wrong answers from good-faith research: secondary sources once said
EURC was a CCTP asset when it was not, and `bridge-capability-spec.md` §2
now says "CCTP bridges USDC. Only USDC." which was correct about
`TokenMessengerV2` and is **outdated** as of Circle's expanded-assets
launch. That spec section must be updated, not cited.

| | USDC | EURC |
|---|---|---|
| Product | CCTP | CCTP for non-USDC (`/cctp/expanded-assets`) |
| Entry contract | `TokenMessengerV2` | `CrossChainTokenService` |
| Fee model | deducted from the amount; **Standard is free**, Fast 0-13 bps | **paid in native gas on the source**, `value: feeTotalAmount` |
| Approval target | USDC → `TokenMessengerV2` | token → per-token `TokenManager`, from `resolveTokenManager(tokenId)` |
| Quote | fees API, `maxFee` + `minFinalityThreshold` | Iris **signed quote**, `GET /v2/quote/cctpx/{tokenId}/{src}/{dst}` |
| Chain reach | ~30 domains | **7 EVM only**: Ethereum, Avalanche, OP, Arbitrum, Base, Polygon, Arc |
| Forwarding | compulsory when used | optional, requested at quote time |

They share only the Iris attestation service. **Two adapters, never one
with an `if (symbol === "EURC")`.** That branch would be a namespace-style
violation of §4.8 wearing a different hat, and their approval targets, fee
currencies and chain sets have nothing in common.

EURC is **pre-configured** by Circle: no registration work on our side.
`tokenId` is a `bytes32` discovered from Iris `/v2/cctpx/tokens`.
`CrossChainTokenService` is CREATE3-deployed at the same address on every
supported mainnet (`0x4318…42BC`; testnet `0x6375…1077`), which is a
constant of the protocol, not a chain support list (§4.8 category 2).

#### ⏰ CCTP V1 is being switched off, and Sui is on it

**V1 deprecation begins 2026-10-31 and completes 2026-12-01.** Message
limits tighten progressively until no new burns can start. Funds are never
stranded: Circle maintains minter allowance covering pending attestations.

**Sui and Noble are CCTP V1 only today** (Sui = domain 8). Circle states
Sui will have V2 "before the deprecation begins". Aptos has already moved
to V2 (domain 9). Our Stellar path is already correctly on V2
(`stellar-burn-params.ts` builds `depositForBurnWithHook` with `maxFee`
and `minFinalityThreshold`).

**Action:** any CCTP integration we add must be V2. Sui USDC bridging must
be treated as *blocked pending Circle's V2 deployment*, with a calendar
check before 2026-10-31, not as something to build on V1 now.

#### Why route Circle assets directly

1. **Cost.** CCTP Standard Transfer is **free**. Routing USDC through an
   aggregator that itself selects CCTP adds a spread for nothing.
2. **Honest UX.** Burn-and-mint means the user receives *native* USDC, not
   a wrapped representation. That is the sentence users care about and we
   can only say it truthfully when we know the mechanism (bridge spec
   §7.1).
3. **Fewer trust hops.** One protocol, audited, Circle-operated, versus an
   aggregator selecting among ~35 bridges.
4. **Arc.** Arc is CCTP domain 26 with Forwarding Service and upfront fees,
   while LI.FI does not serve Arc mainnet at all (§3.1). For our own
   settlement chain, CCTP is the only real option.

#### Where aggregators still win, and must stay

Do not read this as "CCTP replaces LI.FI". It does not:

- Any token that is not USDC or EURC.
- Chains outside CCTP's domain list, and EURC outside its 7.
- **Cross-asset routes** (ETH on Base → USDC on Arc). CCTP moves one asset
  to itself; anything involving a swap leg needs an aggregator, or CCTP
  plus a swap composed by us.
- A fallback when CCTP is degraded. The adapters coexist and
  `resolveRouteAdapters` (§4.3) arbitrates, with CCTP sorted first for its
  assets via the existing `supportsAsset` specificity rule.

#### Fast versus Standard is a user-visible choice

`minFinalityThreshold` 1000 = Fast (0-13 bps, seconds), 2000 = Standard
(free, 15-19 minutes on Ethereum and L2s). On several chains including Arc
the standard attestation is already fast, so Fast Transfer is marked N/A
and there is nothing to choose.

Default to **Standard**, because free and slower is the right default for
a payments wallet, and surface Fast as an explicit opt-in with its fee on
the card. Never select Fast silently: it is a fee the user did not ask
for. If `maxFee` is set below what Fast requires, CCTP falls back to
Standard on its own, which the card must reflect rather than hide.

---

### 4.11 Arc App Kit: an implementation option for the CCTP adapter, never the adapter boundary itself

**Verified against `docs.arc.io` primary docs plus the actual shipped
package source (`@circle-fin/app-kit@1.15.3`, unpacked and read directly —
`bridge.mjs` ships unminified), 2026-09-26.** Circle ships one package
covering Bridge, Swap, Send, Unified Balance, Onramp, and Earn. We use its
**Viem adapter for EVM and its Solana adapter for Solana only** — we do
not carry Ethers anywhere in this stack, and Circle Wallets is a
custodial adapter, not applicable to a self-custody wallet. Its Bridge
capability is CCTP under the hood, wrapped in one method call.

**This changes nothing about §4.10's routing decision and nothing about
§4's architecture.** App Kit is the *implementation* inside the `cctp` /
`cctpx` adapter files — it competes with "call `TokenMessengerV2` /
`CrossChainTokenService` ourselves" for what sits **behind** `execute()`,
not with the registry, the tools, or the cards. `supports()`, `quote()`,
`execute()`, `status()` remain the only surface anything else ever sees
(§4.2, §4.6). **Decided: App Kit becomes that implementation** — it wraps
the exact CCTP flow we would otherwise hand-roll, with a fee mechanism and
a step model we get for free (below). **We are still not adopting Arc as
infrastructure anything else depends on**: swapping App Kit for a raw
contract call, or for a second provider's equivalent kit, stays a
one-file change, because nothing outside that file ever imports
`@circle-fin/app-kit` or references Arc by name.

**What App Kit's Bridge actually is:**

```ts
const result = await kit.bridge({
  from: { adapter: viemAdapter, chain: "Ethereum_Sepolia" },
  to:   { adapter: viemAdapter, chain: "Arc_Testnet" },
  amount: "1.00",           // human-readable decimal; SDK handles base units
});
```

The Viem adapter wraps a live `WalletClient` + `Account` — exactly what
`EvmWalletKit` already constructs. Driven by our own signer instead of a
server-held key, execution is genuinely non-custodial: Circle's SDK
builds and submits the calls, our own key signs them.

**Confirmed by reading the source, not inferred: `kit.bridge()` blocks
in-process for the full attestation wait on a Standard-speed transfer.**
`bridgeFetchAttestation` (`bridge.mjs`) polls Circle's Iris endpoint in a
plain loop — `await sleep(retryDelayMs)` between attempts, budgeted
`DEFAULT_POLL_MAX_RETRIES = 600`, `retryDelayMs` either `2_000` (fast
chains) or `SLOW_ATTESTATION_POLL_DELAY_MS = 30_000` for slow,
high-finality source chains — entirely inside the same `async` call the
top-level `bridge()` awaits. There is no separate `getBridgeStatus()`
(Swap has `getSwapStatus()`; Bridge does not). So for a Standard transfer
this is a **real ~15-19 minute `await`**, and for the worst-case budget
on a slow chain it is bounded at `600 × 30s ≈ 5 hours` before the SDK
itself gives up.

**A promise held open that long does not survive a React Native app
backgrounding, an OS-initiated kill, or a network blip** — the exact
reason our own `bridge_execute` / `bridge_status` split exists (bridge
spec §7.7), and the exact reason a 20-minute in-flight *agent turn*
already needed dedicated keep-alive infrastructure
(`project_agent_background_keepalive`) for something shorter and
lower-stakes than an irreversible burn. **Calling `kit.bridge()` directly
on-device for a Standard-speed transfer is therefore ruled out**, not
merely unconfirmed. A Fast-speed transfer (2s cadence, ~8-20s typical
attestation) is short enough to await inline, on-device, without this
concern.

**Resolved architecture: `kit.bridge()` runs as a backend job, never
inline in a mobile request path, driven by a signer that never leaves the
device.** Concretely, for Standard-speed CCTP:

1. The backend (a worker/job process — never an HTTP request handler
   left open for 20 minutes) constructs a `ViemAdapter` around a
   **remote-signing `Account`**: a viem `Account` whose `signTransaction`
   does not hold a key at all — it round-trips the unsigned payload to
   the user's device (the same push/deep-link channel already built for
   wallet interactions, `project_deeplink_wallet_interactions_implemented`),
   waits for the device to sign locally and return the signed bytes, and
   hands those back to `kit.bridge()`.
2. The backend never possesses the private key at any point — only an
   unsigned payload on the way out and signed bytes on the way back. This
   is the same non-custodial invariant as everywhere else in this spec,
   carried over a network round-trip instead of an in-process call, and
   it is why L4 (§8.4) is written to verify the *content actually being
   signed* rather than trust whoever assembled it (§4.11 addendum below).
3. Fast-speed transfers may skip this and call `kit.bridge()` inline,
   on-device, exactly as the quickstarts show — the block is short enough
   to be a normal foreground wait during an active approval, no different
   from any other transaction confirmation the app already does.

**L4 addendum, specific to the remote-signing round-trip (new).** The
device is still the sole trust anchor that matters: before signing
whatever the backend sent for signature, the device runs the same
`decoded-intent-match` / `simulate-before-sign` pair (§8.4) it would run
against any other provider's calldata. A backend that is compromised, or
that has a bug in how it re-serialized the App Kit-built transaction for
transport, is caught here the same way a compromised aggregator is —
"Circle's SDK built it" and "our own backend relayed it" are each
independently a step L4 does not exempt.

**What App Kit gets us over a hand-rolled call, now that it's the
default:**

| | Hand-rolled `TokenMessengerV2` / `CrossChainTokenService` | App Kit (resolved architecture above) |
|---|---|---|
| Custom fee on USDC | build it ourselves, 100% ours, full §8 review needed | built in (§12.0, §12.5), Arc takes a mandatory 10% |
| Custom fee on EURC | not possible either way | not possible either way |
| Step model | ours to define | already `approve`/`burn`/`fetchAttestation`/`mint` — **matches bridge spec §7.7 exactly**, independent confirmation our model was right |
| Speed-downgrade signal | build it ourselves | `BridgeWarning` field, built in (§8.4 L2 addition) |
| Audit surface | our code, our review | Circle's code, their review — **still gets our own §8.4 wrapping regardless** (target allowlist, decoded-intent-match); an official SDK is not an exemption from verification |
| Retry/recovery | ours to design | `retryBridge()` / `retry()`, **must be driven through the same on-chain-verify-before-resubmit rule as our own `idempotency` check** (T16, §8.4 L4) — App Kit's own retry does not get a pass on this either |

`estimateBridge()` is a read-only call with no blocking-duration risk and
is used for `quote()` regardless of how `execute()` is built.

---

## 5. Wire types

`api/src/bridge/types.ts` and `mobile-app/api/types/bridge.ts` are already
correct in substance. The changes are additive; no field is removed.

```ts
export interface RouteQuote {
  // … every existing TBridgeQuote field, unchanged …

  /** Derived from topology. Never supplied by a caller or a model. */
  kind: RouteKind;

  /**
   * Price impact as a fraction (0.032 = 3.2%), when the provider reports
   * it. Absent means UNKNOWN and must render as absent, never as 0.
   */
  priceImpact?: number;

  /** The venue that won, for display: "Tower DEX", "Cetus", "fly". */
  venue?: { key: string; name: string; logoUri?: string };

  /** Ranked alternatives, when the provider offers them (§6.3). */
  routeOptions?: RouteOption[];
}

export interface RouteQuoteRequest {
  // … every existing TBridgeQuoteRequest field, unchanged …

  /**
   * UI-set only, never model-supplied (§1 non-goals, same rule as
   * slippage). Server defaults to `"standard"` (§4.10). Lets the card's
   * Fast/Standard toggle re-quote without a model turn, the same pattern
   * `bridgeDestinationChoice` uses for a destination-address change
   * (bridge spec §8.1).
   */
  transferSpeedHint?: "fast" | "standard";

  /** UI-set only. Server default per bridge spec §7.5.1. */
  useForwarder?: boolean;
}
```

Two invariants carry over from the bridge spec and are non-negotiable:

1. **CAIP-2 / CAIP-19 only.** A provider's private chain numbering never
   leaves its adapter.
2. **`decimals` travels with every token**, never a shared constant.
   Tower's 1e18 normalization (§3.2) is exactly the bug class this
   prevents: read `*Raw`, carry the token's own decimals.

---

## 6. UX contract — what a swap must show

The bridge contract (spec §7) mostly transfers. These are the deltas.

### 6.1 Price impact is mandatory when known

A swap's characteristic harm is receiving far less than expected because
the pool is thin. The card must show price impact whenever the provider
reports it, with the existing severity thresholds from
`getPriceImpactSeverity` (safe <2%, warn <10%, danger ≥10%).

Above the danger threshold the write gate requires an explicit extra
confirmation, the same shape as the Sui guardian's `highSlippageCheck`.

**Absent is not zero.** A provider that does not report impact renders no
impact line. Inventing 0% on an unknown is how a user gets sandwiched
while reading a reassuring card.

### 6.2 Venue attribution

Show which venue won ("via Tower DEX", "via Cetus"). Users are entitled
to know whose pool they are trading against, and it is the only honest
way to present a number we did not compute ourselves.

### 6.3 Route options are display-only in v1

`routeOptions` renders as "3 other routes checked", expandable. Making it
*selectable* means re-quoting on selection and re-running the write gate,
which is phase 4. Showing that alternatives were considered is most of
the trust benefit at a fraction of the cost.

### 6.4 Steps are rendered from real data, never synthesized or discarded

**Verified live 2026-09-26.** LI.FI returns genuine step data for a
same-chain quote, identical in shape to a cross-chain one:

```
same-chain (Arc Testnet USDC→EURC):
  { type: "protocol", tool: "feeCollection", name: "Integrator Fee" }
  { type: "swap",      tool: "fly",           name: "Fly" }

cross-chain (Base→Arbitrum USDC):
  { type: "protocol", tool: "feeCollection", name: "Integrator Fee" }
  { type: "cross",    tool: "polymerStandard", name: "Polymer" }
```

**Two things are currently wrong, and they compound.**

1. **`toBridgeSteps` (`api` `lifi.mapping.ts`) derives `kind` from a
   same-chain/cross-chain heuristic instead of LI.FI's own `type` field
   it already has.** For the `feeCollection` step this produces
   `kind: "swap"`, `label: "Swap via Integrator Fee"` — a fee deduction
   mislabeled as a trade. `TBridgeStepKind` already includes `"protocol"`
   (`api/types/bridge.ts`); the adapter simply isn't using it. (B15)
2. **Both progress cards discard the entire `steps` array and synthesize
   their own fixed copy.** `BridgeProgressCard`'s `isSwap()` branch
   replaces whatever the adapter returned with "Swapped on \<chain\>";
   the non-swap branch reduces everything to the four fixed bridge
   phases. This is why #1 is invisible today — nothing reads the label —
   but it means the card also throws away real information: which venue
   actually executed each leg, and how many legs there were.

**The rule going forward: never discard adapter-supplied step data, and
never synthesize a label the adapter already gave correctly.** Three
categories, handled differently:

| Step kind | Source | Rendered as |
|---|---|---|
| `protocol` | adapter, fee-shaped | folded into the **fee breakdown**, not a progress row |
| `swap` / `cross` / `burn` (a real tool leg) | adapter, **the venue's own name** | its own progress row, label = `"<Action> via <toolDetails.name>"` |
| `approve` | **ours** — LI.FI's `includedSteps` never contains it; we detect `approvalAddress` ourselves | its own progress row, fixed copy |
| `attestation` / `mint` (cross-chain settlement) | **ours** — no aggregator surfaces an explicit "wait for attestation" includedStep; this models a real asynchronous gap between chains that must never be hidden | its own progress row, fixed copy + duration range |

A `protocol` step folds into the fee line rather than the sequence
because it is verifiably **atomic with the leg it rides on** — same
block, `executionDuration: 0` in the same-chain case — so presenting it
as a discrete row would imply a wait that does not exist. That is a
factual claim, not a stylistic one, and it is why fee disclosure (§12.3)
and step rendering share one code path instead of two.

**This generalises for free to multi-leg routes.** A route with two real
legs (swap → bridge → swap, a genuine multi-hop) renders two progress
rows, each with its own venue name, with no card change required — the
card was never told "a swap is one step"; it was told "render every
non-protocol leg the adapter reports." The one-row Arc case was never a
rule, it was what one leg looks like.

**CCTP-direct is not this bug, and stays exactly as designed.** There is
no provider `includedSteps` to read, because for CCTP we author the
calldata ourselves (§4.10). `approve → burn → attestation → mint` is our
own accurate model of Circle's real architecture, not a synthesized
shortcut standing in for data we chose not to use. Nothing in this
section asks the CCTP adapters to fetch or fabricate a step list.

### 6.5 Cards split, renderers shared


`BridgeQuoteCard` and `BridgeProgressCard` keep serving cross-chain
routes. Swap gets `SwapQuoteCard` and `SwapProgressCard`.

They are **not** copies. The shared pieces move into renderers both
import:

- `WriteApprovalGate` (unchanged, used by both),
- amount + symbol formatting (`bridgeFormat.ts` → `routeFormat.ts`),
- the fee breakdown list, **now including any folded `protocol` step**
  (§6.4) — one place decides what counts as a fee, so it can't drift
  between what the card discloses and what the progress rows imply,
- **`buildDisplaySteps(quote)`** — the §6.4 step builder. Filters
  `protocol` legs into the fee breakdown, maps every remaining adapter
  leg to a progress row using **the adapter's own label and provider
  info**, and appends `attestation`/`mint` only when the route actually
  crosses chains. This fully replaces the per-card `isSwap()` synthesis;
  neither card writes its own step list again,
- the re-quote-on-change hook (`requote`), which is subtle enough that a
  second implementation would drift,
- `agentErrorCopy` mapping.

What each card owns alone:

| `SwapQuoteCard` | `BridgeQuoteCard` |
|---|---|
| price impact + severity (§6.1) | destination address, prominently (§7.4 bridge spec) |
| venue attribution (§6.2) — now **read off the same step data** `buildDisplaySteps` renders, not fetched separately | mechanism + trust model ("burn and mint") |
| "N other routes checked" (§6.3) | destination readiness blockers |
| one-line "You pay / You receive" | duration estimate and range |

The payoff is concrete: **every `isSwap()` conditional added in `3b97c68`
disappears**, and so does the mismatch it was hiding (B15) — `outcomeCopy(…,
{ swap })` and the reinterpreted `same_chain` copy are gone because
neither card branches on topology to decide what a step says; it renders
what the route actually did. A multi-leg route (swap → bridge → swap)
gets multiple rows for free, with no new card logic, because the builder
was never told "a swap is one row" — it renders every leg it is given.

Migration is mechanical and low-risk: `SwapQuoteCard` starts as the Arc
branch of the current card, lifted out, with the bridge branches deleted
from both sides. `buildDisplaySteps` starts as `toBridgeSteps`'s
`type`-derived `kind` fix (B15) plus the filtering rule above.

### 6.6 Copy stays hand-written

Every string is fixed copy. No `err.message`, no provider body, no status
line, no RPC payload reaches a user (CLAUDE.md hard rule). **No
em-dashes in user-facing strings** (`feedback_no_emdash_in_ui_copy`).

### 6.7 Reference mockups: step rendering, before and after

All four cases below use the same `buildDisplaySteps` builder (§6.5).
None of the differences between them are card logic — they fall out of
what the adapter actually reports.

#### A. Same-chain swap, one real leg (Arc, live data)

Adapter reports `[protocol/feeCollection, swap/fly]`.

```
BEFORE (today — synthesized, ignores the adapter):
  ✓ Approved
  ✓ Swapped on Arc

AFTER (§6.4 — fee folded, real venue name):
  ✓ Approved
  ✓ Swap via Fly

  Fee (0.25%)              0.25 USDC     ← the folded protocol step
```

The visible row count doesn't change here — Arc really is one leg — but
the label is now real ("via Fly", the venue that actually executed it)
instead of a chain name with no venue information at all.

#### B. Same-chain swap, two real legs (hypothetical multi-hop)

Adapter reports `[protocol/feeCollection, swap/uniswap, swap/curve]` —
LI.FI routed through an intermediate token.

```
BEFORE (impossible to represent — the card only ever emits one
  synthesized row, so a second real leg has nowhere to go and is
  silently dropped):
  ✓ Approved
  ✓ Swapped on Arc

AFTER (each leg gets its own row, no card change required):
  ✓ Approved
  ✓ Swap via Uniswap
  ✓ Swap via Curve

  Fee (0.25%)              0.25 USDC
```

This is the case that proves the fix is structural, not cosmetic: today's
card cannot show a two-leg swap correctly at all.

#### C. Cross-chain LI.FI bridge (Base → Arbitrum, live data)

Adapter reports `[protocol/feeCollection, cross/polymerStandard]`; the
adapter itself still appends `attestation`/`mint` (§6.4 — that pair is
ours, and stays, because it models a real asynchronous gap no aggregator
surfaces as an includedStep).

```
BEFORE:
  ✓ Approved
  ✓ Bridged
  ⏳ Waiting for attestation
  ○ Deliver on Arbitrum

AFTER (real venue name on the real leg; everything else unchanged):
  ✓ Approved
  ✓ Sent via Polymer
  ⏳ Waiting for attestation
  ○ Deliver on Arbitrum

  Fee (0.25%)              0.025 USDC
```

#### D. CCTP-direct bridge (USDC, any pair) — contrast case, unchanged

There is no adapter `includedSteps` here at all: we build the
`depositForBurn` call ourselves (§4.10). These four phases are our own
model of Circle's real architecture, not a synthesis standing in for
data we declined to use, so §6.4 does not touch this card.

```
  ✓ Approved
  ✓ Burned on Base
  ⏳ Waiting for attestation      (~15 min remaining)
  ○ Minted on Arc

  Fee                      Free
```

The visual language is identical to case C on purpose — a user should
not be able to tell from the progress card alone whether a bridge routed
through an aggregator or through CCTP directly. The mechanism disclosure
line above the steps (§7.3 bridge spec) is where that distinction
belongs, not the step labels.

---

## 7. Agent integration

### 7.1 Split the tools — decided, with reasons

Ship `swap_quote` / `swap_execute` / `swap_status` as **first-class
tools**, not aliases. `bridge_*` keeps serving cross-chain only and
reverts to refusing same-chain routes once swap tools exist.

This is a reversal of the shipped Arc arrangement, and it is deliberate.
Docking Tower onto `bridge_*` was correct when there was no swap surface
to dock onto (§2.3). It stops being correct the moment swap coverage
spans many chains, for five reasons that are all about *practice*, not
taxonomy:

1. **The routing rule is currently prompt prose.**
   `agent-api/src/agents/defi/systemPrompt.ts:49` instructs the model:
   on Arc, use `bridge_quote` with both chains identical, and never
   `defi_intent_*`. That is a conditional the model evaluates at runtime.
   It grows a clause per chain, and every clause is a chance to route
   wrong. A tool whose name is the user's verb removes the conditional
   instead of extending it.

2. **The schemas genuinely differ, and the overlap is dangerous.**
   `bridge_quote` requires `from_chain` and `to_chain`. A swap has one
   chain. Forcing the model to name it twice means a single-token
   hallucination in the second field silently converts a swap request
   into a cross-chain transfer that the user did not ask for and which
   the card will happily render. A `swap_quote` that takes `chain` once
   makes that failure unrepresentable.

3. **`to_address` should not exist on a swap.** On a bridge it is
   safety-critical and namespace-dependent (bridge spec §7.4). On a swap
   the recipient is always the sender. Exposing the field to the model on
   a swap is an invitation to fill it from conversation history, which is
   exactly the bug class `bridgeDestinationChoice` exists to contain.

4. **The write gates protect against different harms.** A swap's gate is
   price impact (§6.1). A bridge's gate is destination readiness and
   strand risk. One tool means one executor branching on topology to pick
   its safety checks, and topology branching inside a write path is where
   safety bugs hide.

5. **`same_chain` stops being two things.** Today it is a no-route reason
   on most chains and a valid route on Arc. Split tools restore one
   meaning per code (B8).

**What is explicitly NOT split:** the registry, the adapters, the quote
engine, the TTL and re-quote logic, the allowance handling, the walletKit
signing dispatch. `swap_execute` and `bridge_execute` call the same core
with the same guarantees (§4.4). The split is the interface, not the
machine.

### 7.2 Tool schemas

```jsonc
// swap_quote — READ
{
  "chain":      "eip155:5042",          // ONE chain. Required.
  "from_asset": "eip155:5042/erc20:0x36…",
  "to_asset":   "eip155:5042/erc20:0xbE…",
  "amount_raw": "1000000",              // atomic units of from_asset

  // Advisory only, NEVER trusted for execution (§8.4 L1). The symbol the
  // model believes it resolved, checked against the DEVICE's own token
  // registry entry for from_asset/to_asset. A mismatch ("model said EURC,
  // registry says this CAIP-19 is USDC.e") surfaces as an explicit
  // confirmation, not a silent pass and not a silent block — the model
  // may be right and the hint stale. This is the guard against the
  // "USDC vs USDC.e" mispick the bridge spec already names (§7.1 bridge
  // spec) but that nothing previously caught at the tool boundary.
  "from_asset_symbol_hint": "USDC",
  "to_asset_symbol_hint": "EURC"
}

// swap_execute — WRITE
{
  "chain": "…", "from_asset": "…", "to_asset": "…", "amount_raw": "…",
  "from_asset_symbol_hint": "…", "to_asset_symbol_hint": "…",
  // The floor the user actually read on the card. Re-quote at signing
  // must clear it or the call fails `stale_precondition` (§7.3).
  "min_receive_raw": "920000",
  // The EXACT impact the user was shown and accepted, in bps — not a
  // boolean. Mirrors `min_receive_raw`'s role: a fresh re-quote whose
  // impact has RISEN past this value is `stale_precondition`, same as a
  // fallen `toAmountMin`. A bare `true` (the earlier shape) cannot
  // express "the user accepted 12%", so it cannot catch a route that
  // worsened to 40% by signing time. Absent + danger-level = refuse
  // (§6.1).
  "price_impact_ack_bps": 1200
}

// swap_status — READ
{ "chain": "…", "tx_hash": "0x…" }
```

No `slippage` field anywhere: it is a server-side default per route class
(§1 non-goals). No `dex` / `venue` field: venue selection is ours (§1).
No `to_address`: the recipient is the signer (§7.1 reason 3).

**`from_address` / sender is never a tool param, on either tool, ever.**
Always resolved from `context.wallet.address`, never accepted from the
model. This is deliberate, not an omission: it is exactly the field
Tower's own `/bridge` got wrong by making optional (§3.2), and the
failure mode of getting it wrong is someone else's funds moving. Stating
it as a rule here is what stops a future "helpful" PR from adding it
back because a schema without it looks incomplete.

**These same two additions — the symbol hints and the bps-valued
impact ack — extend to `bridge_quote` / `bridge_execute` unchanged.**
The bridge spec's own §7.1 names the USDC-vs-USDC.e risk directly, and a
composite bridge route with a bundled swap leg (§6.4 case C) carries
price impact exactly like a swap does. Nothing about either check is
swap-specific; they are properties of moving a named asset, which both
tools do.

#### 7.2.1 Considered and rejected: a single quote fingerprint

An earlier draft of this section considered binding the exact rendered
card to the exact `execute` call with one hash of the approved quote,
checked for equality against the fresh re-quote. **Rejected.** Equality
is the wrong test: a legitimate re-quote is EXPECTED to differ slightly
(price moves in seconds), so a hash would fail on exactly the routes that
should pass, and pass trivially on nothing since any real drift breaks
it. The per-field floor/ceiling design already here —
`min_receive_raw` as a floor, `price_impact_ack_bps` as a ceiling — is
strictly more correct: each field expresses the actual property that must
hold, not incidental equality with a snapshot.

#### 7.2.2 CCTP-specific fields live in the request, not the tool schema

Fast-vs-Standard transfer and Circle's Forwarding Service (§4.10, bridge
spec §7.5.1) are **card-driven choices, never model-supplied** — same
non-goal as slippage (§1). They travel from the card's toggle to a
re-quote via `RouteQuoteRequest.transferSpeedHint` /
`.useForwarder` (§5) — never through the tool schema, and never through
the model. Re-quoting on a toggle change follows the same pattern as
`bridgeDestinationChoice`'s re-quote on an address change (bridge spec
§8.1): a local re-price, not a new model turn.

**`refundAddress` (EURC's `CrossChainTokenService.crossChainTransfer`
`claim.refundAddress`, §3.2) is deliberately NOT a field anywhere**, on
either the tool schema or `RouteQuoteRequest`. The `cctpx` adapter
hardcodes it to `req.fromAddress` internally and never exposes a way to
set it separately. Exposing it as a settable field would BE the
vulnerability L0 exists to prevent — a failed transfer's refund landing
anywhere but the sender's own wallet is exactly the class of harm every
other address rule in this spec is written against, and the fix here is
narrower than a check: there is simply nothing to check because there is
nothing to set.

### 7.3 Execution guarantees (identical to bridge, restated)


`swap_execute` re-quotes fresh, then signs. Both jobs matter:

1. **Staleness.** A user can approve a card minutes after it rendered.
   Submitting the quote the model saw would send a dead route.
2. **Facts-first.** Because the args carry the full route rather than an
   opaque id, the card renders real facts from args, not from the model's
   prose (`project_facts_first_approval_summary`).

A fresh quote whose `toAmountMin` is below `min_receive_raw` is a
`stale_precondition`, never a silent execution.

### 7.4 Error vocabulary

Shared codes where the failure is shared, distinct where it is not
(`project_agent_tool_error_standard`: coarse closed `error` code, open
curated `reason`).

| Code | Swap | Bridge |
|---|---|---|
| `stale_precondition` | ✅ | ✅ |
| `wallet_cannot_execute` | ✅ | ✅ |
| `unsupported_chain` | ✅ | ✅ |
| `no_route_found` | ✅ | ✅ |
| `price_impact_too_high` | ✅ | — |
| `insufficient_liquidity` | ✅ | — |
| `destination_not_ready` | — | ✅ |
| `destination_missing_trustline` | — | ✅ |

### 7.5 Registry parity and write authorization

`EXPECTED_MOBILE_TOOLS` and the server `TOOL_REGISTRY` must be updated
together; `registryParity.test.ts` enforces it and **must be proven to
fail on real drift before it is trusted**
(`feedback_registry_parity_enforcement`).

`swap_execute` is `capability:write`. Tagging alone shows no prompt: the
card must render `WriteApprovalGate`
(`feedback_write_card_approval_gate_required`), and the tool must appear
in `MOBILE_WRITE_TOOLS` so `authorizeToolCall` fails closed
(`project_mobile_capability_crosscheck`).

### 7.6 Migration without a regression window

1. Add `swap_*` alongside `bridge_*`, both able to serve Arc.
2. Update the prompt to prefer `swap_*` for same-chain; keep the Arc
   `bridge_*` clause as a fallback for one release.
3. Once telemetry shows the model reaching for `swap_*` reliably, delete
   the prompt clause and restore `from === to → false` in the bridge
   adapters.

Old conversation history containing `bridge_execute` calls with identical
chains keeps working throughout, which is why step 3 is separate.

### 7.7 Facts-first rendering

The card renders from tool args and the quote, never from the model's
`human_summary` (`project_facts_first_approval_summary`). A model
paraphrasing "you'll get about 92 EURC" is not a substitute for a
rendered `toAmountMin`, and it is the property that keeps a
prompt-injected model from making the screen disagree with the
transaction (§8.5).

---

## 8. Security architecture — protecting funds

### 8.0 The core exposure

**We sign opaque calldata built by a third party.** A swap or bridge quote
arrives from LI.FI or Tower as `{to, data, value, gasLimit}` plus an
approval, and the device signs it. Nothing in that payload is
self-describing. A compromised, coerced, or simply buggy provider can put
anything in `data`, and the user's key will authorise it.

This is the same exposure the DeFi deposit path has, and that path already
answers it with a six-layer, fail-closed pipeline
(`services/defi/safety/`). The swap and bridge paths **do not run it.**

### 8.1 The gap, stated precisely

`runSafetyPipeline` is called from exactly two places:

- `services/agent-executors/defi/writes.ts` (DeFi deposits and withdrawals),
- `services/agent-executors/defi/intentExecutors.ts` (Sui intents, which
  is why **Sui swaps are protected today**).

It is called from **none** of:

- `services/agent-executors/defi/bridge.ts` (`bridge_execute`),
- `services/bridgeRoutes/execute.ts`,
- `services/walletKit/evm/bridge.ts`.

So a structurally identical action — sign third-party calldata that moves
the user's tokens — gets six layers of checks when it is called a deposit
and zero when it is called a bridge or an Arc swap.

**Closing this is the highest-priority item in this spec, ahead of every
coverage feature in §10.** Enabling same-chain LI.FI routes (B1) widens
the unprotected surface from one chain to roughly seventy, so it must not
ship before §8.4.

### 8.2 What protects the path today

Not nothing, and the existing measures should be recognised so they are
not rebuilt:

| Control | Where | Covers |
|---|---|---|
| Quote TTL + re-quote at signing | `bridge.ts` executor, `isQuoteExpired` | stale routes |
| `min_receive_raw` floor enforced against the fresh quote | `bridge.ts:494` | price movement between approval and signing |
| Exact-amount approval, never unbounded | `walletKit/evm/bridge.ts:88` | unlimited allowance |
| Executor allowlist + `eth_getCode` | `api` `tower.adapter.ts:332` | codeless / substituted target (Tower only) |
| Request/response token equality assertion | `api` `tower.adapter.ts:277` | silent token rewriting (Tower only) |
| Destination readiness | `bridgeRoutes/execute.ts` | stranding on arrival |
| `WriteApprovalGate` + biometric | card | unattended execution |
| Facts-first approval summary | `approvalSummary.ts` | model misreporting the action |

Note the two "(Tower only)" rows. Those guards exist because live probing
caught real failures (§3.2). **LI.FI has no equivalent**: no target
allowlist, no code check, no response/request assertion. The provider we
trust most implicitly is the one we verify least.

### 8.3 Threat model

| # | Threat | Realistic? | Answered by |
|---|---|---|---|
| T1 | Provider returns draining calldata (compromise, supply chain, insider) | the core risk | 8.4 L4 decode + simulate |
| T2 | Silent token or amount substitution in the response | **observed live** (§3.2) | 8.4 L2 quote-binding |
| T3 | Approval to a wrong or codeless spender | **observed live** (§3.2) | 8.4 L1 + L4 approval scoping |
| T4 | Unbounded approval left standing | common industry loss | already exact; 8.6 adds revocation |
| T5 | Recipient inside calldata is not the user | undetectable without decode | 8.4 L4 `decoded-intent-match` |
| T6 | Sandwich / MEV on a public mempool | routine on mainnet | §9.2 |
| T7 | Thin-pool price manipulation | routine for long-tail pairs | 8.4 L2 price-impact gate |
| T8 | Token spoofing (fake USDC, same symbol) | routine | 8.4 L1 token verification |
| T9 | Stale quote signed late | happens in normal use | already covered (8.2) |
| T10 | Replay on another chain | low but cheap to prevent | 8.4 L4 `chain-binding` |
| T11 | Prompt injection drives an unwanted swap | real for an agent wallet | 8.5 |
| T12 | Our own backend compromised | must be assumed | 8.4 two trust anchors |
| T13 | RPC lies about code, balance, or receipt | possible | 8.6 |
| T14 | Hidden fee inflated between quote and build | provider-side | 8.4 L2 fee-delta |
| T15 | `partial` / `refunded` bridge outcome read as failure | already handled | bridge spec §7.7.1 |
| T16 | A retried CCTP step double-submits (burn is irreversible and **not protocol-idempotent** — nothing on-chain stops a second identical burn from succeeding) | **new, real** (§4.11 — `retryBridge`/`retry` exist precisely because steps fail) | 8.4 L4 `idempotency`, extended |
| T17 | A Forwarding Service transfer is reported complete from an **off-chain API status field**, never independently checked on-chain | **new, real** (§4.11 — `RetryContext.to` optional, "relies on IRIS API confirmation... instead of on-chain transaction confirmation") | 8.4 L5, extended |
| T18 | A configured fee-recipient address is valid on the wrong chain (source vs destination), silently misdirecting or failing a fee | **new** (§12.0 — Circle's own docs warn against this) | 8.4 L1, extended |

### 8.4 Wiring the pipeline into swap and bridge

The taxonomy needs no redesign. Three additive changes and the existing
checks apply:

```ts
// services/defi/safety/types.ts
export type SafetyAction = "deposit" | "withdraw" | "swap" | "bridge";

// DecodedIntent.action
action: "deposit" | "withdraw" | "approve" | "stake" | "claim"
      | "swap" | "bridge" | "unknown";
```

Plus a `RouteSafetyContext` builder mirroring `buildSuiSafetyContext`, so
`swap_execute` and `bridge_execute` call `runSafetyPipeline` at the same
two stages the deposit path does (`submit`, then `broadcast`).

Layer by layer, what applies:

**L0 — input provenance.** `no-llm-supplied-address` already forbids the
model naming address-shaped fields. It must cover `swap_execute` too, and
this is precisely why §7.1 removes `to_address` from the swap schema: the
field the model must not supply is best deleted rather than validated.

**Asset-chain consistency, new for swap.** `bridge.service.ts` already
asserts `chainOfAsset(req.fromAsset) === req.fromChain` before routing
(`asset_chain_mismatch`); it exists because a mismatched asset would
otherwise quote a route for a pair that isn't the one requested. The
swap service is a **new file**, not an extension of `bridge.service.ts`,
so this check is not inherited for free — it must assert
`chainOfAsset(from_asset) === chain` and the same for `to_asset`
independently, or a swap service written from a blank file will simply
lack a check that exists one file over.

**L1 — identity and provenance.**
- `target-has-code` on the swap target **and the approval spender**.
  Generalise Tower's `eth_getCode` guard to every provider (closes the
  "LI.FI is unverified" gap in §8.2).
- **Provider target allowlist.** Each adapter declares the contracts it is
  permitted to return (`TOWER_EXECUTORS_<chainId>` is the pattern). A
  quote whose `to` is outside its provider's allowlist is refused, not
  rendered. For an aggregator that rotates routers this is a *pinned set
  refreshed out of band*, never "whatever the API said".
- **Token verification** (T8). The `verification` field already exists on
  `TBridgeToken`. An `unverified` output token must surface on the card
  and, above a USD threshold, require explicit acknowledgement.
- **Fee-recipient chain-pinning** (T18, new). If a CCTP adapter ever
  enables a custom fee (§12.0), the configured recipient address must be
  asserted valid **for the source chain of the specific route being
  quoted**, never assumed correct because it "is our fee wallet." Circle's
  own docs warn against exactly this mistake — a destination-chain address
  used as a source-chain fee recipient — and it is the same class of harm
  §12.5.3 already writes the fee-wallet custody rules against, just at a
  different config surface (`kit.setCustomFeePolicy` instead of
  `portal.li.fi`). One rule, two surfaces; do not let the second one skip
  it because it looks like a different feature.
- **Symbol-hint cross-check** (§7.2, new). The model resolves a symbol to
  a CAIP-19; that resolution can be wrong in a way none of the checks
  above catch, because the address it picked can genuinely have code and
  genuinely be on an allowlist while still being the WRONG token — USDC.e
  instead of native USDC is the canonical case (bridge spec §7.1). Assert
  the device's own token registry entry for `from_asset`/`to_asset`
  matches `from_asset_symbol_hint`/`to_asset_symbol_hint`. A mismatch is
  neither a silent pass nor a hard block — the hint could be the stale
  one — it forces an explicit confirmation naming both symbols ("This
  swaps to USDC.e, not USDC — continue?"). This is the one L1 check aimed
  at an honest model's mistake rather than a compromised or malicious
  provider.

**L2 — economic.**
- `decimals-match` applies unchanged and is the single highest-value check
  here. Tower's 1e18 normalization (§3.2) is exactly this footgun.
- `slippage-floor-present`: refuse any route without a usable
  `toAmountMin`. A swap with no floor is an unbounded loss.
- **Price-impact gate** (§6.1): `warn` renders, `danger` requires
  `price_impact_ack_bps` (§7.2) — the exact value acknowledged, not a
  boolean. Absent impact is *unknown*, never 0.
- **Quote-binding assertion** (T2, T14): the built transaction must
  correspond to the quote that was approved. Assert input token, output
  token, input amount, and that `toAmountMin` has not fallen and fees have
  not risen between quote and build. Tower's existing assertion becomes a
  shared check.
- **Transfer-class downgrade must be disclosed, never silent** (new, from
  §4.11). CCTP can silently fall back from Fast to Standard when a
  `maxFee` is set too low (§4.10) or a Fast allowance is exhausted — App
  Kit surfaces this as a structured `BridgeWarning`, but the property it
  names is general, not App-Kit-specific: a route approved as "Fast,
  ~10s, fee X" must not execute as Standard, ~15 min, fee 0 without the
  user seeing that it changed. Whichever adapter builds this (App Kit or
  a raw call), a downgrade is a `stale_precondition` the same way a
  worsened `toAmountMin` is, not a fact to discover from the progress
  card's timer running long.
- `sufficient-balance` applies unchanged.

**L3 — policy.**
- **Provider kill-switch**, mirroring `family-kill-switch`. When an
  aggregator is exploited, ops must disable it without a release. Today
  there is no way to turn LI.FI off.
- Sanctions screening and velocity ceilings apply to swap exactly as they
  do to deposits; a swap is a value movement like any other.

**L4 — execution integrity. The on-device anchor, and the answer to T1.**
- `chain-binding`: the signed `chainId` must equal the chain validated.
- `decoded-intent-match`: decode the calldata and assert it says what the
  quote says. For EVM this is `services/walletKit/evm/clearSigning.ts`
  plus the ERC-7730 descriptors already in `erc7730Snapshot.ts`. Where a
  router's calldata cannot be decoded, **simulation is the fallback, not
  an excuse to skip**.
- `simulate-before-sign` is the strongest general control and the one that
  does not require understanding the calldata at all. Assert, against a
  simulated execution:
  - balance of `to_asset` for the signer increases by at least
    `toAmountMin`,
  - balance of `from_asset` decreases by at most `amount_raw`,
  - **no other token balance decreases**, and no approval is granted to an
    address outside the allowlist.
  That triple catches a draining router even when its calldata is opaque.
- `approval-scoping`: exact amount (already true), spender equal to the
  decoded/simulated spender, and never a blanket `max`.
- `quote-freshness`, `gas-sanity`, `idempotency` apply unchanged.

**L5 — state and post-execution.**
- `position-delta` becomes **receipt-delta** for a swap: after the receipt,
  confirm the output token actually arrived. A failure here is a
  reconciliation alert, never a reported failure of a landed transaction
  (`postexec.ts` never throws).
- For bridges the four-value outcome already covers this.

### 8.5 Agent-specific surface

An LLM proposing value movements is its own attack surface.

- **Amounts and addresses come from the user or the wallet, never the
  model.** L0 enforces it; §7.2's schema removes the opportunity.
- **`WriteApprovalGate` is mandatory on the card.** Tagging a tool
  `capability:write` shows no prompt by itself
  (`feedback_write_card_approval_gate_required`).
- **`MOBILE_WRITE_TOOLS` + `authorizeToolCall` fail closed** on a
  mislabelled write-as-read tool (`project_mobile_capability_crosscheck`).
- **Facts-first rendering.** The card shows the quote's numbers, not the
  model's prose. A model that has been prompt-injected still cannot make
  the card display a different destination or amount than the one that
  will be signed.
- **Injection containment.** Token names, dApp text, and provider strings
  are data. They are never instructions, and never rendered as copy
  (CLAUDE.md user-facing errors).

### 8.6 Residual risks, stated honestly

Not everything is closable, and pretending otherwise is worse than naming
them:

- **RPC trust (T13).** `eth_getCode`, balances, and simulation all run
  through an RPC. A lying endpoint defeats them. Mitigation is the
  existing proxy plus, for high-value swaps, cross-checking simulation
  against a second provider. Not planned for v1; documented so nobody
  assumes simulation is unconditional truth.
- **Simulation divergence.** A simulated result is not a guarantee: state
  moves between simulation and inclusion. `toAmountMin` remains the real
  protection, and simulation is defence in depth, not a substitute.
- **Standing approvals (T4).** Approvals are exact per swap, but they
  accumulate. A revocation surface ("you have N open approvals") is worth
  building and is out of scope here.
- **Provider allowlist staleness.** A pinned router set is safe against
  substitution and brittle against legitimate rotation. Refresh must be
  deliberate and reviewed, and a stale allowlist must fail as "we could
  not verify this route", never as a silent pass.

---

## 9. Bug fixes and hardening backlog

Everything below was found while writing this spec. Each is independently
shippable.

### 9.1 Correctness

| # | Issue | Where | Severity |
|---|---|---|---|
| B1 | `supports()` refuses same-chain, hiding swap coverage on ~70 EVM chains + Solana + Sui | `api/src/bridge/providers/lifi.adapter.ts` `supports()`, and the mobile mirror | **high** (pure loss of capability) |
| B2 | Spec claims Arc mainnet routes via LI.FI; it returns `Chain 5042 is not supported` | `docs/bridge-capability-spec.md:677` | high (a wrong assumption others will build on) |
| B3 | MEV protection is unreachable: `getFlashbotsClient()` builds a **public** client nothing calls, while every submission hardcodes `transport: http(chainRpcUrl(chain))` | `services/swap/mevProtection.ts`, `utils/clients.ts:29`, `services/walletKit/evm/bridge.ts:104` | **high** (looks implemented, protects nothing) |
| B4 | `mevEnabled` is a module-level `let`: unpersisted, non-reactive, contradicts the `useRQGlobalState` convention | `services/swap/mevProtection.ts` | medium |
| B5 | `getSwapRoute` POSTs to `/swap/route`, which does not exist in `api` | `services/swap/aggregator.ts:36` | medium (dead call that looks live) |
| B6 | `SwapInterface.tsx` is orphaned and cannot function: `fromToken`/`toToken` have no setters | `components/swap/SwapInterface.tsx` | low |
| B7 | `priceImpact`, `dexName`, `routeOptions` returned by Tower are discarded | `api/src/bridge/providers/tower.adapter.ts` → cards | medium (§6.1 is a safety surface) |
| B8 | `same_chain` no-route reason now means two different things depending on chain | `api/src/bridge/bridge.service.ts` + card copy | low (resolved by §4.2's `kind`) |
| B9 | Support matrix is the provider's chain list, **not intersected with our `Blockchain` rows**; destination readiness silently returns `[]` for an unknown chain, so bridging to an unsupported chain runs no gas/account/trustline check | `api` `bridge.service.ts` `getSupport()`, `bridgeRoutes/execute.ts:124` | **high** (silent strand risk) |
| B10 | Bitcoin excluded by a hardcoded special case instead of the general rule | `api` `lifi.adapter.ts:411` | low (deleted by §4.7) |
| B11-B14 | Hardcoded chain lists in both Tower adapters, MEV chain set, and chain ids + token addresses written into the agent prompt | see §4.8 audit table | **high** (defeats API-driven chains) |

### 9.2 MEV protection, done properly (B3 + B4)

The concept is sound and the gap is real: **LI.FI routes on Ethereum
mainnet frequently include a same-chain swap leg, and
`evmSubmitBridgeExecution` broadcasts them through the public RPC.** That
is a sandwichable transaction today, with nothing guarding it.

Required work:

1. Allow a **per-submission transport override** in `getWalletClient`, so
   a mainnet route can be broadcast through `rpc.flashbots.net`.
2. Move the setting into persisted reactive state (`useRQGlobalState` +
   MMKV), not a module `let`.
3. Widen applicability from `chainId === 1` to "chains with a public
   mempool and a private-relay endpoint we trust", as a small table.
   Enabling swap on ~70 chains (B1) makes a mainnet-only predicate
   useless almost immediately.
4. Disclose it on the approval card when active. Protection the user
   cannot see is protection they cannot rely on.

Honest scope limit: Flashbots Protect is Ethereum-mainnet infrastructure.
It does nothing for Arc, which has a fixed validator set and sub-second
deterministic finality. This protects the LI.FI mainnet path.

### 9.3 Dead code (B5 + B6)

Do **not** blanket-delete. `getPriceImpactSeverity` is live and
load-bearing for the Sui guardian.

- Move `getPriceImpactSeverity` and `validateSlippage` into a neutral
  `services/swap/slippage.ts`; they are generic thresholds, not
  aggregator logic.
- Delete `getSwapRoute` / `SwapParams` / `SwapRoute` (they can only 404).
- `SwapInterface.tsx`: delete, or keep with a header comment stating it
  is unwired scaffolding. Leaving it as-is invites someone to trust the
  filename.

### 9.4 Tower-specific guards already in place (keep, do not regress)

- executor allowlist (`TOWER_EXECUTORS_<chainId>`, defaults pinned),
- `eth_getCode` presence check on the swap target and spender,
- request/response token equality assertion (silent-rewrite defence),
- `routeOptions` fallback on `BUILD_TX_FAILED`,
- `*Raw` amounts only, never the 1e18-normalized fields.

Every one of these exists because a live probe caught the failure. They
are regression-test material, not cleanup targets.

---

## 10. Phasing

**Ordering rule: safety precedes reach.** Every coverage phase widens the
set of third-party calldata we sign. §8.1 is therefore a prerequisite for
phase 2, not a parallel track, and this is the one dependency in this
spec that must not be resequenced for speed.

**Phase 0 — close the safety gap (blocking).**
Wire `runSafetyPipeline` into `swap_execute` / `bridge_execute` (§8.4).
Add `SafetyAction` `swap`/`bridge`, the `RouteSafetyContext` builder,
`decoded-intent-match` + `simulate-before-sign` on the route path, and
generalise Tower's target allowlist and `eth_getCode` guard to **every**
provider including LI.FI (§8.2's "(Tower only)" rows). Add the provider
kill-switch (§8.4 L3): shipping more providers without an off switch is
not acceptable. **Also land §4.7's chain intersection here** (B9): it is a
silent strand risk today, and enabling same-chain LI.FI routes in phase 2
multiplies the surface it applies to. De-hardcode the chain lists in
the same pass (§4.8, B10-B14) and add the `check:chains` extension, since
a rule without a guardrail decays.

**Phase 1 — derive topology.**
`kind` on the quote (§4.2), `routeKindOf` replacing `isSwap()`, the
`kinds` field on adapters. No new coverage yet, purely the seam. Fix B2's
stale claim in the bridge spec.

**Phase 2 — unlock coverage.**
Drop the same-chain refusal in the LI.FI adapter (B1). Swap lights up on
~70 EVM chains plus Solana and Sui through the existing execution path,
now pipeline-protected. **Gated on phase 0.**

**Phase 3 — swap facts on screen.**
Carry `priceImpact` and `venue` through the wire types, render with
severity thresholds, gate danger-level impact behind `price_impact_ack`
(§6.1, B7). Split the cards (§6.5), backed by `buildDisplaySteps` (§6.4,
B15) so venue attribution and step rendering read the same data instead
of drifting — fix the `kind` derivation in `lifi.mapping.ts` first, since
the cards' correctness now depends on it rather than papering over it.

**Phase 4 — name the verb.**
`swap_quote` / `swap_execute` / `swap_status` as first-class tools,
registry parity, then the prompt rule deleted rather than extended
(§7.1, §7.6).

**Phase 5 — provider arbitration + route options.**
Parallel quoting ranked on `toAmountMin` (§4.3), route options displayed
then selectable (§6.3), cross-provider build-failure fallback. The
conformance suite (§4.6) lands here, since this is the phase that makes
multiple providers routine.

**Phase 6 — MEV + cleanup.**
§9.2 in full, §9.3 dead-code resolution.

**Phase 6b — CCTP-direct adapters, built on Arc App Kit (time-boxed by
the V1 sunset).**
A `cctp` adapter for USDC and a `cctpx` adapter for EURC, both implemented
on `@circle-fin/app-kit`'s Viem adapter (§4.11), sorted ahead of the
aggregators for their assets by the existing `supportsAsset` specificity
rule (§4.3, §4.10). Standard Transfer is the default; Fast is an explicit
opt-in with its fee shown. **Check Circle's Sui V2 status before
2026-10-31** (§4.10). `execute()` on a Standard-speed route runs as a
backend job against the remote-signing `Account` (§4.11) — this is new
infrastructure this phase must also build, not a detail internal to the
adapter file alone. `quote()` uses `estimateBridge()` directly; Fast-speed
`execute()` may call `kit.bridge()` inline, on-device.

**Phase 7 — Sui under the same roof.**
Dock the Sui venue selector as a `RouteAdapter` returning a serialized
PTB (§4.5). `defi_intent_*` keeps `swap_and_supply` and other multi-step
goals.

Phase 0 is the one that protects funds. Phases 2-4 deliver "swap as many
tokens on as many chains as possible". 5-7 are quality and consolidation.

---

## 11. Resolved decisions and open questions

### 11.1 Resolved

1. **Swap and bridge share one registry.** Topology is a property of the
   route, not a separate stack. Tower shipped this way and it held.
2. **Rank on `toAmountMin`, not `toAmount`.** The floor is the promise.
3. **Venue selection is never the model's.** Consistent with Sui.
4. **Tower's `/bridge` is out** until it is non-custodial (§3.2). Arc
   cross-chain, if needed before then, goes through a direct CCTP v2 EVM
   adapter, mirroring `cctp-stellar.adapter.ts`. Arc is CCTP domain 26.
5. **LI.FI needs no key.** Plan capacity around the anonymous tier and
   add a key only when rate limits bite.
6. **Absent price impact renders absent**, never 0%.
7. **Tools split, engine shared** (§4.4, §7.1). The Arc arrangement of
   serving swaps through `bridge_*` is explicitly superseded once swap
   tools exist, and the bridge adapters go back to refusing same-chain
   routes (§7.6 step 3).
8. **Cards split, renderers shared** (§6.5), and **neither card nor the
   `lifi` adapter is allowed to synthesize or discard a step** (§6.4,
   B15). Every `isSwap()` conditional added in `3b97c68` is deleted
   rather than extended, and a multi-leg route renders every leg it was
   given, never a collapsed guess.
9. **Safety precedes reach** (§10). No coverage phase ships before the
   route path runs `runSafetyPipeline`. Widening from one chain to ~70
   while unprotected is the one sequencing error this spec exists to
   prevent.
10. **A missing `targetAllowlist` fails closed** (§4.6). It is the sole
    optional capability whose absence is restrictive, because every other
    absence degrades a feature while that one degrades safety.
11. **Simulation is defence in depth, not proof** (§8.6). `toAmountMin`
    remains the real protection; a passing simulation never licenses
    skipping the floor.
12. **Chain reach is ours, intersected with the provider's** (§4.7). The
    provider's list is an upper bound, never the offer. Our side stays
    API-driven (`Blockchain` rows), so adding a chain is a row and never
    a release, and the bridge matrix can never disagree with the app's
    own chain list.
13. **No hardcoded chain support, at any layer** (§4.8). Adapters query,
    tools validate against the live list, and the prompt names no chain
    id and no token address. Security allowlists are the deliberate
    exception and stay pinned, because tracking whatever the API says is
    the attack they exist to stop.
14. **The tools read the same list the cards render from** (§4.9). One
    source of truth, both trust anchors. Adding a chain is a database
    row, with no release on any of the three repos.
15. **USDC goes through CCTP, EURC through CCTP for non-USDC, everything
    else through aggregators** (§4.10). Two Circle products, two
    adapters, never one branch: different entry contracts, fee
    currencies, approval targets and chain sets.
16. **Any new CCTP work is V2.** V1 is switched off 2026-12-01 and Sui is
    still V1-only, so Sui USDC bridging is blocked pending Circle's V2
    deployment rather than built on V1 now (§4.10).
17. **Do not route Circle stablecoins through an aggregator to earn a
    fee** (§12.2). Monetize the long tail, where routing adds real value.
    A fee, if enabled, is always a visible line (§12.3).
18. **A price-impact acknowledgement carries the number, never a bare
    boolean** (§7.2). `price_impact_ack_bps` mirrors `min_receive_raw`:
    both are floors/ceilings the fresh re-quote must still clear, not a
    one-time checkbox.
19. **`from_address` is never a tool param, ever, on either tool** (§7.2).
    Always `context.wallet.address`. Stated as a rule, not left implicit,
    because it is exactly the field Tower's own `/bridge` got wrong.
20. **Symbol hints are advisory, checked, never trusted** (§7.2, §8.4 L1).
    They catch an honest model resolving the wrong token variant; they
    are not a security boundary against a malicious one, and a mismatch
    is a confirmation, never a silent block.
21. **A refund address is never a settable field, on either the tool
    schema or the wire type** (§7.2.2). For EURC it is hardcoded to
    `fromAddress` inside the `cctpx` adapter alone. The fix for this
    class of risk is having nothing to set, not a check on what was set.
22. **CCTP speed and forwarding are UI state, not model state** (§7.2.2,
    §5). They live on `RouteQuoteRequest`, re-quoted on toggle, and never
    appear in a tool schema.
23. **Arc App Kit is the chosen implementation inside `cctp`/`cctpx`, and
    remains adapter-internal, never an architectural dependency** (§4.11).
    We stay chain-agnostic and provider-agnostic by construction: swapping
    App Kit for a raw contract call, or for a different SDK entirely, is a
    one-file change because nothing outside the `cctp`/`cctpx` adapter
    ever imports it or sees which one is in use. Good DevX earned it a
    place *inside* the file; it does not get to leak outward.
24. **Confirmed by reading the shipped source, not by assumption:
    `kit.bridge()` blocks in-process for the full attestation wait on a
    Standard-speed transfer** (§4.11) — a plain `setTimeout`-based poll
    loop, budgeted up to 600 attempts, inside the same `await`. Calling it
    directly on-device for Standard speed is ruled out, not merely
    unconfirmed. Resolved architecture: run it as a backend job against a
    remote-signing `Account` that round-trips the unsigned payload to the
    device and never holds a key; Fast-speed transfers may still call it
    inline, on-device, since that block is only seconds.

### 11.2 Open, blocked on Tower

Sent to their team; answers change §3.2 only, not the architecture:

- units on `outputAmount` / `minOut` (docs say both 6-decimal and 1e18),
- an explicit `expiresAt` on quotes,
- explicit `approval.spender` / `approval.amountRaw` fields,
- a machine-readable `code` on errors,
- whether `routeOptions` entries can be passed to `build-tx` unchanged,
- whether `/bridge` will offer quote + unsigned-calldata + status,
- what the undocumented "Public frontend key" is allowed to do.
- whether Tower offers an integrator/referrer fee share (§12.1).

### 11.3 Genuinely unknown

- **Demand for swap outside Arc.** The shipped Play Store build predates
  much of this (`project_playstore_build_predates_stellar`), so there is
  no usage signal. Phase 1 is cheap enough that it does not need one.
- **Whether Arc gets a private-mempool story.** Until it does, §9.2 does
  not apply there.
- **Stellar swap.** No adapter reaches it; Stellar has native DEX
  semantics (path payments) that are a genuinely different shape. Out of
  scope here, and a candidate for its own adapter under §4.2.
---

## 12. Monetization — can we take a fee?

Short answer: **yes on aggregator routes; on CCTP routes it depends on
*how* the adapter is built** (§4.11) — raw contract calls give CCTP no fee
hook, but Circle's own App Kit wrapper adds one for USDC specifically.
This section states the mechanics and the constraints; the rate itself is
a product decision, not an engineering one.

### 12.0 ⚠️ Correction: USDC-via-CCTP is monetizable if the adapter is built on App Kit

**Verified against `docs.arc.io` 2026-09-26**, after §12.1 below was
already written stating flatly "burn-and-mint has no integrator hook."
That is only true of a hand-rolled `TokenMessengerV2` call. Circle's own
`@circle-fin/app-kit` (§4.11) adds an application-level fee step around
the raw CCTP flow:

- `kit.setCustomFeePolicy(policy)` — a fee **added on top of** the bridge
  amount (never deducted from it), split **90% to our fee recipient, 10%
  to Arc**, on the source chain.
- **EURC is explicitly excluded.** "CCTP for non-USDC tokens does not
  support custom bridge fees" — the `12.1` table's EURC row stands
  unchanged.
- Source-paid fees (`config.feePayment: "source"`) are **incompatible**
  with a custom fee — pick one or the other per route.

So the accurate matrix is: **EURC is unmonetizable in-protocol no matter
how the adapter is built. USDC is unmonetizable via a hand-rolled contract
call; it is monetizable, with a mandatory 10% cut to Arc, via App Kit** —
which §4.11 has since settled as the chosen implementation. A hand-rolled
call would have kept 100% of any USDC fee but required building and
reviewing the fee step ourselves (full §8 treatment, since it would be
our own code moving funds to a fee wallet); App Kit's fee step is audited
by Circle and ships free, at the cost of the automatic 10% share to Arc,
fixed and not per-route negotiable.

**This does not change §12.2's recommendation.** Whether CCTP fees pass
through App Kit or a hand-rolled call, the argument for leaving USDC/EURC
free stands on its own terms — it's about not charging on the wallet's
cheapest, most-trusted rail, not about whether a fee happens to be
possible. Treat this as new information for *if* that recommendation is
ever revisited, not a reason to revisit it now.

### 12.1 What each provider supports

| Provider | Integrator fee | Mechanism | Status here |
|---|---|---|---|
| **LI.FI** | ✅ native, **swap and bridge alike** | `fee` param on `getQuote` (fraction, e.g. `0.003` = 30 bps); forwarded to our fee wallet at execution time (§12.5) | wired at 0 via `LIFI_INTEGRATOR_FEE_BPS`, but **registration required first** (§12.1.1) |
| **Tower** | ❓ unknown | Tower already takes 30 bps in the input token to its own address | open question, §11.2 |
| **CCTP (USDC), raw call** | ❌ none | burn-and-mint has no integrator hook; Circle's own Standard fee is zero | not possible in-protocol |
| **CCTP (USDC), via App Kit** | ✅ **yes** (§12.0) | `setCustomFeePolicy`, added on top of the amount, 90/10 split | possible, if `execute()` is built on App Kit (§4.11) |
| **CCTP non-USDC (EURC)** | ❌ none, either way | fee is native gas paid to the protocol; App Kit explicitly excludes it too | not possible in-protocol |
| **Sui venues** | ❌ none | DeepBook/Cetus charge pool fees; no integrator slot | not possible in-protocol |

#### 12.1.1 ⚠️ LI.FI fees need registration, not just config

**Verified live 2026-09-26.** Setting `LIFI_INTEGRATOR_FEE_BPS` to a
non-zero value today **breaks every quote**, not just fee-bearing ones:

```
GET /v1/quote?…&integrator=takumipay&fee=0.003
→ 1011  Integrator "takumipay" is not configured for collecting fees.
        Please sign up on https://portal.li.fi/ and configure your fee wallet.
```

The identical error returns for cross-chain and same-chain requests, which
is the control that answers §12.6's open question: **the `fee` parameter
is accepted on same-chain swaps exactly as on bridges.** The rejection is
about integrator registration, not route topology. Swap volume is
monetizable on the same terms as bridge volume.

Prerequisites before the env var may be set anywhere:

1. register the `takumipay` integrator at `portal.li.fi`,
2. configure a fee wallet there,
3. verify a non-zero quote succeeds on **both** topologies,
4. only then raise the value, and only in an environment where step 3
   passed.

Treat a non-zero `LIFI_INTEGRATOR_FEE_BPS` as a **release blocker** until
step 3 is green. The failure mode is total loss of routing, not a missing
fee.

#### 12.1.2 LI.FI already charges 25 bps of its own

Every quote probed, same-chain and cross-chain, carries:

```
feeCosts: [{ name: "LIFI Fixed Fee", percentage: "0.0025", included: true }]
```

That is **LI.FI's** fee, not ours, and `included: true` means it is
already deducted from what the user receives. Two consequences:

- It sharpens §4.10. Routing USDC through LI.FI costs the user 25 bps that
  CCTP Standard Transfer does not charge at all. That gap is the concrete
  number behind "route Circle stablecoins directly", and it exists whether
  or not we ever add a fee of our own.
- **It must already be on screen.** Audit whether `toBridgeFees` surfaces
  an `included: true` fee or lets it vanish into the output amount. A fee
  the user pays and cannot see is the §12.3 rule being broken by a
  provider rather than by us.

### 12.2 The tension with §4.10

Routing USDC and EURC directly through CCTP is the **cheapest path for the
user and the only unmonetizable one for us.** Those are also our highest
volume assets. Stated plainly so the trade is made deliberately rather
than discovered later:

| Route | Best for user | Monetizable |
|---|---|---|
| USDC / EURC via CCTP | ✅ free or near-free | ❌ |
| USDC via an aggregator | ❌ pays a spread | ✅ |
| Everything else via aggregator | ✅ best available | ✅ |

**Recommendation: keep §4.10 as written.** Do not route Circle stablecoins
through an aggregator in order to earn a fee. A payments wallet whose
cheapest asset is deliberately routed expensively is a wallet whose
routing cannot be trusted, and the user can verify the comparison in
seconds. Monetize the long tail, where we genuinely add routing value.

### 12.3 Rules if a fee is switched on

These are non-negotiable regardless of the rate chosen:

1. **Always visible.** A fee appears as its own line in the §6 breakdown
   with a real amount, never folded into the output. This is already
   decided in bridge spec §10.2, and `lifi.adapter.ts` implements it by
   emitting an `integrator` fee line whenever the bps is non-zero.
2. **Never inside `toAmountMin` without disclosure.** The floor the user
   approves must be the floor after all fees, so the number on screen is
   the number they receive.
3. **Server-side only.** The rate is config, never a tool argument and
   never model-supplied. It follows the same rule as slippage (§1).
4. **Disclosed in a fee schedule**, not only in the transaction. A
   payments product needs a stable place that names the fee.
5. **Zero on zero-fee rails.** If CCTP is free, the card says free. Adding
   our own charge on top of a free protocol rail is the fastest way to
   lose the trust that §4.10 buys.
6. **Never on refunds or failures.** A `refunded` outcome returns the full
   amount.

### 12.4 Where a fee could be taken if CCTP routes must be monetized

If product later requires revenue on Circle-asset routes, there are three
options and they are not equal:

- **A separate transfer before the burn.** Honest and simple: the user
  signs one extra transfer, and it is visible. Costs an extra transaction
  and its gas, which on Ethereum can exceed the fee.
- **A CCTP hook on the destination.** `depositForBurnWithHook` /
  `autoExecuteHookData` can execute logic on arrival, including routing a
  cut. More elegant, materially more complex, and it puts our contract in
  the path of the user's funds, which brings §8's whole threat model onto
  code we wrote.
- **Spread on the quote.** Quoting slightly worse than achievable.
  **Rejected.** It is undisclosed by construction and indistinguishable
  from a routing failure.

The first is the only one worth considering before there is volume to
justify the second.

### 12.5 Fee custody and sweep mechanics

**Verified against LI.FI primary docs 2026-09-26**
(`docs.li.fi/introduction/integrating-lifi/monetizing-integration`,
`/fee-forwarder`).

If a fee is enabled, the first question is not "how much" but **"where
does it land, and who holds that key"**. For a product whose entire
security posture is *we never hold user funds*, a fee wallet is the first
place we hold anything at all, and §8's threat model starts applying to
infrastructure we operate.

#### 12.5.1 Where the money actually goes

| | Behaviour |
|---|---|
| Destination | A **fee wallet we designate** at `portal.li.fi`. Our address, our keys. LI.FI never custodies it. |
| Currency | The **source token** of the user's transaction. |
| Chain | The **source chain** of the user's transaction. |
| Timing | Forwarded **inside the user's transaction**, at execution time. No claim step. |
| EVM mechanism | `FeeForwarder` contract, emitting `FeesForwarded(token, FeeDistribution[])`. |
| Solana / Sui / Bitcoin | Sent directly to the fee wallet. |
| Legacy fallback | On chains without `FeeForwarder`, the old `FeeCollector` accrues and **must be withdrawn** through LI.FI's per-chain withdrawal endpoints. |
| LI.FI's cut | *"LI.FI will receive a percentage share of the collected fees depending on the use case and volume."* Rate unpublished: a commercial negotiation, not a plannable number. |

Two consequences worth stating plainly, because both are easy to discover
too late:

- **Changing the fee wallet is not retroactive.** Only transactions after
  the change reach the new address, so a key rotation needs a planned
  cutover, not a portal edit.
- **The fallback path is silent.** A chain without `FeeForwarder` accrues
  instead of forwarding, with no error. Revenue can be sitting in a
  contract while the dashboards look normal.

#### 12.5.2 The dust problem is the real cost

> Fees are collected **on every chain and for every token individually.**

There is no consolidation at collection time. A 30 bps fee on a user
swapping a long-tail token on Linea arrives as **that token, on Linea**.
Across the chain set §4.10 opens up, the result is a wide, shallow spread
of balances in assets we never chose to hold.

This inverts the usual intuition: the fee is easy to *charge* and
expensive to *collect*. Below a per-chain, per-token threshold the gas to
move a balance exceeds the balance, so that revenue is economically
unreachable and should be treated as zero rather than booked as an asset.

Design implications:

1. **Set a sweep threshold per chain**, denominated in USD, below which
   nothing is moved. Expect a long tail that never crosses it.
2. **Forecast on reachable revenue, not gross collected.** A projection
   built on gross will overstate by whatever fraction sits in dust.
3. **Prefer fees on routes whose source token is already liquid.** In
   practice this means the fee is worth most on exactly the high-volume
   stablecoin routes that §4.10 sends to CCTP for free. That is an
   uncomfortable fact and it belongs in the decision, not after it.

#### 12.5.3 Security posture for the fee wallet

The fee wallet is a **company treasury address with continuous inbound
value on many chains**. It is not a user wallet and must not be derived
from, or stored alongside, anything in the app.

Requirements:

- **Never in the mobile app.** No key, no mnemonic, no signing path ships
  in the client. The app's only knowledge of the fee is the *number on the
  card* (§12.3).
- **Cold receive, hot sweep.** The address that receives should not be the
  address that spends. Receive to an address whose key is held offline or
  in a multisig; sweep with a separate operational key that holds nothing
  at rest.
- **Multisig or MPC for anything above a stated balance.** A single EOA
  accumulating unbounded inbound value across ~70 chains is the kind of
  target that gets found.
- **Monitoring, not trust.** Alert on inbound volume deviating from
  expected fee volume. A mismatch means either a misconfigured rate or
  someone else's transactions being attributed to us.
- **Address is config, never a constant.** It changes without a release,
  the same rule as §4.8. And because a wrong value silently redirects
  revenue, it is a **reviewed** config change with a second approver.
- **Document it as a held asset.** The claim "we never hold funds" stays
  true of *user* funds and becomes false of company funds. Public copy and
  security documentation must not overstate.

#### 12.5.4 Sweep mechanics

A deliberately boring design:

1. **Accumulate** at the receive address. No automation touches it.
2. **Periodically evaluate** per chain and per token against the USD
   threshold from §12.5.2.
3. **Sweep** balances over threshold to a treasury chain. Swapping dust to
   a stable asset before bridging is usually cheaper than bridging each
   token.
4. **Reconcile** against LI.FI's Partner Portal figures. A persistent gap
   means the silent `FeeCollector` fallback (§12.5.1) is in play on some
   chain and needs a manual withdrawal.
5. **Record** at time of receipt in the received asset, for accounting.

This is an **ops runbook, not app code.** Nothing in `mobile-app`, `api`
or `agent-api` needs to know the fee wallet exists beyond the disclosure
line on the card. Keep it that way: the moment sweeping logic lives in the
product, a treasury key has a path into a user-facing service.

#### 12.5.5 Decide before enabling anything

Engineering cannot answer these, and they gate the work rather than follow
it:

- [ ] LI.FI's actual revenue-share rate, in writing.
- [ ] Who controls the fee wallet key, and under what approval process.
- [ ] Multisig or MPC choice, and the balance threshold that triggers it.
- [ ] The fee rate itself, and whether it differs by route class.
- [ ] Regulatory review of charging a fee in the Indonesian payments
      context (§12.6), including how fee revenue in volatile assets is
      recognised.
- [ ] Public fee schedule copy (§12.3 rule 4).

Until every box is ticked, `LIFI_INTEGRATOR_FEE_BPS` stays `0` and a
non-zero value remains a release blocker (§12.1.1).

### 12.6 Open

- Tower referrer or fee-share programme: asked, not answered (§11.2).
- ~~Whether LI.FI's integrator fee applies to same-chain swaps.~~
  **Answered 2026-09-26: yes.** Same-chain and cross-chain requests fail
  identically when the integrator is unregistered, proving the parameter
  is topology-independent (§12.1.1).
- Regulatory review of charging a fee in the Indonesian payments context
  is outside this spec and is a prerequisite to switching anything on.
