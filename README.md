# Virtual Print Fleet

Virtueller Druckmaschinenpark zum Testen von Druck-Apps: Canon- und Xerox-Produktionsmaschinen mit Finishern, Canon colorWAVE, Epson-Großformatplotter, Rollen-Fotodrucker bis 210 mm und Roland Print-&-Cut-Plotter – jeweils mit einem simulierten Front-End (Fiery, PRISMAsync, FreeFlow, ClearConnect/Publisher, Edge Print, Order Controller, VersaWorks).

Die Geräte nehmen Jobs über **dieselben Schnittstellen** entgegen wie die echten Maschinen (IPP, LPR, Socket 9100 mit PJL, JDF/JMF, Fiery-API-Nachbildung, Hotfolder), verarbeiten sie wie ein Front-End (Ticket, Materialwahl, Ausschießen, Finishing) und zeigen anschließend **auf welchem Bogen bzw. welcher Rolle was wie gelegt wurde, wo geschnitten, gefalzt, geheftet und gelocht wurde** – plus ein lückenloses Protokoll und das erzeugte PDF.

> **Wichtig:** Das ist eine Simulation. Firmware, Farbmanagement und herstellerspezifische Details der echten Front-Ends werden nicht nachgebaut. Ziel ist, das *Verhalten gegenüber einer Druck-App* und die *Logik der Verarbeitung* realistisch und nachvollziehbar zu machen.

---

## Inhalt

