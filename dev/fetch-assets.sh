#!/usr/bin/env bash
# Download the official PVE frontend packages and extract their static files
# into dev/assets/ (macOS-friendly: only needs curl, ar, tar, zstd/xz).
# Nothing is installed; the .deb files are just unpacked.
set -euo pipefail
cd "$(dirname "$0")"

SUITE="${PVE_SUITE:-trixie}"
PVE_REPO="http://download.proxmox.com/debian/pve"
DEB_REPO="http://deb.debian.org/debian"
CACHE=.cache
OUT=assets
mkdir -p "$CACHE" "$OUT"

fetch_index() { # $1=name $2=url
    local f="$CACHE/$1.Packages"
    [ -s "$f" ] || curl -fsSL "$2" | gunzip > "$f"
    echo "$f"
}

# print the Filename of the highest version of package $2 in index $1
latest() {
    awk -v pkg="$2" '
        /^Package: / { p = $2 }
        /^Version: / { v = $2 }
        /^Filename: / { if (p == pkg) print v "\t" $2 }
    ' "$1" | sort -V | tail -1 | cut -f2
}

extract() { # $1=repo base $2=Filename
    local deb="$CACHE/$(basename "$2")"
    [ -s "$deb" ] || { echo "  downloading $(basename "$2")"; curl -fsSL -o "$deb" "$1/$2"; }
    local tmp; tmp=$(mktemp -d)
    (cd "$tmp" && ar x "$OLDPWD/$deb")
    local data; data=$(ls "$tmp"/data.tar.* | head -1)
    case "$data" in
        *.zst) zstd -dc "$data" | tar -x -C "$OUT" ;;
        *) tar -xf "$data" -C "$OUT" ;;
    esac
    rm -rf "$tmp"
}

pve_idx=$(fetch_index pve "$PVE_REPO/dists/$SUITE/pve-no-subscription/binary-amd64/Packages.gz")
deb_idx=$(fetch_index debian "$DEB_REPO/dists/$SUITE/main/binary-all/Packages.gz")

for p in pve-manager proxmox-widget-toolkit libjs-extjs fonts-font-logos pve-i18n libjs-qrcodejs; do
    f=$(latest "$pve_idx" "$p")
    [ -n "$f" ] || f=$(latest "$deb_idx" "$p")
    [ -n "$f" ] || { echo "!! package $p not found" >&2; exit 1; }
    case "$f" in pool/main/*) base=$( [ "$(latest "$pve_idx" "$p")" = "$f" ] && echo "$PVE_REPO" || echo "$DEB_REPO");; *) base="$PVE_REPO";; esac
    echo "-> $p ($f)"
    extract "$base" "$f"
done

f=$(latest "$deb_idx" fonts-font-awesome)
echo "-> fonts-font-awesome ($f)"
extract "$DEB_REPO" "$f"

echo "assets ready in dev/$OUT"
