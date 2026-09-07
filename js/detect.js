/* global cv */
// Direct port of xwordscan.py steps 1–5 (preprocess → deskew → crop →
// size estimation → cell classification). OCR (step 6) is intentionally
// omitted; the solver only needs the grid structure.

// The opencv-js 5.x browser build exposes `cv` as a Promise that resolves
// once the WASM runtime has initialized. Await it once up front.
let cvReadyPromise = null;
function whenCvReady() {
  if (!cvReadyPromise) {
    cvReadyPromise = Promise.resolve(cv).then((api) => {
      if (!api.Mat) {
        // Fallback for builds exposing onRuntimeInitialized instead
        return new Promise((resolve) => { api.onRuntimeInitialized = () => resolve(api); });
      }
      return api;
    });
  }
  return cvReadyPromise;
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
