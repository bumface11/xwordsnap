/* global detectGrid, buildPuzzle, buildIpuz, shareUrlFor, whenCvReady, recognizeClueBoxes */
const APP_BUILD = 'v21 · 2026-09-14';

let detection = null;
let photoCanvas = null;   // downscaled source image
let cropCanvasEl = null;  // the cropped image that detection ran on
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
  $('clues').hidden = true;
  $('result').hidden = true;
  cropRect = null;
  drawCrop();
  statusEl.textContent = 'Drag on the image to select just the grid (or use the whole image). Rotate if the top of the grid isn\u2019t at the top.';
  $('crop').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Rotate the source photo 90° clockwise so the user can orient the grid
// upright before cropping/detecting.
$('rotateBtn').addEventListener('click', () => {
  const rotated = document.createElement('canvas');
  rotated.width = photoCanvas.height;
  rotated.height = photoCanvas.width;
  const ctx = rotated.getContext('2d');
  ctx.translate(rotated.width / 2, rotated.height / 2);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(photoCanvas, -photoCanvas.width / 2, -photoCanvas.height / 2);
  photoCanvas = rotated;
  cropRect = null;
  drawCrop();
});

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
    statusEl.textContent = 'Tap cells to fix mistakes, then share.';
    $('review').scrollIntoView({ behavior: 'smooth', block: 'start' });
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
  cropCanvasEl = sub;
  runDetection(sub);
});

$('fullBtn').addEventListener('click', () => {
  cropRect = null;
  drawCrop();
  cropCanvasEl = photoCanvas;
  runDetection(photoCanvas);
});

// --- Step 3: review / fix / share ---
// The tap-to-toggle grid is drawn semi-transparently over the binarized
// image the detector saw, so mismatches with the source are visible.
function renderReview() {
  const { rows, cols, blackCells, debugCanvas } = detection;
  $('dims').textContent = `${rows} × ${cols} grid`;
  const wrap = $('gridOverlay');
  wrap.innerHTML = '';

  const bg = document.createElement('canvas');
  bg.className = 'overlay-bg';
  // Prefer the processed (deskewed, cropped) image the classifier used;
  // fall back to the raw crop.
  const source = debugCanvas || cropCanvasEl;
  bg.width = source.width;
  bg.height = source.height;
  bg.getContext('2d').drawImage(source, 0, 0);
  wrap.appendChild(bg);

  const overlay = document.createElement('div');
  overlay.className = 'overlay-grid';
  overlay.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  overlay.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const cell = document.createElement('button');
    cell.className = 'overlay-cell' + (blackCells[r][c] ? ' block' : '');
    cell.onclick = () => {
      blackCells[r][c] = !blackCells[r][c];
      cell.classList.toggle('block');
    };
    overlay.appendChild(cell);
  }
  wrap.appendChild(overlay);
}

