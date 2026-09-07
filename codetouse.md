I've studied both repos (xwordscan and html5-crossword-solver) — here's a complete build plan for the PWA. The key insight is that we can reuse **all** of the hard parts: xwordscan's grid-detection pipeline maps 1:1 onto [OpenCV.js](https://docs.opencv.org/4.x/d5/d10/tutorial_js_root.html) (same API, same function names), and the solver's `JSCrossword` library (`lib/jscrossword_combined.js`) already knows how to build, serialize, and share a puzzle from plain cell data.

## Architecture

```text
xwscan-pwa/
├── index.html          ← camera UI + scan/review/share flow
├── manifest.json       ← PWA manifest (pattern from solver's manifest.json)
├── sw.js               ← cache-first service worker (pattern from solver's sw.js)
├── css/app.css         ← mobile-first styles
├── js/
│   ├── detect.js       ← xwordscan pipeline ported to OpenCV.js (no OCR)
│   ├── puzzle.js       ← build JSCrossword + generate share URL
│   └── app.js          ← camera capture, UI wiring, SW registration
└── lib/
    ├── opencv.js             ← official WASM build (simple, well-known tool)
    └── jscrossword_combined.js  ← copied verbatim from html5-crossword-solver/lib/
```

## Step 1 — Port the xwordscan pipeline (steps 1–5, skipping OCR)

