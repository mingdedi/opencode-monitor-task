#!/usr/bin/env bash
# Deployment / rollout health-watch simulator for monitor-tool scenarios.
#
# Real-world shape: `kubectl rollout status`-style polling. Readiness polls
# are routine noise; a crash-looping pod (WARNING) and the rollout verdict
# (READY / FAILED) are what the agent actually needs to react to.
#
# Wake-worthy lines (target these with `pattern`):
#   WARNING pod <pod> crash-looping (restart n/3); replacing
#   READY rollout complete: 3/3 replicas healthy ...   — exit 0
#   FAILED rollout stuck at 2/3 after ...              — exit 1
# Noise: "poll i/N: rollout status: x/3 replicas ready" lines.
#
# Suggested watch (failure path, the interesting one):
#   monitor(command="bash test/deploy-sim.sh --crash",
#           pattern="WARNING|READY|FAILED",
#           description="shop-app 1.4.2 rollout")
#
# Usage: bash deploy-sim.sh [--polls 10] [--gap-ms 500] [--crash]
set -euo pipefail

POLLS=10
GAP_MS=500
CRASH=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --polls)  POLLS="${2:-10}"; shift 2 ;;
    --gap-ms) GAP_MS="${2:-500}"; shift 2 ;;
    --crash)  CRASH=1; shift ;;
    *) echo "deploy-sim: unknown flag: $1" >&2; exit 64 ;;
  esac
done

sleep_ms() { sleep "$(printf '%d.%03d' $(( $1 / 1000 )) $(( $1 % 1000 )))"; }

# Readiness ramp: healthy run reaches 3/3 and exits early; crash run plateaus
# at 2/3 after a pod enters a crash loop at the midpoint poll.
healthy_ready=(1 1 2 2 3 3 3 3 3 3)
crash_ready=(1 2 2 2 2 2 2 2 2 2)
crash_poll=$(( (POLLS + 1) / 2 ))   # WARNING lands at the midpoint poll

T_START=$(date +%s%3N)
for i in $(seq 1 "$POLLS"); do
  if (( CRASH )); then
    ready=${crash_ready[$(( i - 1 ))]}
  else
    ready=${healthy_ready[$(( i - 1 ))]}
  fi
  echo "poll ${i}/${POLLS}: rollout status: ${ready}/3 replicas ready (image shop-app:1.4.2)"
  sleep_ms "$GAP_MS"

  if (( CRASH && i == crash_poll )); then
    echo "WARNING pod web-7d9f6b-3 crash-looping (restart 2/3); replacing"
    sleep_ms "$GAP_MS"
  fi
  if (( ! CRASH && ready >= 3 )); then
    total_s=$(( ($(date +%s%3N) - T_START) / 1000 ))
    echo "READY rollout complete: 3/3 replicas healthy in ${total_s}s (image shop-app:1.4.2)"
    exit 0
  fi
done

if (( CRASH )); then
  echo "FAILED rollout stuck at 2/3 after ${POLLS} polls; rolling back to shop-app:1.4.1"
  exit 1
fi
# Non-crash run that never converged within POLLS (POLLS < 5).
echo "FAILED rollout inconclusive after ${POLLS} polls"
exit 1
