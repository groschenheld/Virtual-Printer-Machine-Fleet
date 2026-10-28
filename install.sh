#!/usr/bin/env bash
# Virtual Print Fleet – Installation und Builds
#
#   ./install.sh                  Installation für den aktuellen Benutzer (~/.local/bin/vpf, Startmenü)
#   sudo ./install.sh             systemweite Installation (/usr/local/bin/vpf, Startmenü für alle Benutzer)
#   ./install.sh --service        zusätzlich als Hintergrunddienst (systemd) starten
#   ./install.sh --eigene-ips     jedes Gerät eigene IP (127.0.0.11 …) mit Standardports IPP 631 / SNMP 161 (mit --service)
#   ./install.sh --drucker        Geräte zusätzlich als Systemdrucker (CUPS) eintragen – sichtbar in Druckdialogen/Apps
#   ./install.sh --build appimage AppImage bauen          -> dist/*.AppImage   (benötigt Node.js ≥ 22)
#   ./install.sh --build exe      Windows-.exe bauen      -> dist/*.exe        (unter Linux mit Wine/Docker)
#   ./install.sh --build all      beides
#   ./install.sh --uninstall      deinstallieren (siehe ./uninstall.sh --help)
#
# Weitere Optionen: --no-desktop  --bind 0.0.0.0  --port 8650  --lang de|en
#
# English: ./install.sh [--service] [--own-ips] [--printers] [--lang en] – see ./install.sh --help
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAME="virtual-print-fleet"

# Sprache / language: --lang de|en, sonst aus der Systemsprache
VPF_LANG_=""; prev=""
for a in "$@"; do
  case "$a" in --lang=*) VPF_LANG_="${a#--lang=}" ;; esac
  [[ "$prev" == "--lang" ]] && VPF_LANG_="$a"
  prev="$a"
done
LANG_SET=1
if [[ -z "$VPF_LANG_" ]]; then
  LANG_SET=0
  case "${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}" in de*|C|C.*|POSIX|"") VPF_LANG_="de" ;; *) VPF_LANG_="en" ;; esac
fi
[[ "$VPF_LANG_" == en* ]] && VPF_LANG_="en" || VPF_LANG_="de"
t() { if [[ "$VPF_LANG_" == en ]]; then printf '%s' "$2"; else printf '%s' "$1"; fi; }

