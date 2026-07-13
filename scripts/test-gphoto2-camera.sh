#!/usr/bin/env bash

set -euo pipefail

echo "== gphoto2 compatibility test =="
echo

if ! command -v gphoto2 >/dev/null 2>&1; then
  echo "gphoto2 is not installed."
  echo "Install with: brew install gphoto2"
  exit 1
fi

echo "[1/5] gphoto2 version"
gphoto2 --version
echo

echo "[2/5] USB visibility check"
system_profiler SPUSBDataType | grep -E "Canon|EOS|R50|PTP|MTP|Camera|USB" || true
echo

echo "[3/5] Camera auto-detect"
gphoto2 --auto-detect || true
echo

echo "[4/5] Camera summary"
gphoto2 --summary || true
echo

echo "[5/5] Config tree sample"
gphoto2 --list-config | head -n 80 || true
echo

cat <<'EOF'
Notes:
- If the camera is not detected, try:
  - unlock the camera
  - switch USB mode to PTP/MTP if available
  - use a data-capable USB cable
  - close Photos, Image Capture, EOS Utility, or other apps that may grab the camera
- For Canon remote capture, newer config options often appear after:
  gphoto2 --set-config capture=on
EOF
