#!/bin/sh
# Render the ClaudeMom main window for the READMEs: docs/images/<lang>/claudemom.png.
#
#   sh scripts/screenshots/shoot.sh en              # writes docs/images/en/claudemom.png
#   sh scripts/screenshots/shoot.sh ru out.png      # writes the given file instead
#
# The first argument may also be "zh", which renders the real Chinese UI without a translation.
#
# The real app only runs on macOS and Windows and its UI is Chinese only. This script builds the real
# frontend (apps/claude-mom) with the strings replaced through dict.<lang>.json and Tauri replaced by a fake
# that answers from data.json, then captures the page with headless Chromium at the window size from
# tauri.conf.json, 2x. The window shape is taken from the upstream screenshot docs/images/claudemom.png.
#
# Needs: node, the app's dependencies (cd apps/claude-mom && npm ci), python3 with Pillow, and a Chromium
# (the newest one in ~/.cache/ms-playwright, or the path in $CHROME). Fonts come from the system: the result
# looks close to, but not exactly like, a capture on a Mac.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
app="$root/apps/claude-mom"
lang="${1:-}"
out="${2:-$root/docs/images/$lang/claudemom.png}"

case "$lang" in
  en | ru | zh) ;;
  *)
    echo "usage: sh scripts/screenshots/shoot.sh <en|ru|zh> [output.png]" >&2
    exit 2
    ;;
esac
[ -d "$app/node_modules" ] || { echo "missing $app/node_modules: run 'npm ci' in apps/claude-mom first" >&2; exit 1; }
chrome=${CHROME:-$(ls -d "$HOME"/.cache/ms-playwright/chromium-*/chrome-linux64/chrome 2>/dev/null | sort -V | tail -n 1)}
[ -x "$chrome" ] || { echo "no Chromium found: set CHROME=/path/to/chrome" >&2; exit 1; }

set -- $(python3 -I -c 'import json,sys; w = json.load(open(sys.argv[1]))["app"]["windows"][0]; print(w["width"], w["height"])' "$app/src-tauri/tauri.conf.json")
width=$1
height=$2

work=$(mktemp -d)
server=""
cleanup() {
  [ -n "$server" ] && kill "$server" 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT INT TERM
dist="$work/dist"

SHOT_APP_DIR="$app" SHOT_LANG="$lang" SHOT_OUT_DIR="$dist" ${SHOT_DEBUG:+SHOT_DEBUG=1} \
  node "$app/node_modules/vite/bin/vite.js" build --config "$here/vite.config.mjs" 2>&1 | grep -v -E '^\s*$|transforming|\.\.\.' | tail -n 12

port=$(python3 -I -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')
python3 -I -m http.server "$port" --bind 127.0.0.1 --directory "$dist" >/dev/null 2>&1 &
server=$!
ready=0
for _ in $(seq 1 100); do
  if python3 -I -c "import sys, urllib.request; urllib.request.urlopen('http://127.0.0.1:$port/', timeout=1); sys.exit(0)" 2>/dev/null; then
    ready=1
    break
  fi
  python3 -I -c 'import time; time.sleep(0.1)'
done
[ "$ready" = 1 ] || { echo "local server did not start" >&2; exit 1; }

"$chrome" --headless=new --no-first-run --no-default-browser-check --disable-extensions \
  --user-data-dir="$work/profile" --hide-scrollbars --force-dark-mode \
  --window-size="$width,$height" --force-device-scale-factor=2 --virtual-time-budget=6000 \
  --screenshot="$work/raw.png" "http://127.0.0.1:$port/" >/dev/null 2>&1 || true
[ -s "$work/raw.png" ] || { echo "Chromium wrote no screenshot" >&2; exit 1; }

mkdir -p "$(dirname "$out")"
python3 -I "$here/post.py" "$work/raw.png" "$out" "$root/docs/images/claudemom.png"
echo "wrote $out"
