'use strict';
// Standard-Maschinenpark und Materialkatalog.
// Werte (Geschwindigkeiten, Kapazitäten, Ränder) sind praxisnahe Annahmen für die Simulation,
// keine Herstellerangaben. Alles lässt sich in der Oberfläche oder in fleet.json anpassen.

const { $tp } = require('../i18n');
const M = (id, name, kind, o) => ({ id, name, kind, ...o });

const media = [
  // ---------- Bogenware ----------
  M('plain-80-a4', $tp('Normalpapier 80 g A4', 'Plain paper 80 g A4'), 'sheet', { widthMm: 210, heightMm: 297, gsm: 80, type: 'plain', ippType: 'stationery' }),
  M('plain-80-a3', $tp('Normalpapier 80 g A3', 'Plain paper 80 g A3'), 'sheet', { widthMm: 297, heightMm: 420, gsm: 80, type: 'plain', ippType: 'stationery' }),
  M('cc-100-a4', 'Color Copy 100 g A4', 'sheet', { widthMm: 210, heightMm: 297, gsm: 100, type: 'uncoated', ippType: 'stationery' }),
  M('cc-120-sra3', 'Color Copy 120 g SRA3', 'sheet', { widthMm: 320, heightMm: 450, gsm: 120, type: 'uncoated', ippType: 'stationery' }),
  M('cc-250-sra3', 'Color Copy 250 g SRA3', 'sheet', { widthMm: 320, heightMm: 450, gsm: 250, type: 'uncoated', ippType: 'cardstock' }),
  M('gloss-135-sra3', $tp('Bilderdruck glänzend 135 g SRA3', 'Coated gloss 135 g SRA3'), 'sheet', { widthMm: 320, heightMm: 450, gsm: 135, type: 'coated-glossy', ippType: 'stationery-coated' }),
  M('gloss-135-a3', $tp('Bilderdruck glänzend 135 g A3', 'Coated gloss 135 g A3'), 'sheet', { widthMm: 297, heightMm: 420, gsm: 135, type: 'coated-glossy', ippType: 'stationery-coated' }),
  M('matt-170-sra3', $tp('Bilderdruck matt 170 g SRA3', 'Coated matt 170 g SRA3'), 'sheet', { widthMm: 320, heightMm: 450, gsm: 170, type: 'coated-matte', ippType: 'stationery-coated' }),
  M('matt-300-sra3', $tp('Bilderdruck matt 300 g SRA3', 'Coated matt 300 g SRA3'), 'sheet', { widthMm: 320, heightMm: 450, gsm: 300, type: 'coated-matte', ippType: 'cardstock' }),
  M('karton-350-sra3', $tp('Karton matt 350 g SRA3', 'Cover board matt 350 g SRA3'), 'sheet', { widthMm: 320, heightMm: 450, gsm: 350, type: 'coated-matte', ippType: 'cardstock' }),
  M('offset-90-b3', 'Offset 90 g B3 (353 × 500)', 'sheet', { widthMm: 353, heightMm: 500, gsm: 90, type: 'uncoated', ippType: 'stationery' }),
  M('banner-200-330x1200', $tp('Bilderdruck 200 g Langbogen 330 × 1200', 'Coated 200 g long sheet 330 × 1200'), 'sheet', { widthMm: 330, heightMm: 1200, gsm: 200, type: 'coated-glossy', ippType: 'stationery-coated' }),
  M('label-sra3', $tp('Etikettenbogen Folie weiß SRA3', 'Label sheet film white SRA3'), 'sheet', { widthMm: 320, heightMm: 450, gsm: 180, type: 'labels', ippType: 'labels' }),
  // ---------- Rollenware Großformat ----------
  M('bond-80-914', 'Bond 80 g, 914 mm × 50 m', 'roll', { widthMm: 914, lengthM: 50, gsm: 80, type: 'bond', ippType: 'stationery' }),
  M('bond-80-841', 'Bond 80 g, 841 mm × 50 m', 'roll', { widthMm: 841, lengthM: 50, gsm: 80, type: 'bond', ippType: 'stationery' }),
  M('bond-80-610', 'Bond 80 g, 610 mm × 50 m', 'roll', { widthMm: 610, lengthM: 50, gsm: 80, type: 'bond', ippType: 'stationery' }),
  M('bond-80-594', 'Bond 80 g, 594 mm × 50 m', 'roll', { widthMm: 594, lengthM: 50, gsm: 80, type: 'bond', ippType: 'stationery' }),
  M('bond-80-420', 'Bond 80 g, 420 mm × 50 m', 'roll', { widthMm: 420, lengthM: 50, gsm: 80, type: 'bond', ippType: 'stationery' }),
  M('poster-180-914', $tp('Posterpapier matt 180 g, 914 mm × 30 m', 'Poster paper matt 180 g, 914 mm × 30 m'), 'roll', { widthMm: 914, lengthM: 30, gsm: 180, type: 'coated-matte', ippType: 'stationery-coated' }),
  M('photo-gloss-260-1118', $tp('Fotopapier glänzend 260 g, 1118 mm × 30,5 m', 'Photo paper glossy 260 g, 1118 mm × 30.5 m'), 'roll', { widthMm: 1118, lengthM: 30.5, gsm: 260, type: 'photo-glossy', ippType: 'photographic-glossy' }),
  M('photo-satin-240-1118', $tp('Fotopapier satin 240 g, 1118 mm × 30,5 m', 'Photo paper satin 240 g, 1118 mm × 30.5 m'), 'roll', { widthMm: 1118, lengthM: 30.5, gsm: 240, type: 'photo-satin', ippType: 'photographic-satin' }),
  M('proof-250-610', $tp('Proofpapier 250 g, 610 mm × 30,5 m', 'Proofing paper 250 g, 610 mm × 30.5 m'), 'roll', { widthMm: 610, lengthM: 30.5, gsm: 250, type: 'proof', ippType: 'photographic-semi-gloss' }),
  M('canvas-380-914', 'Canvas 380 g, 914 mm × 12 m', 'roll', { widthMm: 914, lengthM: 12, gsm: 380, type: 'canvas', ippType: 'fabric' }),
  // ---------- Fotorollen (Minilab) ----------
  ...[89, 102, 127, 152, 203, 210].map((w) =>
    M(`photo-luster-${w}`, $tp(`Fotopapier Luster 254 g, ${w} mm × 65 m`, `Photo paper luster 254 g, ${w} mm × 65 m`), 'roll', { widthMm: w, lengthM: 65, gsm: 254, type: 'photo-luster', ippType: 'photographic-semi-gloss' })),
  ...[102, 152, 210].map((w) =>
    M(`photo-gloss-${w}`, $tp(`Fotopapier glänzend 254 g, ${w} mm × 65 m`, `Photo paper glossy 254 g, ${w} mm × 65 m`), 'roll', { widthMm: w, lengthM: 65, gsm: 254, type: 'photo-glossy', ippType: 'photographic-glossy' })),
  // ---------- Folien für Print & Cut ----------
  M('vinyl-mono-1370', $tp('Monomer-Vinyl weiß glänzend, 1370 mm × 50 m', 'Monomeric vinyl white gloss, 1370 mm × 50 m'), 'roll', { widthMm: 1370, lengthM: 50, gsm: 160, type: 'vinyl', ippType: 'labels' }),
  M('vinyl-poly-1524', $tp('Polymer-Vinyl weiß matt, 1524 mm × 50 m', 'Polymeric vinyl white matt, 1524 mm × 50 m'), 'roll', { widthMm: 1524, lengthM: 50, gsm: 160, type: 'vinyl', ippType: 'labels' }),
  M('banner-510-1600', 'Frontlit-Banner 510 g, 1600 mm × 50 m', 'roll', { widthMm: 1600, lengthM: 50, gsm: 510, type: 'banner', ippType: 'other' }),
  M('vinyl-mono-500', $tp('Monomer-Vinyl weiß glänzend, 500 mm × 25 m', 'Monomeric vinyl white gloss, 500 mm × 25 m'), 'roll', { widthMm: 500, lengthM: 25, gsm: 160, type: 'vinyl', ippType: 'labels' }),
  M('flex-pu-500', $tp('Flexfolie bedruckbar (Textil), 500 mm × 25 m', 'Printable flex film (textile), 500 mm × 25 m'), 'roll', { widthMm: 500, lengthM: 25, gsm: 150, type: 'transfer', ippType: 'other' }),
];

