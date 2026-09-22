#!/usr/bin/env bash
# Scenario regression: run the five real-world payload sims
# (build / testsuite / logstorm / etl / deploy) through a real OpenCode
# session and assert the plugin behaved correctly end to end.
#
#   S1  build success   pattern filter, checkpoint wakes, exit 0 -> completed,
#                       7 content wakes, 0 dropped
#   S2  build failure   mid-run FAILED wake + BUILD FAILED wake, exit 2
#                       mapped to failed: Exit code 2
#   S3  test suite      per-failure wakes while the suite still runs,
#                       summary wake, exit 1
#   S4  error storm     coalesce_ms 500: 30 ERROR lines -> 1 batched wake +
#                       separate FATAL wake (batch must not swallow the tail)
#   S5  etl pipeline    stage checkpoints + mid-run ANOMALY wakes, exit 0
#   S6  rollout crash   WARNING/FAILED wakes, exit 1, and the `directory`
#                       parameter sets the command cwd
#
# Assertions are made against the plugin log (authoritative) plus the agent
# transcript (PASS tokens, quoted counters). Every scenario also checks for
# orphan processes.
#
# Timing note (same caveat as m1/m2): the headless `opencode run` CLI exits
# once the session goes idle, so the sims default to ~1s gaps between
# wake-worthy lines — notifications then queue while the model is mid-turn.
# Longer gaps are for manual TUI runs (pass --gap-ms to the sims).
#
# Plugin loading uses the project-level auto-load dir (.opencode/plugins/)
# because absolute paths inside the "plugins" config array are silently
# ignored on some V2 builds (observed on v2.0.10).
#
# Usage: bash test/scenario-verify.sh <model>   # provider/model id, from "opencode models"
set -uo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODEL="${1:?usage: bash test/scenario-verify.sh <model> — provider/model id (list with: opencode models)}"
BASE="/tmp/opencode/scenario"
LOG="${TMPDIR:-/tmp}/opencode/opencode-monitor-task.log"

PASS_COUNT=0
FAIL_COUNT=0
FAILED_SCENARIOS=()

