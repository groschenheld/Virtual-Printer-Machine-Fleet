#!/usr/bin/env bash
# Virtual Print Fleet – Installation und Builds
#
#   ./install.sh                  Installation (Abhängigkeiten, Befehl "vpf", Startmenü-Eintrag, Beispieldateien)
#   ./install.sh --service        zusätzlich als systemd-Benutzerdienst starten (läuft im Hintergrund)
#   ./install.sh --build appimage AppImage bauen          -> dist/*.AppImage
#   ./install.sh --build exe      Windows-.exe bauen      -> dist/*.exe (unter Linux nur mit Wine, sonst GitHub Actions)
#   ./install.sh --build all      beides
#   ./install.sh --uninstall      Befehl, Startmenü-Eintrag und Dienst entfernen (Daten bleiben)
#
# Weitere Optionen: --no-desktop  --bind 0.0.0.0  --port 8650
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="${HOME}/.local/bin"
DESKTOP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
SERVICE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
NAME="virtual-print-fleet"

BUILD=""; SERVICE=0; UNINSTALL=0; DESKTOP=1; BIND=""; PORT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --build) BUILD="${2:-all}"; shift 2 ;;
    --service) SERVICE=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --no-desktop) DESKTOP=0; shift ;;
    --bind) BIND="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "Unbekannte Option: $1"; exit 1 ;;
  esac
done

c_ok()   { printf '\033[32m✔\033[0m %s\n' "$*"; }
c_info() { printf '\033[36m›\033[0m %s\n' "$*"; }
c_warn() { printf '\033[33m!\033[0m %s\n' "$*"; }
die()    { printf '\033[31m✘ %s\033[0m\n' "$*"; exit 1; }

OS="$(uname -s)"
case "$OS" in MINGW*|MSYS*|CYGWIN*) IS_WIN=1 ;; *) IS_WIN=0 ;; esac

# ------------------------------------------------------------------ Deinstallation
if [[ $UNINSTALL -eq 1 ]]; then
  if command -v systemctl >/dev/null 2>&1 && [[ -f "$SERVICE_DIR/$NAME.service" ]]; then
    systemctl --user disable --now "$NAME.service" 2>/dev/null || true
    rm -f "$SERVICE_DIR/$NAME.service"; systemctl --user daemon-reload || true
    c_ok "Dienst entfernt"
  fi
  rm -f "$BIN_DIR/vpf" "$DESKTOP_DIR/$NAME.desktop"
  c_ok "Befehl und Startmenü-Eintrag entfernt (Daten unter ~/.local/share/$NAME bleiben erhalten)"
  exit 0
fi

# ------------------------------------------------------------------ Node.js prüfen
if ! command -v node >/dev/null 2>&1; then
  die "Node.js (≥ 18) nicht gefunden. Installation z. B.:
     Debian/Ubuntu:  sudo apt install nodejs npm   (oder https://nodejs.org / nvm)
     Fedora:         sudo dnf install nodejs
     Arch:           sudo pacman -S nodejs npm"
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" -ge 18 ]] || die "Node.js $NODE_MAJOR ist zu alt – benötigt wird Version 18 oder neuer."
c_ok "Node.js $(node -v)"

cd "$APP_DIR"

# ------------------------------------------------------------------ Builds
if [[ -n "$BUILD" ]]; then
  c_info "Installiere Build-Abhängigkeiten (Electron, electron-builder) …"
  npm install --no-audit --no-fund
  build_appimage() {
    [[ "$OS" == "Linux" ]] || { c_warn "AppImage kann nur unter Linux gebaut werden (oder per GitHub Actions)"; return; }
    npx electron-builder --linux AppImage --publish never
    c_ok "AppImage: $(ls -1 dist/*.AppImage 2>/dev/null | tail -1)"
  }
  build_exe() {
    if [[ $IS_WIN -eq 1 ]]; then
      npx electron-builder --win nsis portable --publish never
    elif command -v wine >/dev/null 2>&1 || command -v wine64 >/dev/null 2>&1; then
      c_info "Baue Windows-Pakete mit Wine …"
      npx electron-builder --win nsis portable --publish never
    elif command -v docker >/dev/null 2>&1; then
      c_info "Kein Wine gefunden – baue im Docker-Image electronuserland/builder:wine …"
      docker run --rm -v "$APP_DIR":/project -w /project electronuserland/builder:wine \
        /bin/bash -c "npm install --no-audit --no-fund && npx electron-builder --win nsis portable --publish never"
    else
      c_warn "Für die .exe unter Linux wird Wine oder Docker benötigt."
      c_warn "Alternative ohne lokale Werkzeuge: Repository auf GitHub pushen und einen Tag setzen (git tag v0.1.0 && git push --tags) –"
      c_warn "der Workflow .github/workflows/build.yml baut AppImage und .exe und hängt sie an das Release."
      return
    fi
    c_ok "Windows: $(ls -1 dist/*.exe 2>/dev/null | tr '\n' ' ')"
  }
  case "$BUILD" in
    appimage) build_appimage ;;
    exe|win|windows) build_exe ;;
    all) build_appimage; build_exe ;;
    *) die "Unbekanntes Build-Ziel: $BUILD (appimage|exe|all)" ;;
  esac
  exit 0
