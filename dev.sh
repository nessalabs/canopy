#!/usr/bin/env bash
# Canopy dev entrypoint.
#
#   ./dev.sh            daemon + Electron desktop app (default)
#   ./dev.sh web        daemon + web client on http://localhost:5173
#   ./dev.sh daemon     daemon only (tsx watch)
#   ./dev.sh setup      install deps, verify the electron binary, typecheck
#   ./dev.sh test       run every workspace's tests
#   ./dev.sh doctor     print tool versions and daemon state
#
# Env: CANOPY_HOME (~/.canopy), CANOPY_PORT (9483), NESSA_UI_DIR (../nessa_ui), CODEX_BIN
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CANOPY_HOME="${CANOPY_HOME:-$HOME/.canopy}"
CANOPY_PORT="${CANOPY_PORT:-9483}"
export CANOPY_HOME CANOPY_PORT

log() { printf '\033[1;32m▸\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

check_node() {
  command -v node >/dev/null || die "node not found (need >= 22)"
  local major; major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$major" -ge 22 ] || die "node >= 22 required, found $(node --version)"
}

ensure_electron_binary() {
  local dir="$ROOT/node_modules/electron"
  [ -d "$dir" ] || return 0
  if [ ! -f "$dir/path.txt" ] || [ ! -d "$dir/dist" ]; then
    log "electron binary missing — fetching"
    (cd "$dir" && node install.js)
  fi
}

setup() {
  check_node
  log "npm install (workspaces)"
  (cd "$ROOT" && npm install)
  ensure_electron_binary
  log "typecheck"
  (cd "$ROOT" && npm run typecheck)
}

needs_setup() { [ ! -d "$ROOT/node_modules" ] || [ ! -f "$ROOT/node_modules/electron/path.txt" ]; }

DAEMON_PID=""
start_daemon() {
  log "canopyd on http://127.0.0.1:$CANOPY_PORT (CANOPY_HOME=$CANOPY_HOME)"
  (cd "$ROOT" && npm -w @canopy/daemon run dev) &
  DAEMON_PID=$!
  trap 'kill "$DAEMON_PID" 2>/dev/null || true' EXIT
  for _ in $(seq 1 60); do
    if curl -fs "http://127.0.0.1:$CANOPY_PORT/healthz" >/dev/null 2>&1; then
      log "daemon ready · token: $(cat "$CANOPY_HOME/token")"
      return 0
    fi
    sleep 0.5
  done
  die "daemon did not become healthy"
}

doctor() {
  echo "node:      $(node --version 2>/dev/null || echo missing)"
  echo "npm:       $(npm --version 2>/dev/null || echo missing)"
  echo "git:       $(git --version 2>/dev/null || echo missing)"
  echo "claude:    $(command -v claude || echo missing)"
  echo "codex:     $(command -v codex || echo missing)"
  echo "deps:      $([ -d "$ROOT/node_modules" ] && echo installed || echo missing)"
  echo "electron:  $([ -f "$ROOT/node_modules/electron/path.txt" ] && echo ok || echo missing)"
  echo "nessa_ui:  $([ -d "${NESSA_UI_DIR:-$ROOT/../nessa_ui}" ] && echo present || echo missing)"
  echo "canopy:    $CANOPY_HOME ($([ -f "$CANOPY_HOME/token" ] && echo 'token present' || echo 'no token yet'))"
  curl -fs "http://127.0.0.1:$CANOPY_PORT/healthz" >/dev/null 2>&1 && echo "daemon:    running on :$CANOPY_PORT" || echo "daemon:    not running"
}

cmd="${1:-dev}"
case "$cmd" in
  setup)  setup ;;
  daemon) cd "$ROOT" && exec npm -w @canopy/daemon run dev ;;
  dev)    needs_setup && setup; start_daemon; cd "$ROOT" && npm -w @canopy/desktop run dev ;;
  web)    needs_setup && setup; start_daemon; cd "$ROOT" && npm -w @canopy/web run dev ;;
  test)   cd "$ROOT" && npm test ;;
  doctor) doctor ;;
  *) die "unknown command: $cmd" ;;
esac
