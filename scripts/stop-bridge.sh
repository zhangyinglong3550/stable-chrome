#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$ROOT/logs/bridge.pid"
PORT="${STABLE_CHROME_PORT:-19527}"

stopped=0
if [[ -f "$PID_FILE" ]]; then
  pid="$(cat "$PID_FILE")"
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" || true
    sleep 0.3
    kill -9 "$pid" 2>/dev/null || true
    echo "stopped bridge pid=$pid"
    stopped=1
  else
    echo "stale pid file ($pid)"
  fi
  rm -f "$PID_FILE"
else
  echo "no pid file"
fi

# 兜底：pid 文件过期时仍释放端口
if command -v lsof >/dev/null 2>&1; then
  extra="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "${extra}" ]]; then
    # shellcheck disable=SC2086
    kill $extra 2>/dev/null || true
    sleep 0.2
    # shellcheck disable=SC2086
    kill -9 $extra 2>/dev/null || true
    echo "freed port $PORT (pids: $extra)"
    stopped=1
  fi
fi

if [[ "$stopped" -eq 0 ]]; then
  echo "bridge not running"
fi