- [Maschinenpark](#maschinenpark)
- [Was pro Job entsteht](#was-pro-job-entsteht)
- [Installation](#installation)
- [AppImage und Windows-.exe bauen](#appimage-und-windows-exe-bauen)
- [Drucker-App anbinden](#drucker-app-anbinden)
- [Schnittstellen im Detail](#schnittstellen-im-detail)
- [Material laden, Störungen auslösen](#material-laden-störungen-auslösen)
- [Ticket-Format (Hotfolder, Upload, Fiery-API)](#ticket-format)
- [Grenzen der Simulation](#grenzen-der-simulation)
- [Projektstruktur & Entwicklung](#projektstruktur--entwicklung)

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

Voraussetzung: **Node.js ≥ 18** (Linux, macOS oder Windows).

```bash
git clone https://github.com/<du>/virtual-print-fleet.git
cd virtual-print-fleet
./install.sh              # Abhängigkeiten, Befehl "vpf", Startmenü-Eintrag, Beispieldateien
vpf --open                # startet die Simulation und öffnet http://127.0.0.1:8650
```

Optionen von `install.sh`:

| Option | Wirkung |
|---|---|
| `--service` | zusätzlich als systemd-Benutzerdienst im Hintergrund starten |
| `--bind 0.0.0.0` | Geräte im Netzwerk erreichbar machen (Standard: nur `127.0.0.1`) |
| `--port 8650` | Port der Oberfläche |
| `--build appimage` / `--build exe` / `--build all` | Desktop-Pakete bauen (siehe unten) |
| `--uninstall` | Befehl, Startmenü-Eintrag und Dienst entfernen (Daten bleiben) |

Ohne Installer: `npm install && npm start` (headless) bzw. `npm run app` (Electron-Fenster).

`vpf` / `node src/cli.js` kennt `--port`, `--bind`, `--data <ordner>`, `--time <faktor>` (Zeitraffer, `0` = sofort) und `--open`.

Daten liegen unter `~/.local/share/virtual-print-fleet` (Linux), `%APPDATA%\virtual-print-fleet` (Windows) bzw. `~/Library/Application Support/virtual-print-fleet` (macOS) – oder in `VPF_DATA`.

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

Tipp: Nach dem ersten `npm install` die `package-lock.json` mit einchecken, dann sind die Builds reproduzierbar.

## Drucker-App anbinden

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

### Verarbeitung je Gerätetyp

- **Bogen:** 1:1 mit automatischer Drehung und Skalierung, N-up, Broschüre (Ausschießschema, Leerseiten, Bundzuwachs, Mittelfalz, Rückstich, Frontbeschnitt, SquareFold), Step & Repeat mit Anschnitt, Schnittmarken und nummerierter Schneidemaschinen-Schnittfolge, Duplex lange/kurze Kante, Heft-/Lochpositionen (DIN 80 mm), Falzlinien.
- **Großformat:** automatische Rollenwahl (kleinste passende Breite, Drehung spart Rolle), Synchron- oder Formatschnitt, Restbreite als Abfall, Nesting, Kacheln mit Überlappung, randlos, Rollenrestlänge/Rollenende, DIN-824-Faltung (vereinfacht).
- **Foto:** Rollenbreite muss einer Printkante entsprechen, Füllen mit berechnetem Beschnitt oder Einpassen mit Rand, randloser Überdruck, Schnitt je Print, Rückseitendruck.
- **Print & Cut:** Nesting auf der Rolle, L-Schnittmarken (+ Zwischenmarken bei langen Jobs), Konturschnitt aus `CutContour`, Perforation aus `PerfCutContour`, alternativ TrimBox-Schnitt, Nur-Druck/Nur-Schnitt, Querschnitt, Schnittlänge und -zeit.

## Material laden, Störungen auslösen

Oberfläche → Gerät → **Material laden**: Jedes Fach / jede Rolle bekommt ein Material aus dem Katalog (nur passende Formate/Breiten werden angeboten) und einen Füllstand (Bogen bzw. Restmeter). Der Katalog ist unter **Materialkatalog** erweiterbar. Alles wird sofort per IPP (`media-col-ready`), JMF (`Resource`) und Fiery-API (`/consumables`) gemeldet.

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
- Kein mDNS/Bonjour – Geräte werden per Adresse angelegt.

## Projektstruktur & Entwicklung

```
src/
  cli.js, server.js          Start (headless) und HTTP-Server (Oberfläche, REST-API, Geräte-Ports)
  config/defaults.js         Maschinenpark + Materialkatalog
  frontends/                 Verhalten der Front-Ends (Warteschlangen, Begriffe, Regeln)
  core/                      Fleet, Device (Status, Material, Warteschlange), Job (Log, Protokoll)
  protocols/                 IPP (codec + server), LPD, Socket/PJL, JMF/JDF, Fiery-API, Hotfolder
  pipeline/                  Formaterkennung, Preflight (Schmuckfarben/Schneidpfade), Material, Ausschießen
                             (Bogen, Rolle, Foto, Print&Cut), Finishing, Ausgabe-PDFs, Ablauf
ui/                          Oberfläche (ohne Framework, pdf.js für die Bogenansicht)
electron/main.js             Desktop-Hülle für AppImage/.exe
tools/send.js                Testclient (IPP/LPR/Socket/JMF)
tools/make-samples.js        Beispieldateien (Broschüre, Visitenkarten, Pläne, Foto, Sticker mit CutContour, PJL, HP-GL)
test/                        node:test – Einheiten- und Ende-zu-Ende-Tests über die echten Protokolle
```

```bash
npm test          # Tests (startet die Simulation auf Testports)
npm start         # headless
npm run app       # Electron
```

REST-API der Oberfläche (für Automatisierung, z. B. in Tests eurer App): `GET /api/state`, `GET /api/jobs`, `GET /api/jobs/{id}`, `POST /api/jobs/{id}/release|cancel|reprint|hold|delete|ticket`, `POST /api/devices/{id}/slots/{slot}` (`{"mediaId":"…","level":…}`), `POST /api/devices/{id}/errors` (`{"type":"jam","active":true}`), `PUT /api/settings` (`{"timeFactor":0}`), `GET /api/events` (Server-Sent Events).

## Lizenz

MIT – siehe [LICENSE](LICENSE). Hersteller- und Produktnamen dienen nur der Bezeichnung der simulierten Geräte; das Projekt steht in keiner Verbindung zu Canon, Xerox, Epson, Roland DG oder EFI.