fi

# ------------------------------------------------------------------ Installation
c_info "Installiere Laufzeit-Abhängigkeiten …"
npm install --omit=dev --no-audit --no-fund
c_ok "Abhängigkeiten installiert"

node tools/make-samples.js "$APP_DIR/samples" >/dev/null && c_ok "Beispieldateien in $APP_DIR/samples"

EXTRA=""
[[ -n "$BIND" ]] && EXTRA="$EXTRA --bind $BIND"
[[ -n "$PORT" ]] && EXTRA="$EXTRA --port $PORT"

if [[ $IS_WIN -eq 0 ]]; then
  mkdir -p "$BIN_DIR"
  cat > "$BIN_DIR/vpf" <<EOF
#!/usr/bin/env bash
exec node "$APP_DIR/src/cli.js"$EXTRA "\$@"
EOF
  chmod +x "$BIN_DIR/vpf"
  c_ok "Befehl installiert: $BIN_DIR/vpf"
  case ":$PATH:" in *":$BIN_DIR:"*) ;; *) c_warn "$BIN_DIR ist nicht im PATH – z. B. in ~/.bashrc ergänzen: export PATH=\"\$HOME/.local/bin:\$PATH\"" ;; esac

  if [[ $DESKTOP -eq 1 && "$OS" == "Linux" ]]; then
    mkdir -p "$DESKTOP_DIR"
    cat > "$DESKTOP_DIR/$NAME.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Virtual Print Fleet
Comment=Virtueller Druckmaschinenpark (Simulation)
Exec=$BIN_DIR/vpf --open
Icon=$APP_DIR/build/icon.png
Terminal=true
Categories=Utility;Development;
EOF
    c_ok "Startmenü-Eintrag angelegt"
  fi

  if [[ $SERVICE -eq 1 ]]; then
    command -v systemctl >/dev/null 2>&1 || die "systemd nicht verfügbar"
    mkdir -p "$SERVICE_DIR"
    cat > "$SERVICE_DIR/$NAME.service" <<EOF
[Unit]
Description=Virtual Print Fleet (Druckmaschinen-Simulation)
After=network.target

[Service]
ExecStart=$(command -v node) $APP_DIR/src/cli.js$EXTRA
Restart=on-failure

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable --now "$NAME.service"
    c_ok "Dienst gestartet (systemctl --user status $NAME)"
  fi
fi

echo
c_ok "Fertig."
echo "   Starten:      vpf --open        (oder: npm start)"
echo "   Oberfläche:   http://127.0.0.1:${PORT:-8650}"
echo "   Desktop-App:  ./install.sh --build appimage   bzw.   --build exe"
