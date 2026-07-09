#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$ROOT/logs/bridge.pid"
if [[ -f "$PID_FILE" ]]; then
  pid="$(cat "$PID_FILE")"
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" || true
    sleep 0.3
    kill -9 "$pid" 2>/dev/null || true
    echo "stopped bridge pid=$pid"
  else
    echo "stale pid file ($pid)"
  fi
  rm -f "$PID_FILE"
else
  echo "no pid file"
fi
