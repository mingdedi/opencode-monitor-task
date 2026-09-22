#!/usr/bin/env bash
# ETL / data-pipeline simulator for monitor-tool scenario testing.
#
# Real-world shape: a nightly pipeline moving rows through extract ->
# transform -> validate -> load. Progress chatter is routine, stage
# completions are checkpoints, and ANOMALY lines are data-quality incidents
# the agent should surface while the pipeline keeps running.
#
# Wake-worthy lines (target these with `pattern`):
#   STAGE <name> complete rows=<n> ...     — one per stage checkpoint
#   ANOMALY row <id> <reason> (quarantined) — mid-stage data incidents
#   ETL COMPLETE loaded=<n> anomalies=<n>   — exit 0
# Noise: per-chunk progress lines with row counts and percentages.
#
# Suggested watch:
#   monitor(command="bash test/etl-sim.sh",
#           pattern="STAGE .* complete|ANOMALY|ETL COMPLETE",
#           description="nightly orders etl")
#
# Usage: bash etl-sim.sh [--gap-ms 1000] [--anomalies 2]
set -euo pipefail

GAP_MS=1000
ANOMALIES=2
while [[ $# -gt 0 ]]; do
  case "$1" in
    --gap-ms)   GAP_MS="${2:-1000}"; shift 2 ;;
    --anomalies) ANOMALIES="${2:-2}"; shift 2 ;;
    *) echo "etl-sim: unknown flag: $1" >&2; exit 64 ;;
  esac
done

sleep_ms() { sleep "$(printf '%d.%03d' $(( $1 / 1000 )) $(( $1 % 1000 )))"; }

progress() { # $1 = stage name, rest = percents
  local stage="$1"; shift
  for p in "$@"; do
    echo "  ${stage} $(( 50000 * p / 100 ))/50000 rows (${p}%)"
    sleep_ms 150
  done
}

emit_anomaly() { # $1 = used-up counter for deterministic row ids
  case "$1" in
    0) echo "ANOMALY row 3412 customer_id=null (quarantined)" ;;
    1) echo "ANOMALY row 28711 amount=-42.00 negative (quarantined)" ;;
    *) echo "ANOMALY row $(( 1000 + $1 * 9997 )) malformed utf8 (quarantined)" ;;
  esac
}

T_START=$(date +%s%3N)
ANOM_USED=0

# --- extract ---------------------------------------------------------------
progress extract 24 58 86
echo "STAGE extract complete rows=50000 (src=orders_snapshot.csv)"
sleep_ms "$GAP_MS"

# --- transform --------------------------------------------------------------
progress transform 30 65 95
echo "STAGE transform complete rows=49973 (-27 dupes)"
sleep_ms "$GAP_MS"

# --- validate (anomalies land mid/after the stage) --------------------------
progress validate 40 80
echo "STAGE validate complete rows=49971 quarantined=${ANOMALIES}"
if (( ANOMALIES > 0 )); then
  sleep_ms "$GAP_MS"
  emit_anomaly "$ANOM_USED"; ANOM_USED=$(( ANOM_USED + 1 ))
  if (( ANOMALIES > 1 )); then
    sleep_ms "$GAP_MS"
    emit_anomaly "$ANOM_USED"; ANOM_USED=$(( ANOM_USED + 1 ))
  fi
fi
sleep_ms "$GAP_MS"

# --- load -------------------------------------------------------------------
progress load 50 90
echo "STAGE load complete rows=49971 (warehouse=analytics.orders)"
if (( ANOMALIES > 2 )); then
  # keep the --anomalies knob honest for manual experimentation
  for extra in $(seq 3 "$ANOMALIES"); do
    sleep_ms "$GAP_MS"
    emit_anomaly "$(( extra - 1 ))"
  done
fi
sleep_ms "$GAP_MS"

total_s=$(( ($(date +%s%3N) - T_START) / 1000 ))
echo "ETL COMPLETE loaded=49971 anomalies=${ANOMALIES} duration=${total_s}s"
