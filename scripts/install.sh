#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

chmod +x \
  "$ROOT/cli/sbc" \
  "$ROOT/bridge/server.py" \
  "$ROOT/scripts/"*.sh

# simple icons if missing
ICON_DIR="$ROOT/extension/icons"
mkdir -p "$ICON_DIR"
python3 - <<'PY' "$ICON_DIR"
from pathlib import Path
import struct, zlib, sys
out = Path(sys.argv[1])

def png(size: int, rgb=(15, 143, 140)) -> bytes:
    # minimal solid-color PNG
    import binascii
    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', binascii.crc32(tag + data) & 0xffffffff)
    raw = b''.join(b'\x00' + bytes(rgb) * size for _ in range(size))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')

for s in (16, 48, 128):
    (out / f'icon{s}.png').write_bytes(png(s))
print('icons written', out)
PY

# symlink CLI
mkdir -p "$HOME/.local/bin"
ln -sfn "$ROOT/cli/sbc" "$HOME/.local/bin/sbc"

# install Claude skill
SKILL_DIR="$HOME/.claude/skills/stable-chrome"
mkdir -p "$SKILL_DIR"
cp -f "$ROOT/skill/SKILL.md" "$SKILL_DIR/SKILL.md"
# keep absolute path helper
cat > "$SKILL_DIR/config.json" <<EOF
{
  "root": "$ROOT",
  "bridge": "http://127.0.0.1:19527",
  "cli": "$ROOT/cli/sbc"
}
EOF

echo "Installed:"
echo "  CLI:   $HOME/.local/bin/sbc  (or $ROOT/cli/sbc)"
echo "  Skill: $SKILL_DIR/SKILL.md"
echo
echo "Next:"
echo "  1) $ROOT/scripts/start-bridge.sh"
echo "  2) Chrome -> chrome://extensions -> Load unpacked -> $ROOT/extension"
echo "  3) $ROOT/scripts/doctor.sh"
echo "  4) sbc open-tabs"
