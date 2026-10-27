#!/usr/bin/env bash
# Virtual Print Fleet – Installation und Builds
#
#   ./install.sh                  Installation für den aktuellen Benutzer (~/.local/bin/vpf, Startmenü)
#   sudo ./install.sh             systemweite Installation (/usr/local/bin/vpf, Startmenü für alle Benutzer)
#   ./install.sh --service        zusätzlich als Hintergrunddienst (systemd) starten
#   ./install.sh --drucker        Geräte zusätzlich als Systemdrucker (CUPS) eintragen – sichtbar in Druckdialogen/Apps
#   ./install.sh --build appimage AppImage bauen          -> dist/*.AppImage   (benötigt Node.js ≥ 22)
#   ./install.sh --build exe      Windows-.exe bauen      -> dist/*.exe        (unter Linux mit Wine/Docker)
#   ./install.sh --build all      beides
#   ./install.sh --uninstall      deinstallieren (siehe ./uninstall.sh --help)
#
# Weitere Optionen: --no-desktop  --bind 0.0.0.0  --port 8650
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAME="virtual-print-fleet"

BUILD=""; SERVICE=0; DESKTOP=1; BIND=""; PORT=""; PRINTERS=0
for a in "$@"; do [[ "$a" == "--uninstall" ]] && exec bash "$APP_DIR/uninstall.sh" "${@/--uninstall/}"; done
while [[ $# -gt 0 ]]; do
  case "$1" in
    --build) BUILD="${2:-all}"; shift 2 ;;
    --service) SERVICE=1; shift ;;
    --drucker|--printers) PRINTERS=1; shift ;;
    --no-desktop) DESKTOP=0; shift ;;
    --bind) BIND="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "Unbekannte Option: $1"; exit 1 ;;
  esac
done

c_ok()   { printf '\033[32m✔\033[0m %s\n' "$*"; }
c_info() { printf '\033[36m›\033[0m %s\n' "$*"; }
c_warn() { printf '\033[33m!\033[0m %s\n' "$*"; }
die()    { printf '\033[31m✘ %s\033[0m\n' "$*"; exit 1; }

OS="$(uname -s)"
case "$OS" in MINGW*|MSYS*|CYGWIN*) IS_WIN=1 ;; *) IS_WIN=0 ;; esac

# ------------------------------------------------------------------ Installationsart
# Mit root/sudo: systemweit. Der eigentliche Benutzer (SUDO_USER) bleibt Eigentümer der Projektdateien.
if [[ $IS_WIN -eq 0 && "$(id -u)" -eq 0 ]]; then
  MODE="system"
  RUN_USER="${SUDO_USER:-root}"
  BIN_DIR="/usr/local/bin"
  DESKTOP_DIR="/usr/share/applications"
  ICON_DIR="/usr/share/icons/hicolor/512x512/apps"
else
  MODE="user"
  RUN_USER="$(id -un)"
  BIN_DIR="${HOME}/.local/bin"
  DESKTOP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
  ICON_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/512x512/apps"
fi
RUN_GROUP="$(id -gn "$RUN_USER" 2>/dev/null || echo "$RUN_USER")"

# npm im Projektordner als eigentlicher Benutzer ausführen (sonst gehören node_modules root)
as_user() {
  if [[ "$MODE" == "system" && "$RUN_USER" != "root" ]]; then
    sudo -u "$RUN_USER" -H env "PATH=$PATH" "$@"
  else
    "$@"
  fi
}
fix_owner() {
  [[ "$MODE" == "system" && "$RUN_USER" != "root" ]] || return 0
  for p in "$APP_DIR/node_modules" "$APP_DIR/samples" "$APP_DIR/package-lock.json" "$APP_DIR/dist"; do
    [[ -e "$p" ]] && chown -R "$RUN_USER:$RUN_GROUP" "$p"
  done
  return 0
}

