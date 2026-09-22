#!/usr/bin/env bash
# M1 manual verification: a multi-stage background command must wake the
# agent once per stage via <task-notification>, then finish cleanly with no
# orphan processes.
#
# Plugin loading uses the documented project-level auto-load dir
# (.opencode/plugins/) because absolute paths inside the "plugins" config
# array are silently ignored on some V2 builds (observed on v2.0.10).
#
# Usage: bash test/m1-verify.sh <model>   # provider/model id, from "opencode models"
set -uo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODEL="${1:?usage: bash test/m1-verify.sh <model> — provider/model id (list with: opencode models)}"
TEST_DIR="/tmp/opencode/m1-test"
LOG="${TMPDIR:-/tmp}/opencode/opencode-monitor-task.log"
AUTOLOAD_DIR="$TEST_DIR/.opencode/plugins/opencode-monitor-task"

rm -rf "$TEST_DIR"
mkdir -p "$AUTOLOAD_DIR"

# Install the plugin into the project's auto-load directory.
cp -r "$PLUGIN_DIR/src" "$AUTOLOAD_DIR/src"
cp "$PLUGIN_DIR/package.json" "$AUTOLOAD_DIR/package.json"
# Shim so the auto-loader can resolve the entry at the directory root.
cat > "$AUTOLOAD_DIR/index.ts" <<'EOF'
export { default } from "./src/index"
EOF

cat > "$TEST_DIR/stages.sh" <<'EOS'
#!/usr/bin/env bash
# 1s gaps: notifications queue while the model is mid-turn, so the run CLI
# (which exits once the session goes idle) cannot race ahead of the final
# stage. Idle-wake itself was verified manually with longer gaps.
for i in 1 2 3; do
  echo "stage $i finish"
  sleep 1
done
echo "all stages complete"
EOS
chmod +x "$TEST_DIR/stages.sh"

: > "$LOG"

PROMPT='Use the monitor tool (not the shell tool) to watch this exact command: bash /tmp/opencode/m1-test/stages.sh — description "m1 smoke stages". After it starts, reply with one short line confirming monitoring has started, then wait. Each time a <task-notification> wakes you, acknowledge that stage in one short line, then wait again. When a notification reports the monitor completed (exit code 0), reply with exactly: M1-PASS'

cd "$TEST_DIR"
opencode run --standalone --auto --model "$MODEL" "$PROMPT" 2>&1 | tee "$TEST_DIR/run-output.txt"
RUN_STATUS=${PIPESTATUS[0]}

echo "=== plugin log ==="
cat "$LOG" 2>/dev/null || echo "(no plugin log)"

echo "=== orphan check ==="
if pgrep -f "stages\.sh" >/dev/null; then
  echo "FAIL: orphan stages.sh process remains:"
  pgrep -af "stages\.sh"
  exit 1
fi
echo "no orphan processes"

echo "=== result ==="
echo "run exit status: $RUN_STATUS"
if grep -q "M1-PASS" "$TEST_DIR/run-output.txt"; then
  echo "RESULT: PASS"
else
  echo "RESULT: FAIL (M1-PASS not found in run output)"
  exit 1
fi