$('confirmGridBtn').addEventListener('click', () => {
  $('clues').hidden = false;
  statusEl.textContent = 'Take a photo of the clues, then draw a box around each column of text.';
  $('clues').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

$('skipCluesFromReviewBtn').addEventListener('click', () => shareStep(null));

// --- Step 4: share ---
let lastShareArgs = null;   // { rows, cols, blackCells, title, clueText } from the most recent shareStep()

function shareStep(clueText) {
  const { rows, cols, blackCells } = detection;
  const title = $('title').value.trim() || 'Scanned Crossword';
  lastShareArgs = { rows, cols, blackCells, title, clueText };
  const xw = buildPuzzle(rows, cols, blackCells, title, clueText);
  const url = shareUrlFor(xw);
  $('shareLink').value = url;
  $('openBtn').href = url;
  $('result').hidden = false;
  statusEl.textContent = 'Share the link, or open it directly in the solver.';
  $('result').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

$('copyBtn').addEventListener('click', () =>
  navigator.clipboard.writeText($('shareLink').value));

// Downloads the puzzle as a plain .ipuz file — handy for inspecting the grid
// shape and clue numbering independent of the solver's own link encoding.
$('downloadIpuzBtn').addEventListener('click', () => {
  if (!lastShareArgs) return;
  const { rows, cols, blackCells, title, clueText } = lastShareArgs;
  const ipuz = buildIpuz(rows, cols, blackCells, title, clueText);
  const blob = new Blob([JSON.stringify(ipuz, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${title.replace(/[^\w.-]+/g, '_') || 'xwordsnap'}.ipuz`;
  a.click();
  URL.revokeObjectURL(a.href);
});

// --- Step 3: clue photo → OCR ---
let cluesPhotoCanvas = null;      // raw captured clue photo — boxes are drawn on this directly
let clueBoxes = [];               // [{ corners: {tl,tr,br,bl: {x,y}}, direction: 'across'|'down' }]
let clueBoxDragStart = null;      // { start, rect } while drawing a brand-new box
let selectedBoxIndex = null;      // box currently showing corner handles
let resizeState = null;           // { index, corner } while dragging a handle
let extractedClueText = null;     // { across: {number:text}, down: {number:text} }

$('cluesCamera').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  statusEl.textContent = 'Loading clue photo…';
  try {
    const img = new Image();
    img.src = URL.createObjectURL(file);
    await img.decode();
    cluesPhotoCanvas = document.createElement('canvas');
    const scale = Math.min(1, 1600 / img.naturalWidth);
    cluesPhotoCanvas.width = Math.round(img.naturalWidth * scale);
    cluesPhotoCanvas.height = Math.round(img.naturalHeight * scale);
    cluesPhotoCanvas.getContext('2d').drawImage(img, 0, 0, cluesPhotoCanvas.width, cluesPhotoCanvas.height);
    resetCluesUiState();
    statusEl.textContent = 'Drag a box around each column of clue text.';
  } catch (err) {
    statusEl.textContent = '⚠️ ' + errMsg(err);
  }
});

// Resets anything tied to the clue photo's pixel coordinates (drawn boxes,
// extracted text). No OpenCV work happens here — enhancement is applied per
// box, right before OCR, in recognizeClueBoxes.
function resetCluesUiState() {
  clueBoxes = [];
  selectedBoxIndex = null;
  extractedClueText = null;
  $('confirmCluesBtn').hidden = true;
  $('cluesResultList').innerHTML = '';
  drawCluesCanvas();
  renderBoxList();
}

// Rotate the source clue photo 90° clockwise so the text reads upright.
$('cluesRotateBtn').addEventListener('click', () => {
  if (!cluesPhotoCanvas) return;
  const rotated = document.createElement('canvas');
  rotated.width = cluesPhotoCanvas.height;
  rotated.height = cluesPhotoCanvas.width;
  const ctx = rotated.getContext('2d');
  ctx.translate(rotated.width / 2, rotated.height / 2);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(cluesPhotoCanvas, -cluesPhotoCanvas.width / 2, -cluesPhotoCanvas.height / 2);
  cluesPhotoCanvas = rotated;
  resetCluesUiState();
});

function drawCluesCanvas() {
  const canvas = $('cluesCanvas');
  canvas.width = cluesPhotoCanvas.width;
  canvas.height = cluesPhotoCanvas.height;
  renderCluesScene(canvas.getContext('2d'), true);
}

// Draws the photo + box outlines (and optionally selection handles) onto any
// canvas context — shared by the on-screen canvas and the magnifier loupe,
// so the loupe can omit handles without duplicating the drawing logic.
function renderCluesScene(ctx, includeHandles) {
  ctx.drawImage(cluesPhotoCanvas, 0, 0);
  clueBoxes.forEach((box, i) => {
    drawBoxOutline(ctx, box.corners, box.direction, i + 1);
    if (includeHandles && i === selectedBoxIndex) drawHandles(ctx, box.corners);
  });
  if (clueBoxDragStart && clueBoxDragStart.rect) {
    drawBoxOutline(ctx, cornerPoints(clueBoxDragStart.rect), 'across', clueBoxes.length + 1);
  }
}

function drawBoxOutline(ctx, corners, direction, label) {
  ctx.strokeStyle = direction === 'down' ? '#e0a52f' : '#2f6fed';
  ctx.lineWidth = Math.max(2, ctx.canvas.width / 400);
  ctx.beginPath();
  ctx.moveTo(corners.tl.x, corners.tl.y);
  ctx.lineTo(corners.tr.x, corners.tr.y);
  ctx.lineTo(corners.br.x, corners.br.y);
  ctx.lineTo(corners.bl.x, corners.bl.y);
  ctx.closePath();
  ctx.stroke();
  ctx.fillStyle = ctx.strokeStyle;
  ctx.font = `${Math.max(14, ctx.canvas.width / 40)}px sans-serif`;
  ctx.fillText(String(label), corners.tl.x + 4, corners.tl.y + 18);
}

// Small draggable circles at each corner of the selected box, so it can be
// fine-tuned after the initial drag without redrawing it from scratch.
function cornerPoints(rect) {
  return {
    tl: { x: rect.x, y: rect.y },
    tr: { x: rect.x + rect.w, y: rect.y },
    bl: { x: rect.x, y: rect.y + rect.h },
    br: { x: rect.x + rect.w, y: rect.y + rect.h },
  };
}

function handleRadius(canvas) {
  return Math.max(9, canvas.width / 120);
}

function drawHandles(ctx, corners) {
  const r = handleRadius(ctx.canvas);
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#2f6fed';
  ctx.lineWidth = 2;
  for (const p of Object.values(corners)) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}

function hitTestHandle(corners, p, canvas) {
  const r = handleRadius(canvas) * 1.6;   // slightly forgiving hit area for touch
  return Object.keys(corners).find((key) =>
    Math.hypot(p.x - corners[key].x, p.y - corners[key].y) <= r) || null;
}

// Even-odd point-in-polygon test against the (possibly non-rectangular) quad.
function pointInQuad(p, corners) {
  const pts = [corners.tl, corners.tr, corners.br, corners.bl];
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
    const intersect = ((yi > p.y) !== (yj > p.y)) &&
      (p.x < (xj - xi) * (p.y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

// Shoelace-formula area, used to drop a box if a handle drag has shrunk it
// down to a sliver.
function quadArea(corners) {
  const pts = [corners.tl, corners.tr, corners.br, corners.bl];
  let area = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    area += (pts[j].x + pts[i].x) * (pts[j].y - pts[i].y);
  }
  return Math.abs(area / 2);
}

// --- Magnifier loupe shown while dragging a corner handle ---
// A fixed-position circular canvas that floats above the touch point (so
// the finger doesn't cover it) and shows a zoomed-in crop of the clues
// canvas centered on the handle, with a crosshair marking the exact point.
let magnifierEl = null;
let magnifierSourceCanvas = null;   // offscreen scene render without handles
const MAGNIFIER_SIZE = 160;
const MAGNIFIER_ZOOM = 1.2;
const MAGNIFIER_OFFSET = 90; // px between the finger and the loupe center

function ensureMagnifier() {
  if (magnifierEl) return magnifierEl;
  magnifierEl = document.createElement('canvas');
  magnifierEl.width = MAGNIFIER_SIZE;
  magnifierEl.height = MAGNIFIER_SIZE;
  Object.assign(magnifierEl.style, {
    position: 'fixed',
    left: '0',
    top: '0',
    width: `${MAGNIFIER_SIZE}px`,
    height: `${MAGNIFIER_SIZE}px`,
    borderRadius: '50%',
    border: '3px solid #2f6fed',
    boxShadow: '0 2px 12px rgba(0,0,0,0.45)',
    pointerEvents: 'none',
    zIndex: '1000',
    display: 'none',
    background: '#fff',
  });
  document.body.appendChild(magnifierEl);
  return magnifierEl;
}

// canvasPoint: the drag point in cluesCanvas pixel space (for the zoomed crop).
// clientX/clientY: the pointer's viewport position (for placing the loupe).
function updateMagnifier(canvasPoint, clientX, clientY) {
  const canvas = $('cluesCanvas');
  const mag = ensureMagnifier();
  const srcSize = MAGNIFIER_SIZE / MAGNIFIER_ZOOM;
  const sx = Math.min(Math.max(canvasPoint.x - srcSize / 2, 0), Math.max(canvas.width - srcSize, 0));
  const sy = Math.min(Math.max(canvasPoint.y - srcSize / 2, 0), Math.max(canvas.height - srcSize, 0));

  // Render a handle-free copy of the scene so the dragged handle's white
  // fill doesn't cover the exact spot the user is trying to see.
  if (!magnifierSourceCanvas) magnifierSourceCanvas = document.createElement('canvas');
  magnifierSourceCanvas.width = canvas.width;
  magnifierSourceCanvas.height = canvas.height;
  renderCluesScene(magnifierSourceCanvas.getContext('2d'), false);

  const ctx = mag.getContext('2d');
  ctx.clearRect(0, 0, MAGNIFIER_SIZE, MAGNIFIER_SIZE);
  ctx.save();
  ctx.beginPath();
  ctx.arc(MAGNIFIER_SIZE / 2, MAGNIFIER_SIZE / 2, MAGNIFIER_SIZE / 2 - 2, 0, Math.PI * 2);
  ctx.clip();
  ctx.drawImage(magnifierSourceCanvas, sx, sy, srcSize, srcSize, 0, 0, MAGNIFIER_SIZE, MAGNIFIER_SIZE);
  ctx.restore();

  // Crosshair at the exact handle position within the zoomed crop.
  const relX = (canvasPoint.x - sx) * MAGNIFIER_ZOOM;
  const relY = (canvasPoint.y - sy) * MAGNIFIER_ZOOM;
  ctx.strokeStyle = '#e0442f';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(relX - 9, relY); ctx.lineTo(relX + 9, relY);
  ctx.moveTo(relX, relY - 9); ctx.lineTo(relX, relY + 9);
  ctx.stroke();

  // Float the loupe above the finger by default so it stays visible; flip
  // below if there isn't room above, and clamp horizontally to the viewport.
  let left = clientX - MAGNIFIER_SIZE / 2;
  let top = clientY - MAGNIFIER_OFFSET - MAGNIFIER_SIZE / 2;
  if (top < 8) top = clientY + MAGNIFIER_OFFSET - MAGNIFIER_SIZE / 2;
  left = Math.min(Math.max(left, 8), window.innerWidth - MAGNIFIER_SIZE - 8);
  mag.style.left = `${left}px`;
  mag.style.top = `${top}px`;
  mag.style.display = 'block';
}

function hideMagnifier() {
  if (magnifierEl) magnifierEl.style.display = 'none';
}

function cluesCanvasPoint(e) {
  const canvas = $('cluesCanvas');
  const rect = canvas.getBoundingClientRect();
  return {
    x: Math.min(Math.max((e.clientX - rect.left) * (canvas.width / rect.width), 0), canvas.width),
    y: Math.min(Math.max((e.clientY - rect.top) * (canvas.height / rect.height), 0), canvas.height),
  };
}

$('cluesCanvas').addEventListener('pointerdown', (e) => {
  if (!cluesPhotoCanvas) return;
  e.preventDefault();
  const canvas = e.target;
  const p = cluesCanvasPoint(e);

  if (selectedBoxIndex !== null) {
    const corner = hitTestHandle(clueBoxes[selectedBoxIndex].corners, p, canvas);
    if (corner) {
      resizeState = { index: selectedBoxIndex, corner };
      canvas.setPointerCapture(e.pointerId);
      updateMagnifier(p, e.clientX, e.clientY);
      return;
    }
  }

  const hitIndex = clueBoxes.findIndex((box) => pointInQuad(p, box.corners));
  if (hitIndex !== -1) {
    selectedBoxIndex = hitIndex;
    drawCluesCanvas();
    renderBoxList();
    return;
  }

  selectedBoxIndex = null;
  clueBoxDragStart = { start: p, rect: null };
  canvas.setPointerCapture(e.pointerId);
  drawCluesCanvas();
});
$('cluesCanvas').addEventListener('pointermove', (e) => {
  const p = cluesCanvasPoint(e);

  if (resizeState) {
    const { index, corner } = resizeState;
    // Move only the dragged vertex — the other three corners stay put, so
    // the box can be skewed into an arbitrary quadrilateral, not just resized
    // as a rectangle.
    clueBoxes[index].corners[corner] = { x: Math.round(p.x), y: Math.round(p.y) };
    drawCluesCanvas();
    updateMagnifier(p, e.clientX, e.clientY);
    return;
  }

  if (!clueBoxDragStart) return;
  clueBoxDragStart.rect = {
    x: Math.round(Math.min(clueBoxDragStart.start.x, p.x)),
    y: Math.round(Math.min(clueBoxDragStart.start.y, p.y)),
    w: Math.round(Math.abs(p.x - clueBoxDragStart.start.x)),
    h: Math.round(Math.abs(p.y - clueBoxDragStart.start.y)),
  };
  drawCluesCanvas();
});
$('cluesCanvas').addEventListener('pointerup', () => {
  if (resizeState) {
    const corners = clueBoxes[resizeState.index].corners;
    if (quadArea(corners) < 400) {
      // Shrunk down to a sliver — drop it rather than leave an unusable box.
      clueBoxes.splice(resizeState.index, 1);
      selectedBoxIndex = null;
      renderBoxList();
    }
    resizeState = null;
    hideMagnifier();
    drawCluesCanvas();
    return;
  }

  if (clueBoxDragStart && clueBoxDragStart.rect &&
      clueBoxDragStart.rect.w >= 20 && clueBoxDragStart.rect.h >= 20) {
    // The box always starts life as a plain rectangle; its four corners
    // become independently draggable afterwards via the handles.
    clueBoxes.push({ corners: cornerPoints(clueBoxDragStart.rect), direction: 'across' });
    selectedBoxIndex = clueBoxes.length - 1;
    renderBoxList();
  }
  clueBoxDragStart = null;
  drawCluesCanvas();
});

$('cluesCanvas').addEventListener('pointercancel', () => {
  // Touch drags can be cancelled by the OS (e.g. a scroll gesture taking
  // over) — make sure we don't get stuck with a phantom drag or loupe.
  resizeState = null;
  clueBoxDragStart = null;
  hideMagnifier();
  drawCluesCanvas();
});

$('undoBoxBtn').addEventListener('click', () => {
  clueBoxes.pop();
  if (selectedBoxIndex !== null && selectedBoxIndex >= clueBoxes.length) selectedBoxIndex = null;
  drawCluesCanvas();
  renderBoxList();
});

function renderBoxList() {
  const wrap = $('cluesBoxList');
  wrap.innerHTML = '';
  clueBoxes.forEach((box, i) => {
    const row = document.createElement('div');
    row.className = 'clue-box-row' + (i === selectedBoxIndex ? ' selected' : '');
    row.onclick = (e) => {
      if (e.target.closest('select, button')) return;
      selectedBoxIndex = i;
      drawCluesCanvas();
      renderBoxList();
    };

    const label = document.createElement('span');
    label.textContent = `Box ${i + 1}`;
    row.appendChild(label);

    const select = document.createElement('select');
    for (const dir of ['across', 'down']) {
      const opt = document.createElement('option');
      opt.value = dir;
      opt.textContent = dir === 'across' ? 'Across' : 'Down';
      if (box.direction === dir) opt.selected = true;
      select.appendChild(opt);
    }
    select.onchange = () => { box.direction = select.value; drawCluesCanvas(); };
    row.appendChild(select);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'secondary';
    removeBtn.textContent = 'Remove';
    removeBtn.onclick = () => {
      clueBoxes.splice(i, 1);
      if (selectedBoxIndex === i) selectedBoxIndex = null;
      else if (selectedBoxIndex !== null && selectedBoxIndex > i) selectedBoxIndex--;
      drawCluesCanvas();
      renderBoxList();
    };
    row.appendChild(removeBtn);

    wrap.appendChild(row);
  });
}

$('extractCluesBtn').addEventListener('click', async () => {
  if (!clueBoxes.length) {
    statusEl.textContent = 'Draw at least one box around the clue text first.';
    return;
  }
  statusEl.textContent = 'Running OCR… 0%';
  try {
    extractedClueText = await recognizeClueBoxes(cluesPhotoCanvas, clueBoxes, (frac) => {
      statusEl.textContent = `Running OCR… ${Math.round(frac * 100)}%`;
    });
    renderClueResults();
    $('confirmCluesBtn').hidden = false;
    statusEl.textContent = 'Check the extracted clues below, then continue.';
  } catch (err) {
    console.error('OCR failed', err);
    statusEl.textContent = '⚠️ ' + errMsg(err);
  }
});

function renderClueResults() {
  const wrap = $('cluesResultList');
  wrap.innerHTML = '';
  for (const [dirKey, dirLabel] of [['across', 'Across'], ['down', 'Down']]) {
    const numbers = Object.keys(extractedClueText[dirKey]).sort((a, b) => Number(a) - Number(b));
    if (!numbers.length) continue;
    const heading = document.createElement('h3');
    heading.textContent = dirLabel;
    wrap.appendChild(heading);
    for (const num of numbers) {
      const row = document.createElement('div');
      row.className = 'clue-edit-row';
      const label = document.createElement('span');
      label.textContent = num;
      row.appendChild(label);
      const textarea = document.createElement('textarea');
      textarea.value = extractedClueText[dirKey][num];
      textarea.oninput = () => { extractedClueText[dirKey][num] = textarea.value; };
      row.appendChild(textarea);
      wrap.appendChild(row);
    }
  }
}

$('skipCluesBtn').addEventListener('click', () => shareStep(null));
$('confirmCluesBtn').addEventListener('click', () => shareStep(extractedClueText));

// PWA registration (same pattern as the solver's index.html)
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');