#!/usr/bin/env bash
# Simulated service error storm for monitor-tool scenario testing.
#
# Real-world shape: a backend service runs fine, then its database goes away
# and every worker logs an ERROR at once — a burst a few milliseconds apart —
# before the pool gives up and the process dies. This is the canonical
# payload for the plugin's two burst-handling features:
#
#   - coalesce_ms: matching lines arriving inside the window merge into ONE
#     notification ("[N lines coalesced]", first 10 shown, rest suppressed)
#   - token bucket: without coalescing, a 31-line burst lands 5 wakes
#     (burst), the rest are dropped and counted in events_dropped
#
# Output shape (bash builtins write per call, so output is never buffered):
#
#     service up: listening on :8080 (workers=8, pid 12345)     <- healthy start
#     ...2s of silence...
#     ERROR [worker 3] ConnectionRefusedError: db:5432 (attempt 1, backoff 812ms)
#     ...30 lines, 30ms apart, colored red...
#     FATAL: worker pool exhausted after 30 connection errors, shutting down
#     (exit 1)
#
# Suggested monitor calls (the pair is the point — run both, compare):
#   A. merge the storm — the recommended production posture:
#     monitor(command="bash test/storm-sim.sh",
#             description="payments-api logs",
#             pattern="ERROR|FATAL", coalesce_ms=1500)
#   B. no coalescing — observe the raw token bucket:
#     monitor(command="bash test/storm-sim.sh",
#             description="payments-api logs",
#             pattern="ERROR|FATAL")
#
# What a correct plugin does:
#   A: one wake "[31 lines coalesced]" + lifecycle "monitor failed: Exit code 1";
#      events_sent=1, events_dropped=0
#   B: 5 wakes delivered, then the rest throttled away (events_dropped climbs,
#      plugin log records "throttled lines dropped so far: N");
#      lines_matched=31 in BOTH cases (matching happens before throttling);
#      the FATAL line may itself be throttled in B — the lifecycle notice is
#      what guarantees the exit status still reaches the agent
#
# Usage:
#   bash storm-sim.sh [--errors 30] [--interval 0.03] [--up-seconds 2] [--seed 7]
set -u

ERRORS=30
INTERVAL=0.03
UP_SECONDS=2
SEED=7

while [[ $# -gt 0 ]]; do
  case "$1" in
    --errors)     ERRORS="$2";     shift 2 ;;
    --interval)   INTERVAL="$2";   shift 2 ;;
    --up-seconds) UP_SECONDS="$2"; shift 2 ;;
    --seed)       SEED="$2";       shift 2 ;;
    *) echo "unknown option: $1 (usage: [--errors N] [--interval S] [--up-seconds S] [--seed S])" >&2; exit 64 ;;
  esac
done
RANDOM=$SEED

RED=$'\033[31m'; GREEN=$'\033[32m'; RESET=$'\033[0m'

# Healthy phase: exactly one non-matching line, then silence.
printf '%sservice up: listening on :8080 (workers=8, pid %s)%s\n' \
  "$GREEN" "$$" "$RESET"
sleep "$UP_SECONDS"

# The storm: --errors lines on stderr, --interval seconds apart, red.
for ((i = 1; i <= ERRORS; i++)); do
  printf '%sERROR [worker %d] ConnectionRefusedError: db:5432 (attempt %d, backoff %dms)%s\n' \
    "$RED" "$((RANDOM % 8))" "$i" "$((RANDOM % 900 + 100))" "$RESET" >&2
  sleep "$INTERVAL"
done

printf '%sFATAL: worker pool exhausted after %s connection errors, shutting down%s\n' \
  "$RED" "$ERRORS" "$RESET" >&2
exit 1