Every OpenCV call in [`xwordscan.py`](https://github.com/bumface11/xwordscan/blob/affd047f0887ad5611fef607cd6162a269214aca/xwordscan.py) has an identical OpenCV.js equivalent. Here's the port:

```javascript name=js/detect.js
// Direct port of xwordscan.py steps 1–5 (preprocess → deskew → crop →
// size estimation → cell classification). OCR (step 6) is intentionally
// omitted; the solver only needs the grid structure.

function detectGrid(imgElement) {
  const src = cv.imread(imgElement);
  const gray = new cv.Mat();
  const binary = new cv.Mat();

  // --- Step 1: preprocess (xwordscan.preprocess) ---
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  cv.bilateralFilter(gray, gray, 9, 75, 75);
  cv.normalize(gray, gray, 0, 255, cv.NORM_MINMAX);
  cv.adaptiveThreshold(gray, binary, 255,
    cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 15, 10);
  const kernel = cv.Mat.ones(3, 3, cv.CV_8U);
  cv.morphologyEx(binary, binary, cv.MORPH_CLOSE, kernel);

  // --- Step 3: find outer grid bbox (xwordscan.find_grid_bbox) ---
  // (Deskew is skipped: phone photos taken with on-screen alignment
  //  guidance are near-level; add HoughLinesP later if needed.)
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(binary, contours, hierarchy,
    cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
  let best = null, bestArea = 0;
  for (let i = 0; i < contours.size(); i++) {
    const area = cv.contourArea(contours.get(i));
    if (area > bestArea) { bestArea = area; best = cv.boundingRect(contours.get(i)); }
  }
  if (!best) throw new Error('No grid found — get closer and fill the frame.');

  const grayGrid = gray.roi(best);
  const binaryGrid = binary.roi(best);

  // --- Step 4: estimate rows × cols (xwordscan.detect_grid_size) ---
  const rows = countLines(binaryGrid, 'horizontal') - 1;
  const cols = countLines(binaryGrid, 'vertical') - 1;

  // --- Step 5: classify cells (xwordscan.is_black_cell) ---
  const cellH = Math.floor(grayGrid.rows / rows);
  const cellW = Math.floor(grayGrid.cols / cols);
  const blackCells = [];
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < cols; c++) {
      // Inset 15% to ignore grid lines bleeding into the cell sample
      const x = c * cellW + Math.floor(cellW * 0.15);
      const y = r * cellH + Math.floor(cellH * 0.15);
      const w = Math.floor(cellW * 0.7), h = Math.floor(cellH * 0.7);
      const cell = grayGrid.roi(new cv.Rect(x, y, w, h));
      const mean = cv.mean(cell)[0];
      row.push(mean / 255 < 0.5);
      cell.delete();
    }
    blackCells.push(row);
  }

  [src, gray, binary, kernel, contours, hierarchy, grayGrid, binaryGrid]
    .forEach(m => m.delete());
  return { rows, cols, blackCells };
}

function countLines(binaryGrid, dir) {
  const proj = [];
  const limit = dir === 'horizontal' ? binaryGrid.rows : binaryGrid.cols;
  const span  = dir === 'horizontal' ? binaryGrid.cols : binaryGrid.rows;
  for (let i = 0; i < limit; i++) {
    let sum = 0;
    for (let j = 0; j < span; j++) {
      sum += dir === 'horizontal'
        ? binaryGrid.ucharPtr(i, j)[0]
        : binaryGrid.ucharPtr(j, i)[0];
    }
    proj.push(sum / (span * 255));
  }
  // xwordscan._count_line_groups with 0.3 threshold
  let groups = 0, inGroup = false;
  for (const v of proj) {
    if (v > 0.3 && !inGroup) { groups++; inGroup = true; }
    else if (v <= 0.3) inGroup = false;
  }
  return Math.max(1, groups);
}
```

## Step 2 — Build the puzzle and generate the share URL

This mirrors `build_puz()` from xwordscan (standard numbering, `---` placeholder clues) and the share flow from [`src/export.js`](https://github.com/bumface11/html5-crossword-solver/blob/ca6671451f452b9b069eee46da3eab851a03de7d/src/export.js) + [`share.js`](https://github.com/bumface11/html5-crossword-solver/blob/ca6671451f452b9b069eee46da3eab851a03de7d/share.js#L487-L508): serialize with `JSCrossword.serialize()` and put it in the URL hash, which `CrosswordShared.getCrosswordParams()` in [`js/crossword.shared.js`](https://github.com/bumface11/html5-crossword-solver/blob/ca6671451f452b9b069eee46da3eab851a03de7d/js/crossword.shared.js#L16-L32) already knows how to consume.

```javascript name=js/puzzle.js
// Builds a JSCrossword from detected grid data (mirrors xwordscan.build_puz)
// and produces a solver share URL (mirrors sharePuzzle() in src/export.js).

// Point this at your deployed copy of html5-crossword-solver:
const SOLVER_BASE = 'https://bumface11.github.io/html5-crossword-solver/index.html';

function buildPuzzle(rows, cols, blackCells, title = 'Scanned Crossword') {
  const cells = [];
  let clueNum = 1;
  const acrossClues = [], downClues = [];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (blackCells[r][c]) {
        cells.push({ x: c, y: r, type: 'block' });
        continue;
      }
      // Standard numbering, ported from xwordscan.build_puz
      const startsAcross = (c === 0 || blackCells[r][c - 1]) &&
                           c + 1 < cols && !blackCells[r][c + 1];
      const startsDown   = (r === 0 || blackCells[r - 1][c]) &&
                           r + 1 < rows && !blackCells[r + 1][c];
      let number = null;
      if (startsAcross || startsDown) {
        number = String(clueNum++);
        if (startsAcross) acrossClues.push({ word: number, number, text: '---' });
        if (startsDown)   downClues.push({ word: number, number, text: '---' });
      }
      cells.push({ x: c, y: r, solution: '-', number });
    }
  }

  const xw = new JSCrossword(
    { title, author: '', width: cols, height: rows, kind: 'crossword' },
    cells,
    null,
    [
      { title: 'Across', clues: acrossClues },
      { title: 'Down',   clues: downClues }
    ]
  );
  return xw;
}

function shareUrlFor(xw) {
  const encoded = xw.serialize();   // LZ-string, URI-safe — same as sharePuzzle()
  return `${SOLVER_BASE}#${encoded}`;
}
```

## Step 3 — Camera capture + review screen + PWA shell

Keep the camera part dead simple — `<input capture>` hands the heavy lifting to Android's native camera app (autofocus, flash, HDR), which is far more reliable than a custom `getUserMedia` viewfinder for this use case:

```html name=index.html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>xwordscan PWA</title>
  <link rel="manifest" href="manifest.json">
  <meta name="theme-color" content="#111111">
  <link rel="stylesheet" href="css/app.css">
  <script src="lib/jscrossword_combined.js"></script>
  <script src="lib/opencv.js" async onload="cvReady()"></script>
</head>
<body>
  <main id="app">
    <h1>Scan a Crossword</h1>

    <label class="scan-btn">
      📷 Take a photo of the grid
      <input id="camera" type="file" accept="image/*" capture="environment" hidden>
    </label>

    <img id="photo" hidden>

    <section id="review" hidden>
      <h2 id="dims"></h2>
      <div id="gridPreview"></div>   <!-- tap a cell to toggle black/white -->
      <input id="title" placeholder="Puzzle title (optional)">
      <button id="shareBtn">Generate solver link</button>
    </section>

    <section id="result" hidden>
      <input id="shareLink" readonly>
      <button id="copyBtn">Copy</button>
      <a id="openBtn" target="_blank" rel="noopener">Open in solver</a>
    </section>

    <p id="status" role="status"></p>
  </main>
  <script src="js/detect.js"></script>
  <script src="js/puzzle.js"></script>
  <script src="js/app.js"></script>
</body>
</html>
```

```javascript name=js/app.js
let detection = null;

function cvReady() { document.getElementById('status').textContent = 'Ready.'; }

document.getElementById('camera').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const status = document.getElementById('status');
  status.textContent = 'Detecting grid…';
  const img = document.getElementById('photo');
  img.src = URL.createObjectURL(file);
  await img.decode();

  // Downscale for speed — detection doesn't need full camera resolution
  const canvas = document.createElement('canvas');
  const scale = Math.min(1, 1200 / img.naturalWidth);
  canvas.width = img.naturalWidth * scale;
  canvas.height = img.naturalHeight * scale;
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);

  try {
    detection = detectGrid(canvas);   // js/detect.js
    renderReview();
    document.getElementById('review').hidden = false;
    status.textContent = 'Tap cells to fix mistakes, then share.';
  } catch (err) {
    status.textContent = '⚠️ ' + err.message;
  }
});

