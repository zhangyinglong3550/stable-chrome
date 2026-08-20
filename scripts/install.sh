#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

chmod +x \
  "$ROOT/cli/sbc" \
  "$ROOT/bridge/server.py" \
  "$ROOT/scripts/"*.sh

exec python3 "$ROOT/cli/sbc" setup "$@"
