// Direct port of xwordscan.py steps 1–5 (preprocess → deskew → crop →
// size estimation → cell classification). OCR (step 6) is intentionally
// omitted; the solver only needs the grid structure.

// opencv.js is ~13 MB, so it is fetched with a progress callback and injected
// as a blob script. The 5.x browser build then exposes `cv` as a Promise that
// resolves once the WASM runtime has initialized.
let cvReadyPromise = null;

function whenCvReady(onProgress) {
  if (!cvReadyPromise) {
    cvReadyPromise = loadOpenCvScript(onProgress).then(() => {
      const mod = globalThis.cv;
      if (mod instanceof Promise) return mod;
      if (mod.Mat) return mod;
      // Fallback for builds exposing onRuntimeInitialized instead
      return new Promise((resolve) => { mod.onRuntimeInitialized = () => resolve(mod); });
    });
  }
  return cvReadyPromise;
}

function loadOpenCvScript(onProgress) {
  return fetch('lib/opencv.js').then(async (res) => {
    if (!res.ok) throw new Error(`Failed to download OpenCV (HTTP ${res.status})`);
    const total = Number(res.headers.get('Content-Length')) || 13300000;
    const chunks = [];
    let received = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (onProgress) onProgress(received / total);
    }
    const blob = new Blob(chunks, { type: 'text/javascript' });
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = URL.createObjectURL(blob);
      s.onload = resolve;
      s.onerror = () => reject(new Error('Failed to execute OpenCV'));
      document.head.appendChild(s);
    });
  });
}

async function detectGrid(imgElement) {
  const cv = await whenCvReady();
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
  const span = dir === 'horizontal' ? binaryGrid.cols : binaryGrid.rows;
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
