/* global detectGrid, buildPuzzle, shareUrlFor, whenCvReady */
const APP_BUILD = 'v6 · 2026-09-07';

let detection = null;
let photoCanvas = null;   // downscaled source image
let cropRect = null;      // {x, y, w, h} in photoCanvas pixels; null = whole image
let dragStart = null;

const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const progressBar = $('cvProgressBar');
const progressWrap = $('cvProgressWrap');

$('buildNote').textContent = `build ${APP_BUILD}`;

// OpenCV throws plain integers (Emscripten exception pointers), not Errors
function errMsg(err) {
  if (err && err.message) return err.message;
  return String(err);
}

// --- OpenCV load with progress ---
whenCvReady((fraction) => {
  const pct = Math.min(100, Math.round(fraction * 100));
  progressBar.style.width = pct + '%';
  statusEl.textContent = pct < 100
    ? `Downloading OpenCV… ${pct}%`
    : 'Initializing OpenCV runtime…';
}).then(() => {
  statusEl.textContent = 'Ready — take a photo, or use the sample grid to test.';
  progressWrap.hidden = true;
}).catch((err) => {
  statusEl.textContent = '⚠️ ' + errMsg(err);
});

// --- Step 1: get an image (native camera on mobile, file picker on desktop) ---
$('camera').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';           // allow picking the same file again
  if (!file) return;
  statusEl.textContent = 'Loading photo…';
  try {
    const img = $('photo');
    img.src = URL.createObjectURL(file);
    await img.decode();
    photoCanvas = document.createElement('canvas');
    // Downscale for speed — detection doesn't need full camera resolution
    const scale = Math.min(1, 1200 / img.naturalWidth);
    photoCanvas.width = Math.round(img.naturalWidth * scale);
    photoCanvas.height = Math.round(img.naturalHeight * scale);
    photoCanvas.getContext('2d').drawImage(img, 0, 0, photoCanvas.width, photoCanvas.height);
    showCropStep();
  } catch (err) {
    statusEl.textContent = '⚠️ ' + errMsg(err);
  }
});

// --- Test harness: synthesize a 15×15 grid so the pipeline can be exercised
// --- without a camera (desktop browser, Codespaces port-forward, etc.) ---
$('sampleBtn').addEventListener('click', () => {
  photoCanvas = makeSampleGrid();
  showCropStep();
});

function makeSampleGrid(n = 15, px = 900) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = px;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, px, px);
  const cell = px / n;
  let seed = 42;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const blocks = new Set();
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (rand() < 0.18 && !(r === 0 && c === 0)) {
      blocks.add(r + ',' + c);
      blocks.add((n - 1 - r) + ',' + (n - 1 - c)); // 180° symmetry, like a real puzzle
    }
  }
  ctx.fillStyle = '#000';
  for (const key of blocks) {
    const [r, c] = key.split(',').map(Number);
    ctx.fillRect(c * cell, r * cell, cell, cell);
  }
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 2;
  for (let i = 0; i <= n; i++) {
    ctx.beginPath(); ctx.moveTo(0, i * cell); ctx.lineTo(px, i * cell); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(i * cell, 0); ctx.lineTo(i * cell, px); ctx.stroke();
  }
  return canvas;
}

// --- Step 2: manual crop ---
function showCropStep() {
  $('crop').hidden = false;
  $('review').hidden = true;
  $('result').hidden = true;
  cropRect = null;
  drawCrop();
  statusEl.textContent = 'Drag on the image to select just the grid (or use the whole image).';
  $('crop').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function drawCrop() {
  const canvas = $('cropCanvas');
  canvas.width = photoCanvas.width;
  canvas.height = photoCanvas.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(photoCanvas, 0, 0);
  if (cropRect) {
    const { x, y, w, h } = cropRect;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.fillRect(0, 0, canvas.width, y);
    ctx.fillRect(0, y + h, canvas.width, canvas.height - y - h);
    ctx.fillRect(0, y, x, h);
    ctx.fillRect(x + w, y, canvas.width - x - w, h);
    ctx.strokeStyle = '#2f6fed';
    ctx.lineWidth = Math.max(3, canvas.width / 300);
    ctx.strokeRect(x, y, w, h);
  }
}

function canvasPoint(e) {
  const canvas = $('cropCanvas');
  const rect = canvas.getBoundingClientRect();
  return {
    x: Math.min(Math.max((e.clientX - rect.left) * (canvas.width / rect.width), 0), canvas.width),
    y: Math.min(Math.max((e.clientY - rect.top) * (canvas.height / rect.height), 0), canvas.height),
  };
}

$('cropCanvas').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  dragStart = canvasPoint(e);
  e.target.setPointerCapture(e.pointerId);
});
$('cropCanvas').addEventListener('pointermove', (e) => {
  if (!dragStart) return;
  const p = canvasPoint(e);
  cropRect = {
    x: Math.round(Math.min(dragStart.x, p.x)),
    y: Math.round(Math.min(dragStart.y, p.y)),
    w: Math.round(Math.abs(p.x - dragStart.x)),
    h: Math.round(Math.abs(p.y - dragStart.y)),
  };
  drawCrop();
});
$('cropCanvas').addEventListener('pointerup', () => {
  if (cropRect && (cropRect.w < 20 || cropRect.h < 20)) cropRect = null; // tiny drag = tap
  dragStart = null;
  drawCrop();
});

async function runDetection(source) {
  statusEl.textContent = 'Detecting grid…';
  try {
    detection = await detectGrid(source);
    console.log('detection result', detection);   // inspectable in DevTools
    renderReview();
    $('review').hidden = false;
    $('result').hidden = true;
    statusEl.textContent = 'Tap cells to fix mistakes, then share.';
  } catch (err) {
    console.error('detection failed', err);
    statusEl.textContent = '⚠️ ' + errMsg(err);
  }
}

$('detectBtn').addEventListener('click', () => {
  const rect = cropRect || { x: 0, y: 0, w: photoCanvas.width, h: photoCanvas.height };
  const sub = document.createElement('canvas');
  sub.width = rect.w;
  sub.height = rect.h;
  sub.getContext('2d').drawImage(photoCanvas, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
  runDetection(sub);
});

$('fullBtn').addEventListener('click', () => {
  cropRect = null;
  drawCrop();
  runDetection(photoCanvas);
});

// --- Step 3: review / fix / share ---
function renderReview() {
  const { rows, cols, blackCells } = detection;
  $('dims').textContent = `${rows} × ${cols} grid`;
  const preview = $('gridPreview');
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

$('shareBtn').addEventListener('click', () => {
  const { rows, cols, blackCells } = detection;
  const title = $('title').value.trim() || 'Scanned Crossword';
  const xw = buildPuzzle(rows, cols, blackCells, title);
  const url = shareUrlFor(xw);
  $('shareLink').value = url;
  $('openBtn').href = url;
  $('result').hidden = false;
});

$('copyBtn').addEventListener('click', () =>
  navigator.clipboard.writeText($('shareLink').value));

// PWA registration (same pattern as the solver's index.html)
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
