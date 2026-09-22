#!/usr/bin/env bash
# Test-suite runner simulator (TAP-ish output) for monitor-tool scenarios.
#
# Real-world shape: a long test suite streaming per-test results. Individual
# failures arrive while the suite is still running — the agent learns about
# them mid-flight instead of after the whole run, and the exit code confirms
# the final verdict.
#
# Wake-worthy lines (target these with `pattern`):
#   not ok <i> - <name> (<reason>)     — per failing test, mid-run
#   # SUITE PASSED: N/N in <s>s        — exit 0
#   # SUITE FAILED: M/N passed, ...    — exit 1
# Noise: passing "ok i - ..." lines and "# slow test:" comments.
#
# Suggested watch:
#   monitor(command="bash test/testsuite-sim.sh --fail-at 9,17",
#           pattern="not ok|SUITE (PASSED|FAILED)",
#           description="checkout integration suite")
#
# Usage: bash testsuite-sim.sh [--tests 24] [--fail-at 9,17] [--gap-ms 300]
set -euo pipefail

TESTS=24
FAIL_AT="9,17"
GAP_MS=300
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tests)   TESTS="${2:-24}"; shift 2 ;;
    --fail-at) FAIL_AT="${2:-}"; shift 2 ;;
    --gap-ms)  GAP_MS="${2:-300}"; shift 2 ;;
    *) echo "testsuite-sim: unknown flag: $1" >&2; exit 64 ;;
  esac
done

sleep_ms() { sleep "$(printf '%d.%03d' $(( $1 / 1000 )) $(( $1 % 1000 )))"; }

NAMES=(
  health.liveness health.readiness parser.empty_body parser.utf8_bom
  auth.login_ok auth.token_refresh auth.logout auth.scope_reject
  billing.prorate billing.invoice_id cart.add_item cart.remove_item
  cart.coupon_stack search.prefix search.fuzzy search.pagination
  upload.small upload.multipart upload.checksum notify.email
  notify.webhook_retry cache.hit_ratio cache.invalidation metrics.flush
)
REASONS=( "(expected 401, got 200)" "(timeout after 2000ms)" "(assert 3 == 4 rows)" )

declare -A FAILSET=()
if [[ -n "$FAIL_AT" ]]; then
  IFS=, read -ra _parts <<< "$FAIL_AT"
  for t in "${_parts[@]}"; do
    [[ -n "$t" ]] && FAILSET["${t//[[:space:]]/}"]=1
  done
fi

echo "1..${TESTS}"
T_START=$(date +%s%3N)
FAILED_NAMES=()
for i in $(seq 1 "$TESTS"); do
  name=${NAMES[$(( (i - 1) % ${#NAMES[@]} ))]}
  if [[ -n "${FAILSET[$i]:-}" ]]; then
    echo "not ok ${i} - ${name} ${REASONS[$(( (i - 1) % ${#REASONS[@]} ))]}"
    FAILED_NAMES+=("$name")
  else
    echo "ok ${i} - ${name}"
  fi
  if (( i % 6 == 0 )); then
    echo "# slow test: ${name} took 3.8s"
  fi
  sleep_ms "$GAP_MS"
done

total_s=$(( ($(date +%s%3N) - T_START) / 1000 ))
if (( ${#FAILED_NAMES[@]} == 0 )); then
  echo "# SUITE PASSED: ${TESTS}/${TESTS} in ${total_s}s"
  exit 0
fi
echo "# SUITE FAILED: $(( TESTS - ${#FAILED_NAMES[@]} ))/${TESTS} passed, ${#FAILED_NAMES[@]} failed (${FAILED_NAMES[*]})"
exit 1
