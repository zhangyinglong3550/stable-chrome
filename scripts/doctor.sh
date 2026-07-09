#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST="${STABLE_CHROME_HOST:-127.0.0.1}"
PORT="${STABLE_CHROME_PORT:-19527}"
SBC="$ROOT/cli/sbc"

echo "== stable-chrome doctor =="
echo "root: $ROOT"
echo

echo "-- Chrome process --"
if pgrep -f 'Google Chrome.app/Contents/MacOS/Google Chrome' >/dev/null 2>&1; then
  echo "OK Chrome running"
else
  echo "FAIL Chrome not running — open Google Chrome first"
fi
echo

echo "-- Bridge --"
if curl -sS --max-time 2 "http://$HOST:$PORT/health" >/tmp/sbc-health.json 2>/dev/null; then
  echo "OK bridge health:"
  cat /tmp/sbc-health.json; echo
else
  echo "FAIL bridge offline. Start with: $ROOT/scripts/start-bridge.sh"
fi
echo

echo "-- Doctor API --"
if curl -sS --max-time 2 "http://$HOST:$PORT/doctor" >/tmp/sbc-doctor.json 2>/dev/null; then
  python3 - <<'PY'
import json
from pathlib import Path
d=json.loads(Path('/tmp/sbc-doctor.json').read_text())
ext=d.get('extension') or {}
print('extension.online =', ext.get('online'))
print('extension.id     =', ext.get('extensionId'))
print('extension.ageMs  =', ext.get('ageMs'))
for h in d.get('hints') or []:
    print('hint:', h)
PY
else
  echo "doctor api unavailable"
fi
echo

echo "-- CLI --"
if [[ -x "$SBC" ]]; then
  "$SBC" health || true
else
  echo "CLI not executable: $SBC"
fi
echo

echo "-- Next steps if extension offline --"
cat <<EOF
1) open chrome://extensions
2) enable Developer mode
3) Load unpacked -> $ROOT/extension
4) keep at least one Chrome window open
5) rerun: $ROOT/scripts/doctor.sh
6) test:  $ROOT/cli/sbc open-tabs
EOF
