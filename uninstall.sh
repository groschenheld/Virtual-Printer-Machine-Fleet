#!/usr/bin/env bash
# Virtual Print Fleet – Deinstallation
#
#   ./uninstall.sh            Befehl "vpf", Startmenü-Eintrag, Symbol und Dienst entfernen
#   sudo ./uninstall.sh       zusätzlich systemweite Installation und Reste unter /root entfernen
#   ./uninstall.sh --purge    außerdem Daten (Jobs, Hotfolder, Maschinenpark-Einstellungen),
#                             node_modules, samples und dist im Projektordner löschen
#   -y / --yes                ohne Rückfrage
#
# Der Projektordner selbst (Quellcode) bleibt immer erhalten – den löscht man bei Bedarf von Hand.
set -uo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAME="virtual-print-fleet"
PURGE=0; YES=0
for a in "$@"; do
  case "$a" in
    --purge) PURGE=1 ;;
    -y|--yes) YES=1 ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    "") ;;
    *) echo "Unbekannte Option: $a"; exit 1 ;;
  esac
done

c_ok()   { printf '\033[32m✔\033[0m %s\n' "$*"; }
c_info() { printf '\033[36m›\033[0m %s\n' "$*"; }
c_warn() { printf '\033[33m!\033[0m %s\n' "$*"; }

IS_ROOT=0; [[ "$(id -u)" -eq 0 ]] && IS_ROOT=1
REAL_USER="${SUDO_USER:-$(id -un)}"
REAL_HOME="$(getent passwd "$REAL_USER" 2>/dev/null | cut -d: -f6)"; REAL_HOME="${REAL_HOME:-$HOME}"

# Home-Verzeichnisse, deren Benutzer-Installation entfernt wird
HOMES=("$REAL_HOME")
[[ $IS_ROOT -eq 1 && "$REAL_HOME" != "/root" && -d /root ]] && HOMES+=("/root")

removed=0
rm_if() {
  for p in "$@"; do
    if [[ -e "$p" || -L "$p" ]]; then
      if rm -rf -- "$p" 2>/dev/null; then c_ok "entfernt: $p"; removed=$((removed+1)); else c_warn "keine Berechtigung: $p (mit sudo ausführen)"; fi
    fi
  done
}

# ------------------------------------------------------------------ Laufende Instanzen / Dienste
if command -v systemctl >/dev/null 2>&1; then
  if [[ -f "/etc/systemd/system/$NAME.service" ]]; then
    if [[ $IS_ROOT -eq 1 ]]; then
      systemctl disable --now "$NAME.service" >/dev/null 2>&1 || true
      rm_if "/etc/systemd/system/$NAME.service"
      systemctl daemon-reload >/dev/null 2>&1 || true
    else
      c_warn "Systemdienst /etc/systemd/system/$NAME.service gefunden – zum Entfernen: sudo ./uninstall.sh"
    fi
  fi
  for h in "${HOMES[@]}"; do
    unit="$h/.config/systemd/user/$NAME.service"
    [[ -f "$unit" ]] || continue
    owner="$(stat -c %U "$unit" 2>/dev/null || echo "$REAL_USER")"
    if [[ "$owner" == "$(id -un)" ]]; then
      systemctl --user disable --now "$NAME.service" >/dev/null 2>&1 || true
      systemctl --user daemon-reload >/dev/null 2>&1 || true
    elif [[ $IS_ROOT -eq 1 ]]; then
      uid="$(id -u "$owner")"
      sudo -u "$owner" XDG_RUNTIME_DIR="/run/user/$uid" systemctl --user disable --now "$NAME.service" >/dev/null 2>&1 || true
    fi
    rm_if "$unit"
  done
fi
# Noch laufende Simulationen aus diesem Projektordner beenden
if command -v pgrep >/dev/null 2>&1; then
  pids="$(pgrep -f "$APP_DIR/src/cli.js" 2>/dev/null | grep -v "^$$\$" || true)"
  if [[ -n "$pids" ]]; then
    kill $pids 2>/dev/null && c_ok "laufende Simulation beendet (PID $(echo $pids | tr '\n' ' '))" || c_warn "laufende Simulation (PID $pids) konnte nicht beendet werden"
  fi
fi

# ------------------------------------------------------------------ Systemdrucker (CUPS)
if command -v lpstat >/dev/null 2>&1 && command -v lpadmin >/dev/null 2>&1; then
  for p in $(lpstat -v 2>/dev/null | sed -n 's/^[^ ]* [^ ]* \(VPF_[^:]*\):.*/\1/p'); do
    if lpadmin -x "$p" 2>/dev/null; then c_ok "Systemdrucker entfernt: $p"; removed=$((removed+1)); else c_warn "Systemdrucker $p: keine Berechtigung (sudo ./uninstall.sh)"; fi
  done
fi

# ------------------------------------------------------------------ Befehl, Startmenü, Symbol
if [[ $IS_ROOT -eq 1 ]]; then
  rm_if /usr/local/bin/vpf "/usr/share/applications/$NAME.desktop" "/usr/share/icons/hicolor/512x512/apps/$NAME.png"
elif [[ -e /usr/local/bin/vpf || -e "/usr/share/applications/$NAME.desktop" ]]; then
  c_warn "Systemweite Installation gefunden (/usr/local/bin/vpf) – zum Entfernen: sudo ./uninstall.sh"
fi
for h in "${HOMES[@]}"; do
  rm_if "$h/.local/bin/vpf" "$h/.local/share/applications/$NAME.desktop" "$h/.local/share/icons/hicolor/512x512/apps/$NAME.png"
done
command -v update-desktop-database >/dev/null 2>&1 && { update-desktop-database "$REAL_HOME/.local/share/applications" >/dev/null 2>&1; [[ $IS_ROOT -eq 1 ]] && update-desktop-database /usr/share/applications >/dev/null 2>&1; } || true
rm_if "$APP_DIR/.install-info"

# ------------------------------------------------------------------ Purge
if [[ $PURGE -eq 1 ]]; then
  DATA_DIRS=()
  for h in "${HOMES[@]}"; do DATA_DIRS+=("$h/.local/share/$NAME" "$h/.config/Virtual Print Fleet"); done
  [[ -n "${VPF_DATA:-}" ]] && DATA_DIRS+=("$VPF_DATA")
  existing=()
  for d in "${DATA_DIRS[@]}" "$APP_DIR/node_modules" "$APP_DIR/samples" "$APP_DIR/dist" "$APP_DIR/package-lock.json"; do [[ -e "$d" ]] && existing+=("$d"); done
  if [[ ${#existing[@]} -gt 0 ]]; then
    echo
    c_info "Folgendes wird endgültig gelöscht (inkl. aller Jobs, Protokolle und Hotfolder):"
    for d in "${existing[@]}"; do echo "     $d"; done
    if [[ $YES -eq 0 ]]; then
      read -r -p "   Fortfahren? [j/N] " ans
      [[ "$ans" =~ ^[jJyY]$ ]] || { c_warn "Purge abgebrochen – Daten bleiben erhalten"; existing=(); }
    fi
    rm_if "${existing[@]}"
  fi
else
  for h in "${HOMES[@]}"; do [[ -d "$h/.local/share/$NAME" ]] && c_info "Daten bleiben erhalten: $h/.local/share/$NAME  (löschen mit --purge)"; done
fi

echo
if [[ $removed -eq 0 ]]; then c_info "Nichts zu entfernen gefunden."; else c_ok "Deinstallation abgeschlossen."; fi
echo "   Der Projektordner $APP_DIR bleibt bestehen."
