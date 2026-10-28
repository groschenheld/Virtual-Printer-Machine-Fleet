# Virtual Print Fleet

**Deutsch** · [English](README.md)

Virtueller Druckmaschinenpark zum Testen von Druck-Apps: Canon- und Xerox-Produktionsmaschinen mit Finishern, Canon colorWAVE, Epson-Großformatplotter, Rollen-Fotodrucker bis 210 mm und Roland Print-&-Cut-Plotter – jeweils mit einem simulierten Front-End (Fiery, PRISMAsync, FreeFlow, ClearConnect/Publisher, Edge Print, Order Controller, VersaWorks).

Die Geräte nehmen Jobs über **dieselben Schnittstellen** entgegen wie die echten Maschinen (IPP, LPR, Socket 9100 mit PJL, JDF/JMF, Fiery-API-Nachbildung, Hotfolder), verarbeiten sie wie ein Front-End (Ticket, Materialwahl, Ausschießen, Finishing) und zeigen anschließend **auf welchem Bogen bzw. welcher Rolle was wie gelegt wurde, wo geschnitten, gefalzt, geheftet und gelocht wurde** – plus ein lückenloses Protokoll und das erzeugte PDF.

> **Wichtig:** Das ist eine Simulation. Firmware, Farbmanagement und herstellerspezifische Details der echten Front-Ends werden nicht nachgebaut. Ziel ist, das *Verhalten gegenüber einer Druck-App* und die *Logik der Verarbeitung* realistisch und nachvollziehbar zu machen.

---

## Inhalt

