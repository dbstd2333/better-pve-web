#!/usr/bin/env bash
# Concatenate src/ modules (in src/ORDER) into dist/better-pve.{css,js}.
set -euo pipefail
cd "$(dirname "$0")"
version=$(cat VERSION)
mkdir -p dist
: > dist/better-pve.css
: > dist/better-pve.js
printf '/* better-pve %s */\n' "$version" >> dist/better-pve.css
printf '/* better-pve %s */\n(function () {\n// no "use strict": ExtJS callParent() relies on fn.caller\nvar BPVE_VERSION = "%s";\n' "$version" "$version" >> dist/better-pve.js
while IFS= read -r f; do
    [ -z "$f" ] && continue
    case "$f" in
        *.css) { printf '\n/* ---- %s ---- */\n' "$f"; cat "src/$f"; } >> dist/better-pve.css ;;
        *.js)  { printf '\n// ---- %s ----\n' "$f"; cat "src/$f"; } >> dist/better-pve.js ;;
    esac
done < src/ORDER
printf '\n})();\n' >> dist/better-pve.js
echo "built dist/better-pve.css dist/better-pve.js ($version)"
