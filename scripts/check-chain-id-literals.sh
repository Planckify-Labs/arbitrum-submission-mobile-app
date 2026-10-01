#!/usr/bin/env bash
# check-chain-id-literals.sh
#
# Sibling of check-chain-agnostic.sh for swap spec §4.8: chain SUPPORT is
# API-driven (a `Blockchain` row), so shared code must not carry chain-id
# literals: no `"eip155:<n>"` strings and no `chainId === <n>` comparisons.
# Every hardcode the spec's audit found was added by someone who knew the
# rule and had a good local reason; without a guardrail the rule decays.
#
# Two categories are LEGITIMATE and belong in `services/`, not here:
#   - protocol identity constants (a provider's private chain numbering,
#     a gas token's fixed system address), inside the adapter / kit;
#   - security allowlists (pinned routers, trusted relays), which must NOT
#     track the API because tracking it is the attack.
# So this scans the shared UI roots plus the route surface, and each
# allowlisted file states which category it is, or that it is known debt.
#
# Run via `pnpm check:chains`. Exits 0 on clean, 1 with offending lines.
set -euo pipefail

SEARCH_ROOTS=(components hooks app services/bridgeRoutes services/agent-executors/defi)

PATTERN='["'"'"'`]eip155:[0-9]+["'"'"'`]|(chainId|chain\.id|chain_id)[[:space:]]*===?[[:space:]]*[0-9]+\b'

ALLOWLIST=(
  # Display-name fallback for approval surfaces, which see only raw tool
  # args. Naming, not support: an unknown chain falls back to its id.
  "components/home/TakumiAgent/StructuredUI/approvalSummary.ts"

  # "You receive native USDC" badge scoped to Arc: a product decision
  # (commit 92fe56e). Known debt: should read the destination row's
  # native-currency token instead.
  "components/home/TakumiAgent/StructuredUI/cards/BridgeQuoteCard.tsx"

  # Route fallback only (the backend stamps the provider on every quote);
  # mirrors the api Tower table, which cannot be derived from Tower's
  # `/chains` yet (swap spec §4.8 B12 note).
  "services/bridgeRoutes/adapters/towerAdapter.ts"
)

if ! command -v rg >/dev/null 2>&1; then
  echo "check-chain-id-literals: ripgrep (rg) not found; skipping." >&2
  exit 0
fi

EXCLUDES=()
for f in "${ALLOWLIST[@]}"; do
  EXCLUDES+=("--glob" "!$f")
done

# Comments may cite ids as examples; only code is checked.
HITS=$(rg --no-heading --line-number -e "$PATTERN" "${SEARCH_ROOTS[@]}" \
  --glob '!**/*.test.ts' \
  --glob '!**/*.test.tsx' \
  "${EXCLUDES[@]}" \
  | grep -vE '^[^:]+:[0-9]+:[[:space:]]*(//|\*|/\*)' || true)

if [ -n "$HITS" ]; then
  echo "check-chain-id-literals: chain-id literals in shared code (swap spec §4.8):" >&2
  echo "$HITS" >&2
  echo >&2
  echo "Chains come from Blockchain rows. Resolve through the chain list, or, for a" >&2
  echo "protocol constant / security allowlist, keep it inside the adapter or kit." >&2
  exit 1
fi

echo "chain-id literal check: OK"