usage() {
  if [[ "$VPF_LANG_" == en ]]; then cat <<'EOT'
Virtual Print Fleet – installation and builds

  ./install.sh                  install for the current user (~/.local/bin/vpf, menu entry)
  sudo ./install.sh             system-wide installation (/usr/local/bin/vpf, menu entry for all users)
  ./install.sh --service        additionally run as background service (systemd)
  ./install.sh --own-ips        every device its own IP (127.0.0.11 …) with standard ports IPP 631 / SNMP 161 (with --service)
                                (German alias: --eigene-ips)
  ./install.sh --printers       also register the devices as system printers (CUPS) – visible in print dialogs/apps
  ./install.sh --build appimage build an AppImage        -> dist/*.AppImage   (needs Node.js ≥ 22)
  ./install.sh --build exe      build a Windows .exe     -> dist/*.exe        (on Linux with Wine/Docker)
  ./install.sh --build all      both
  ./install.sh --uninstall      uninstall (see ./uninstall.sh --help)

More options: --no-desktop  --bind 0.0.0.0  --port 8650  --lang de|en
EOT
  else sed -n '2,15p' "$0"; fi
}

BUILD=""; SERVICE=0; DESKTOP=1; BIND=""; PORT=""; PRINTERS=0; OWNIPS=0
for a in "$@"; do [[ "$a" == "--uninstall" ]] && exec bash "$APP_DIR/uninstall.sh" "${@/--uninstall/}"; done
while [[ $# -gt 0 ]]; do
  case "$1" in
    --build) BUILD="${2:-all}"; shift 2 ;;
    --service) SERVICE=1; shift ;;
    --drucker|--printers) PRINTERS=1; shift ;;
    --eigene-ips|--own-ips) OWNIPS=1; shift ;;
    --lang) shift 2 ;;
    --lang=*) shift ;;
    --no-desktop) DESKTOP=0; shift ;;
    --bind) BIND="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "$(t "Unbekannte Option" "Unknown option"): $1"; exit 1 ;;
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
  die "$(t "Node.js (≥ 18) nicht gefunden – das ist die einzige Voraussetzung. Installation z. B.:" "Node.js (≥ 18) not found – it is the only requirement. Install e.g.:")
     Debian/Ubuntu:  sudo apt install nodejs   ($(t "aktueller" "newer"): https://nodejs.org $(t "oder" "or") nvm)
     Fedora:         sudo dnf install nodejs
     Arch:           sudo pacman -S nodejs"
fi
NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" -ge 18 ]] || die "$(t "Node.js $NODE_MAJOR ist zu alt – benötigt wird Version 18 oder neuer." "Node.js $NODE_MAJOR is too old – version 18 or newer is required.")"
if [[ $MODE == system ]]; then INST_TXT="$(t "systemweit (für Benutzer $RUN_USER)" "system-wide (for user $RUN_USER)")"; else INST_TXT="$(t "für Benutzer $RUN_USER" "for user $RUN_USER")"; fi
c_ok "Node.js $("$NODE" -v)$([[ $BUNDLED -eq 1 ]] && t " (mitgeliefert)" " (bundled)") · Installation: $INST_TXT"

cd "$APP_DIR"

# Reste einer früheren Installation mit falschem Eigentümer (z. B. nach "sudo bash install.sh") reparieren
if [[ "$MODE" == "user" && -d node_modules && ! -w node_modules ]]; then
  die "$(t "node_modules gehört einem anderen Benutzer (vermutlich von einer Installation mit sudo)." "node_modules belongs to another user (probably from an installation with sudo).")
     $(t "Einmal reparieren" "Repair once"):  sudo chown -R $(id -un) \"$APP_DIR\"   – $(t "oder systemweit installieren" "or install system-wide"): sudo ./install.sh"
fi

# ------------------------------------------------------------------ Builds
if [[ -n "$BUILD" ]]; then
  [[ "$NODE_MAJOR" -ge 22 ]] || die "$(t "Für Desktop-Builds (Electron/electron-builder) wird Node.js ≥ 22 benötigt (vorhanden: $(node -v))." "Desktop builds (Electron/electron-builder) need Node.js ≥ 22 (found: $(node -v)).")
     $(t "Z. B. mit nvm" "E.g. with nvm"):  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash && nvm install 22
     $(t "Ohne lokales Node 22: Tag pushen (git tag v0.1.0 && git push --tags) – GitHub Actions baut AppImage und .exe." "Without local Node 22: push a tag (git tag v0.1.0 && git push --tags) – GitHub Actions builds the AppImage and .exe.")"
  c_info "$(t "Installiere Build-Abhängigkeiten (Electron, electron-builder) …" "Installing build dependencies (Electron, electron-builder) …")"
  fix_owner
  as_user npm install --no-audit --no-fund --loglevel=error
  build_appimage() {
    [[ "$OS" == "Linux" ]] || { c_warn "$(t "AppImage kann nur unter Linux gebaut werden (oder per GitHub Actions)" "AppImage can only be built on Linux (or via GitHub Actions)")"; return; }
    as_user npx electron-builder --linux AppImage --publish never
    c_ok "AppImage: $(ls -1 dist/*.AppImage 2>/dev/null | tail -1)"
  }
  build_exe() {
    if [[ $IS_WIN -eq 1 ]]; then
      npx electron-builder --win nsis portable --publish never
    elif command -v wine >/dev/null 2>&1 || command -v wine64 >/dev/null 2>&1; then
      c_info "$(t "Baue Windows-Pakete mit Wine …" "Building Windows packages with Wine …")"
      as_user npx electron-builder --win nsis portable --publish never
    elif command -v docker >/dev/null 2>&1; then
      c_info "$(t "Kein Wine gefunden – baue im Docker-Image electronuserland/builder:wine …" "No Wine found – building in the Docker image electronuserland/builder:wine …")"
      docker run --rm -v "$APP_DIR":/project -w /project electronuserland/builder:wine \
        /bin/bash -c "npm install --no-audit --no-fund --loglevel=error && npx electron-builder --win nsis portable --publish never"
    else
      c_warn "$(t "Für die .exe unter Linux wird Wine oder Docker benötigt." "Building the .exe on Linux needs Wine or Docker.")"
      c_warn "$(t "Alternative: Repository auf GitHub pushen und einen Tag setzen (git tag v0.1.0 && git push --tags) –" "Alternative: push the repository to GitHub and set a tag (git tag v0.1.0 && git push --tags) –")"
      c_warn "$(t "der Workflow .github/workflows/build.yml baut AppImage und .exe und hängt sie an das Release." "the workflow .github/workflows/build.yml builds the AppImage and .exe and attaches them to the release.")"
      return
    fi
    c_ok "Windows: $(ls -1 dist/*.exe 2>/dev/null | tr '\n' ' ')"
  }
  case "$BUILD" in
    appimage) build_appimage ;;
    exe|win|windows) build_exe ;;
    all) build_appimage; build_exe ;;
    *) die "$(t "Unbekanntes Build-Ziel" "Unknown build target"): $BUILD (appimage|exe|all)" ;;
  esac
  fix_owner
  exit 0
fi

# ------------------------------------------------------------------ Installation
c_ok "$(t "Abhängigkeiten sind im Repository enthalten (src/vendor, ui/vendor) – kein npm install nötig" "Dependencies are included in the repository (src/vendor, ui/vendor) – no npm install needed")"
as_user "$NODE" tools/make-samples.js "$APP_DIR/samples" >/dev/null && c_ok "$(t "Beispieldateien in" "Sample files in") $APP_DIR/samples"

EXTRA=""
[[ -n "$BIND" ]] && EXTRA="$EXTRA --bind $BIND"
[[ -n "$PORT" ]] && EXTRA="$EXTRA --port $PORT"
[[ $OWNIPS -eq 1 ]] && EXTRA="$EXTRA --eigene-ips"

if [[ $IS_WIN -eq 1 ]]; then
  c_ok "$(t "Fertig. Start mit: node src/cli.js   (oder Desktop-App: ./install.sh --build exe)" "Done. Start with: node src/cli.js   (or desktop app: ./install.sh --build exe)")"
  exit 0
fi

mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/vpf" <<EOF
#!/usr/bin/env bash
# Virtual Print Fleet – installiert aus: $APP_DIR
exec "$NODE" "$APP_DIR/src/cli.js" "\$@"$EXTRA
EOF
chmod 755 "$BIN_DIR/vpf"
c_ok "$(t "Befehl installiert" "Command installed"): $BIN_DIR/vpf"
if [[ "$MODE" == "user" ]]; then
  case ":$PATH:" in *":$BIN_DIR:"*) ;; *) c_warn "$BIN_DIR $(t "ist nicht im PATH – in ~/.bashrc ergänzen" "is not in PATH – add to ~/.bashrc"): export PATH=\"\$HOME/.local/bin:\$PATH\"" ;; esac
fi

# Installationsdaten für die Deinstallation festhalten
{
  echo "MODE=$MODE"; echo "RUN_USER=$RUN_USER"; echo "BIN=$BIN_DIR/vpf"
  echo "DESKTOP=$DESKTOP_DIR/$NAME.desktop"; echo "ICON=$ICON_DIR/$NAME.png"; echo "DATE=$(date -Iseconds)"
} > "$APP_DIR/.install-info"
fix_owner; [[ "$MODE" == "system" && "$RUN_USER" != "root" ]] && chown "$RUN_USER:$RUN_GROUP" "$APP_DIR/.install-info"

# Sprache für Oberfläche/Simulation speichern (wenn angegeben oder noch keine gewählt)
as_user "$NODE" -e '
const fs = require("fs"), p = require("path");
const d = require(process.argv[1]).defaultDataDir();
const f = p.join(d, "settings.json");
let j = {}; try { j = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
if (process.argv[3] === "1" || !j.lang) { j.lang = process.argv[2]; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(f, JSON.stringify(j, null, 2)); }
' "$APP_DIR/src/core/store.js" "$VPF_LANG_" "$LANG_SET" || true

# Laufende Steuerzentrale einer älteren Version beenden (startet beim nächsten Aufruf neu)
if command -v pgrep >/dev/null 2>&1; then
  for pid in $(pgrep -f "$APP_DIR/src/cli.js control-serve" 2>/dev/null || true); do kill "$pid" 2>/dev/null || true; done
fi

if [[ $DESKTOP -eq 1 && "$OS" == "Linux" ]]; then
  mkdir -p "$DESKTOP_DIR" "$ICON_DIR"
  cp "$APP_DIR/build/icon.png" "$ICON_DIR/$NAME.png"
  cat > "$DESKTOP_DIR/$NAME.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Virtual Print Fleet
Comment=Virtual printing machine park (simulation) – control centre
Comment[de]=Virtueller Druckmaschinenpark (Simulation) – Steuerzentrale
Exec=$BIN_DIR/vpf steuerung
Icon=$NAME
Terminal=false
Categories=Utility;Development;
Actions=ui;

[Desktop Action ui]
Name=Open interface
Name[de]=Oberfläche öffnen
Exec=xdg-open http://127.0.0.1:${PORT:-8650}/
EOF
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true
  command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q "$(dirname "$(dirname "$ICON_DIR")")" >/dev/null 2>&1 || true
  c_ok "$(t "Startmenü-Eintrag „Virtual Print Fleet“ (Steuerzentrale) angelegt" "Menu entry “Virtual Print Fleet” (control centre) created") ($DESKTOP_DIR)"
fi

if [[ $SERVICE -eq 1 ]]; then
  command -v systemctl >/dev/null 2>&1 || die "$(t "systemd nicht verfügbar" "systemd not available")"
  NODE_BIN="$([[ $BUNDLED -eq 1 ]] && echo "$NODE" || command -v node)"
  if [[ "$MODE" == "system" ]]; then
    cat > "/etc/systemd/system/$NAME.service" <<EOF
[Unit]
Description=Virtual Print Fleet (Druckmaschinen-Simulation)
After=network.target

[Service]
User=$RUN_USER
# Standardports (631, 515, 161 …) ohne Root-Rechte binden dürfen
AmbientCapabilities=CAP_NET_BIND_SERVICE
ExecStart="$NODE_BIN" "$APP_DIR/src/cli.js"$EXTRA
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable "$NAME.service" >/dev/null 2>&1
    systemctl restart "$NAME.service"   # neu starten, damit eine aktualisierte Version läuft
    c_ok "$(t "Systemdienst läuft als" "System service running as") $RUN_USER (systemctl status $NAME)"
    # Steuerzentrale darf den Dienst als normaler Benutzer starten/stoppen (Polkit)
    if [[ -d /etc/polkit-1/rules.d && "$RUN_USER" != "root" ]]; then
      cat > "/etc/polkit-1/rules.d/49-$NAME.rules" <<EOF
// Virtual Print Fleet: $RUN_USER darf den Simulationsdienst über die Steuerzentrale starten/stoppen
// Virtual Print Fleet: $RUN_USER may start/stop the simulation service from the control centre
polkit.addRule(function (action, subject) {
  if (action.id == "org.freedesktop.systemd1.manage-units" &&
      action.lookup("unit") == "$NAME.service" && subject.user == "$RUN_USER") {
    var verb = action.lookup("verb");
    if (verb == "start" || verb == "stop" || verb == "restart") return polkit.Result.YES;
  }
});
EOF
      chmod 644 "/etc/polkit-1/rules.d/49-$NAME.rules"
      c_ok "$(t "Steuerzentrale darf den Dienst starten/stoppen (Polkit-Regel)" "Control centre may start/stop the service (polkit rule)")"
    fi
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
    systemctl --user enable "$NAME.service" >/dev/null 2>&1
    systemctl --user restart "$NAME.service"
    c_ok "$(t "Benutzerdienst läuft" "User service running") (systemctl --user status $NAME)"
  fi
fi

if [[ $OWNIPS -eq 1 && ( $SERVICE -eq 0 || "$MODE" != "system" ) ]]; then
  c_warn "$(t "--eigene-ips braucht Rechte für Ports unter 1024: am besten als Systemdienst einrichten (sudo ./install.sh --service --eigene-ips)." "--own-ips needs permission for ports below 1024: best set it up as a system service (sudo ./install.sh --service --own-ips).")"
  c_warn "$(t "Alternativ" "Alternatively"): sudo setcap cap_net_bind_service=+ep \"$(readlink -f "$(command -v node)")\"  ($(t "gilt dann für alle Node-Programme" "then applies to all Node programs"))"
fi
if [[ $SERVICE -eq 1 && $PRINTERS -eq 1 ]]; then sleep 2; fi
if [[ $PRINTERS -eq 1 ]]; then
  c_info "$(t "Trage Geräte als Systemdrucker ein …" "Registering devices as system printers …")"
  if "$NODE" "$APP_DIR/src/cli.js" drucker-einrichten $EXTRA; then c_ok "$(t "Systemdrucker eingetragen" "System printers registered") (lpstat -v | grep VPF_)"
  else c_warn "$(t "Eintragen fehlgeschlagen – mit sudo erneut" "Registration failed – again with sudo"): sudo $BIN_DIR/vpf drucker-einrichten"; fi
fi

echo
c_ok "$(t "Fertig." "Done.")"
SUDO_P="$([[ $MODE == system ]] && echo 'sudo ')"
echo "   $(t "Steuerzentrale:  Startmenü „Virtual Print Fleet“ oder: vpf steuerung" "Control centre:  menu entry “Virtual Print Fleet” or: vpf control")"
echo "   $(t "Starten:         vpf --open        (als $RUN_USER, nicht mit sudo)" "Start:           vpf --open        (as $RUN_USER, not with sudo)")"
echo "   $(t "Oberfläche:      " "Interface:       ")http://127.0.0.1:${PORT:-8650}"
[[ $PRINTERS -eq 0 ]] && echo "   $(t "Für Druck-Apps sichtbar machen" "Make visible for print apps"): ${SUDO_P}vpf drucker-einrichten   ($(t "oder Button in der Oberfläche" "or button in the interface"))"
echo "   $(t "Deinstallieren" "Uninstall"):  ${SUDO_P}./uninstall.sh   ($(t "mit --purge auch Daten und Abhängigkeiten" "with --purge also data and dependencies"))"
[[ "$NODE_MAJOR" -lt 22 ]] && c_warn "$(t "Hinweis: Für AppImage/.exe-Builds wird Node.js ≥ 22 benötigt – die Simulation selbst läuft mit" "Note: AppImage/.exe builds need Node.js ≥ 22 – the simulation itself runs with") $(node -v)."
exit 0
