# Virtual Print Fleet

[Deutsch](README.de.md) · **English**

A virtual printing machine park for testing print apps: Canon and Xerox production presses with finishers, Canon colorWAVE, Epson wide-format plotters, roll photo printers up to 210 mm and Roland print & cut plotters – each with a simulated front end (Fiery, PRISMAsync, FreeFlow, ClearConnect/Publisher, Edge Print, Order Controller, VersaWorks).

The devices accept jobs through **the same interfaces** as the real machines (IPP, LPR, socket 9100 with PJL, JDF/JMF, a Fiery API emulation, hot folders, SNMP), process them like a front end (ticket, media selection, imposition, finishing) and then show **on which sheet or roll what was placed how, and where it was cut, folded, stapled and punched** – plus a complete log and the generated PDF.

> **Important:** this is a simulation. Firmware, colour management and vendor-specific details of the real front ends are not reproduced. The goal is to make the *behaviour towards a print app* and the *processing logic* realistic and traceable.

The whole application (interface, control centre, device web pages, drivers, logs, command line, installer) is available in **German and English** and can be switched at any time.

---

## Contents

- [Machine park](#machine-park)
- [What is created per job](#what-is-created-per-job)
- [Installation](#installation)
- [Control centre](#control-centre)
- [Language (German/English)](#language-germanenglish)
- [Building the AppImage and Windows .exe](#building-the-appimage-and-windows-exe)
- [Connecting your print app](#connecting-your-print-app)
- [Interfaces in detail](#interfaces-in-detail)
- [Loading media, triggering faults](#loading-media-triggering-faults)
- [Ticket format (hot folder, upload, Fiery API)](#ticket-format)
- [Limits of the simulation](#limits-of-the-simulation)
- [Project structure & development](#project-structure--development)
- [About this project & feedback](#about-this-project--feedback)

---

## Machine park

| Device | Front end (simulated) | Media | Finishing |
|---|---|---|---|
| Canon imagePRESS V1350 | Fiery (imagePRESS Server) | 4 trays + bypass, up to 330 × 1300 mm | stapling, 2/4-hole punching, booklet with face trim, folding (half, letter, Z-fold) |
| Canon varioPRINT iX3200 | PRISMAsync | 4 trays, up to B3/353 × 750 mm | stapling, punching, booklet with square fold + trim, high-capacity stacker |
| Xerox Iridesse | Fiery (EX-P) | 4 trays + bypass, long sheet 330 × 1200 | Production Ready Finisher Plus, SquareFold Trimmer, C/Z-fold |
| Xerox Versant 4100 | FreeFlow Print Server | 4 trays + bypass | Business Ready Finisher, Booklet Maker |
| Canon colorWAVE 3800 | ClearConnect + Publisher | 4 rolls 297–1067 mm, automatic roll selection | synchro/standard-length cut, online folder (DIN 824 A/B, accordion) |
| Epson SureColor SC-P9500 | Epson Edge Print | 1 roll up to 1118 mm | nesting, tiling, borderless, auto cutter, take-up reel |
| Epson SureColor SC-T7700D | driver / HP-GL/2 | 2 rolls, automatic roll selection | auto cutter |
| Epson SureLab SL-D1070 / SL-D870 | Order Controller | photo rolls 89–210 mm | borderless with overprint, cutter, back printing |
| Roland TrueVIS VG3-640 | VersaWorks 6 | roll up to 1625 mm | print + contour cut (CutContour/PerfCutContour), crop marks, cross cut |
| Roland BN2-20 | VersaWorks 6 | roll up to 515 mm | as above |

Speeds, capacities and margins are realistic assumptions, not vendor specifications – everything can be changed in the interface or in `fleet.json`. Devices can be duplicated, removed and given their own presets/virtual printers.

## What is created per job

Every job has its own folder (`<data>/jobs/<job id>/`). The file names are the same in both languages:

| File | Content |
|---|---|
| `eingang.*` | the data exactly as received |
| `dokument.pdf` | normalized PDF (input of the simulated RIP) |
| `ausgabe.pdf` | **what the machine prints**: one page per sheet side or roll section, imposed, with RIP marks (crop marks, Roland registration marks) |
| `nachweis.pdf` | the same with **PDF layers that can be shown/hidden**: print image, non-printable/waste, items & pages, cut, fold, stapling & punching, info – with numbered cut/fold sequence |
| `schnitt.camm` | cut data for print & cut (CAMM-GL style, origin at the lower left crop mark, perforation as cut/bridge sequence) |
| `layout.json` | geometry of all surfaces (for your own evaluations) |
| `log.txt` / `log.json` | process with real and **simulated** time: receive → ticket (every setting with its source) → preflight → media (candidate table with reasons) → imposition → finishing → print → status |
| `protokoll.txt` | capture of the interface: IPP attributes, LPD control file, PJL header, JMF/JDF, Fiery API – **and the responses** the app received |

The interface adds the sheet/roll view (real print image via pdf.js + overlay layers), the live log, the origin of every ticket setting and an interface capture per device (incl. the app's polling queries).

## Installation

**Everything needed is included in the repository** – the libraries (pdf-lib, pdf.js) are bundled in `src/vendor` and `ui/vendor`, no `npm install` is needed. The only requirement is **Node.js ≥ 18**. AppImage/.exe builds need Node.js ≥ 22.

Without Node.js installed: use the **portable package** (`virtual-print-fleet-<version>-linux-x64.tar.gz`, `…-linux-arm64.tar.gz` or `…-win-x64.zip` from the GitHub releases). It brings the Node.js runtime in the `runtime/` folder; unpack and run `./vpf --open` or `./vpf control` (Windows: “Virtual Print Fleet.cmd” opens the control centre) – or `./install.sh` for the command and a menu entry. Build it yourself: `tools/portable.sh linux-x64|linux-arm64|win-x64`.

```bash
git clone https://github.com/<you>/virtual-print-fleet.git
cd virtual-print-fleet
./install.sh --lang en    # for your own user: ~/.local/bin/vpf + menu entry
vpf --open                # starts the simulation and opens http://127.0.0.1:8650
vpf control               # or: control centre (menu entry “Virtual Print Fleet”)
```

Or system-wide for all users:

```bash
sudo ./install.sh --lang en   # /usr/local/bin/vpf + /usr/share/applications; project files stay owned by your user
vpf --open                    # afterwards start as a normal user (not with sudo)
```

Options of `install.sh`:

| Option | Effect |
|---|---|
| `--drucker` (`--printers`) | also register the devices as system printers (see [Making devices visible in the app](#making-devices-visible-in-the-app)) |
| `--service` | additionally start as a background service (without sudo: systemd user service, with sudo: system service running as your own user; the control centre may start/stop it via a polkit rule) |
| `--eigene-ips` (`--own-ips`) | every device its own IP with standard ports (see [Own IP per device](#own-ip-per-device-for-apps-that-only-know-the-ip)) |
| `--lang de` / `--lang en` | language of installer, interface, device pages and logs (default: system language) |
| `--bind 0.0.0.0` | make the devices reachable on the network (default: `127.0.0.1` only) |
| `--port 8650` | port of the interface |
| `--no-desktop` | do not create a menu entry |
| `--build appimage` / `--build exe` / `--build all` | build desktop packages (see below) |

Re-running `install.sh` updates an existing installation (the service is restarted with the new version).

### Uninstalling

```bash
./uninstall.sh            # remove command, menu entry, icon and service – data is kept
sudo ./uninstall.sh       # also a system-wide installation and leftovers under /root (e.g. after "sudo bash install.sh")
./uninstall.sh --purge    # also delete jobs, hot folders, settings, node_modules, samples and dist (asks first, -y without asking)
```

Removed are: the `vpf` command, menu entry and icon, the service (system or user service) including its polkit rule, all `VPF_…` system printers in CUPS together with their saved print options (`lpoptions`), temporary driver files and `.install-info`. Running simulations and the control centre are stopped. The project folder itself is kept, as is – without `--purge` – the data under `~/.local/share/virtual-print-fleet`. Nothing else on the system is changed (no network, firewall or CUPS base settings; the device IPs 127.0.0.11–21 belong to the loopback range that exists anyway). `./install.sh --uninstall` calls the same script.

Without the installer: `node src/cli.js --open` (headless). Electron window for development: `npm install && npm run app`.

`vpf` / `node src/cli.js` understands `--port`, `--bind`, `--data <folder>`, `--time <factor>` (time lapse, `0` = instant), `--no-mdns`, `--lang de|en`, `--own-ips`/`--shared-ip` and `--open`, plus the commands `control`, `printers-install`, `printers-remove`, `printers-driver`, `printers-check` and `printers-commands` (German names: `steuerung`, `drucker-einrichten`, `drucker-entfernen`, `drucker-treiber`, `drucker-pruefen`, `drucker-befehle`).

Data is stored in `~/.local/share/virtual-print-fleet` (Linux), `%APPDATA%\virtual-print-fleet` (Windows) or `~/Library/Application Support/virtual-print-fleet` (macOS) – or in `VPF_DATA`.

## Control centre

A small window to operate the simulation – also while it is off. Start it from the menu entry **Virtual Print Fleet**, with `vpf control` or from the interface via **⏻ Control**. It opens as its own app window (Chromium/Chrome/Edge in app mode, otherwise the default browser) at `http://127.0.0.1:8649/`.

| Function | What happens |
|---|---|
| **Switch on / Switch off / Restart** | starts or stops the simulation – as a system service via `systemctl` (allowed by the installer's polkit rule, otherwise a graphical password prompt), as a user service via `systemctl --user`, without a service as its own background process (log: `<data>/simulation.log`) |
| **Quit program** | stops the simulation and closes the control centre |
| **On/off per printer**, **All on/off** | a device that is switched off no longer answers IPP, LPD, socket, SNMP and Bonjour – like a real machine without power. This lets you test how your app handles unreachable printers. |
| **Printer page ↗** | opens the web page of the device or print server directly (Fiery WebTools, PRISMAsync, FreeFlow, WebTools Express, Epson Web Config, Edge Print, Order Controller, VersaWorks) |
| **In the simulation ↗** | opens the device in the simulation interface (media, jobs, capture) |
| **DE / EN** | switches the language for everything |

The control centre only accepts requests from `127.0.0.1` and only with its own header field – other web pages cannot remote-control it.

## Language (German/English)

Interface, control centre, device web pages, PPD drivers, job logs, status messages (IPP/LPD/JMF), command line and `install.sh`/`uninstall.sh` are available in German and English.

- Switch: the **EN/DE** button at the top of the interface, **DE/EN** in the control centre, `vpf --lang en` or `./install.sh --lang en`.
- The choice is saved (`settings.json`); without a choice the system language is used.
- Default names (media, trays, rolls, finishers, output trays) are switched as well, names you gave yourself stay.
- Jobs that were already processed keep their log in the language they were processed in.
- Queue/preset names (e.g. `CAD_Falten_DIN824`, `NurDruck`) stay unchanged because they are part of the printer addresses.
- Run `vpf printers-install` again after switching if the system drivers (PPD) should appear in the new language too.

## Building the AppImage and Windows .exe

```bash
./install.sh --build appimage   # → dist/Virtual Print Fleet-<version>.AppImage
./install.sh --build exe        # → dist/*.exe (installer + portable)
```

The `.exe` can be built directly on Windows (Git Bash: `./install.sh --build exe` or `npm install && npm run dist:win`). On Linux electron-builder needs **Wine** or **Docker** for it (the script uses whatever is available).

**Easiest via GitHub:** the workflow `.github/workflows/build.yml` runs the tests on every push and builds the AppImage (Ubuntu) and `.exe` (Windows) as artifacts. A tag creates a release with both files:

```bash
git tag v0.1.0 && git push --tags
```

Every release tag additionally produces the portable packages (Linux x64/arm64, Windows x64) including the Node.js runtime.

Tip: after the first `npm install`, commit the `package-lock.json` so that builds are reproducible.

## Connecting your print app

### Making devices visible in the app

The simulation provides the devices under their own addresses. Whether an app shows them *by itself* depends on how it finds printers:

| The app finds printers via … | Then |
|---|---|
| the **system printer list** (CUPS on Linux/macOS, print queues on Windows) – most desktop apps and print dialogs do this | run `vpf printers-install` (or **Register as system printers** in the interface). Every device appears as printer `VPF_<device name>`, with `--alle-queues` additionally every queue (e.g. Fiery “hold”) as a separate printer. |
| **network discovery** (Bonjour/mDNS, “search for network printers”) | built in and on by default: every device is announced as `_ipp._tcp`, `_printer._tcp` and `_pdl-datastream._tcp`. If the app runs on **another computer**, choose “reachable on the network” (0.0.0.0) in the settings or start `vpf --bind 0.0.0.0`. |
| a **manually entered address/IP** | enter the address from “Front end & interfaces” of the device (table below). |

```bash
vpf printers-install                   # all devices as CUPS printers (with their own PPD driver)
vpf printers-install --alle-queues     # additionally hold queues/presets as separate printers
vpf printers-install --raw             # pass data through unchanged (no CUPS filter)
vpf printers-check                     # check system printers + drivers (send this output when reporting problems)
vpf printers-remove                    # remove all VPF_ printers again
vpf printers-commands                  # only show the lpadmin commands
```

`lpadmin` needs admin rights: either with `sudo` (for a per-user installation: `sudo ~/.local/bin/vpf printers-install`) or by adding the user to the `lpadmin` group. The simulation must be running for jobs to arrive – most conveniently as a service (`./install.sh --service --printers`). `uninstall.sh` removes the system printers as well.

On Windows `vpf printers-install` (PowerShell as administrator) creates a TCP/IP port and a printer with the “Microsoft PS Class Driver” per device – for that the simulation needs Ghostscript (PostScript input).

### Own IP per device (for apps that only know the IP)

Many apps only take the **IP address** from the system printer and then query the device on the **standard ports** – IPP on 631, SNMP on 161 (e.g. for loaded rolls and trays). For this there is the addressing mode **“own IP”**: every device gets its own loopback address (127.0.0.11, 127.0.0.12, …) with IPP 631, web page 80, LPD 515, socket 9100 and **SNMP 161** (Printer MIB: prtInputTable with roll width/remaining length/media, consumables, status).

```bash
sudo ./install.sh --service --own-ips --printers   # service allowed to use standard ports + system printers
vpf printers-check
```

Ports below 1024 need root or `CAP_NET_BIND_SERVICE` – the system service gets this via `AmbientCapabilities`. You can also switch in the interface (Settings → Device addressing) or with `vpf --own-ips` / `vpf --shared-ip`; afterwards re-register the system printers. If CUPS runs with `Port 631` instead of `Listen localhost:631`, port 631 is taken on all addresses – then change `/etc/cups/cupsd.conf` to `Listen localhost:631`.

### Print servers, controllers, RIPs – drivers and installable options

What sits in front of the machine differs, just like in reality:

| Device | In front | Kind |
|---|---|---|
| imagePRESS, Iridesse | Fiery | separate **print server** |
| varioPRINT iX | PRISMAsync | separate **print server** |
| Versant | FreeFlow Print Server | separate **print server** |
| colorWAVE | ClearConnect / WebTools Express | **controller integrated in the device** (Publisher Select/Express is only client software for sending) |
| Epson SC-P9500 / SC-T7700D | switchable: **direct** (Epson Web Config, driver/HP-GL/2) or **Edge Print** | Edge Print = **software RIP on a PC** |
| Epson SureLab | Order Controller | **software on the connected PC** |
| Roland | VersaWorks | **software RIP on a PC** |

Each of these stations has its own web page at `http://<host>:<http port>/` (e.g. `http://127.0.0.1:6310/` for the Fiery of the imagePRESS): **Fiery WebTools**, **PRISMAsync Remote Control**, **FreeFlow web interface**, **ClearConnect/WebTools Express**, Edge Print, Order Controller or VersaWorks (each as a simulation). They offer status, jobs (print/hold/cancel), **configuration** with the **installable options** (which finisher modules are attached), tray assignment and behaviour on media/finishing conflicts, as well as **drivers & software**. `printer-more-info` (IPP) and `adminurl` (Bonjour) point to this page too – i.e. the “printer web page” button in the system settings. The control centre opens it with **Printer page**.

`vpf printers-install` creates the system printers with a **PPD driver generated per device** (instead of letting CUPS derive the driver itself): with paper trays or rolls, media types, output trays, duplex, stapling/punching/folding/booklet or DIN 824 folding and the installable options – including constraints when a module is not installed. The selection in the print dialog arrives at the simulation as IPP attributes (`finishings`, `media-col`, `output-bin`, `sides`) and is shown in the log. Single driver: `vpf printers-driver ipv1350` or download on the print server page. `--driverless` uses CUPS “everywhere” instead.

If installable options are changed, use “Update system printers” afterwards (or run `vpf printers-install` again) so that the system driver offers the same modules.

### Addresses

Every device has its own ports (default: HTTP `6310+n`, LPD `5150+n`, socket `9100+n`; `n` = position in the machine park). The exact addresses are shown in the interface under **Front end & interfaces**, in the control centre and in the console at start-up.

| Access | Address (example imagePRESS) |
|---|---|
| IPP | `ipp://127.0.0.1:6310/ipp/print` – queues/presets: `…/ipp/print/hold`, `…/ipp/print/Broschuere_A5` |
| LPR | host `127.0.0.1`, port `5150`, queue `print` / `hold` / `direct` (Fiery names) |
| Socket | `127.0.0.1:9100` (PJL header is evaluated, PJL status queries are answered) |
| JDF/JMF | `http://127.0.0.1:6310/jmf` |
| Fiery API | `http://127.0.0.1:6310/live/api/v5` (Fiery devices only) |
| Hot folder | `<data>/hotfolders/<device>/<queue>/` |

**Linux (CUPS):**

```bash
# driverless (IPP Everywhere, PWG raster/PDF)
sudo lpadmin -p vpf-imagepress -E -v ipp://127.0.0.1:6310/ipp/print -m everywhere
# or raw socket queue (the app sends PDF/PJL itself)
sudo lpadmin -p vpf-colorwave -E -v socket://127.0.0.1:9104 -m raw
```

**Windows:** “Add printer” → *Add a printer using a TCP/IP address* → `127.0.0.1`, port `9100+n` (RAW), driver e.g. “Microsoft PS Class Driver” (then PostScript is sent → set Ghostscript in the settings) – or *Select a shared printer by name* with `http://127.0.0.1:6310/ipp/print` and the “Microsoft IPP Class Driver”.
The Windows “LPR port” always uses port 515: for that case give each device its own loopback address (e.g. `127.0.0.11`) and the standard ports 631/515/9100 (interface → Front end & interfaces).

**Test client without your own app:**

```bash
npm run samples                                                          # create sample files
node tools/send.js ipp samples/broschuere-a4-10-seiten.pdf --url ipp://127.0.0.1:6310/ipp/print --attr finishings=8 --attr copies=2 --wait
node tools/send.js lpr samples/broschuere-a4-10-seiten.pdf --port 5150 --queue hold
node tools/send.js raw samples/pjl-job-a4-heften-lochen.prn --port 9100
node tools/send.js jmf samples/broschuere-a4-10-seiten.pdf --url http://127.0.0.1:6312/jmf --copies 5 --duplex --staple
node tools/send.js ipp samples/aufkleber-cutcontour.pdf --url ipp://127.0.0.1:6319/ipp/print/QueueA --attr copies=6
node tools/send.js status --url ipp://127.0.0.1:6314/ipp/print
```

## Interfaces in detail

**IPP 1.1/2.0** – Print-Job, Validate-Job, Create-Job + Send-Document (several documents), Close-Job, Get-Printer-Attributes (incl. `media-col-ready` from the loaded trays/rolls, `printer-input-tray`, `marker-levels`, `finishings-supported`), Get-Jobs, Get-Job-Attributes, Cancel/Hold/Release/Restart-Job, Pause/Resume-Printer, Identify-Printer. Job attributes: `copies`, `sides`, `media`, `media-col` (size, source, type, grammage, margins), `finishings` (PWG 5100.1 enums for stapling, punching, folding, saddle stitch, trimming), `finishings-col`, `number-up`, `page-ranges`, `print-scaling`, `output-bin`, `job-hold-until`, `job-priority`, `imposition-template`, … Unsupported values come back like on real printers as `successful-ok-ignored-or-substituted-attributes` with an unsupported group. Job and printer states (`job-state`, `job-state-reasons`, `printer-state-reasons` such as `media-needed-error`, `media-empty-error`, `media-jam-error`, `cover-open-error`) follow the simulated process.

**LPR/LPD (RFC 1179)** – receiving incl. control file (job name, user, copies), short/long status queries, removing jobs. Queue names as on the front end: Fiery `print`/`hold`/`direct`, PRISMAsync `print`/`hold`/`docbox`, FreeFlow `DefaultQueue`/`HoldQueue`, VersaWorks `QueueA`/`QueueB`, colorWAVE `print`/`SmartInbox`, plus all presets.

**Socket 9100** – PJL header (`JOB NAME`, `COPIES`/`QTY`, `DUPLEX`/`BINDING`, `PAPER`, `MEDIASOURCE`, `MEDIATYPE`, `STAPLE`, `PUNCH`, `FOLD`, `BOOKLET`, `OUTBIN`, `HOLD`, …). Unknown commands are explicitly marked as “not evaluated” in the log. `@PJL INFO STATUS/ID/CONFIG/USTATUS`, `INQUIRE`, `ECHO` are answered.

**SNMP v1/v2c** – GET/GETNEXT/GETBULK for system/hrPrinter and a subset of the Printer MIB: input table (trays/rolls with size, remaining level, media name/type), output table, consumables (marker supplies), console display, printer status. Any community is accepted.

**JDF/JMF** – `SubmitQueueEntry` (MIME package `multipart/related`, `file://` or `http(s)://` URL), `QueueStatus`, `Status`, `KnownDevices`, `KnownMessages`, `Resource` (returns the loaded media as JDF `Media`), `Abort/Remove/Hold/ResumeQueueEntry`, response via `ReturnJMF`. From the JDF, `Media`, `LayoutPreparationParams` (Sides, NumberUp, Saddle), `ComponentLink/@Amount`, `DigitalPrintingParams`, `StitchingParams`, `HoleMakingParams`, `FoldingParams`, `Trimming/CuttingParams` are taken over.

**Fiery API (emulation)** – `POST /login`, `GET /info`, `GET /consumables`, `GET /paper`, `GET|POST /jobs`, `GET|PUT|DELETE /jobs/{id}`, `PUT /jobs/{id}/print|hold|cancel|reprint`, `GET /jobs/{id}/preview`. Paths and field names follow the public Fiery API but are not complete – compare with the documentation of your Fiery server for exact tests.

**Hot folder** – per device and queue/preset. Optionally a ticket `<name>.json` (format below) or `<name>.jdf` lies next to the print file. Processed files move to `_erledigt` (done) or `_fehler` (error).

**Data formats** – PDF, PostScript/EPS (with Ghostscript), JPEG/PNG (photo printing), PWG raster (IPP Everywhere/driverless), HP-GL/2 (basic set), PJL-wrapped. PCL and XPS are detected but not rasterized (the job aborts with a clear message).

### Front-end behaviour you can test

- **Missing media:** Fiery/FreeFlow/Edge Print/VersaWorks hold the job (`held`, `resources-are-not-ready`); PRISMAsync, colorWAVE and Order Controller **wait** and continue automatically as soon as matching media is loaded. Switchable per device.
- **Hold queues** (Fiery `hold`, Smart Inbox, VersaWorks queue B), release via interface, IPP Release-Job, JMF ResumeQueueEntry or Fiery API.
- **Tray empty while printing** → automatic tray switching to the same media or stop with `media-empty-error`; after refilling the job continues.
- **Finishing conflicts** (e.g. booklet above the maximum sheet count, punching at too high grammage, staple position not available) → job held with reason, “Print anyway” possible.
- **Faults** at the push of a button: paper jam, cover open, finisher/blade error, offline, pause.
- **Printer switched off** (control centre): no answer on any protocol, like a device without power.

### Processing per device type

- **Sheet:** 1:1 with automatic rotation and scaling, N-up, booklet (imposition scheme, blank pages, creep, half fold, saddle stitch, face trim, square fold), step & repeat with bleed, crop marks and numbered guillotine cut sequence, duplex long/short edge, staple/punch positions (DIN 80 mm), fold lines.
- **Wide format:** automatic roll selection (narrowest fitting width, rotation saves roll), synchro or standard-length cut, remaining width as waste, nesting, tiling with overlap, borderless, remaining roll length/end of roll, DIN 824 folding (simplified).
- **Photo:** the roll width must match a print edge, fill with calculated crop or fit with border, borderless overprint, cut per print, back printing.
- **Print & cut:** nesting on the roll, L crop marks (+ intermediate marks on long jobs), contour cut from `CutContour`, perforation from `PerfCutContour`, alternatively TrimBox cut, print only/cut only, cross cut, cut length and time.

## Loading media, triggering faults

Interface → device → **Load media**: every tray / roll gets a media from the catalogue (only fitting sizes/widths are offered) and a level (sheets or remaining metres). The catalogue can be extended under **Media catalogue**. Everything is reported immediately via IPP (`media-col-ready`), SNMP (Printer MIB), JMF (`Resource`) and Fiery API (`/consumables`).

The **time lapse** at the top right controls how fast simulated time passes (instant, real time, 5×, 20×, 100×) – useful to test an app's status polling while jobs are running.

## Ticket format

For hot folder companion files (`<name>.json`), the upload in the interface, presets and the Fiery API field `ticket`:

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
  "photo": { "printSizeMm": [102, 152], "fit": "fill", "backprint": "Order 4711 / image {n}" },
  "cut": { "mode": "contour", "marks": true, "perf": true, "sheetCut": true }
}
```

All fields are optional. Whatever is not set comes from the preset or the device default – the log shows for every setting where it came from.

## Limits of the simulation

- No real rasterization, no colour management, no trapping logic; `ausgabe.pdf` is imposed as vectors.
- DIN 824 folding and creep are simplified; fold sequences of real folding machines differ.
- The Fiery API is an approximation (see above); JMF/JDF covers the usual job submissions, not the complete standard.
- `schnitt.camm` is meant for traceability (paths, order, origin) – not to drive a real plotter.
- PostScript needs Ghostscript on the computer (path in the settings).
- HTTPS for Fiery API/IPPS is not built in (everything runs over HTTP).
- SNMP answers v1/v2c queries (GET/GETNEXT/GETBULK) for a subset of the Printer MIB; no SNMPv3, no traps, no setting of values.
- The system printer setup was tested against an emulated `lpadmin`, not a real CUPS; the Windows path is untested.

## Project structure & development

```
src/
  cli.js, server.js          start (headless) and HTTP server (interface, REST API, device ports)
  control.js                 control centre (start/stop, printers on/off, printer pages)
  i18n.js                    German/English ($t(de, en))
  config/defaults.js         machine park + media catalogue
  frontends/                 behaviour of the front ends (queues, terms, rules)
  core/                      Fleet, Device (status, media, queue), Job (log, protocol)
  protocols/                 IPP (codec + server), LPD, socket/PJL, SNMP, mDNS, JMF/JDF, Fiery API, hot folder, device web pages
  pipeline/                  format detection, preflight (spot colours/cut paths), media, imposition
                             (sheet, roll, photo, print & cut), finishing, output PDFs, process
  system/                    PPD driver generation, system printer setup (CUPS/Windows)
src/vendor/pdf-lib.js        bundled pdf-lib (incl. pako, tslib) – no npm dependencies at runtime
ui/                          interface (no framework); ui/vendor/pdfjs = pdf.js for the sheet view
tools/portable.sh            build the portable package incl. Node.js runtime
electron/main.js             desktop shell for AppImage/.exe
tools/send.js                test client (IPP/LPR/socket/JMF)
tools/make-samples.js        sample files (booklet, business cards, plans, photo, sticker with CutContour, PJL, HP-GL)
test/                        node:test – unit and end-to-end tests over the real protocols
```

```bash
node --test       # tests (start the simulation on test ports)
npm start         # headless
npm run app       # Electron
```

New user-facing text is written bilingually: `$t('Deutscher Text', 'English text')` (module-level constants: `$tp(…)` inside `$lazy({…})`, in the browser UI `$t` reads the current language).

REST API of the interface (for automation, e.g. in tests of your app): `GET /api/state`, `GET /api/jobs`, `GET /api/jobs/{id}`, `POST /api/jobs/{id}/release|cancel|reprint|hold|delete|ticket`, `POST /api/devices/{id}/slots/{slot}` (`{"mediaId":"…","level":…}`), `POST /api/devices/{id}/errors` (`{"type":"jam","active":true}`), `PUT /api/devices/{id}` (`{"enabled":false}` = device off), `PUT /api/settings` (`{"timeFactor":0}`, `{"lang":"en"}`), `POST /api/quit`, `GET /api/events` (server-sent events).

## About this project & feedback

This project was created with **Claude** (Anthropic's AI assistant) – code, tests and documentation were generated in a conversation and then tested against the author's own print app.

**Suggestions for improvement are very welcome!** Whether a device behaves differently from the real machine, a protocol detail is missing, a translation is clumsy or you have an idea for a new feature – please open an [issue](../../issues) or a pull request.

## Licence

MIT – see [LICENSE](LICENSE). Bundled third-party components and their licences: [THIRD_PARTY_LICENSES.txt](THIRD_PARTY_LICENSES.txt). Manufacturer and product names are only used to name the simulated devices; the project is not affiliated with Canon, Xerox, Epson, Roland DG or EFI.
