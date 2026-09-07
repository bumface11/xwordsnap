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
  const filtered = new cv.Mat();   // bilateralFilter can't run in-place (throws in the 5.0 WASM build)
  const binary = new cv.Mat();

  // --- Step 1: preprocess (xwordscan.preprocess) ---
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  cv.bilateralFilter(gray, filtered, 9, 75, 75);
  cv.normalize(filtered, filtered, 0, 255, cv.NORM_MINMAX);
  cv.adaptiveThreshold(filtered, binary, 255,
    cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 15, 10);
  const kernel = cv.Mat.ones(3, 3, cv.CV_8U);
  cv.morphologyEx(binary, binary, cv.MORPH_CLOSE, kernel);

  // --- Step 2: deskew (xwordscan.deskew) ---
  // Dominant near-horizontal line angle from the Hough transform, then
  // rotate both images by it. Critical on phone photos taken at an angle.
  let skew = 0;
  {
    const edges = new cv.Mat();
    const lines = new cv.Mat();
    cv.Canny(binary, edges, 50, 150, 3);
    cv.HoughLines(edges, lines, 1, Math.PI / 180, 200);
    const angles = [];
    for (let i = 0; i < lines.rows; i++) {
      const angleDeg = lines.data32F[i * 2 + 1] * 180 / Math.PI - 90;
      if (Math.abs(angleDeg) < 10) angles.push(angleDeg);
    }
    edges.delete();
    lines.delete();
    if (angles.length) {
      angles.sort((a, b) => a - b);
      skew = angles[Math.floor(angles.length / 2)];   // median
    }
  }

  let grayGridSrc = filtered, binaryGridSrc = binary;
  const deskewed = [];
  if (Math.abs(skew) >= 0.5) {
    const center = new cv.Point(filtered.cols / 2, filtered.rows / 2);
    const M = cv.getRotationMatrix2D(center, skew, 1.0);
    const size = new cv.Size(filtered.cols, filtered.rows);
    const grayRot = new cv.Mat(), binRot = new cv.Mat();
    cv.warpAffine(filtered, grayRot, M, size, cv.INTER_LINEAR,
      cv.BORDER_REPLICATE, new cv.Scalar());
    cv.warpAffine(binary, binRot, M, size, cv.INTER_NEAREST,
      cv.BORDER_CONSTANT, new cv.Scalar(0, 0, 0, 0));
    M.delete();
    deskewed.push(grayRot, binRot);
    grayGridSrc = grayRot;
    binaryGridSrc = binRot;
  }

  // --- Step 3: locate the grid quad and perspective-warp it flat ---
  // xwordscan targets flatbed scans, so an axis-aligned bbox suffices there.
  // Phone photos have perspective distortion (grid lines converge), so we
  // find the outer border as a quadrilateral (approxPolyDP), falling back to
  // minAreaRect, then to a plain bbox.
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(binaryGridSrc, contours, hierarchy,
    cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
  let biggest = null, bestArea = 0;
  for (let i = 0; i < contours.size(); i++) {
    const area = cv.contourArea(contours.get(i));
    if (area > bestArea) { bestArea = area; biggest = contours.get(i); }
  }
  if (!biggest) throw new Error('No grid found — get closer and fill the frame.');

  const warpMats = [];
  let quad = null;
  const peri = cv.arcLength(biggest, true);
  const approx = new cv.Mat();
  warpMats.push(approx);
  for (const eps of [0.01, 0.02, 0.03, 0.05]) {
    cv.approxPolyDP(biggest, approx, eps * peri, true);
    if (approx.rows === 4) {
      quad = [];
      for (let i = 0; i < 4; i++) quad.push([approx.data32S[i * 2], approx.data32S[i * 2 + 1]]);
      break;
    }
  }
  if (!quad) {
    try {
      quad = cv.RotatedRect.points(cv.minAreaRect(biggest)).map(p => [p.x, p.y]);
    } catch (e) {
      const r = cv.boundingRect(biggest);
      quad = [[r.x, r.y], [r.x + r.width, r.y],
              [r.x + r.width, r.y + r.height], [r.x, r.y + r.height]];
    }
  }
  // Order corners: top-left, top-right, bottom-right, bottom-left.
  // TL = min(x+y), BR = max(x+y), TR = max(y-x), BL = min(y-x).
  const sums = quad.map(p => p[0] + p[1]);
  const difs = quad.map(p => p[1] - p[0]);
  const ordered = [quad[idxOf(sums, false)], quad[idxOf(difs, false)],
                  quad[idxOf(sums, true)], quad[idxOf(difs, true)]]; // ordered corners: TL, TR, BR, BL
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const warpW = Math.max(2, Math.round(Math.max(dist(ordered[0], ordered[1]), dist(ordered[3], ordered[2]))));
  const warpH = Math.max(2, Math.round(Math.max(dist(ordered[0], ordered[3]), dist(ordered[1], ordered[2]))));
  const srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, ordered.flat());
  const dstPts = cv.matFromArray(4, 1, cv.CV_32FC2,
    [0, 0, warpW - 1, 0, warpW - 1, warpH - 1, 0, warpH - 1]);
  const warpM = cv.getPerspectiveTransform(srcPts, dstPts);
  warpMats.push(srcPts, dstPts, warpM);
  const dsize = new cv.Size(warpW, warpH);
  const grayGrid = new cv.Mat(), binaryGrid = new cv.Mat();
  warpMats.push(grayGrid, binaryGrid);
  cv.warpPerspective(grayGridSrc, grayGrid, warpM, dsize, cv.INTER_LINEAR,
    cv.BORDER_REPLICATE, new cv.Scalar());
  cv.warpPerspective(binaryGridSrc, binaryGrid, warpM, dsize, cv.INTER_NEAREST,
    cv.BORDER_CONSTANT, new cv.Scalar(0, 0, 0, 0));

  // --- Step 4: grid size via autocorrelation pitch + phase-aligned scoring ---
  // xwordscan counts projection groups above a 0.3 threshold, which breaks on
  // faint phone-photo lines (projections stay under 0.3 even on true lines).
  // Instead: estimate cell pitch from the autocorrelation peak, then score
  // candidate cell counts by how strongly an evenly-spaced grid aligns with
  // the projection. Crosswords are usually square, so a shared square count
  // wins unless the per-axis counts are clearly stronger.
  const projH = rowProjection(binaryGrid);   // dark fraction per row
  const projV = colProjection(binaryGrid);   // dark fraction per column
  const pitchH = pitchEstimate(projH);
  const pitchV = pitchEstimate(projV);
  if (!pitchH || !pitchV) {
    [src, gray, filtered, binary, kernel, contours, hierarchy,
      ...deskewed, ...warpMats].forEach(m => m.delete());
    throw new Error('No regular grid spacing found — crop tightly to the grid.');
  }
  const est = (warpH / pitchH + warpW / pitchV) / 2;
  const candidates = [];
  for (let n = Math.max(3, Math.floor(est) - 2); n <= Math.ceil(est) + 2; n++) candidates.push(n);
  const scoreH = {}, scoreV = {}, phaseH = {}, phaseV = {};
  for (const n of candidates) {
    [scoreH[n], phaseH[n]] = gridScore(projH, n);
    [scoreV[n], phaseV[n]] = gridScore(projV, n);
  }
  const pick = (table) => candidates.reduce((a, b) => (table[a] >= table[b] ? a : b));
  const squareN = candidates.reduce((a, b) =>
    scoreH[a] + scoreV[a] >= scoreH[b] + scoreV[b] ? a : b);
  const bestH = pick(scoreH), bestV = pick(scoreV);
  const useSquare = scoreH[squareN] + scoreV[squareN] >=
                    0.92 * (scoreH[bestH] + scoreV[bestV]);
  const rows = useSquare ? squareN : bestH;
  const cols = useSquare ? squareN : bestV;
  if (rows < 2 || cols < 2) {
    [src, gray, filtered, binary, kernel, contours, hierarchy,
      ...deskewed, ...warpMats].forEach(m => m.delete());
    throw new Error(
      `Could not measure grid lines (saw ${rows}×${cols}) — crop tightly to the grid's outer border.`);
  }

  // --- Step 5: classify cells ---
  // Evenly-spaced lines at the best phase (the warp removed perspective, so
  // per-line snapping is unnecessary and harmful). Cell brightness is the
  // mean of the inner 50%. Classification is 1-D k-means (k=3) over all cell
  // means with the darkest cluster = blocks: newspaper grids with gray-shaded
  // cells form three brightness populations and break xwordscan's fixed 0.5
  // threshold.
  const lineH = linePositions(warpH, rows, phaseH[rows]);
  const lineV = linePositions(warpW, cols, phaseV[cols]);
  const means = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const y0 = lineH[r], y1 = lineH[r + 1], x0 = lineV[c], x1 = lineV[c + 1];
      const dy = y1 - y0, dx = x1 - x0;
      const cell = grayGrid.roi(new cv.Rect(
        x0 + Math.floor(dx * 0.25), y0 + Math.floor(dy * 0.25),
        Math.max(2, dx - 2 * Math.floor(dx * 0.25)),
        Math.max(2, dy - 2 * Math.floor(dy * 0.25))));
      means.push(cv.mean(cell)[0] / 255);
      cell.delete();
    }
  }
  const flags = darkestCluster(means);
  const blackCells = [];
  for (let r = 0; r < rows; r++) blackCells.push(flags.slice(r * cols, (r + 1) * cols));

  // Debug view: the perspective-corrected gray grid the classifier sampled —
  // the review overlay is drawn on top of this so mistakes are obvious.
  const debugCanvas = document.createElement('canvas');
  cv.imshow(debugCanvas, grayGrid);

  [src, gray, filtered, binary, kernel, contours, hierarchy,
    ...deskewed, ...warpMats].forEach(m => m.delete());
  return { rows, cols, blackCells, debugCanvas };
}