const sheetSlot = (id, name, ippSource, capacity, mediaId, o = {}) => ({ id, name, kind: 'sheet', ippSource, capacity, loaded: mediaId ? { mediaId, level: capacity } : null, ...o });
const rollSlot = (id, name, ippSource, mediaId, o = {}) => ({ id, name, kind: 'roll', ippSource, loaded: mediaId ? { mediaId, levelM: null } : null, ...o });
const toner = (lvl = 85) => [
  { name: 'Cyan', color: '#00a0e0', level: lvl, type: 'toner' },
  { name: 'Magenta', color: '#e0007a', level: lvl - 7, type: 'toner' },
  { name: 'Yellow', color: '#f5d000', level: lvl - 12, type: 'toner' },
  { name: 'Black', color: '#222222', level: lvl - 3, type: 'toner' },
];
const inks = (names) => names.map((n, i) => ({ name: n[0], color: n[1], level: 90 - i * 4, type: 'ink' }));

const devices = [
  {
    id: 'ipv1350', name: 'Canon imagePRESS V1350', vendor: 'Canon', model: 'imagePRESS V1350', kind: 'sheet',
    frontend: { type: 'fiery', product: $tp('imagePRESS Server (Fiery-basiert)', 'imagePRESS Server (Fiery-based)') },
    color: true, duplex: true, speed: { ppm: 135 },
    marginsMm: { left: 2, right: 2, top: 2, bottom: 2 },
    sheet: { minMm: [100, 148], maxMm: [330, 1300], maxGsm: 400, duplexMaxGsm: 400 },
    slots: [
      sheetSlot('tray-1', $tp('Fach 1', 'Tray 1'), 'tray-1', 550, 'cc-100-a4'),
      sheetSlot('tray-2', $tp('Fach 2', 'Tray 2'), 'tray-2', 550, 'plain-80-a3'),
      sheetSlot('pod-1', 'POD-Deck 1', 'large-capacity', 2000, 'gloss-135-sra3'),
      sheetSlot('pod-2', 'POD-Deck 2', 'large-capacity-2', 2000, 'matt-300-sra3'),
      sheetSlot('bypass', $tp('Stapelanlage (Bypass)', 'Multi-sheet bypass'), 'manual', 250, null),
    ],
    finisher: {
      name: $tp('Broschürenfinisher + Falzeinheit + Trimmer', 'Booklet finisher + folding unit + trimmer'),
      modules: {
        stapler: { maxSheets: 100, positions: ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'dual-left', 'dual-top', 'dual-right'], staples: 5000 },
        puncher: { holes: [2, 4], maxGsm: 300 },
        booklet: { maxSheets: 30, trim: true, maxTrimMm: 15, squareFold: false, staples: 2000 },
        folder: { types: ['half', 'letter', 'z', 'engineering-z'], maxGsm: 105 },
        stacker: { capacity: 3500 },
      },
      bins: [{ id: 'top', name: $tp('Obere Ablage', 'Top tray') }, { id: 'stacker', name: $tp('Hauptablage', 'Main tray') }, { id: 'booklet', name: $tp('Broschürenablage', 'Booklet tray') }],
    },
    presets: [
      { name: 'Broschuere_A5', ticket: { imposition: 'booklet', finishing: { booklet: { saddle: true } } } },
      { name: 'Visitenkarten_SRA3', ticket: { imposition: 'step-repeat', stepRepeat: { gapMm: 0, bleedMm: 3, marks: true }, media: { mediaId: 'matt-300-sra3' } } },
      { name: 'Handout_2auf1', ticket: { imposition: 'n-up', numberUp: 2, sides: 'two-sided-long-edge' } },
    ],
    supplies: toner(88),
  },
  {
    id: 'vpix3200', name: 'Canon varioPRINT iX3200', vendor: 'Canon', model: 'varioPRINT iX3200', kind: 'sheet',
    frontend: { type: 'prismasync', product: 'PRISMAsync Print Server' },
    color: true, duplex: true, speed: { ppm: 320 },
    marginsMm: { left: 3, right: 3, top: 3, bottom: 3 },
    sheet: { minMm: [182, 182], maxMm: [353, 750], maxGsm: 350, duplexMaxGsm: 350 },
    slots: [
      sheetSlot('tray-1', $tp('Fach 1', 'Tray 1'), 'tray-1', 2500, 'offset-90-b3'),
      sheetSlot('tray-2', $tp('Fach 2', 'Tray 2'), 'tray-2', 2500, 'gloss-135-sra3'),
      sheetSlot('tray-3', $tp('Fach 3', 'Tray 3'), 'tray-3', 2500, 'matt-170-sra3'),
      sheetSlot('tray-4', $tp('Fach 4', 'Tray 4'), 'tray-4', 2500, 'cc-120-sra3'),
    ],
    finisher: {
      name: $tp('Hefter/Broschürenmodul + Hochstapler', 'Stapler/booklet module + high-capacity stacker'),
      modules: {
        stapler: { maxSheets: 100, positions: ['top-left', 'dual-left', 'dual-top'], staples: 5000 },
        puncher: { holes: [2, 4], maxGsm: 250 },
        booklet: { maxSheets: 50, trim: true, maxTrimMm: 20, squareFold: true, staples: 5000 },
        stacker: { capacity: 5000 },
      },
      bins: [{ id: 'stacker', name: $tp('Hochstapler', 'High-capacity stacker') }, { id: 'top', name: $tp('Probeausgabe', 'Proof tray') }, { id: 'booklet', name: $tp('Broschürenablage', 'Booklet tray') }],
    },
    presets: [
      { name: 'Broschuere', ticket: { imposition: 'booklet', finishing: { booklet: { saddle: true, squareFold: true, trimMm: 5 } } } },
    ],
    supplies: inks([['Cyan', '#00a0e0'], ['Magenta', '#e0007a'], ['Yellow', '#f5d000'], ['Black', '#222']]),
  },
  {
    id: 'iridesse', name: 'Xerox Iridesse Production Press', vendor: 'Xerox', model: 'Iridesse Production Press', kind: 'sheet',
    frontend: { type: 'fiery', product: $tp('Xerox EX-P Print Server (Fiery-basiert)', 'Xerox EX-P Print Server (Fiery-based)') },
    color: true, duplex: true, speed: { ppm: 120 },
    marginsMm: { left: 2, right: 2, top: 2, bottom: 2 },
    sheet: { minMm: [98, 146], maxMm: [330, 1200], maxGsm: 400, duplexMaxGsm: 400 },
    slots: [
      sheetSlot('tray-1', $tp('Fach 1', 'Tray 1'), 'tray-1', 2000, 'gloss-135-sra3'),
      sheetSlot('tray-2', $tp('Fach 2', 'Tray 2'), 'tray-2', 2000, 'matt-170-sra3'),
      sheetSlot('tray-6', $tp('Fach 6 (OHCF)', 'Tray 6 (OHCF)'), 'large-capacity', 2000, 'cc-250-sra3'),
      sheetSlot('tray-7', $tp('Fach 7 (OHCF)', 'Tray 7 (OHCF)'), 'large-capacity-2', 2000, 'banner-200-330x1200'),
      sheetSlot('tray-5', $tp('Zusatzzufuhr', 'Bypass tray'), 'manual', 250, null),
    ],
    finisher: {
      name: $tp('Production Ready Finisher Plus + SquareFold Trimmer + C/Z-Falzung', 'Production Ready Finisher Plus + SquareFold Trimmer + C/Z folding'),
      modules: {
        stapler: { maxSheets: 100, positions: ['top-left', 'top-right', 'dual-left', 'dual-top'], staples: 5000 },
        puncher: { holes: [2, 4], maxGsm: 220 },
        booklet: { maxSheets: 30, trim: true, maxTrimMm: 20, squareFold: true, staples: 2000 },
        folder: { types: ['letter', 'z', 'engineering-z'], maxGsm: 90 },
        stacker: { capacity: 3000 },
      },
      bins: [{ id: 'top', name: $tp('Obere Ablage', 'Top tray') }, { id: 'stacker', name: $tp('Stapelfach', 'Stacker tray') }, { id: 'booklet', name: $tp('Broschürenablage', 'Booklet tray') }],
    },
    presets: [
      { name: 'Broschuere_SquareFold', ticket: { imposition: 'booklet', finishing: { booklet: { saddle: true, squareFold: true, trimMm: 5 } } } },
      { name: 'Langbogen_Banner', ticket: { media: { mediaId: 'banner-200-330x1200' } } },
    ],
    supplies: toner(76),
  },
  {
    id: 'versant4100', name: 'Xerox Versant 4100', vendor: 'Xerox', model: 'Versant 4100 Press', kind: 'sheet',
    frontend: { type: 'ffps', product: 'Xerox FreeFlow Print Server' },
    color: true, duplex: true, speed: { ppm: 100 },
    marginsMm: { left: 2, right: 2, top: 2, bottom: 2 },
    sheet: { minMm: [102, 152], maxMm: [330, 660], maxGsm: 350, duplexMaxGsm: 350 },
    slots: [
      sheetSlot('tray-1', $tp('Fach 1', 'Tray 1'), 'tray-1', 550, 'plain-80-a4'),
      sheetSlot('tray-2', $tp('Fach 2', 'Tray 2'), 'tray-2', 550, 'plain-80-a3'),
      sheetSlot('tray-3', $tp('Fach 3', 'Tray 3'), 'tray-3', 550, 'cc-250-sra3'),
      sheetSlot('tray-6', $tp('Fach 6 (HCF)', 'Tray 6 (HCF)'), 'large-capacity', 2000, 'gloss-135-sra3'),
      sheetSlot('tray-5', $tp('Zusatzzufuhr', 'Bypass tray'), 'manual', 250, null),
    ],
    finisher: {
      name: $tp('Business Ready Finisher mit Booklet Maker', 'Business Ready Finisher with Booklet Maker'),
      modules: {
        stapler: { maxSheets: 50, positions: ['top-left', 'dual-left', 'dual-top'], staples: 5000 },
        puncher: { holes: [2, 4], maxGsm: 220 },
        booklet: { maxSheets: 16, trim: false, squareFold: false, staples: 2000 },
        stacker: { capacity: 2000 },
      },
      bins: [{ id: 'top', name: $tp('Obere Ablage', 'Top tray') }, { id: 'stacker', name: $tp('Stapelfach', 'Stacker tray') }, { id: 'booklet', name: $tp('Broschürenablage', 'Booklet tray') }],
    },
    presets: [{ name: 'DefaultQueue', ticket: {} }],
    supplies: toner(64),
  },
  {
    id: 'cw3800', name: 'Canon colorWAVE 3800', vendor: 'Canon', model: 'colorWAVE 3800', kind: 'wide',
    frontend: { type: 'publisher', product: $tp('Integrierter Controller (ClearConnect-Bedienfeld, WebTools Express)', 'Embedded controller (ClearConnect panel, WebTools Express)') },
    color: true, duplex: false, speed: { m2h: 300 },
    marginsMm: { left: 3, right: 3, top: 3, bottom: 3 },
    roll: { minWidthMm: 297, maxWidthMm: 1067, maxLengthMm: 6000, leadTrimMm: 5, borderless: false, nesting: false, autoRoll: true },
    slots: [
      rollSlot('roll-1', $tp('Rolle 1', 'Roll 1'), 'main-roll', 'bond-80-914'),
      rollSlot('roll-2', $tp('Rolle 2', 'Roll 2'), 'alternate-roll', 'bond-80-841'),
      rollSlot('roll-3', $tp('Rolle 3', 'Roll 3'), 'roll-3', 'bond-80-594'),
      rollSlot('roll-4', $tp('Rolle 4', 'Roll 4'), 'roll-4', 'poster-180-914'),
    ],
    finisher: {
      name: $tp('Querschneider + Online-Faltmaschine + Ablage', 'Cross cutter + online folder + tray'),
      modules: {
        cutter: { modes: ['synchro', 'standard'] },
        wfFolder: { forms: ['din824-a', 'din824-b', 'fan'], maxWidthMm: 914, maxLengthMm: 5000 },
        stacker: { capacity: 150 },
      },
      bins: [{ id: 'top', name: $tp('Obere Ablage', 'Top tray') }, { id: 'folder', name: $tp('Faltmaschine', 'Folder') }, { id: 'rear', name: $tp('Hintere Ablage', 'Rear tray') }],
    },
    presets: [
      { name: 'CAD_Falten_DIN824', ticket: { finishing: { fold: 'din824-a' }, outputBin: 'folder' } },
    ],
    supplies: [{ name: 'Cyan', color: '#00a0e0', level: 70, type: 'toner' }, { name: 'Magenta', color: '#e0007a', level: 66, type: 'toner' }, { name: 'Yellow', color: '#f5d000', level: 81, type: 'toner' }, { name: 'Black', color: '#222', level: 52, type: 'toner' }],
  },
  {
    id: 'p9500', name: 'Epson SureColor SC-P9500', vendor: 'Epson', model: 'SureColor SC-P9500 (44")', kind: 'wide',
    frontend: { type: 'edgeprint', product: $tp('Epson Edge Print (Software-RIP auf einem PC vor dem Drucker)', 'Epson Edge Print (software RIP on a PC in front of the printer)') },
    color: true, duplex: false, speed: { m2h: 18 },
    marginsMm: { left: 3, right: 3, top: 3, bottom: 3 },
    roll: { minWidthMm: 254, maxWidthMm: 1118, maxLengthMm: 18000, leadTrimMm: 10, borderless: true, nesting: true, autoRoll: false },
    slots: [rollSlot('roll-1', $tp('Rollenhalter', 'Roll holder'), 'main-roll', 'photo-gloss-260-1118')],
    finisher: { name: $tp('Auto-Cutter + Aufwickler', 'Auto cutter + take-up reel'), modules: { cutter: { modes: ['auto', 'none'] }, takeUp: {} }, bins: [{ id: 'basket', name: $tp('Papierkorb', 'Paper basket') }, { id: 'takeup', name: $tp('Aufwickler', 'Take-up reel') }] },
    presets: [{ name: 'Foto_Nesting', frontend: 'edgeprint', ticket: { roll: { nesting: true } } }, { name: 'Randlos', frontend: 'edgeprint', ticket: { roll: { borderless: true } } }],
    supplies: inks([['Cyan', '#00a0e0'], ['Vivid Magenta', '#e0007a'], ['Yellow', '#f5d000'], ['Photo Black', '#111'], ['Matte Black', '#333'], ['Light Cyan', '#7fd3f7'], ['Vivid Light Magenta', '#f49ac1'], ['Orange', '#f7941d'], ['Green', '#00a651'], ['Violet', '#7f3f98'], ['Gray', '#888'], ['Light Gray', '#bbb']]),
  },
  {
    id: 't7700d', name: 'Epson SureColor SC-T7700D', vendor: 'Epson', model: $tp('SureColor SC-T7700D (44", Doppelrolle)', 'SureColor SC-T7700D (44", dual roll)'), kind: 'wide',
    frontend: { type: 'driver', product: $tp('Integrierte Netzwerkschnittstelle (Epson Web Config) – ohne RIP', 'Embedded network interface (Epson Web Config) – no RIP') },
    color: true, duplex: false, speed: { m2h: 120 },
    marginsMm: { left: 3, right: 3, top: 3, bottom: 3 },
    roll: { minWidthMm: 254, maxWidthMm: 1118, maxLengthMm: 18000, leadTrimMm: 5, borderless: false, nesting: false, autoRoll: true },
    slots: [rollSlot('roll-1', $tp('Rolle 1 (oben)', 'Roll 1 (upper)'), 'main-roll', 'bond-80-914'), rollSlot('roll-2', $tp('Rolle 2 (unten)', 'Roll 2 (lower)'), 'alternate-roll', 'bond-80-610')],
    finisher: { name: $tp('Auto-Cutter + Ablagekorb', 'Auto cutter + output basket'), modules: { cutter: { modes: ['auto'] }, stacker: { capacity: 20 } }, bins: [{ id: 'stacker', name: $tp('Ablagekorb', 'Output basket') }] },
    presets: [],
    supplies: inks([['Cyan', '#00a0e0'], ['Magenta', '#e0007a'], ['Yellow', '#f5d000'], ['Black', '#222'], ['Matte Black', '#333']]),
  },
  {
    id: 'sld1070', name: 'Epson SureLab SL-D1070', vendor: 'Epson', model: 'SureLab SL-D1070', kind: 'photo',
    frontend: { type: 'ordercontroller', product: $tp('Epson Order Controller (Software auf dem angeschlossenen PC)', 'Epson Order Controller (software on the connected PC)') },
    color: true, duplex: false, speed: { printsPerHour: 360, refSizeMm: [102, 152] },
    marginsMm: { left: 0, right: 0, top: 0, bottom: 0 },
    roll: { minWidthMm: 89, maxWidthMm: 210, minLengthMm: 89, maxLengthMm: 1000, borderless: true, overspillMm: 1.5, leadTrimMm: 0 },
    slots: [rollSlot('roll-1', $tp('Papierrolle', 'Paper roll'), 'main-roll', 'photo-luster-152')],
    finisher: { name: $tp('Schneider + Sortierfach + Rückseitendruck', 'Cutter + sorter + back printing'), modules: { cutter: { modes: ['auto'] }, backprint: {}, sorter: { bins: 1 } }, bins: [{ id: 'tray', name: $tp('Ausgabefach', 'Output tray') }] },
    presets: [{ name: '10x15_Luster', ticket: { photo: { printSizeMm: [102, 152], fit: 'fill' } } }, { name: '13x18', ticket: { photo: { printSizeMm: [127, 178], fit: 'fill' } } }, { name: '20x30', ticket: { photo: { printSizeMm: [203, 305], fit: 'fill' } } }],
    supplies: inks([['Black', '#222'], ['Cyan', '#00a0e0'], ['Magenta', '#e0007a'], ['Yellow', '#f5d000'], ['Light Cyan', '#7fd3f7'], ['Light Magenta', '#f49ac1']]),
  },
  {
    id: 'sld870', name: 'Epson SureLab SL-D870', vendor: 'Epson', model: 'SureLab SL-D870', kind: 'photo',
    frontend: { type: 'ordercontroller', product: $tp('Epson Order Controller (Software auf dem angeschlossenen PC)', 'Epson Order Controller (software on the connected PC)') },
    color: true, duplex: false, speed: { printsPerHour: 290, refSizeMm: [102, 152] },
    marginsMm: { left: 0, right: 0, top: 0, bottom: 0 },
    roll: { minWidthMm: 89, maxWidthMm: 210, minLengthMm: 89, maxLengthMm: 1000, borderless: true, overspillMm: 1.5, leadTrimMm: 0 },
    slots: [rollSlot('roll-1', $tp('Papierrolle', 'Paper roll'), 'main-roll', 'photo-gloss-210')],
    finisher: { name: $tp('Schneider + Ausgabefach', 'Cutter + output tray'), modules: { cutter: { modes: ['auto'] }, backprint: {} }, bins: [{ id: 'tray', name: $tp('Ausgabefach', 'Output tray') }] },
    presets: [{ name: '20x30', ticket: { photo: { printSizeMm: [203, 305], fit: 'fill' } } }, { name: '21x30', ticket: { photo: { printSizeMm: [210, 297], fit: 'fill' } } }],
    supplies: inks([['Black', '#222'], ['Cyan', '#00a0e0'], ['Magenta', '#e0007a'], ['Yellow', '#f5d000'], ['Light Cyan', '#7fd3f7'], ['Light Magenta', '#f49ac1']]),
  },
  {
    id: 'vg3640', name: 'Roland TrueVIS VG3-640', vendor: 'Roland DG', model: 'TrueVIS VG3-640 (Print & Cut)', kind: 'printcut',
    frontend: { type: 'versaworks', product: $tp('Roland VersaWorks 6 (Software-RIP auf einem PC)', 'Roland VersaWorks 6 (software RIP on a PC)') },
    color: true, duplex: false, speed: { m2h: 18, cutMmS: 300 },
    marginsMm: { left: 10, right: 10, top: 10, bottom: 10 },
    roll: { minWidthMm: 259, maxWidthMm: 1625, maxLengthMm: 25000, leadTrimMm: 20, borderless: false, nesting: true, gapMm: 5, markOffsetMm: 10, markSizeMm: 10, multiMarkEveryMm: 1000 },
    slots: [rollSlot('roll-1', $tp('Medienrolle', 'Media roll'), 'main-roll', 'vinyl-mono-1370')],
    finisher: {
      name: $tp('Integriertes Schneidmesser + Querschneider + Aufwickler', 'Integrated cutting blade + cross cutter + take-up reel'),
      modules: { contourCutter: { forceGf: 80, speedCmS: 30, perf: true }, cutter: { modes: ['sheet-cut', 'none'] }, takeUp: {} },
      bins: [{ id: 'front', name: $tp('Medienausgabe vorne', 'Front media output') }, { id: 'takeup', name: $tp('Aufwickler', 'Take-up reel') }],
    },
    presets: [
      { name: 'QueueA', mode: 'print', ticket: { cut: { mode: 'contour', marks: true } } },
      { name: 'QueueB', mode: 'hold', ticket: { cut: { mode: 'contour', marks: true } } },
      { name: 'NurDruck', ticket: { cut: { mode: 'none' } } },
    ],
    supplies: inks([['Cyan', '#00a0e0'], ['Magenta', '#e0007a'], ['Yellow', '#f5d000'], ['Black', '#222'], ['Red', '#e3001b'], ['Orange', '#f7941d'], ['Green', '#00a651'], ['Light Black', '#666']]),
  },
  {
    id: 'bn220', name: 'Roland BN2-20', vendor: 'Roland DG', model: 'BN2-20 (Print & Cut Desktop)', kind: 'printcut',
    frontend: { type: 'versaworks', product: $tp('Roland VersaWorks 6 (Software-RIP auf einem PC)', 'Roland VersaWorks 6 (software RIP on a PC)') },
    color: true, duplex: false, speed: { m2h: 4, cutMmS: 150 },
    marginsMm: { left: 7, right: 7, top: 10, bottom: 10 },
    roll: { minWidthMm: 150, maxWidthMm: 515, maxLengthMm: 25000, leadTrimMm: 10, borderless: false, nesting: true, gapMm: 4, markOffsetMm: 8, markSizeMm: 8, multiMarkEveryMm: 1000 },
    slots: [rollSlot('roll-1', $tp('Medienrolle', 'Media roll'), 'main-roll', 'vinyl-mono-500')],
    finisher: { name: $tp('Integriertes Schneidmesser + Querschneider', 'Integrated cutting blade + cross cutter'), modules: { contourCutter: { forceGf: 60, speedCmS: 15, perf: true }, cutter: { modes: ['sheet-cut', 'none'] } }, bins: [{ id: 'front', name: $tp('Medienausgabe', 'Media output') }] },
    presets: [
      { name: 'QueueA', mode: 'print', ticket: { cut: { mode: 'contour', marks: true } } },
      { name: 'QueueB', mode: 'hold', ticket: { cut: { mode: 'contour', marks: true } } },
    ],
    supplies: inks([['Cyan', '#00a0e0'], ['Magenta', '#e0007a'], ['Yellow', '#f5d000'], ['Black', '#222']]),
  },
];

const settings = {
  uiPort: 8650,
  bindHost: '127.0.0.1',
  basePorts: { http: 6310, lpd: 5150, raw: 9100 },
  timeFactor: 20, // 20 = 20× schneller als Echtzeit, 0 = sofort
  maxRenderedSets: 1,
  ghostscript: '', // Pfad zu gs/gswin64c für PostScript, leer = automatisch suchen
  keepJobs: 500,
  addressing: 'ports', // 'ports' = alle Geräte auf einer IP mit eigenen Ports, 'ip' = jedes Gerät eigene IP (127.0.0.11 …) mit Standardports 631/80/515/9100/161
  mdns: true, // Geräte per Bonjour/mDNS im Netzwerk ankündigen
};

module.exports = { media, devices, settings };
