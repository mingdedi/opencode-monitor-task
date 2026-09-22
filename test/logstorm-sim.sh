#!/usr/bin/env bash
# Service log + error-storm simulator for monitor-tool scenario testing.
#
# Real-world shape: a busy service logs INFO/WARN noise; at some point a
# dependency degrades and it emits a rapid burst of ERROR lines followed by a
# FATAL line and a non-zero exit. Watching this WITHOUT coalesce_ms would burn
# the whole token budget on the storm; with coalesce_ms the burst collapses
# into one notification.
#
# Wake-worthy lines (target these with `pattern`):
#   ERROR db.pool acquire timeout (attempt k/N ...)  — the storm (30 lines)
#   FATAL db.pool exhausted; service shutting down    — the tail, exit 1
# Noise: INFO request lines and WARN cache lines.
#
# Suggested watch (the interesting one):
#   monitor(command="bash test/logstorm-sim.sh",
#           pattern="ERROR|FATAL", coalesce_ms=500,
#           description="payments-api prod log")
#
# Expected wake sequence with the suggested watch:
#   1. [30 lines coalesced] batch (10 shown + "(... 20 more lines suppressed)")
#   2. FATAL line (arrives after the coalesce window -> separate wake)
#   3. lifecycle: monitor failed: Exit code 1
#
# Usage: bash logstorm-sim.sh [--warmup 8] [--storm 30] [--gap-ms 250]
#   --fatal-delay-ms <n>  pause between storm end and FATAL (default 800;
#                         must exceed coalesce_ms to stay a separate wake)
set -euo pipefail

WARMUP=8
STORM=30
GAP_MS=250
FATAL_DELAY_MS=800
while [[ $# -gt 0 ]]; do
  case "$1" in
    --warmup)        WARMUP="${2:-8}"; shift 2 ;;
    --storm)         STORM="${2:-30}"; shift 2 ;;
    --gap-ms)        GAP_MS="${2:-250}"; shift 2 ;;
    --fatal-delay-ms) FATAL_DELAY_MS="${2:-800}"; shift 2 ;;
    *) echo "logstorm-sim: unknown flag: $1" >&2; exit 64 ;;
  esac
done

sleep_ms() { sleep "$(printf '%d.%03d' $(( $1 / 1000 )) $(( $1 % 1000 )))"; }

PATHS=(/v1/charge /v1/refund /v1/payout /v1/balance /healthz)

# Warm-up: normal traffic noise.
for i in $(seq 1 "$WARMUP"); do
  path=${PATHS[$(( i % ${#PATHS[@]} ))]}
  echo "INFO  req id=r-$((1000 + i)) ${path} 200 in $(( 8 + i ))ms"
  if (( i % 3 == 0 )); then
    echo "WARN  cache miss ratio 0.$(( 30 + i )) (threshold 0.40)"
  fi
  sleep_ms "$GAP_MS"
done

# The storm: N ERROR lines back-to-back, no gaps.
for k in $(seq 1 "$STORM"); do
  echo "ERROR db.pool acquire timeout (attempt ${k}/${STORM} backoff 200ms)"
done

sleep_ms "$FATAL_DELAY_MS"
echo "FATAL db.pool exhausted; service shutting down"
exit 1
