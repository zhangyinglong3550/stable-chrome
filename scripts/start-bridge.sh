#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$ROOT/logs"
mkdir -p "$LOG_DIR"
PID_FILE="$LOG_DIR/bridge.pid"
HOST="${STABLE_CHROME_HOST:-127.0.0.1}"
PORT="${STABLE_CHROME_PORT:-19527}"

if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "bridge already running pid=$(cat "$PID_FILE")"
  curl -sS "http://$HOST:$PORT/health" || true
  echo
  exit 0
fi

# free port if stale
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port $PORT busy; refusing to start. Kill the process or change STABLE_CHROME_PORT."
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN || true
  exit 1
fi

nohup python3 "$ROOT/bridge/server.py" --host "$HOST" --port "$PORT" \
  >"$LOG_DIR/bridge.out" 2>&1 &
echo $! >"$PID_FILE"
sleep 0.4
if kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "bridge started pid=$(cat "$PID_FILE") http://$HOST:$PORT"
  curl -sS "http://$HOST:$PORT/health" || true
  echo
else
  echo "bridge failed to start; see $LOG_DIR/bridge.out"
  exit 1
fi