# ------------------------------------------------------------------ Node.js prüfen
# Mitgelieferte Laufzeit (portables Paket) hat Vorrang vor System-Node
if [[ -x "$APP_DIR/runtime/node" ]]; then NODE="$APP_DIR/runtime/node"; BUNDLED=1; else NODE="node"; BUNDLED=0; fi
if [[ $BUNDLED -eq 0 ]] && ! command -v node >/dev/null 2>&1; then
  die "Node.js (≥ 18) nicht gefunden – das ist die einzige Voraussetzung. Installation z. B.:
     Debian/Ubuntu:  sudo apt install nodejs   (aktueller: https://nodejs.org oder nvm)
     Fedora:         sudo dnf install nodejs
     Arch:           sudo pacman -S nodejs"
fi
NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" -ge 18 ]] || die "Node.js $NODE_MAJOR ist zu alt – benötigt wird Version 18 oder neuer."
c_ok "Node.js $("$NODE" -v)$([[ $BUNDLED -eq 1 ]] && echo " (mitgeliefert)") · Installation: $([[ $MODE == system ]] && echo "systemweit (für Benutzer $RUN_USER)" || echo "für Benutzer $RUN_USER")"

cd "$APP_DIR"

# Reste einer früheren Installation mit falschem Eigentümer (z. B. nach "sudo bash install.sh") reparieren
if [[ "$MODE" == "user" && -d node_modules && ! -w node_modules ]]; then
  die "node_modules gehört einem anderen Benutzer (vermutlich von einer Installation mit sudo).
     Einmal reparieren:  sudo chown -R $(id -un) \"$APP_DIR\"   – oder systemweit installieren: sudo ./install.sh"
fi

# ------------------------------------------------------------------ Builds
if [[ -n "$BUILD" ]]; then
  [[ "$NODE_MAJOR" -ge 22 ]] || die "Für Desktop-Builds (Electron/electron-builder) wird Node.js ≥ 22 benötigt (vorhanden: $(node -v)).
     Z. B. mit nvm:  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash && nvm install 22
     Ohne lokales Node 22: Tag pushen (git tag v0.1.0 && git push --tags) – GitHub Actions baut AppImage und .exe."
  c_info "Installiere Build-Abhängigkeiten (Electron, electron-builder) …"
  fix_owner
  as_user npm install --no-audit --no-fund --loglevel=error
  build_appimage() {
    [[ "$OS" == "Linux" ]] || { c_warn "AppImage kann nur unter Linux gebaut werden (oder per GitHub Actions)"; return; }
    as_user npx electron-builder --linux AppImage --publish never
    c_ok "AppImage: $(ls -1 dist/*.AppImage 2>/dev/null | tail -1)"
  }
  build_exe() {
    if [[ $IS_WIN -eq 1 ]]; then
      npx electron-builder --win nsis portable --publish never
    elif command -v wine >/dev/null 2>&1 || command -v wine64 >/dev/null 2>&1; then
      c_info "Baue Windows-Pakete mit Wine …"
      as_user npx electron-builder --win nsis portable --publish never
    elif command -v docker >/dev/null 2>&1; then
      c_info "Kein Wine gefunden – baue im Docker-Image electronuserland/builder:wine …"
      docker run --rm -v "$APP_DIR":/project -w /project electronuserland/builder:wine \
        /bin/bash -c "npm install --no-audit --no-fund --loglevel=error && npx electron-builder --win nsis portable --publish never"
    else
      c_warn "Für die .exe unter Linux wird Wine oder Docker benötigt."
      c_warn "Alternative: Repository auf GitHub pushen und einen Tag setzen (git tag v0.1.0 && git push --tags) –"
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
  fix_owner
  exit 0
fi

# ------------------------------------------------------------------ Installation
c_ok "Abhängigkeiten sind im Repository enthalten (src/vendor, ui/vendor) – kein npm install nötig"
as_user "$NODE" tools/make-samples.js "$APP_DIR/samples" >/dev/null && c_ok "Beispieldateien in $APP_DIR/samples"

EXTRA=""
[[ -n "$BIND" ]] && EXTRA="$EXTRA --bind $BIND"
[[ -n "$PORT" ]] && EXTRA="$EXTRA --port $PORT"

if [[ $IS_WIN -eq 1 ]]; then
  c_ok "Fertig. Start mit: node src/cli.js   (oder Desktop-App: ./install.sh --build exe)"
  exit 0
fi

mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/vpf" <<EOF
#!/usr/bin/env bash
# Virtual Print Fleet – installiert aus: $APP_DIR
exec "$NODE" "$APP_DIR/src/cli.js"$EXTRA "\$@"
EOF
chmod 755 "$BIN_DIR/vpf"
c_ok "Befehl installiert: $BIN_DIR/vpf"
if [[ "$MODE" == "user" ]]; then
  case ":$PATH:" in *":$BIN_DIR:"*) ;; *) c_warn "$BIN_DIR ist nicht im PATH – in ~/.bashrc ergänzen: export PATH=\"\$HOME/.local/bin:\$PATH\"" ;; esac
