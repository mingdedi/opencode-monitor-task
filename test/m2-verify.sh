#!/usr/bin/env bash
# M2 end-to-end verification: exercise the plugin inside a real OpenCode
# service, one scenario per P0 acceptance criterion.
#
#   A  criteria 1+7  startup latency + injection rejection + wake latency <2s
#   B  criteria 2    all three stop conditions + correct exit status
#   C  criteria 3    monitor_stop leaves no orphan processes
#   D  criteria 5    token-bucket throttle: burst 5, dropped count accurate
#   E  criteria 4+6  16 concurrent cap, 17th rejected, no orphans after exit
#
# Plugin loading uses the project-level auto-load dir (.opencode/plugins/)
# because absolute paths inside the "plugins" config array are silently
# ignored on some V2 builds (observed on v2.0.10).
#
# Usage: bash test/m2-verify.sh <model>   # provider/model id, from "opencode models"
set -uo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODEL="${1:?usage: bash test/m2-verify.sh <model> — provider/model id (list with: opencode models)}"
BASE="/tmp/opencode/m2"
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

# ---------------------------------------------------------------- scenario A
note "Scenario A: injection rejected + fast id + wake latency <2s (P0 #1 #7)"
DIR="$BASE/a"; rm -rf "$DIR"; mkdir -p "$DIR"; install_plugin "$DIR"
cat > "$DIR/stages.sh" <<'EOS'
#!/usr/bin/env bash
# 1s gaps: notifications queue while the model is mid-turn. (Known M1 finding:
# the headless `opencode run` CLI exits once the session goes idle, so late
# notifications would be lost with longer gaps; idle-wake itself was verified
# manually in TUI during M1.)
for i in 1 2 3; do
  echo "stage $i ts=$(date +%s%3N)"
  sleep 1
done
echo "all stages complete"
EOS
chmod +x "$DIR/stages.sh"
: > "$LOG"

PROMPT_A='Use only the monitor tool for background work. Step 1: call monitor with exactly this command: echo $(whoami) — it should be REJECTED; note the rejection reason in one short line. Step 2: call monitor with command: bash /tmp/opencode/m2/a/stages.sh and description "m2 stages". Step 3: reply with the returned monitor id (starts with mon_) in one short line, then wait. Each time a <task-notification> wakes you, acknowledge that stage in one short line, then wait again. When a notification reports the monitor completed (exit code 0), reply with exactly: M2A-PASS'
run_opencode "$DIR" "$PROMPT_A"

grep -q "mon_" "$DIR/run-output.txt" && pass "monitor id returned to agent" || fail "A: no monitor id in output"
grep -q "M2A-PASS" "$DIR/run-output.txt" && pass "agent completed A flow (M2A-PASS)" || fail "A: M2A-PASS missing"
grep -Eqi "reject|拒绝" "$DIR/run-output.txt" && pass "agent saw the rejection" || fail "A: rejection not surfaced"

# Wake latency: delivered-log timestamp minus the ts= embedded by stages.sh.
LAT_OUT="$(python3 - "$LOG" <<'PY'
import re, sys, datetime
rows = []
for line in open(sys.argv[1], errors="replace"):
    m = re.match(r"\[(\S+?)\] delivered mon_\w+: stage (\d) ts=(\d+)", line)
    if m:
        t = datetime.datetime.fromisoformat(m.group(1).replace("Z", "+00:00")).timestamp() * 1000
        rows.append((int(m.group(2)), int(m.group(3)), t))
if len(rows) < 3:
    print("INSUFFICIENT", len(rows)); sys.exit(0)
worst = max(t2 - t1 for _, t1, t2 in rows)
print("OK" if worst < 2000 else "SLOW", f"n={len(rows)} worst={worst:.0f}ms",
      " ".join(f"s{s}:{t2-t1:.0f}ms" for s, t1, t2 in rows))
PY
)"
if [[ "$LAT_OUT" == OK* ]]; then
  pass "wake injection latency <2s ($LAT_OUT)"
else
  fail "A: wake latency — $LAT_OUT (note: with 1s gaps the queue path is measured; idle-wake verified in M1 TUI)"
fi

# ---------------------------------------------------------------- scenario B
note "Scenario B: three stop conditions + exit status (P0 #2)"
DIR="$BASE/b"; rm -rf "$DIR"; mkdir -p "$DIR"; install_plugin "$DIR"
: > "$LOG"

PROMPT_B='Start three monitors using only the monitor tool, in this order: (1) command exactly: printf '"'"'b1\nb2\nb3\nb4\nb5\n'"'"' with max_events 2; (2) command: sleep 40 with idle_timeout_ms 3000; (3) command: sh -c '"'"'echo hi-b3; exit 7'"'"'. After all three are started reply "all started" in one line and wait. Notifications will wake you as each monitor finishes. When ALL three have finished, call monitor_list once and report, one line per monitor id: its state and exit_info. Then reply with exactly: M2B-PASS'
run_opencode "$DIR" "$PROMPT_B"

grep -q "M2B-PASS" "$DIR/run-output.txt" && pass "agent completed B flow (M2B-PASS)" || fail "B: M2B-PASS missing"
grep -q 'finalized state=stopped exit="reached max_events=2"' "$LOG" \
  && pass "stop condition 1: max_events reached" || fail "B: max_events finalize not seen in log"
