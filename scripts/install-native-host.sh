#!/usr/bin/env bash
# Optional: native host is NOT required for the HTTP bridge architecture.
# Kept for future dual-transport / diagnostics compatibility.
set -euo pipefail
echo "stable-chrome v0.1 uses HTTP bridge (127.0.0.1:19527), not native messaging."
echo "No native host install is required."
echo "If you passed an extension ID, it is only needed for Chrome's extension page identification."
if [[ $# -ge 1 ]]; then
  echo "extension id noted: $1"
fi