fi

# Installationsdaten für die Deinstallation festhalten
{
  echo "MODE=$MODE"; echo "RUN_USER=$RUN_USER"; echo "BIN=$BIN_DIR/vpf"
  echo "DESKTOP=$DESKTOP_DIR/$NAME.desktop"; echo "ICON=$ICON_DIR/$NAME.png"; echo "DATE=$(date -Iseconds)"
} > "$APP_DIR/.install-info"
fix_owner; [[ "$MODE" == "system" && "$RUN_USER" != "root" ]] && chown "$RUN_USER:$RUN_GROUP" "$APP_DIR/.install-info"

if [[ $DESKTOP -eq 1 && "$OS" == "Linux" ]]; then
  mkdir -p "$DESKTOP_DIR" "$ICON_DIR"
  cp "$APP_DIR/build/icon.png" "$ICON_DIR/$NAME.png"
  cat > "$DESKTOP_DIR/$NAME.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Virtual Print Fleet
Comment=Virtueller Druckmaschinenpark (Simulation)
Exec=$BIN_DIR/vpf --open
Icon=$NAME
Terminal=true
Categories=Utility;Development;
EOF
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true
  command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q "$(dirname "$(dirname "$ICON_DIR")")" >/dev/null 2>&1 || true
  c_ok "Startmenü-Eintrag angelegt ($DESKTOP_DIR)"
fi

if [[ $SERVICE -eq 1 ]]; then
  command -v systemctl >/dev/null 2>&1 || die "systemd nicht verfügbar"
  NODE_BIN="$([[ $BUNDLED -eq 1 ]] && echo "$NODE" || command -v node)"
  if [[ "$MODE" == "system" ]]; then
    cat > "/etc/systemd/system/$NAME.service" <<EOF
[Unit]
Description=Virtual Print Fleet (Druckmaschinen-Simulation)
After=network.target

[Service]
User=$RUN_USER
ExecStart="$NODE_BIN" "$APP_DIR/src/cli.js"$EXTRA
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable --now "$NAME.service"
    c_ok "Systemdienst läuft als $RUN_USER (systemctl status $NAME)"
  else
    SERVICE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
    mkdir -p "$SERVICE_DIR"
    cat > "$SERVICE_DIR/$NAME.service" <<EOF
[Unit]
Description=Virtual Print Fleet (Druckmaschinen-Simulation)

[Service]
ExecStart="$NODE_BIN" "$APP_DIR/src/cli.js"$EXTRA
Restart=on-failure

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable --now "$NAME.service"
    c_ok "Benutzerdienst läuft (systemctl --user status $NAME)"
  fi
fi

if [[ $PRINTERS -eq 1 ]]; then
  c_info "Trage Geräte als Systemdrucker ein …"
  if "$NODE" "$APP_DIR/src/cli.js" drucker-einrichten $EXTRA; then c_ok "Systemdrucker eingetragen (lpstat -v | grep VPF_)"
  else c_warn "Eintragen fehlgeschlagen – mit sudo erneut: sudo $BIN_DIR/vpf drucker-einrichten"; fi
fi

echo
c_ok "Fertig."
echo "   Starten:       vpf --open        (als $RUN_USER, nicht mit sudo)"
echo "   Oberfläche:    http://127.0.0.1:${PORT:-8650}"
[[ $PRINTERS -eq 0 ]] && echo "   Für Druck-Apps sichtbar machen: $([[ $MODE == system ]] && echo 'sudo ')vpf drucker-einrichten   (oder Button in der Oberfläche)"
echo "   Deinstallieren: $([[ $MODE == system ]] && echo 'sudo ')./uninstall.sh   (mit --purge auch Daten und Abhängigkeiten)"
[[ "$NODE_MAJOR" -lt 22 ]] && c_warn "Hinweis: Für AppImage/.exe-Builds wird Node.js ≥ 22 benötigt – die Simulation selbst läuft mit $(node -v)."
exit 0