function renderReview() {
  const { rows, cols, blackCells } = detection;
  document.getElementById('dims').textContent = `${rows} × ${cols} grid`;
  const preview = document.getElementById('gridPreview');
  preview.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  preview.innerHTML = '';
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const cell = document.createElement('button');
    cell.className = 'cell' + (blackCells[r][c] ? ' block' : '');
    cell.onclick = () => {
      blackCells[r][c] = !blackCells[r][c];
      cell.classList.toggle('block');
    };
    preview.appendChild(cell);
  }
}

document.getElementById('shareBtn').addEventListener('click', () => {
  const { rows, cols, blackCells } = detection;
  const title = document.getElementById('title').value.trim() || 'Scanned Crossword';
  const xw = buildPuzzle(rows, cols, blackCells, title);
  const url = shareUrlFor(xw);
  document.getElementById('shareLink').value = url;
  document.getElementById('openBtn').href = url;
  document.getElementById('result').hidden = false;
});

document.getElementById('copyBtn').addEventListener('click', () =>
  navigator.clipboard.writeText(document.getElementById('shareLink').value));

// PWA registration (same pattern as the solver's index.html)
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
```

The manifest and service worker follow the solver's existing patterns — cache-first with a versioned `CACHE_NAME` you bump on deploy, exactly like [`sw.js`](https://github.com/bumface11/html5-crossword-solver/blob/ca6671451f452b9b069eee46da3eab851a03de7d/sw.js):

```javascript name=sw.js
const CACHE_NAME = 'xw-scan-v1'; // bump on every deploy (same rule as the solver)
const ASSETS = [
  './', './index.html', './manifest.json', './css/app.css',
  './js/app.js', './js/detect.js', './js/puzzle.js',
  './lib/jscrossword_combined.js', './lib/opencv.js'
];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS)));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(names => Promise.all(names.map(n => n !== CACHE_NAME && caches.delete(n))))
    .then(() => clients.claim()));
});
self.addEventListener('fetch', e => {
  e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request)));
});
```

## Design decisions & notes

- **No OCR, no Paddle** — as requested. The pipeline stops at grid structure; the solver only needs black/white layout plus sequential numbering (the same `--no-ocr` path xwordscan already supports).
- **Deskew skipped (initially).** xwordscan's Hough deskew targets flatbed scans; with a phone, it's simpler to guide the user ("hold the phone parallel to the page"). `cv.HoughLinesP` exists in OpenCV.js if you want to add it later.
- **Cell sampling is inset 15%** — a small improvement over xwordscan's full-cell mean, because phone photos at slight angles let grid lines bleed into cell edges.
- **Tap-to-toggle review screen** replaces OCR as the human-in-the-loop correction step — fast on mobile and removes the biggest classification failure mode.
- **Serialization is shared verbatim**: `JSCrossword.serialize()` produces exactly the hash format the solver's `CrosswordShared.getCrosswordParams()` deserializes, so the generated URL just works — no solver changes needed.
- **Deliberately not reused:** jQuery and `js/crosswords.js` (the scanner UI is trivial DOM work), and `lscache` (no save-state needed — the share URL *is* the state).

Want me to create the `xwscan-pwa` repo and push these files (plus `css/app.css` and `manifest.json` filled out) as a starting commit?