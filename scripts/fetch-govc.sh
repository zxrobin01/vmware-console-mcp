#!/usr/bin/env bash
# Fetch govc (govmomi CLI) into tools/ for the ESXi backend.
# Usage: scripts/fetch-govc.sh [v0.56.2]
set -euo pipefail
VERSION="${1:-v0.56.2}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$ROOT/tools"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
URL="https://github.com/vmware/govmomi/releases/download/$VERSION/govc_Linux_x86_64.tar.gz"
echo "Downloading govc $VERSION ..."
curl -fsSL "$URL" -o "$TMP/govc.tgz"
tar -xzf "$TMP/govc.tgz" -C "$TMP"
install -m 0755 "$TMP/govc" "$ROOT/tools/govc"
"$ROOT/tools/govc" version
echo "govc installed at $ROOT/tools/govc"
