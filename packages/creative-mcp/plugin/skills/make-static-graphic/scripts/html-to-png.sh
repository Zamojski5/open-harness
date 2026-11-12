#!/usr/bin/env bash
# Render a local HTML file to PNG with a headless Chromium-family browser.
# Usage: html-to-png.sh <in.html> <out.png> <width> <height> [scale]
#   scale: device pixel ratio (1 = exact size, 2 = retina/2x). Default 1.
set -euo pipefail
in="${1:?in.html}"; out="${2:?out.png}"; w="${3:?width}"; h="${4:?height}"; scale="${5:-1}"
browser="${BROWSER_BIN:-}"
if [[ -z "$browser" ]]; then
  for c in \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "/Applications/Chromium.app/Contents/MacOS/Chromium" \
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" \
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
    "$(command -v chromium 2>/dev/null || true)" "$(command -v google-chrome 2>/dev/null || true)"; do
    [[ -n "$c" && -x "$c" ]] && { browser="$c"; break; }
  done
fi
[[ -z "$browser" ]] && { echo "No Chromium-family browser found. Set BROWSER_BIN." >&2; exit 2; }
abs_in="$(cd "$(dirname "$in")" && pwd)/$(basename "$in")"
mkdir -p "$(dirname "$out")"
abs_out="$(cd "$(dirname "$out")" && pwd)/$(basename "$out")"
profile="$(mktemp -d)"   # separate profile so a running browser is not reused
trap 'rm -rf "$profile"' EXIT
"$browser" --headless=new --disable-gpu --hide-scrollbars --no-first-run --no-default-browser-check \
  --user-data-dir="$profile" --force-device-scale-factor="$scale" \
  --virtual-time-budget=3000 --window-size="$w,$h" --screenshot="$abs_out" "file://$abs_in" >/dev/null 2>&1
[[ -s "$abs_out" ]] || { echo "Render failed: no output" >&2; exit 1; }
if command -v ffprobe >/dev/null; then
  echo "$abs_out $(ffprobe -v error -show_entries stream=width,height -of csv=p=0:s=x "$abs_out")"
else
  echo "$abs_out"
fi
