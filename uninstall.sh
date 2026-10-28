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
# Sprache / language: --lang de|en, sonst Systemsprache
VPF_LANG_=""; prev=""
for a in "$@"; do case "$a" in --lang=*) VPF_LANG_="${a#--lang=}" ;; esac; [[ "$prev" == "--lang" ]] && VPF_LANG_="$a"; prev="$a"; done
if [[ -z "$VPF_LANG_" ]]; then case "${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}" in de*|C|C.*|POSIX|"") VPF_LANG_="de" ;; *) VPF_LANG_="en" ;; esac; fi
[[ "$VPF_LANG_" == en* ]] && VPF_LANG_="en" || VPF_LANG_="de"
t() { if [[ "$VPF_LANG_" == en ]]; then printf '%s' "$2"; else printf '%s' "$1"; fi; }
skip=0
for a in "$@"; do
  if [[ $skip -eq 1 ]]; then skip=0; continue; fi
  case "$a" in
    --purge) PURGE=1 ;;
    -y|--yes) YES=1 ;;
    --lang) skip=1 ;;
    --lang=*) ;;
    -h|--help)
      if [[ "$VPF_LANG_" == en ]]; then cat <<'EOT'
Virtual Print Fleet – uninstall

  ./uninstall.sh            remove the "vpf" command, menu entry, icon and service
  sudo ./uninstall.sh       also remove a system-wide installation and leftovers under /root
  ./uninstall.sh --purge    also delete data (jobs, hot folders, machine park settings),
                            node_modules, samples and dist in the project folder
  -y / --yes                without confirmation

The project folder itself (source code) is always kept – delete it by hand if needed.
EOT
      else sed -n '2,10p' "$0"; fi
      exit 0 ;;
    "") ;;
    *) echo "$(t "Unbekannte Option" "Unknown option"): $a"; exit 1 ;;
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
      if rm -rf -- "$p" 2>/dev/null; then c_ok "$(t "entfernt" "removed"): $p"; removed=$((removed+1)); else c_warn "$(t "keine Berechtigung" "permission denied"): $p ($(t "mit sudo ausführen" "run with sudo"))"; fi
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
      rm_if "/etc/polkit-1/rules.d/49-$NAME.rules"
    else
      c_warn "$(t "Systemdienst" "System service") /etc/systemd/system/$NAME.service $(t "gefunden – zum Entfernen" "found – to remove it"): sudo ./uninstall.sh"
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
[[ $IS_ROOT -eq 1 ]] && rm_if "/etc/polkit-1/rules.d/49-$NAME.rules"
# Noch laufende Simulationen aus diesem Projektordner beenden
if command -v pgrep >/dev/null 2>&1; then
  pids="$(pgrep -f "$APP_DIR/src/cli.js" 2>/dev/null | grep -v "^$$\$" || true)"
  if [[ -n "$pids" ]]; then
    kill $pids 2>/dev/null && c_ok "$(t "laufende Simulation/Steuerzentrale beendet" "running simulation/control centre stopped") (PID $(echo $pids | tr '\n' ' '))" || c_warn "$(t "laufende Simulation konnte nicht beendet werden" "running simulation could not be stopped") (PID $pids)"
  fi
fi

# ------------------------------------------------------------------ Systemdrucker (CUPS)
if command -v lpstat >/dev/null 2>&1 && command -v lpadmin >/dev/null 2>&1; then
  for p in $(LC_ALL=C lpstat -e 2>/dev/null | grep '^VPF_'); do
    if lpadmin -x "$p" 2>/dev/null; then c_ok "$(t "Systemdrucker entfernt" "System printer removed"): $p"; removed=$((removed+1)); else c_warn "$(t "Systemdrucker" "System printer") $p: $(t "keine Berechtigung" "permission denied") (sudo ./uninstall.sh)"; fi
  done
fi

# Gespeicherte Druckoptionen/Standarddrucker für VPF-Drucker (lpoptions) entfernen
for f in /etc/cups/lpoptions "${HOMES[@]/%//.cups/lpoptions}"; do
  [[ -f "$f" ]] && grep -qE '^(Default|Dest) VPF_' "$f" 2>/dev/null || continue
  if sed -i -E '/^(Default|Dest) VPF_/d' "$f" 2>/dev/null; then c_ok "$(t "Druckoptionen der VPF-Drucker entfernt" "Print options of the VPF printers removed"): $f"; removed=$((removed+1)); else c_warn "$(t "keine Berechtigung" "permission denied"): $f"; fi
done
# Reste temporärer Treiberdateien (nur nach Abbruch vorhanden)
for d in "${TMPDIR:-/tmp}"/vpf-ppd-* "${TMPDIR:-/tmp}"/vpf-chk-*; do [[ -e "$d" ]] && rm_if "$d"; done

# ------------------------------------------------------------------ Befehl, Startmenü, Symbol
if [[ $IS_ROOT -eq 1 ]]; then
  rm_if /usr/local/bin/vpf "/usr/share/applications/$NAME.desktop" "/usr/share/icons/hicolor/512x512/apps/$NAME.png"
elif [[ -e /usr/local/bin/vpf || -e "/usr/share/applications/$NAME.desktop" ]]; then
  c_warn "$(t "Systemweite Installation gefunden (/usr/local/bin/vpf) – zum Entfernen" "System-wide installation found (/usr/local/bin/vpf) – to remove it"): sudo ./uninstall.sh"
fi
for h in "${HOMES[@]}"; do
  rm_if "$h/.local/bin/vpf" "$h/.local/share/applications/$NAME.desktop" "$h/.local/share/icons/hicolor/512x512/apps/$NAME.png"
done
command -v gtk-update-icon-cache >/dev/null 2>&1 && { gtk-update-icon-cache -q "$REAL_HOME/.local/share/icons/hicolor" >/dev/null 2>&1; [[ $IS_ROOT -eq 1 ]] && gtk-update-icon-cache -q /usr/share/icons/hicolor >/dev/null 2>&1; } || true
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
    c_info "$(t "Folgendes wird endgültig gelöscht (inkl. aller Jobs, Protokolle und Hotfolder):" "The following will be deleted permanently (incl. all jobs, logs and hot folders):")"
    for d in "${existing[@]}"; do echo "     $d"; done
    if [[ $YES -eq 0 ]]; then
      read -r -p "   $(t "Fortfahren? [j/N]" "Continue? [y/N]") " ans
      [[ "$ans" =~ ^[jJyY]$ ]] || { c_warn "$(t "Purge abgebrochen – Daten bleiben erhalten" "Purge cancelled – data is kept")"; existing=(); }
    fi
    rm_if "${existing[@]}"
  fi
else
  for h in "${HOMES[@]}"; do [[ -d "$h/.local/share/$NAME" ]] && c_info "$(t "Daten bleiben erhalten" "Data is kept"): $h/.local/share/$NAME  ($(t "löschen mit --purge" "delete with --purge"))"; done
fi

echo
if [[ $removed -eq 0 ]]; then c_info "$(t "Nichts zu entfernen gefunden." "Nothing found to remove.")"; else c_ok "$(t "Deinstallation abgeschlossen." "Uninstallation complete.")"; fi
echo "   $(t "Der Projektordner $APP_DIR bleibt bestehen." "The project folder $APP_DIR is kept.")"
