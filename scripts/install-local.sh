#!/usr/bin/env bash
# Install this plugin into an auto-load directory.
#
# Default (project mode): .opencode/plugins/ inside this repo — the SERVER
# runtime discovers plugins there automatically; local paths inside the
# "plugins" config array are silently ignored on some V2 builds (observed on
# v2.0.10/v2.0.11).
#
# --global-full: ~/.config/opencode/plugins/ with the COMPLETE plugin (both
# entry shims + package.json + src) and REMOVES the project-level copy — the
# publish-like layout: server instances spawn per location, so every project
# gets the tools, not just this repo. The default mode refuses to run while
# this layout is in place (the server scans both dirs -> two server-plugin
# instances: duplicate tools, duplicate state writer).
#
# --global: ~/.config/opencode/plugins/ — the TUI runtime (v2.0.11) ONLY
# auto-discovers the global dir, not the project-level one (verified live:
# project-level tui.ts never loaded; statusline in the global dir does). The
# global copy installs the TUI entry only (tui.ts + src) — index.ts is NOT
# installed there, otherwise the server would load a second server-plugin
# instance (duplicate tools, duplicate state writer). The server-side scan of
# the global dir still imports tui.ts; src/tui.ts detects the server context
# and skips quietly.
#
# --link: ~/.config/opencode/plugins/opencode-monitor-task becomes a SINGLE
# symlink to this repo root. The repo root already IS the full plugin layout
# (index.ts + tui.ts shims + package.json + src), so one link covers both
# entries. Dev-friendly in two ways: (a) edits to src/ are live immediately —
# no reinstall, just touch the entry to hot-reload; (b) when the global config
# dir is itself a git repo, it tracks ONE symlink entry instead of 20+ copied
# files, so reinstalls never dirty its git status. SAFETY: rm on a symlink
# only unlinks it, but rm -rf "$TARGET/src" WOULD recurse through the link
# into this repo — every other mode unlinks a pre-existing link first
# (the -L guards below).
#
# TODO(L1, unfinished): v2.0.11 CANNOT load a plugin directory that is itself
# a symlink — host logs "Plugin must export a default definition ...
# Missing key [\"default\"]" on every instance spawn (verified 2026-09-22;
# node-level import of the same path works, so it is a host scanner/loader
# symlink limitation, not a plugin defect). Use --global-full until the host
# behavior is understood.
#
# The copy is a deployment artifact (gitignored). Rerun this script after
# changing src/, then reload:
#   touch .opencode/plugins/opencode-monitor-task/index.ts
#   opencode service restart   # only if hot reload did not pick it up
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ "${1:-}" = "--link" ]; then
  TARGET="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins/opencode-monitor-task"
  mkdir -p "$(dirname "$TARGET")"
  if [ -L "$TARGET" ]; then
    rm "$TARGET"                     # unlink only — never recurse through it
  elif [ -e "$TARGET" ]; then
    rm -rf "$TARGET"                 # old copied install: a real directory
  fi
  ln -s "$ROOT" "$TARGET"
  # Same dual-instance guard as --global-full: the server scans both dirs.
  PROJ="$ROOT/.opencode/plugins/opencode-monitor-task"
  if [ -L "$PROJ" ]; then
    rm "$PROJ"
    echo "removed project-level link: $PROJ"
  elif [ -d "$PROJ" ]; then
    rm -rf "$PROJ"
    echo "removed project-level copy: $PROJ"
  fi
  touch "$TARGET/index.ts" "$TARGET/tui.ts"
  echo "linked: $TARGET -> $ROOT"
  echo "WARNING: TODO(L1) unfinished — v2.0.11 fails to load a symlinked plugin" >&2
  echo "         dir (Missing default). Prefer: $0 --global-full" >&2
  exit 0
fi

if [ "${1:-}" = "--global-full" ]; then
  TARGET="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins/opencode-monitor-task"
  mkdir -p "$TARGET"
  # A previous --link install must be unlinked first; otherwise
  # rm -rf "$TARGET/src" below would recurse through the link into $ROOT.
  if [ -L "$TARGET" ]; then rm "$TARGET" && mkdir -p "$TARGET"; fi
  rm -rf "$TARGET/src"
  cp -r "$ROOT/src" "$TARGET/src"
  cp "$ROOT/package.json" "$TARGET/package.json"
  cat > "$TARGET/index.ts" <<'EOF'
export { default } from "./src/index"
EOF
  cat > "$TARGET/tui.ts" <<'EOF'
export { default } from "./src/tui"
EOF
  # The server scans BOTH the project-level and global dirs; a leftover
  # project-level copy would load a second server-plugin instance.
  if [ -d "$ROOT/.opencode/plugins/opencode-monitor-task" ]; then
    rm -rf "$ROOT/.opencode/plugins/opencode-monitor-task"
    echo "removed project-level copy: $ROOT/.opencode/plugins/opencode-monitor-task"
  fi
  touch "$TARGET/index.ts" "$TARGET/tui.ts"
  echo "installed (full plugin, publish-like layout): $TARGET"
  exit 0
fi

if [ "${1:-}" = "--global" ]; then
  TARGET="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins/opencode-monitor-task"
  mkdir -p "$TARGET"
  # Unlink a previous --link install first (see the safety note above).
  if [ -L "$TARGET" ]; then rm "$TARGET" && mkdir -p "$TARGET"; fi
  rm -rf "$TARGET/src"
  cp -r "$ROOT/src" "$TARGET/src"
  cat > "$TARGET/tui.ts" <<'EOF'
export { default } from "./src/tui"
EOF
  touch "$TARGET/tui.ts"
  if [ -f "$TARGET/index.ts" ]; then
    echo "note: full global install present; prefer --global-full (index.ts left in place)" >&2
  fi
  echo "installed (TUI entry only): $TARGET"
  exit 0
fi

# Refuse while a full global install exists: the server scans both dirs and
# would load two server-plugin instances (duplicate tools, state writer).
GLOBAL_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins/opencode-monitor-task"
if [ -f "$GLOBAL_DIR/index.ts" ]; then
  echo "ERROR: full global install detected at $GLOBAL_DIR" >&2
  echo "  A project-level copy on top would load TWO server-plugin instances." >&2
  echo "  - sync the publish-like layout instead: $0 --global-full" >&2
  echo "  - or remove it first to return to dev layout: rm -rf $GLOBAL_DIR" >&2
  exit 1
fi

TARGET="$ROOT/.opencode/plugins/opencode-monitor-task"

mkdir -p "$TARGET"
# Unlink a stale link first (same safety rule; a link here would otherwise
# send the rm -rf below into arbitrary targets).
if [ -L "$TARGET" ]; then rm "$TARGET" && mkdir -p "$TARGET"; fi
rm -rf "$TARGET/src"
cp -r "$ROOT/src" "$TARGET/src"
cp "$ROOT/package.json" "$TARGET/package.json"

# Shim so the auto-loader can resolve the entry at the directory root
# (package.json "exports" points at ./src/index.ts, but discovery for
# .opencode/plugins/ packages expects a root entry file).
cat > "$TARGET/index.ts" <<'EOF'
export { default } from "./src/index"
EOF

# TUI-side entry shim: mirrors the server one. (The project-level dir is not
# scanned by the TUI runtime on v2.0.11 — run `install-local.sh --global` for
# the sidebar panel. Kept here so npm-package installs, where both entries are
# discovered via package exports, work with one artifact.)
cat > "$TARGET/tui.ts" <<'EOF'
export { default } from "./src/tui"
EOF

touch "$TARGET/index.ts" "$TARGET/tui.ts"
echo "installed: $TARGET"