function idxOf(arr, wantMax) {
  let best = 0;
  for (let i = 1; i < arr.length; i++) {
    if (wantMax ? arr[i] > arr[best] : arr[i] < arr[best]) best = i;
  }
  return best;
}

// Per-row dark fraction of the binary image.
// Note: opencv-js 5.0's ucharPtr(row, col) returns a 1-element view, not the
// rest of the row, so we read rows via rowPtr()/mat.data instead.
function rowProjection(binary) {
  const rows = binary.rows, cols = binary.cols;
  const data = binary.data;
  const step = binary.step[0];
  const out = new Float64Array(rows);
  for (let i = 0; i < rows; i++) {
    let s = 0;
    const base = i * step;
    for (let j = 0; j < cols; j++) s += data[base + j];
    out[i] = s / (cols * 255);
  }
  return out;
}

// Per-column dark fraction of the binary image.
function colProjection(binary) {
  const rows = binary.rows, cols = binary.cols;
  const data = binary.data;
  const step = binary.step[0];
  const out = new Float64Array(cols);
  for (let i = 0; i < rows; i++) {
    const base = i * step;
    for (let j = 0; j < cols; j++) out[j] += data[base + j];
  }
  for (let j = 0; j < cols; j++) out[j] /= rows * 255;
  return out;
}

