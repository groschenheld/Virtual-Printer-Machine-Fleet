#!/usr/bin/env bash
# Baut ein portables Paket inkl. Node.js-Laufzeit – auf dem Zielrechner wird nichts weiter benötigt.
#
#   tools/portable.sh linux-x64            -> dist/virtual-print-fleet-<version>-linux-x64.tar.gz
#   tools/portable.sh linux-arm64          -> dist/virtual-print-fleet-<version>-linux-arm64.tar.gz
#   tools/portable.sh win-x64              -> dist/virtual-print-fleet-<version>-win-x64.zip
#
#   NODE_VERSION=22.12.0 tools/portable.sh linux-x64     bestimmte Node-Version laden (Standard: 22.12.0)
#   NODE_BIN=/pfad/zu/node tools/portable.sh linux-x64   vorhandenes Node-Binary verwenden statt herunterzuladen
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:-linux-x64}"
NODE_VERSION="${NODE_VERSION:-22.12.0}"
VERSION="$(node -p "require('$ROOT/package.json').version" 2>/dev/null || grep -m1 '"version"' "$ROOT/package.json" | sed 's/.*: *"\(.*\)".*/\1/')"
NAME="virtual-print-fleet"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
PKG="$WORK/$NAME"
mkdir -p "$PKG/runtime" "$ROOT/dist"

# ---------------------------------------------------------------- Anwendung
for p in src ui tools build/icon.png README.md LICENSE THIRD_PARTY_LICENSES.txt package.json install.sh uninstall.sh; do
  mkdir -p "$PKG/$(dirname "$p")"
  cp -r "$ROOT/$p" "$PKG/$p"
done
rm -f "$PKG/tools/portable.sh"

# ---------------------------------------------------------------- Node-Laufzeit
case "$TARGET" in
  linux-x64|linux-arm64) EXE="node"; ARCHIVE="node-v$NODE_VERSION-$TARGET.tar.xz" ;;
  win-x64) EXE="node.exe"; ARCHIVE="node-v$NODE_VERSION-$TARGET.zip" ;;
  *) echo "Unbekanntes Ziel: $TARGET (linux-x64|linux-arm64|win-x64)"; exit 1 ;;
esac
if [[ -n "${NODE_BIN:-}" ]]; then
  cp "$NODE_BIN" "$PKG/runtime/$EXE"
  NODE_DIR="$(dirname "$(dirname "$NODE_BIN")")"
  [[ -f "$NODE_DIR/LICENSE" ]] && cp "$NODE_DIR/LICENSE" "$PKG/runtime/LICENSE-node.txt"
else
  echo "› Lade Node.js $NODE_VERSION für $TARGET …"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/$ARCHIVE" -o "$WORK/$ARCHIVE"
  if [[ "$ARCHIVE" == *.zip ]]; then
    unzip -q "$WORK/$ARCHIVE" -d "$WORK/n"
  else
    mkdir -p "$WORK/n" && tar -xJf "$WORK/$ARCHIVE" -C "$WORK/n"
  fi
  SRC="$WORK/n/node-v$NODE_VERSION-$TARGET"
  if [[ "$EXE" == "node.exe" ]]; then cp "$SRC/node.exe" "$PKG/runtime/"; else cp "$SRC/bin/node" "$PKG/runtime/"; fi
  cp "$SRC/LICENSE" "$PKG/runtime/LICENSE-node.txt"
fi

# ---------------------------------------------------------------- Startdateien
if [[ "$EXE" == "node" ]]; then
  chmod 755 "$PKG/runtime/node"
  cat > "$PKG/vpf" <<'EOF'
#!/usr/bin/env bash
# Virtual Print Fleet – Start mit mitgelieferter Node.js-Laufzeit
DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
exec "$DIR/runtime/node" "$DIR/src/cli.js" "$@"
EOF
  chmod 755 "$PKG/vpf" "$PKG/install.sh" "$PKG/uninstall.sh"
  ( cd "$WORK" && tar -czf "$ROOT/dist/$NAME-$VERSION-$TARGET.tar.gz" "$NAME" )
  OUT="$ROOT/dist/$NAME-$VERSION-$TARGET.tar.gz"
else
  printf '@echo off\r\nrem Virtual Print Fleet – Start mit mitgelieferter Node.js-Laufzeit\r\n"%%~dp0runtime\\node.exe" "%%~dp0src\\cli.js" %%*\r\n' > "$PKG/vpf.cmd"
  printf '@echo off\r\n"%%~dp0runtime\\node.exe" "%%~dp0src\\cli.js" --open\r\n' > "$PKG/Virtual Print Fleet starten.cmd"
  ( cd "$WORK" && zip -qr "$ROOT/dist/$NAME-$VERSION-$TARGET.zip" "$NAME" )
  OUT="$ROOT/dist/$NAME-$VERSION-$TARGET.zip"
fi
echo "✔ $OUT ($(du -h "$OUT" | cut -f1))"
