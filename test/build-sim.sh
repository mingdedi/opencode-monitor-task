#!/usr/bin/env bash
# Simulated large-project build (make -j style) for monitor-tool scenario testing.
#
# Real-world shape: `make -j16` on a C project — a wall of per-file compile
# lines on stdout (noise), colored gcc warnings on stderr, the occasional
# hard error, and one final status line. Watched by the opencode-monitor-task
# plugin it exercises:
#
#   - regex wake filtering: compile/warning noise stays in lines_scanned only
#   - ANSI stripping: patterns are matched against the *cleaned* text, so a
#     pattern written for plain gcc output works despite the color codes
#   - stdout+stderr merge: warnings land on stderr, status lines on stdout
#   - exit-status mapping: --fail-at N aborts with a hard error -> non-zero
#     exit -> lifecycle notification "monitor failed: Exit code 1"
#
# Output shape (bash builtins write per call, so output is never block-buffered):
#
#     CC      src/core/parser.o                                     <- noise, stdout
#     src/warn.c:41:13: warning: unused variable 'tmp' [-Wunused-variable]   <- stderr
#     src/fatal.c:88:5: error: dereferencing pointer to incomplete type 'struct conn_t'
#     BUILD OK: 30/30 targets built in 4s (-j16)
#
# Suggested monitor calls:
#   wake on errors and final status only (recommended):
#     monitor(command="bash test/build-sim.sh",
#             description="nightly build",
#             pattern="error:|BUILD (OK|FAILED)")
#   no pattern — every compile line wakes until the token bucket throttles
#   (burst 5 + 1/s; expect a large events_dropped):
#     monitor(command="bash test/build-sim.sh")
#
# What a correct plugin does (recommended call, defaults, no --fail-at):
#   - ~30 CC lines + a handful of colored warnings are scanned but never wake
#   - exactly one wake: "BUILD OK: …" + lifecycle "monitor completed: exit code 0"
#   - with --fail-at N: two wakes ("error: …" delivered from stderr,
#     "BUILD FAILED …") + lifecycle "monitor failed: Exit code 1";
#     monitor_list shows lines_matched=2 despite ANSI colors in both lines
#
# Usage:
#   bash build-sim.sh [--files 30] [--sec-per-file 0.15] [--fail-at N] [--seed 7]
set -u

FILES=30
SEC_PER_FILE=0.15
FAIL_AT=0
SEED=7

while [[ $# -gt 0 ]]; do
  case "$1" in
    --files)        FILES="$2";        shift 2 ;;
    --sec-per-file) SEC_PER_FILE="$2"; shift 2 ;;
    --fail-at)      FAIL_AT="$2";      shift 2 ;;
    --seed)         SEED="$2";         shift 2 ;;
    *) echo "unknown option: $1 (usage: [--files N] [--sec-per-file S] [--fail-at N] [--seed S])" >&2; exit 64 ;;
  esac
done
RANDOM=$SEED  # assigning seeds bash's PRNG

RED=$'\033[31m'; MAGENTA=$'\033[35m'; GREEN=$'\033[32m'; RESET=$'\033[0m'

SRCS=(
  src/core/parser.o src/core/lexer.o src/core/ast.o
  src/net/socket.o src/net/tls.o src/net/http.o
  src/storage/page.o src/storage/btree.o src/storage/wal.o
  src/util/buffer.o src/util/log.o src/util/hash.o
  src/exec/scan.o src/exec/agg.o src/exec/join.o
)
WARN_KINDS=(unused-variable format-truncation deprecated-declarations maybe-uninitialized)
WARN_VARS=(tmp n ctx buf)

START=$(date +%s)

for ((i = 1; i <= FILES; i++)); do
  src="${SRCS[$((RANDOM % ${#SRCS[@]}))]}"
  printf 'CC      %s\n' "$src"

  # gcc prints ~20% of files with a warning; colored magenta, on stderr.
  if (( RANDOM % 5 == 0 )); then
    wvar="${WARN_VARS[$((RANDOM % ${#WARN_VARS[@]}))]}"
    wkind="${WARN_KINDS[$((RANDOM % ${#WARN_KINDS[@]}))]}"
    printf '%s%s:%d:%d: warning: unused variable %s [-W%s]%s\n' \
      "$MAGENTA" "${src%.*}.c" \
      "$((RANDOM % 400 + 20))" "$((RANDOM % 60 + 5))" "'$wvar'" "$wkind" "$RESET" >&2
  fi

  # Deterministic hard failure at target FAIL_AT (compiler error on stderr,
  # make status line on stdout, exit 1).
  if (( FAIL_AT > 0 && i == FAIL_AT )); then
    printf "%ssrc/fatal.c:88:5: error: dereferencing pointer to incomplete type 'struct conn_t'%s\n" \
      "$RED" "$RESET" >&2
    printf '%sBUILD FAILED: make -j16 stopped at target %d/%d (1 error, exit 1)%s\n' \
      "$RED" "$i" "$FILES" "$RESET"
    exit 1
  fi

  sleep "$SEC_PER_FILE"
done

printf '%sBUILD OK: %d/%d targets built in %ds (-j16)%s\n' \
  "$GREEN" "$FILES" "$FILES" "$(( $(date +%s) - START ))" "$RESET"