- [Maschinenpark](#maschinenpark)
- [Was pro Job entsteht](#was-pro-job-entsteht)
- [Installation](#installation)
- [Steuerzentrale](#steuerzentrale)
- [Sprache (Deutsch/Englisch)](#sprache-deutschenglisch)
- [AppImage und Windows-.exe bauen](#appimage-und-windows-exe-bauen)
- [Drucker-App anbinden](#drucker-app-anbinden)
- [Schnittstellen im Detail](#schnittstellen-im-detail)
- [Material laden, Störungen auslösen](#material-laden-störungen-auslösen)
- [Ticket-Format (Hotfolder, Upload, Fiery-API)](#ticket-format)
- [Grenzen der Simulation](#grenzen-der-simulation)
- [Projektstruktur & Entwicklung](#projektstruktur--entwicklung)
- [Über dieses Projekt & Feedback](#über-dieses-projekt--feedback)

---

## Maschinenpark

| Gerät | Front-End (simuliert) | Material | Weiterverarbeitung |
|---|---|---|---|
| Canon imagePRESS V1350 | Fiery (imagePRESS Server) | 4 Fächer + Bypass, bis 330 × 1300 mm | Heften, Lochen 2/4, Broschüre mit Frontbeschnitt, Falzen (Mittel-, Wickel-, Z-Falz) |
| Canon varioPRINT iX3200 | PRISMAsync | 4 Fächer, bis B3/353 × 750 mm | Heften, Lochen, Broschüre mit Rückenpressung + Beschnitt, Hochstapler |
| Xerox Iridesse | Fiery (EX-P) | 4 Fächer + Zusatzzufuhr, Langbogen 330 × 1200 | Production Ready Finisher Plus, SquareFold Trimmer, C/Z-Falz |
| Xerox Versant 4100 | FreeFlow Print Server | 4 Fächer + Zusatzzufuhr | Business Ready Finisher, Booklet Maker |
| Canon colorWAVE 3800 | ClearConnect + Publisher | 4 Rollen 297–1067 mm, automatische Rollenwahl | Synchron-/Formatschnitt, Online-Faltmaschine (DIN 824 A/B, Leporello) |
| Epson SureColor SC-P9500 | Epson Edge Print | 1 Rolle bis 1118 mm | Nesting, Kacheln, randlos, Auto-Cutter, Aufwickler |
| Epson SureColor SC-T7700D | Treiber / HP-GL/2 | 2 Rollen, automatische Rollenwahl | Auto-Cutter |
| Epson SureLab SL-D1070 / SL-D870 | Order Controller | Fotorollen 89–210 mm | Randlos mit Überdruck, Schneider, Rückseitendruck |
| Roland TrueVIS VG3-640 | VersaWorks 6 | Rolle bis 1625 mm | Druck + Konturschnitt (CutContour/PerfCutContour), Schnittmarken, Querschnitt |
| Roland BN2-20 | VersaWorks 6 | Rolle bis 515 mm | wie oben |

Geschwindigkeiten, Kapazitäten und Ränder sind praxisnahe Annahmen, keine Herstellerangaben – alles ist in der Oberfläche bzw. in `fleet.json` änderbar. Geräte lassen sich duplizieren, entfernen und mit eigenen Presets/virtuellen Druckern versehen.

## Was pro Job entsteht

Jeder Job hat einen eigenen Ordner (`<Daten>/jobs/<Job-ID>/`):

| Datei | Inhalt |
|---|---|
| `eingang.*` | Die Daten exakt so, wie sie empfangen wurden |
| `dokument.pdf` | Normalisiertes PDF (Eingang des simulierten RIP) |
| `ausgabe.pdf` | **Was die Maschine druckt**: eine Seite pro Bogenseite bzw. Rollenabschnitt, ausgeschossen, mit RIP-Marken (Schnittmarken, Roland-Passermarken) |
| `nachweis.pdf` | Dasselbe mit **ein-/ausblendbaren PDF-Ebenen**: Druckbild, nicht druckbar/Abfall, Nutzen & Seiten, Schnitt, Falz, Heftung & Lochung, Info – mit nummerierter Schnitt-/Falzfolge |
| `schnitt.camm` | Schneiddaten für Print & Cut (CAMM-GL-artig, Ursprung linke untere Schnittmarke, Perforation als Schnitt-/Steg-Folge) |
| `layout.json` | Geometrie aller Flächen (für eigene Auswertungen) |
| `log.txt` / `log.json` | Ablauf mit realer und **simulierter** Zeit: Empfang → Ticket (jede Einstellung mit Quelle) → Preflight → Material (Kandidatentabelle mit Begründung) → Ausschießen → Finishing → Druck → Status |
| `protokoll.txt` | Mitschnitt der Schnittstelle: IPP-Attribute, LPD-Steuerdatei, PJL-Kopf, JMF/JDF, Fiery-API – **und die Antworten**, die die App bekommen hat |

In der Oberfläche gibt es dazu die Bogen-/Rollenansicht (echtes Druckbild via pdf.js + Overlay-Ebenen), das Live-Log, den Ticket-Ursprung je Einstellung und einen Schnittstellen-Mitschnitt je Gerät (inkl. Polling-Abfragen der App).

## Installation

**Alles Nötige ist im Repository enthalten** – die Bibliotheken (pdf-lib, pdf.js) liegen gebündelt in `src/vendor` und `ui/vendor`, ein `npm install` ist nicht nötig. Einzige Voraussetzung ist **Node.js ≥ 18**. Für AppImage/.exe-Builds wird Node.js ≥ 22 benötigt.

Ohne installiertes Node.js: das **portable Paket** nehmen (`virtual-print-fleet-<version>-linux-x64.tar.gz`, `…-linux-arm64.tar.gz` bzw. `…-win-x64.zip` aus den GitHub-Releases). Es bringt die Node.js-Laufzeit im Ordner `runtime/` mit; entpacken und `./vpf --open` bzw. `./vpf steuerung` (Windows: „Virtual Print Fleet.cmd“ öffnet die Steuerzentrale) – oder `./install.sh` für Befehl und Startmenü-Eintrag. Selbst bauen: `tools/portable.sh linux-x64|linux-arm64|win-x64`.

```bash
git clone https://github.com/<du>/virtual-print-fleet.git
cd virtual-print-fleet
./install.sh              # für den eigenen Benutzer: ~/.local/bin/vpf + Startmenü-Eintrag
vpf --open                # startet die Simulation und öffnet http://127.0.0.1:8650
vpf steuerung             # oder: Steuerzentrale (Startmenü „Virtual Print Fleet“)
```

Oder systemweit für alle Benutzer:

```bash
sudo ./install.sh         # /usr/local/bin/vpf + /usr/share/applications; Projektdateien bleiben dem eigenen Benutzer
vpf --open                # danach als normaler Benutzer starten (nicht mit sudo)
```

Optionen von `install.sh`:

| Option | Wirkung |
|---|---|
| `--drucker` | Geräte zusätzlich als Systemdrucker eintragen (siehe [Geräte in der App sichtbar machen](#geräte-in-der-app-sichtbar-machen)) |
| `--service` | zusätzlich als Hintergrunddienst starten (ohne sudo: systemd-Benutzerdienst, mit sudo: Systemdienst, der als eigener Benutzer läuft; die Steuerzentrale darf ihn per Polkit-Regel starten/stoppen) |
| `--eigene-ips` (`--own-ips`) | jedes Gerät eigene IP mit Standardports (siehe [Eigene IP je Gerät](#eigene-ip-je-gerät-für-apps-die-nur-die-ip-kennen)) |
| `--lang de` / `--lang en` | Sprache von Installer, Oberfläche, Geräteseiten und Protokollen (Standard: Systemsprache) |
| `--bind 0.0.0.0` | Geräte im Netzwerk erreichbar machen (Standard: nur `127.0.0.1`) |
| `--port 8650` | Port der Oberfläche |
| `--no-desktop` | keinen Startmenü-Eintrag anlegen |
| `--build appimage` / `--build exe` / `--build all` | Desktop-Pakete bauen (siehe unten) |

### Deinstallation

```bash
./uninstall.sh            # Befehl, Startmenü-Eintrag, Symbol und Dienst entfernen – Daten bleiben
sudo ./uninstall.sh       # zusätzlich systemweite Installation und Reste unter /root (z. B. nach "sudo bash install.sh")
./uninstall.sh --purge    # außerdem Jobs, Hotfolder, Einstellungen, node_modules, samples und dist löschen (mit Rückfrage, -y ohne)
```

Entfernt werden: der Befehl `vpf`, Startmenü-Eintrag und Symbol, der Dienst (System- oder Benutzerdienst) samt Polkit-Regel, alle Systemdrucker `VPF_…` in CUPS samt ihrer gespeicherten Druckoptionen (`lpoptions`), temporäre Treiberdateien und `.install-info`. Laufende Simulationen und die Steuerzentrale werden beendet. Der Projektordner selbst bleibt bestehen, ebenso – ohne `--purge` – die Daten unter `~/.local/share/virtual-print-fleet`. Am System wird sonst nichts verändert (keine Netzwerk-, Firewall- oder CUPS-Grundeinstellungen; die Geräte-IPs 127.0.0.11–21 gehören zum ohnehin vorhandenen Loopback-Bereich). `./install.sh --uninstall` ruft dasselbe Skript auf.

Ohne Installer: `node src/cli.js --open` (headless). Electron-Fenster zum Entwickeln: `npm install && npm run app`.

`vpf` / `node src/cli.js` kennt `--port`, `--bind`, `--data <ordner>`, `--time <faktor>` (Zeitraffer, `0` = sofort), `--no-mdns`, `--lang de|en`, `--eigene-ips`/`--gemeinsame-ip` und `--open` sowie die Befehle `steuerung`, `drucker-einrichten`, `drucker-entfernen`, `drucker-treiber`, `drucker-pruefen` und `drucker-befehle` (englische Namen: `control`, `printers-install`, `printers-remove`, `printers-driver`, `printers-check`, `printers-commands`).

Daten liegen unter `~/.local/share/virtual-print-fleet` (Linux), `%APPDATA%\virtual-print-fleet` (Windows) bzw. `~/Library/Application Support/virtual-print-fleet` (macOS) – oder in `VPF_DATA`.

## Steuerzentrale

Ein kleines Fenster zum Bedienen der Simulation – auch dann, wenn sie aus ist. Start über den Startmenü-Eintrag **Virtual Print Fleet**, mit `vpf steuerung` oder in der Oberfläche über **⏻ Steuerung**. Es öffnet sich als eigenes App-Fenster (Chromium/Chrome/Edge im App-Modus, sonst im Standardbrowser) unter `http://127.0.0.1:8649/`.

| Funktion | Was passiert |
|---|---|
| **Einschalten / Ausschalten / Neu starten** | startet bzw. stoppt die Simulation – als Systemdienst über `systemctl` (erlaubt durch die Polkit-Regel des Installers, sonst grafische Passwortabfrage), als Benutzerdienst über `systemctl --user`, ohne Dienst als eigener Hintergrundprozess (Log: `<Daten>/simulation.log`) |
| **Programm beenden** | stoppt die Simulation und schließt die Steuerzentrale |
| **Ein/Aus je Drucker**, **Alle ein/aus** | ein ausgeschaltetes Gerät antwortet nicht mehr auf IPP, LPD, Socket, SNMP und Bonjour – wie eine echte Maschine ohne Strom. So lässt sich testen, wie die App mit nicht erreichbaren Druckern umgeht. |
| **Druckerseite ↗** | öffnet direkt die Webseite des Geräts bzw. Druckservers (Fiery WebTools, PRISMAsync, FreeFlow, WebTools Express, Epson Web Config, Edge Print, Order Controller, VersaWorks) |
| **In der Simulation ↗** | öffnet das Gerät in der Simulations-Oberfläche (Material, Jobs, Mitschnitt) |
| **DE / EN** | schaltet die Sprache für alles um |

Die Steuerzentrale nimmt nur Anfragen von `127.0.0.1` an und nur mit eigenem Kopfzeilenfeld – fremde Webseiten können sie nicht fernsteuern.

## Sprache (Deutsch/Englisch)

Oberfläche, Steuerzentrale, Geräte-Webseiten, PPD-Treiber, Job-Protokolle, Statusmeldungen (IPP/LPD/JMF), Kommandozeile sowie `install.sh`/`uninstall.sh` gibt es auf Deutsch und Englisch.

- Umschalten: Knopf **EN/DE** oben in der Oberfläche, **DE/EN** in der Steuerzentrale, `vpf --lang en` oder `./install.sh --lang en`.
- Die Wahl wird gespeichert (`settings.json`); ohne Wahl gilt die Systemsprache.
- Standardnamen (Material, Fächer, Rollen, Finisher, Ablagen) werden mit umgestellt, selbst vergebene Namen bleiben.
- Bereits verarbeitete Jobs behalten ihr Protokoll in der Sprache, in der sie verarbeitet wurden.
- Die Namen der Warteschlangen/Presets (z. B. `CAD_Falten_DIN824`, `NurDruck`) bleiben unverändert, weil sie Teil der Druckeradressen sind.
- Nach dem Umschalten `vpf drucker-einrichten` erneut ausführen, wenn auch die Systemtreiber (PPD) in der neuen Sprache erscheinen sollen.

## AppImage und Windows-.exe bauen

```bash
./install.sh --build appimage   # → dist/Virtual Print Fleet-<version>.AppImage
./install.sh --build exe        # → dist/*.exe (Installer + portable)
```

Die `.exe` lässt sich unter Windows direkt bauen (Git Bash: `./install.sh --build exe` oder `npm install && npm run dist:win`). Unter Linux braucht electron-builder dafür **Wine** oder **Docker** (das Skript nutzt automatisch, was vorhanden ist).

**Am einfachsten über GitHub:** Der Workflow `.github/workflows/build.yml` testet bei jedem Push und baut AppImage (Ubuntu) und `.exe` (Windows) als Artefakte. Mit einem Tag entsteht ein Release mit beiden Dateien:

```bash
git tag v0.1.0 && git push --tags
```

Bei jedem Release-Tag entstehen zusätzlich die portablen Pakete (Linux x64/arm64, Windows x64) inklusive Node.js-Laufzeit.

Tipp: Nach dem ersten `npm install` die `package-lock.json` mit einchecken, dann sind die Builds reproduzierbar.

## Drucker-App anbinden

### Geräte in der App sichtbar machen

Die Simulation stellt die Geräte unter eigenen Adressen bereit. Ob eine App sie *von selbst* anzeigt, hängt davon ab, wie sie Drucker findet:

| Die App findet Drucker über … | Dann |
|---|---|
| die **System-Druckerliste** (CUPS unter Linux/macOS, Druckwarteschlangen unter Windows) – das tun die meisten Desktop-Apps und Druckdialoge | `vpf drucker-einrichten` ausführen (oder in der Oberfläche **Als Systemdrucker eintragen**). Jedes Gerät erscheint als Drucker `VPF_<Gerätename>`, mit `--alle-queues` zusätzlich jede Warteschlange (z. B. Fiery „hold“) als eigener Drucker. |
| **Netzwerksuche** (Bonjour/mDNS, „Drucker im Netzwerk suchen“) | ist eingebaut und standardmäßig an: jedes Gerät wird als `_ipp._tcp`, `_printer._tcp` und `_pdl-datastream._tcp` angekündigt. Läuft die App auf einem **anderen Rechner**, in den Einstellungen „im Netzwerk erreichbar“ (0.0.0.0) wählen bzw. `vpf --bind 0.0.0.0` starten. |
| **manuell eingegebene Adresse/IP** | die Adresse aus „Front-End & Schnittstellen“ des Geräts eintragen (Tabelle unten). |

```bash
vpf drucker-einrichten                 # alle Geräte als CUPS-Drucker (mit eigenem PPD-Treiber)
vpf drucker-einrichten --alle-queues   # zusätzlich hold/Presets als eigene Drucker
vpf drucker-einrichten --raw           # Daten unverändert durchreichen (kein CUPS-Filter)
vpf drucker-pruefen                    # Systemdrucker + Treiber prüfen (bei Fehlern diese Ausgabe schicken)
vpf drucker-entfernen                  # alle VPF_-Drucker wieder austragen
vpf drucker-befehle                    # nur die lpadmin-Befehle anzeigen
```

`lpadmin` braucht Admin-Rechte: entweder mit `sudo` (bei Installation nur für den Benutzer: `sudo ~/.local/bin/vpf drucker-einrichten`) oder den Benutzer in die Gruppe `lpadmin` aufnehmen. Die Simulation muss laufen, damit Jobs ankommen – am bequemsten als Dienst (`./install.sh --service --drucker`). `uninstall.sh` entfernt die Systemdrucker mit.

Unter Windows legt `vpf drucker-einrichten` (PowerShell als Administrator) je Gerät einen TCP/IP-Port und einen Drucker mit dem „Microsoft PS Class Driver“ an – dafür braucht die Simulation Ghostscript (PostScript-Eingang).

### Eigene IP je Gerät (für Apps, die nur die IP kennen)

Viele Apps nehmen aus dem Systemdrucker nur die **IP-Adresse** und fragen das Gerät dann auf den **Standardports** ab – IPP auf 631, SNMP auf 161 (z. B. für geladene Rollen und Fächer). Dafür gibt es die Adressierungsart **„eigene IP“**: Jedes Gerät bekommt eine eigene Loopback-Adresse (127.0.0.11, 127.0.0.12, …) mit IPP 631, Webseite 80, LPD 515, Socket 9100 und **SNMP 161** (Printer-MIB: prtInputTable mit Rollenbreite/Restlänge/Material, Verbrauchsmaterial, Status).

```bash
sudo ./install.sh --service --eigene-ips --drucker   # Dienst mit Recht auf Standardports + Systemdrucker
vpf drucker-pruefen
```

Ports unter 1024 brauchen Root bzw. `CAP_NET_BIND_SERVICE` – der Systemdienst bekommt das per `AmbientCapabilities`. Umschalten geht auch in der Oberfläche (Einstellungen → Adressierung) bzw. mit `vpf --eigene-ips` / `vpf --gemeinsame-ip`; danach die Systemdrucker neu einrichten. Läuft CUPS mit `Port 631` statt `Listen localhost:631`, ist Port 631 auf allen Adressen belegt – dann in `/etc/cups/cupsd.conf` auf `Listen localhost:631` umstellen.

### Druckserver, Controller, RIP – Treiber und Installierbare Optionen

Was vor der Maschine sitzt, ist wie in echt unterschiedlich:

| Gerät | Davor | Art |
|---|---|---|
| imagePRESS, Iridesse | Fiery | eigener **Druckserver** |
| varioPRINT iX | PRISMAsync | eigener **Druckserver** |
| Versant | FreeFlow Print Server | eigener **Druckserver** |
| colorWAVE | ClearConnect / WebTools Express | **im Gerät integrierter Controller** (Publisher Select/Express ist nur Client-Software zum Senden) |
| Epson SC-P9500 / SC-T7700D | umschaltbar: **direkt** (Epson Web Config, Treiber/HP-GL/2) oder **Edge Print** | Edge Print = **Software-RIP auf einem PC** |
| Epson SureLab | Order Controller | **Software am angeschlossenen PC** |
| Roland | VersaWorks | **Software-RIP auf einem PC** |

Jede dieser Stationen hat eine eigene Webseite unter `http://<host>:<http-port>/` (z. B. `http://127.0.0.1:6310/` für den Fiery der imagePRESS): **Fiery WebTools**, **PRISMAsync Fernzugriff**, **FreeFlow-Weboberfläche**, **ClearConnect/WebTools Express**, Edge Print, Order Controller bzw. VersaWorks (jeweils als Simulation). Dort gibt es Status, Aufträge (drucken/halten/abbrechen), **Konfiguration** mit den **Installierbaren Optionen** (welche Finisher-Module angeschlossen sind), Fachzuordnung und Verhalten bei Material-/Finishing-Konflikten sowie **Treiber & Software**. Auf diese Seite zeigen auch `printer-more-info` (IPP) und `adminurl` (Bonjour) – also der Knopf „Webseite des Druckers“ in den Systemeinstellungen.

`vpf drucker-einrichten` legt die Systemdrucker mit einem je Gerät erzeugten **PPD-Treiber** an (statt CUPS den Treiber selbst ableiten zu lassen): mit Papierfächern bzw. Rollen, Materialarten, Ablagen, Duplex, Heften/Lochen/Falzen/Broschüre bzw. DIN-824-Faltung und den Installierbaren Optionen – inkl. Sperren, wenn ein Modul nicht installiert ist. Die Auswahl im Druckdialog kommt als IPP-Attribut (`finishings`, `media-col`, `output-bin`, `sides`) bei der Simulation an und steht im Protokoll. Treiber einzeln: `vpf drucker-treiber ipv1350` oder Download auf der Druckserver-Seite. `--driverless` nutzt stattdessen CUPS „everywhere“.

Werden Installierbare Optionen geändert, danach „Systemdrucker aktualisieren“ (bzw. erneut `vpf drucker-einrichten`), damit der Systemtreiber dieselben Module anbietet.

### Adressen

Jedes Gerät hat eigene Ports (Standard: HTTP `6310+n`, LPD `5150+n`, Socket `9100+n`; `n` = Position im Maschinenpark). Die genauen Adressen stehen in der Oberfläche unter **Front-End & Schnittstellen** und beim Start in der Konsole.

| Zugang | Adresse (Beispiel imagePRESS) |
|---|---|
| IPP | `ipp://127.0.0.1:6310/ipp/print` – Warteschlangen/Presets: `…/ipp/print/hold`, `…/ipp/print/Broschuere_A5` |
| LPR | Host `127.0.0.1`, Port `5150`, Queue `print` / `hold` / `direct` (Fiery-Namen) |
| Socket | `127.0.0.1:9100` (PJL-Kopf wird ausgewertet, PJL-Statusabfragen werden beantwortet) |
| JDF/JMF | `http://127.0.0.1:6310/jmf` |
| Fiery-API | `http://127.0.0.1:6310/live/api/v5` (nur Fiery-Geräte) |
| Hotfolder | `<Daten>/hotfolders/<gerät>/<warteschlange>/` |

**Linux (CUPS):**

```bash
# driverless (IPP Everywhere, PWG-Raster/PDF)
sudo lpadmin -p vpf-imagepress -E -v ipp://127.0.0.1:6310/ipp/print -m everywhere
# oder rohe Socket-Queue (App schickt PDF/PJL selbst)
sudo lpadmin -p vpf-colorwave -E -v socket://127.0.0.1:9104 -m raw
```

**Windows:** „Drucker hinzufügen“ → *Drucker über TCP/IP-Adresse* → `127.0.0.1`, Port `9100+n` (RAW), Treiber z. B. „Microsoft PS Class Driver“ (dann wird PostScript gesendet → Ghostscript in den Einstellungen angeben) – oder *Freigegebenen Drucker über Namen* mit `http://127.0.0.1:6310/ipp/print` und dem „Microsoft IPP Class Driver“.
Der Windows-„LPR-Port“ verwendet fest Port 515: Für diesen Fall jedem Gerät eine eigene Loopback-Adresse (z. B. `127.0.0.11`) und die Standardports 631/515/9100 geben (Oberfläche → Front-End & Schnittstellen).

**Testclient ohne eigene App:**

```bash
npm run samples                                                          # Beispieldateien erzeugen
node tools/send.js ipp samples/broschuere-a4-10-seiten.pdf --url ipp://127.0.0.1:6310/ipp/print --attr finishings=8 --attr copies=2 --wait
node tools/send.js lpr samples/broschuere-a4-10-seiten.pdf --port 5150 --queue hold
node tools/send.js raw samples/pjl-job-a4-heften-lochen.prn --port 9100
node tools/send.js jmf samples/broschuere-a4-10-seiten.pdf --url http://127.0.0.1:6312/jmf --copies 5 --duplex --staple
node tools/send.js ipp samples/aufkleber-cutcontour.pdf --url ipp://127.0.0.1:6319/ipp/print/QueueA --attr copies=6
node tools/send.js status --url ipp://127.0.0.1:6314/ipp/print
```

## Schnittstellen im Detail

**IPP 1.1/2.0** – Print-Job, Validate-Job, Create-Job + Send-Document (mehrere Dokumente), Close-Job, Get-Printer-Attributes (inkl. `media-col-ready` aus den geladenen Fächern/Rollen, `printer-input-tray`, `marker-levels`, `finishings-supported`), Get-Jobs, Get-Job-Attributes, Cancel/Hold/Release/Restart-Job, Pause/Resume-Printer, Identify-Printer. Job-Attribute: `copies`, `sides`, `media`, `media-col` (Größe, Quelle, Typ, Grammatur, Ränder), `finishings` (PWG-5100.1-Enums für Heften, Lochen, Falzen, Rückstich, Beschnitt), `finishings-col`, `number-up`, `page-ranges`, `print-scaling`, `output-bin`, `job-hold-until`, `job-priority`, `imposition-template`, … Nicht unterstützte Werte kommen wie bei echten Druckern als `successful-ok-ignored-or-substituted-attributes` mit Unsupported-Gruppe zurück. Job- und Druckerzustände (`job-state`, `job-state-reasons`, `printer-state-reasons` wie `media-needed-error`, `media-empty-error`, `media-jam-error`, `cover-open-error`) folgen dem simulierten Ablauf.

**LPR/LPD (RFC 1179)** – Empfang inkl. Steuerdatei (Jobname, Benutzer, Kopien), Statusabfragen kurz/lang, Jobs entfernen. Warteschlangennamen wie am Front-End: Fiery `print`/`hold`/`direct`, PRISMAsync `print`/`hold`/`docbox`, FreeFlow `DefaultQueue`/`HoldQueue`, VersaWorks `QueueA`/`QueueB`, colorWAVE `print`/`SmartInbox`, plus alle Presets.

**Socket 9100** – PJL-Kopf (`JOB NAME`, `COPIES`/`QTY`, `DUPLEX`/`BINDING`, `PAPER`, `MEDIASOURCE`, `MEDIATYPE`, `STAPLE`, `PUNCH`, `FOLD`, `BOOKLET`, `OUTBIN`, `HOLD`, …). Unbekannte Befehle werden im Log ausdrücklich als „nicht ausgewertet“ markiert. `@PJL INFO STATUS/ID/CONFIG/USTATUS`, `INQUIRE`, `ECHO` werden beantwortet.

**SNMP v1/v2c** – GET/GETNEXT/GETBULK für System/hrPrinter und eine Teilmenge der Printer-MIB: Eingabetabelle (Fächer/Rollen mit Format, Füllstand, Materialname/-art), Ausgabetabelle, Verbrauchsmaterial, Bedienfeldanzeige, Druckerstatus. Jede Community wird angenommen.

**JDF/JMF** – `SubmitQueueEntry` (MIME-Paket `multipart/related`, `file://`- oder `http(s)://`-URL), `QueueStatus`, `Status`, `KnownDevices`, `KnownMessages`, `Resource` (liefert die geladenen Medien als JDF-`Media`), `Abort/Remove/Hold/ResumeQueueEntry`, Rückmeldung per `ReturnJMF`. Aus dem JDF werden `Media`, `LayoutPreparationParams` (Sides, NumberUp, Saddle), `ComponentLink/@Amount`, `DigitalPrintingParams`, `StitchingParams`, `HoleMakingParams`, `FoldingParams`, `Trimming/CuttingParams` übernommen.

**Fiery-API (Nachbildung)** – `POST /login`, `GET /info`, `GET /consumables`, `GET /paper`, `GET|POST /jobs`, `GET|PUT|DELETE /jobs/{id}`, `PUT /jobs/{id}/print|hold|cancel|reprint`, `GET /jobs/{id}/preview`. Pfade und Feldnamen sind an die öffentliche Fiery-API angelehnt, aber nicht vollständig – für exakte Tests mit der Dokumentation eures Fiery-Servers abgleichen.

**Hotfolder** – je Gerät und Warteschlange/Preset. Optional liegt neben der Druckdatei ein Ticket `<name>.json` (Format unten) oder `<name>.jdf`. Verarbeitete Dateien wandern nach `_erledigt` bzw. `_fehler`.

**Datenformate** – PDF, PostScript/EPS (mit Ghostscript), JPEG/PNG (Fotodruck), PWG-Raster (IPP Everywhere/driverless), HP-GL/2 (Grundumfang), PJL-umhüllt. PCL und XPS werden erkannt, aber nicht gerastert (Job bricht mit klarer Meldung ab).

### Front-End-Verhalten, das sich testen lässt

- **Fehlendes Material:** Fiery/FreeFlow/Edge Print/VersaWorks halten den Job an (`held`, `resources-are-not-ready`); PRISMAsync, colorWAVE und Order Controller **warten** und laufen automatisch weiter, sobald passendes Material geladen wird. Umschaltbar je Gerät.
- **Hold-Warteschlangen** (Fiery `hold`, Smart Inbox, VersaWorks Queue B), Freigabe per Oberfläche, IPP Release-Job, JMF ResumeQueueEntry oder Fiery-API.
- **Fach leer während des Drucks** → automatische Fachumschaltung auf gleiches Material oder Stopp mit `media-empty-error`; nach dem Nachlegen läuft der Job weiter.
- **Finishing-Konflikte** (z. B. Broschüre über Maximalbogen, Lochung bei zu hoher Grammatur, Heftposition nicht vorhanden) → Job angehalten mit Begründung, „Trotzdem drucken“ möglich.
- **Störungen** auf Knopfdruck: Papierstau, Abdeckung offen, Finisher-/Messerfehler, Offline, Pause.
- **Drucker ausgeschaltet** (Steuerzentrale): keine Antwort auf irgendeinem Protokoll, wie ein Gerät ohne Strom.

### Verarbeitung je Gerätetyp

- **Bogen:** 1:1 mit automatischer Drehung und Skalierung, N-up, Broschüre (Ausschießschema, Leerseiten, Bundzuwachs, Mittelfalz, Rückstich, Frontbeschnitt, SquareFold), Step & Repeat mit Anschnitt, Schnittmarken und nummerierter Schneidemaschinen-Schnittfolge, Duplex lange/kurze Kante, Heft-/Lochpositionen (DIN 80 mm), Falzlinien.
- **Großformat:** automatische Rollenwahl (kleinste passende Breite, Drehung spart Rolle), Synchron- oder Formatschnitt, Restbreite als Abfall, Nesting, Kacheln mit Überlappung, randlos, Rollenrestlänge/Rollenende, DIN-824-Faltung (vereinfacht).
- **Foto:** Rollenbreite muss einer Printkante entsprechen, Füllen mit berechnetem Beschnitt oder Einpassen mit Rand, randloser Überdruck, Schnitt je Print, Rückseitendruck.
- **Print & Cut:** Nesting auf der Rolle, L-Schnittmarken (+ Zwischenmarken bei langen Jobs), Konturschnitt aus `CutContour`, Perforation aus `PerfCutContour`, alternativ TrimBox-Schnitt, Nur-Druck/Nur-Schnitt, Querschnitt, Schnittlänge und -zeit.

## Material laden, Störungen auslösen

Oberfläche → Gerät → **Material laden**: Jedes Fach / jede Rolle bekommt ein Material aus dem Katalog (nur passende Formate/Breiten werden angeboten) und einen Füllstand (Bogen bzw. Restmeter). Der Katalog ist unter **Materialkatalog** erweiterbar. Alles wird sofort per IPP (`media-col-ready`), SNMP (Printer-MIB), JMF (`Resource`) und Fiery-API (`/consumables`) gemeldet.

Der **Zeitraffer** oben rechts steuert, wie schnell die simulierte Zeit vergeht (sofort, Echtzeit, 5×, 20×, 100×) – nützlich, um Status-Polling einer App bei laufenden Jobs zu testen.

## Ticket-Format

Für Hotfolder-Begleitdateien (`<name>.json`), den Upload in der Oberfläche, Presets und das Fiery-API-Feld `ticket`:

```json
{
  "copies": 500,
  "sides": "two-sided-long-edge",
  "imposition": "step-repeat",
  "stepRepeat": { "bleedMm": 3, "gapMm": 0, "marks": true },
  "media": { "mediaId": "matt-300-sra3", "source": "tray-2", "sizeMm": [320, 450], "type": "coated-matte", "gsm": 300 },
  "finishing": { "staple": "top-left", "punch": { "holes": 2, "edge": "left" }, "fold": "letter", "booklet": { "saddle": true, "trimMm": 5, "squareFold": true } },
  "numberUp": 2, "scaling": "fit", "pageRanges": [[1, 4]], "outputBin": "stacker", "hold": false, "priority": 50,
  "roll": { "nesting": true, "tiling": false, "borderless": false, "addMargins": false, "cut": "synchro" },
  "photo": { "printSizeMm": [102, 152], "fit": "fill", "backprint": "Auftrag 4711 / Bild {n}" },
  "cut": { "mode": "contour", "marks": true, "perf": true, "sheetCut": true }
}
```

Alle Felder sind optional. Was nicht gesetzt ist, kommt aus Preset bzw. Gerätestandard – das Log zeigt für jede Einstellung, woher sie stammt.

## Grenzen der Simulation

- Keine echte Rasterung, kein Farbmanagement, keine Trapping-/Überfüllungslogik; `ausgabe.pdf` ist vektoriell ausgeschossen.
- DIN-824-Faltung und Bundzuwachs sind vereinfacht nachgebildet; Faltfolgen echter Faltmaschinen weichen ab.
- Die Fiery-API ist eine Annäherung (siehe oben); JMF/JDF deckt die üblichen Job-Übergaben ab, nicht den vollständigen Standard.
- `schnitt.camm` dient der Nachvollziehbarkeit (Pfade, Reihenfolge, Ursprung) – nicht dazu, einen echten Plotter anzusteuern.
- PostScript braucht Ghostscript auf dem Rechner (Pfad in den Einstellungen).
- HTTPS für Fiery-API/IPPS ist nicht eingebaut (alles läuft über HTTP).
- SNMP beantwortet v1/v2c-Abfragen (GET/GETNEXT/GETBULK) für eine Teilmenge der Printer-MIB (Fächer/Rollen, Ablagen, Verbrauchsmaterial, Status); kein SNMPv3, keine Traps, kein Setzen von Werten.
- Die Systemdrucker-Einrichtung wurde gegen ein nachgebildetes `lpadmin` getestet, nicht gegen ein echtes CUPS; der Windows-Weg ist ungetestet.

## Projektstruktur & Entwicklung

```
src/
  cli.js, server.js          Start (headless) und HTTP-Server (Oberfläche, REST-API, Geräte-Ports)
  control.js                 Steuerzentrale (Start/Stopp, Drucker ein/aus, Druckerseiten)
  i18n.js                    Deutsch/Englisch ($t(de, en))
  config/defaults.js         Maschinenpark + Materialkatalog
  frontends/                 Verhalten der Front-Ends (Warteschlangen, Begriffe, Regeln)
  core/                      Fleet, Device (Status, Material, Warteschlange), Job (Log, Protokoll)
  protocols/                 IPP (codec + server), LPD, Socket/PJL, JMF/JDF, Fiery-API, Hotfolder
  pipeline/                  Formaterkennung, Preflight (Schmuckfarben/Schneidpfade), Material, Ausschießen
                             (Bogen, Rolle, Foto, Print&Cut), Finishing, Ausgabe-PDFs, Ablauf
src/vendor/pdf-lib.js        gebündeltes pdf-lib (inkl. pako, tslib) – keine npm-Abhängigkeiten zur Laufzeit
ui/                          Oberfläche (ohne Framework); ui/vendor/pdfjs = pdf.js für die Bogenansicht
tools/portable.sh            portables Paket inkl. Node.js-Laufzeit bauen
electron/main.js             Desktop-Hülle für AppImage/.exe
tools/send.js                Testclient (IPP/LPR/Socket/JMF)
tools/make-samples.js        Beispieldateien (Broschüre, Visitenkarten, Pläne, Foto, Sticker mit CutContour, PJL, HP-GL)
test/                        node:test – Einheiten- und Ende-zu-Ende-Tests über die echten Protokolle
```

```bash
node --test       # Tests (startet die Simulation auf Testports)
npm start         # headless
npm run app       # Electron
```

Neue Texte für Benutzer werden zweisprachig geschrieben: `$t('Deutscher Text', 'English text')` (Konstanten auf Modulebene: `$tp(…)` in `$lazy({…})`; in der Browser-Oberfläche liest `$t` die aktuelle Sprache).

REST-API der Oberfläche (für Automatisierung, z. B. in Tests eurer App): `GET /api/state`, `GET /api/jobs`, `GET /api/jobs/{id}`, `POST /api/jobs/{id}/release|cancel|reprint|hold|delete|ticket`, `POST /api/devices/{id}/slots/{slot}` (`{"mediaId":"…","level":…}`), `POST /api/devices/{id}/errors` (`{"type":"jam","active":true}`), `PUT /api/settings` (`{"timeFactor":0}`, `{"lang":"en"}`), `PUT /api/devices/{id}` (`{"enabled":false}` = Gerät aus), `POST /api/quit`, `GET /api/events` (Server-Sent Events).

## Über dieses Projekt & Feedback

Dieses Projekt wurde mit **Claude** (dem KI-Assistenten von Anthropic) erstellt – Code, Tests und Dokumentation sind im Gespräch entstanden und wurden anschließend mit der eigenen Druck-App getestet.

**Verbesserungsvorschläge sind ausdrücklich willkommen!** Ob ein Gerät sich anders verhält als die echte Maschine, ein Protokolldetail fehlt, eine Übersetzung holpert oder du eine Idee für eine neue Funktion hast – gerne ein [Issue](../../issues) oder einen Pull Request aufmachen.

## Lizenz

MIT – siehe [LICENSE](LICENSE). Gebündelte Fremdkomponenten und ihre Lizenzen: [THIRD_PARTY_LICENSES.txt](THIRD_PARTY_LICENSES.txt). Hersteller- und Produktnamen dienen nur der Bezeichnung der simulierten Geräte; das Projekt steht in keiner Verbindung zu Canon, Xerox, Epson, Roland DG oder EFI.