note()  { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
pass()  { printf '  \033[32mPASS\033[0m %s\n' "$*"; PASS_COUNT=$((PASS_COUNT+1)); }
fail()  { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAIL_COUNT=$((FAIL_COUNT+1)); FAILED_SCENARIOS+=("$*"); }

install_plugin() {  # $1 = test dir
  local dir="$1/.opencode/plugins/opencode-monitor-task"
  mkdir -p "$dir"
  cp -r "$PLUGIN_DIR/src" "$dir/src"
  cp "$PLUGIN_DIR/package.json" "$dir/package.json"
  cat > "$dir/index.ts" <<'EOF'
export { default } from "./src/index"
EOF
}

run_opencode() {  # $1 = test dir, $2 = prompt
  (cd "$1" && timeout 300 opencode run --standalone --auto --model "$MODEL" "$2" 2>&1 | tee "$1/run-output.txt")
  return "${PIPESTATUS[0]}"
}

# Content (non-lifecycle) delivered lines in the current log slice.
content_delivered() {
  grep '] delivered ' "$LOG" | grep -vc 'monitor \(completed\|stopped\|failed\)' || true
}

# $1 = scenario tag, $2 = pgrep fragment for the sim script
no_orphan() {
  if pgrep -f "$2" >/dev/null; then
    fail "$1: orphan process remains: $(pgrep -af "$2" | tr '\n' ' ')"
  else
    pass "$1: no orphan processes"
  fi
}

mkdir -p "$(dirname "$BASE")"

# ---------------------------------------------------------------- scenario S1
note "Scenario S1: build success — pattern filter + checkpoint wakes + exit 0"
DIR="$BASE/s1"; rm -rf "$DIR"; mkdir -p "$DIR"; install_plugin "$DIR"
cp "$PLUGIN_DIR/test/build-sim.sh" "$DIR/"
: > "$LOG"

PROMPT_S1='Use only the monitor tool for background work. Start ONE monitor with exactly this command: bash /tmp/opencode/scenario/s1/build-sim.sh — exactly this pattern: STAGE \d+/\d+|BUILD (SUCCESS|FAILED) — and description: s1 build success. After it starts, reply: watching — then wait. Each time a <task-notification> wakes you, acknowledge it in one short line, then wait again. When the completion notification arrives, call monitor_list once and report in one line the events_sent, events_dropped, lines_scanned and lines_matched of this monitor. Then reply with exactly: M3S1-PASS'
run_opencode "$DIR" "$PROMPT_S1"

grep -q "M3S1-PASS" "$DIR/run-output.txt" && pass "agent completed S1 flow (M3S1-PASS)" || fail "S1: M3S1-PASS missing"
grep -F 'finalized state=completed exit="exit code 0"' "$LOG" >/dev/null \
  && pass "final state completed / exit code 0" || fail "S1: completed finalize not seen in log"
grep -F '] delivered ' "$LOG" | grep -F 'BUILD SUCCESS' >/dev/null \
  && pass "BUILD SUCCESS wake delivered" || fail "S1: BUILD SUCCESS wake not delivered"
SENT="$(content_delivered)"
[[ "$SENT" == 7 ]] && pass "exactly 7 content wakes (6 stages + verdict)" || fail "S1: expected 7 content wakes, got $SENT"
grep -q 'throttled lines dropped' "$LOG" \
  && fail "S1: unexpected throttled drops" || pass "0 dropped (throttle never engaged)"
no_orphan S1 "scenario/s1/build-sim"

# ---------------------------------------------------------------- scenario S2
note "Scenario S2: build failure — FAILED wakes mid-run + exit 2 mapping"
DIR="$BASE/s2"; rm -rf "$DIR"; mkdir -p "$DIR"; install_plugin "$DIR"
cp "$PLUGIN_DIR/test/build-sim.sh" "$DIR/"
: > "$LOG"

PROMPT_S2='Use only the monitor tool for background work. Start ONE monitor with exactly this command: bash /tmp/opencode/scenario/s2/build-sim.sh --fail-at lint — exactly this pattern: STAGE \d+/\d+|BUILD (SUCCESS|FAILED) — and description: s2 build failure. After it starts, reply: watching — then wait. Each time a <task-notification> wakes you, acknowledge it in one short line, then wait again. When a notification reports the monitor failed with a non-zero exit code, call monitor_list once and report in one line the state and exit_info of this monitor. Then reply with exactly: M3S2-PASS'
run_opencode "$DIR" "$PROMPT_S2"

grep -q "M3S2-PASS" "$DIR/run-output.txt" && pass "agent completed S2 flow (M3S2-PASS)" || fail "S2: M3S2-PASS missing"
grep -F 'STAGE 4/6 lint FAILED' "$LOG" >/dev/null \
  && pass "mid-run stage-FAILED wake delivered" || fail "S2: STAGE 4/6 lint FAILED wake not delivered"
grep -F 'BUILD FAILED at stage lint' "$LOG" >/dev/null \
  && pass "BUILD FAILED wake delivered" || fail "S2: BUILD FAILED wake not delivered"
grep -F 'finalized state=failed exit="Exit code 2"' "$LOG" >/dev/null \
  && pass "exit 2 mapped to failed: Exit code 2" || fail "S2: Exit code 2 finalize not seen in log"
grep -F 'monitor failed: Exit code 2' "$LOG" >/dev/null \
  && pass "final notification carries exit status" || fail "S2: final notification w/ exit status missing"
no_orphan S2 "scenario/s2/build-sim"

# ---------------------------------------------------------------- scenario S3
note "Scenario S3: test suite — per-failure wakes while suite still running"
DIR="$BASE/s3"; rm -rf "$DIR"; mkdir -p "$DIR"; install_plugin "$DIR"
cp "$PLUGIN_DIR/test/testsuite-sim.sh" "$DIR/"
: > "$LOG"

PROMPT_S3='Use only the monitor tool for background work. Start ONE monitor with exactly this command: bash /tmp/opencode/scenario/s3/testsuite-sim.sh — exactly this pattern: not ok|SUITE (PASSED|FAILED) — and description: s3 suite failures. After it starts, reply: watching — then wait. Failed tests will wake you while the suite is still running: acknowledge each failed test in one short line, then keep waiting. After the suite summary notification and the exit notification, call monitor_list once and report in one line the events_sent and events_dropped of this monitor. Then reply with exactly: M3S3-PASS'
run_opencode "$DIR" "$PROMPT_S3"

grep -q "M3S3-PASS" "$DIR/run-output.txt" && pass "agent completed S3 flow (M3S3-PASS)" || fail "S3: M3S3-PASS missing"
NOT_OK="$(grep -c 'delivered mon_[a-z0-9]* \[queue\]: not ok' "$LOG" || true)"
[[ "$NOT_OK" == 2 ]] && pass "both failing tests woke the agent mid-run" || fail "S3: expected 2 'not ok' wakes, got $NOT_OK"
grep -F '] delivered ' "$LOG" | grep -F '# SUITE FAILED' >/dev/null \
  && pass "suite summary wake delivered" || fail "S3: SUITE FAILED summary wake not delivered"
grep -F 'finalized state=failed exit="Exit code 1"' "$LOG" >/dev/null \
  && pass "exit 1 mapped to failed: Exit code 1" || fail "S3: Exit code 1 finalize not seen in log"
SENT="$(content_delivered)"
[[ "$SENT" == 3 ]] && pass "exactly 3 content wakes (2 failures + summary)" || fail "S3: expected 3 content wakes, got $SENT"
no_orphan S3 "scenario/s3/testsuite-sim"

# ---------------------------------------------------------------- scenario S4
note "Scenario S4: error storm — coalesce 30 ERROR lines into 1 wake + FATAL tail"
DIR="$BASE/s4"; rm -rf "$DIR"; mkdir -p "$DIR"; install_plugin "$DIR"
cp "$PLUGIN_DIR/test/logstorm-sim.sh" "$DIR/"
: > "$LOG"

PROMPT_S4='Use only the monitor tool for background work. Start ONE monitor with exactly this command: bash /tmp/opencode/scenario/s4/logstorm-sim.sh — exactly this pattern: ERROR|FATAL — with coalesce_ms 500 — and description: s4 error storm. After it starts, reply: watching — then wait. The ERROR burst will arrive as one coalesced notification: when it wakes you, quote its bracket header such as [30 lines coalesced] and its suppressed-lines note in one short line. When the FATAL notification wakes you, acknowledge it in one short line. After the notification reporting the monitor failed (exit code 1), call monitor_list once and report in one line the events_sent and events_dropped of this monitor. Then reply with exactly: M3S4-PASS'
run_opencode "$DIR" "$PROMPT_S4"

grep -q "M3S4-PASS" "$DIR/run-output.txt" && pass "agent completed S4 flow (M3S4-PASS)" || fail "S4: M3S4-PASS missing"
grep -F '[30 lines coalesced]' "$LOG" >/dev/null \
  && pass "30 ERROR lines merged into one batched wake" || fail "S4: coalesced batch not seen in log"
grep -Eq 'lines coalesced|suppressed' "$DIR/run-output.txt" \
  && pass "agent saw coalesce header / suppression note" || fail "S4: agent did not quote the coalesce batch"
FATAL_SENT="$(grep -c 'delivered mon_[a-z0-9]* \[queue\]: FATAL' "$LOG" || true)"
[[ "$FATAL_SENT" == 1 ]] && pass "FATAL tail delivered as its own wake (not swallowed)" || fail "S4: expected 1 FATAL wake, got $FATAL_SENT"
grep -F 'finalized state=failed exit="Exit code 1"' "$LOG" >/dev/null \
  && pass "exit 1 mapped to failed: Exit code 1" || fail "S4: Exit code 1 finalize not seen in log"
SENT="$(content_delivered)"
[[ "$SENT" == 2 ]] && pass "exactly 2 content wakes (storm batch + FATAL)" || fail "S4: expected 2 content wakes, got $SENT"
no_orphan S4 "scenario/s4/logstorm-sim"

# ---------------------------------------------------------------- scenario S5
note "Scenario S5: etl pipeline — stage checkpoints + mid-run ANOMALY wakes"
DIR="$BASE/s5"; rm -rf "$DIR"; mkdir -p "$DIR"; install_plugin "$DIR"
cp "$PLUGIN_DIR/test/etl-sim.sh" "$DIR/"
: > "$LOG"

PROMPT_S5='Use only the monitor tool for background work. Start ONE monitor with exactly this command: bash /tmp/opencode/scenario/s5/etl-sim.sh — exactly this pattern: STAGE .* complete|ANOMALY|ETL COMPLETE — and description: s5 etl pipeline. After it starts, reply: watching — then wait. Stage completions and ANOMALY lines wake you: acknowledge each in one short line and flag ANOMALY lines as data-quality incidents. After the completion notification, call monitor_list once and report in one line the lines_scanned and lines_matched of this monitor. Then reply with exactly: M3S5-PASS'
run_opencode "$DIR" "$PROMPT_S5"

grep -q "M3S5-PASS" "$DIR/run-output.txt" && pass "agent completed S5 flow (M3S5-PASS)" || fail "S5: M3S5-PASS missing"
ANOM="$(grep -c 'delivered mon_[a-z0-9]* \[queue\]: ANOMALY' "$LOG" || true)"
[[ "$ANOM" == 2 ]] && pass "both ANOMALY incidents woke the agent mid-run" || fail "S5: expected 2 ANOMALY wakes, got $ANOM"
grep -F '] delivered ' "$LOG" | grep -F 'ETL COMPLETE' >/dev/null \
  && pass "ETL COMPLETE wake delivered" || fail "S5: ETL COMPLETE wake not delivered"
grep -F 'finalized state=completed exit="exit code 0"' "$LOG" >/dev/null \
  && pass "final state completed / exit code 0" || fail "S5: completed finalize not seen in log"
SENT="$(content_delivered)"
[[ "$SENT" == 7 ]] && pass "exactly 7 content wakes (4 stages + 2 anomalies + verdict)" || fail "S5: expected 7 content wakes, got $SENT"
no_orphan S5 "scenario/s5/etl-sim"

# ---------------------------------------------------------------- scenario S6
note "Scenario S6: rollout crash — WARNING/FAILED wakes + directory param cwd"
DIR="$BASE/s6"; rm -rf "$DIR"; mkdir -p "$DIR"; install_plugin "$DIR"
cp "$PLUGIN_DIR/test/deploy-sim.sh" "$DIR/"
: > "$LOG"

PROMPT_S6='Use only the monitor tool for background work. Start ONE monitor with exactly this command: bash /tmp/opencode/scenario/s6/deploy-sim.sh --crash — exactly this pattern: WARNING|READY|FAILED — and description: s6 rollout watch — and directory: /tmp/opencode/scenario/s6. After it starts, reply: watching — then wait. Acknowledge each wake in one short line. When a notification reports the monitor failed, call monitor_list once and report in one line the state and exit_info of this monitor. Then reply with exactly: M3S6-PASS'
run_opencode "$DIR" "$PROMPT_S6"

grep -q "M3S6-PASS" "$DIR/run-output.txt" && pass "agent completed S6 flow (M3S6-PASS)" || fail "S6: M3S6-PASS missing"
grep -F 'WARNING pod web-7d9f6b-3 crash-looping' "$LOG" >/dev/null \
  && pass "crash-loop WARNING wake delivered" || fail "S6: WARNING wake not delivered"
grep -F 'FAILED rollout stuck at 2/3' "$LOG" >/dev/null \
  && pass "rollback FAILED wake delivered" || fail "S6: FAILED wake not delivered"
grep -F 'finalized state=failed exit="Exit code 1"' "$LOG" >/dev/null \
  && pass "exit 1 mapped to failed: Exit code 1" || fail "S6: Exit code 1 finalize not seen in log"
grep -F ': started (pid' "$LOG" | grep -F "cwd /tmp/opencode/scenario/s6" >/dev/null \
  && pass "directory parameter set the command cwd" || fail "S6: cwd not set from directory param"
no_orphan S6 "scenario/s6/deploy-sim"

# ------------------------------------------------------------------ summary
note "Summary"
if pgrep -f 'scenario/s[1-6]/' >/dev/null; then
  fail "final sweep: leftover processes: $(pgrep -af 'scenario/s[1-6]/' | tr '\n' ' ')"
else
  pass "final sweep: no orphan processes across all scenarios"
fi
echo "  passed: $PASS_COUNT   failed: $FAIL_COUNT"
if (( FAIL_COUNT > 0 )); then
  printf '  failed checks:\n'
  printf '    - %s\n' "${FAILED_SCENARIOS[@]}"
  exit 1
fi
echo "  RESULT: ALL PASS"