// Cell pitch (px) = N / best-line-count. Finds the line count n whose
// evenly-spaced comb best matches the projection's periodicity: score =
// mean correlation at harmonics of the pitch minus correlation at the
// half-period (valleys between lines). Robust to faint lines, where the
// naive global autocorrelation max picks a sub-harmonic.
function pitchEstimate(proj, minCells = 5, maxCells = 40) {
  const N = proj.length;
  if (!Number.isFinite(proj[0])) return null;
  let mean = 0;
  for (const v of proj) mean += v;
  mean /= N;
  const p = Float64Array.from(proj, v => v - mean);
  let energy = 0;
  for (const v of p) energy += v * v;
  if (energy <= 0) return null;
  const corr = (lag) => {
    let s = 0;
    for (let i = 0; i + lag < N; i++) s += p[i] * p[i + lag];
    return s / (N - lag);
  };
  let bestN = null, bestScore = -Infinity;
  for (let n = minCells; n <= maxCells; n++) {
    const pitch = (N - 1) / n;
    if (pitch < 2) break;
    let harm = 0;
    for (let k = 1; k <= 4; k++) harm += corr(Math.round(k * pitch));
    harm /= 4;
    const score = harm - 0.5 * corr(Math.round(pitch / 2));
    if (score > bestScore) { bestScore = score; bestN = n; }
  }
  return bestN ? (N - 1) / bestN : null;
}

// Score a candidate cell count n by phase-aligning n+1 evenly-spaced lines
// with the (lightly smoothed) projection. Returns [score, bestPhase].
function gridScore(proj, n) {
  const N = proj.length;
  const pitch = (N - 1) / n;
  const smooth = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    let s = 0, cnt = 0;
    for (let k = -2; k <= 2; k++) {
      const j = i + k;
      if (j >= 0 && j < N) { s += proj[j]; cnt++; }
    }
    smooth[i] = s / cnt;
  }
  let bestScore = -1, bestPhase = 0;
  const phaseMin = -pitch * 0.25, phaseMax = pitch * 0.25;
  for (let phase = phaseMin; phase <= phaseMax; phase += 1) {
    let s = 0;
    for (let k = 0; k <= n; k++) {
      const pos = Math.min(N - 1, Math.max(0, Math.round(phase + k * pitch)));
      s += smooth[pos];
    }
    s /= (n + 1);
    if (s > bestScore) { bestScore = s; bestPhase = phase; }
  }
  return [bestScore, bestPhase];
}

function linePositions(N, n, phase) {
  const pitch = (N - 1) / n;
  const lines = [];
  for (let k = 0; k <= n; k++) {
    lines.push(Math.min(N - 1, Math.max(0, Math.round(phase + k * pitch))));
  }
  return lines;
}

// 1-D k-means (k=3, deterministic quantile init). Returns a boolean array,
// true for members of the darkest cluster (= black squares). Grids with gray
// shaded cells form three brightness populations; plain grids collapse to
// two and the darkest is still the blocks.
function darkestCluster(means, k = 3) {
  const sorted = [...means].sort((a, b) => a - b);
  if (sorted[sorted.length - 1] - sorted[0] < 0.08) {
    return means.map(() => false);   // uniform grid — no blocks
  }
  let centers = [0.1, 0.45, 0.8].map(q => sorted[Math.floor(q * (sorted.length - 1))]);
  const assign = (m) => {
    let bi = 0, bd = Infinity;
    centers.forEach((c, i) => { const d = Math.abs(m - c); if (d < bd) { bd = d; bi = i; } });
    return bi;
  };
  for (let iter = 0; iter < 20; iter++) {
    const sumsArr = new Array(k).fill(0), counts = new Array(k).fill(0);
    for (const m of means) { const i = assign(m); sumsArr[i] += m; counts[i]++; }
    centers = centers.map((c, i) => counts[i] ? sumsArr[i] / counts[i] : c);
  }
  const darkCenter = Math.min(...centers);
  return means.map(m => centers[assign(m)] === darkCenter);
}
