#!/bin/sh
set -e

root=$(cd "$(dirname "$0")/../.." && pwd)
svg="$root/IAM/Assets/mining-platform-icon.svg"
out="$root/resource/app_icons/X1"

chrome=$(command -v google-chrome || command -v chromium || command -v chromium-browser)
if [ -z "$chrome" ]; then
  echo "make_icon.sh: no Chrome on PATH; install one or rasterise $svg by hand" >&2
  exit 1
fi

for size in 128 32; do
  "$chrome" --headless=new --disable-gpu --no-sandbox --hide-scrollbars \
    --default-background-color=00000000 \
    --screenshot="$out/mining-platform-icon-$size.png" \
    --window-size="$size,$size" "file://$svg" >/dev/null 2>&1
  echo "wrote $out/mining-platform-icon-$size.png"
done