grep -qE 'finalized state=stopped exit="idle timeout after 3000ms' "$LOG" \
  && pass "stop condition 2: idle timeout" || fail "B: idle timeout finalize not seen in log"
grep -q 'finalized state=failed exit="Exit code 7"' "$LOG" \
  && pass "exit status mapped: non-zero -> failed Exit code 7" || fail "B: Exit code 7 not seen in log"
grep -q 'monitor failed: Exit code 7' "$LOG" \
  && pass "final notification carries exit status" || fail "B: final notification w/ exit status missing"

# ---------------------------------------------------------------- scenario C
note "Scenario C: monitor_stop leaves no orphans (P0 #3)"
DIR="$BASE/c"; rm -rf "$DIR"; mkdir -p "$DIR"; install_plugin "$DIR"
: > "$LOG"

PROMPT_C='Using the monitor tool: start a monitor with command: sleep 617 and description "orphan test". The moment you have the monitor id, call monitor_stop with that id. Then reply with exactly: M2C-PASS'
run_opencode "$DIR" "$PROMPT_C"

grep -q "M2C-PASS" "$DIR/run-output.txt" && pass "agent completed C flow (M2C-PASS)" || fail "C: M2C-PASS missing"
sleep 1
if pgrep -f "sleep 61[7]" >/dev/null; then
  fail "C: orphan process remains: $(pgrep -af 'sleep 61[7]' | tr '\n' ' ')"
else
  pass "no orphan after monitor_stop (process-group kill works)"
fi
grep -q 'finalized state=stopped exit="stopped by monitor_stop"' "$LOG" \
  && pass "stop maps to state=stopped" || fail "C: stopped-by-monitor_stop not in log"

# ---------------------------------------------------------------- scenario D
note "Scenario D: token bucket — burst 5, dropped counted (P0 #5)"
DIR="$BASE/d"; rm -rf "$DIR"; mkdir -p "$DIR"; install_plugin "$DIR"
: > "$LOG"

PROMPT_D='Using the monitor tool: start a monitor with command exactly: printf '"'"'d1\nd2\nd3\nd4\nd5\nd6\nd7\nd8\nd9\nd10\nd11\nd12\nd13\nd14\nd15\nd16\nd17\nd18\nd19\nd20\n'"'"' and description "throttle test". Wait for its completion notification, then call monitor_list and report this monitor'"'"'s events_sent and events_dropped values in one line. Then reply with exactly: M2D-PASS'
run_opencode "$DIR" "$PROMPT_D"

grep -q "M2D-PASS" "$DIR/run-output.txt" && pass "agent completed D flow (M2D-PASS)" || fail "D: M2D-PASS missing"
SENT="$(grep '] delivered ' "$LOG" | grep -vc 'monitor \(completed\|stopped\|failed\)' || true)"
[[ "$SENT" == 5 ]] && pass "exactly 5 content lines delivered (burst), lifecycle extra" || fail "D: expected 5 delivered, got $SENT"
grep -q 'throttled lines dropped so far: 1' "$LOG" \
  && pass "drop counter engaged (first drop logged)" || fail "D: drop log line missing"
grep -Eq 'events_sent[^0-9]*5|sent[^0-9]*5' "$DIR/run-output.txt" && grep -Eq 'dropped[^0-9]*15|丢弃[^0-9]*15' "$DIR/run-output.txt" \
  && pass "agent-reported counters: sent=5 dropped=15" || fail "D: agent counters not reported"

# ---------------------------------------------------------------- scenario E
note "Scenario E: 16-per-session cap + 17th rejected + no orphans after exit (P0 #4 #6)"
DIR="$BASE/e"; rm -rf "$DIR"; mkdir -p "$DIR"; install_plugin "$DIR"
: > "$LOG"

PROMPT_E='Task: call the monitor tool exactly 17 times in a row. Every call has command: sleep 631 and description "cap test". Constraints: use ONLY the monitor tool — never the shell/bash/execute tool, no loops, no echo; one monitor call at a time, 17 calls total. One of them will fail with an error. After all 17 calls, report in one line how many succeeded and quote the rejection error of the failed call. Then reply with exactly: M2E-PASS'
run_opencode "$DIR" "$PROMPT_E"

grep -q "M2E-PASS" "$DIR/run-output.txt" && pass "agent completed E flow (M2E-PASS)" || fail "E: M2E-PASS missing"
STARTED="$(grep -c ': started (pid' "$LOG" || true)"
[[ "$STARTED" == 16 ]] && pass "exactly 16 monitors admitted" || fail "E: expected 16 started, got $STARTED"
grep -Eq '16|sixteen' "$DIR/run-output.txt" && pass "agent reported the 16 cap" || fail "E: agent did not report 16"
sleep 2   # standalone service has exited; exit-guard must have SIGKILLed all
if pgrep -f "sleep 63[1]" >/dev/null; then
  fail "E: orphans remain after service exit: $(pgrep -af 'sleep 63[1]' | tr '\n' ' ')"
else
  pass "no orphans after service exit (exit-guard cleanup works)"
fi

# ------------------------------------------------------------------ summary
note "Summary"
echo "  passed: $PASS_COUNT   failed: $FAIL_COUNT"
if (( FAIL_COUNT > 0 )); then
  printf '  failed checks:\n'
  printf '    - %s\n' "${FAILED_SCENARIOS[@]}"
  exit 1
fi
echo "  RESULT: ALL PASS"
