#!/usr/bin/env bash
# check-no-raw-error-ui.sh
#
# Fails when UI-layer code (app/, components/, hooks/) reads the raw text of
# an error (`err.message`, `String(err)`) outside a dev-only log, or when an
# agent executor builds an `ExecutorError` message from raw error text.
#
# Why: library errors embed endpoints (ky: "Request timed out: GET https://
# <api host>/<path>", viem: "URL: https://<rpc>"), and end users must never
# see them. UI strings are hand-written; raw detail goes to `__DEV__` logs.
# Executor `reason`s also reach the LLM and the chat, so they follow the same
# rule. See CLAUDE.md "User-facing errors".
#
# A line is accepted when it is a comment, sits within 4 lines after a
# `__DEV__` / `console.` mention, or carries `// safe-error-ok: <reason>`.
#
# Run via `pnpm check:chains` (chained) or directly.
set -euo pipefail

UI_ROOTS=(app components hooks)
EXEC_ROOT=services/agent-executors

UI_PATTERN='(^|[^A-Za-z0-9_])(e|err|error|[A-Za-z]*(Error|Err))[?]?[.]message([^A-Za-z0-9_]|$)|String[(](e|err|error)[)]'

fail=0

scan_ui() {
  find "${UI_ROOTS[@]}" -type f \( -name '*.ts' -o -name '*.tsx' \) \
    ! -name '*.test.*' ! -name '*.spec.*' -print0 |
    PAT="$UI_PATTERN" xargs -0 awk '
      FNR == 1 { dev = -100 }
      /__DEV__|console\./ { dev = FNR }
      $0 ~ ENVIRON["PAT"] {
        if ($0 ~ /^[[:space:]]*(\/\/|\*|\/\*)/) next
        if ($0 ~ /safe-error-ok/) next
        if (FNR - dev <= 4) next
        printf "%s:%d: %s\n", FILENAME, FNR, $0
      }
    '
}

scan_executors() {
  find "$EXEC_ROOT" -type f -name '*.ts' ! -name '*.test.*' -print0 |
    xargs -0 awk '
      FNR == 1 { ctor = -100 }
      /new ExecutorError\(/ { ctor = FNR }
      /err[.]message|String[(]err[)]/ {
        if ($0 ~ /^[[:space:]]*(\/\/|\*)/) next
        if ($0 ~ /safe-error-ok/) next
        if (FNR - ctor <= 4 && $0 ~ /`|\$\{/) {
          printf "%s:%d: %s\n", FILENAME, FNR, $0
        }
      }
    '
}

ui_hits=$(scan_ui || true)
exec_hits=$(scan_executors || true)

if [ -n "$ui_hits" ]; then
  echo "Raw error text read in UI-layer code (use fixed copy; log raw in __DEV__):"
  echo "$ui_hits"
  fail=1
fi
if [ -n "$exec_hits" ]; then
  echo "ExecutorError message built from raw error text (use a curated token + logExecutorDetail):"
  echo "$exec_hits"
  fail=1
fi

exit $fail
