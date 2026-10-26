/* global detectTextBoxes, recognizeTextBox */
// Automatic clue-column detection. PP-OCR finds the "Across" and "Down"
// headings (which also give the page tilt); the columns themselves are then
// measured from the ink on the deskewed page, because the text detector drops
// lines in dense newsprint. The clue numbers are right-justified, so a clear
// vertical channel separates them from the clue text; its slope also gives the
// perspective shear of the columns. Returns boxes in the shape app.js uses:
// { corners, direction, split }.

const AUTO_MAX_HEADING_CANDIDATES = 60;

function editDistance(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

function headingKind(text) {
  const t = text.toLowerCase().replace(/[^a-z]/g, '');
  if (t.length >= 4 && t.length <= 7 && editDistance(t, 'across') <= 1) return 'across';
  if (t.length >= 3 && t.length <= 5 && editDistance(t, 'down') <= 1) return 'down';
  return null;
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
}

// Rotates a canvas by `turns` quarter-turns clockwise.
function rotateCanvasQuarter(canvas, turns) {
  const t = ((turns % 4) + 4) % 4;
  if (t === 0) return canvas;
  const out = document.createElement('canvas');
  const swap = t % 2 === 1;
  out.width = swap ? canvas.height : canvas.width;
  out.height = swap ? canvas.width : canvas.height;
  const ctx = out.getContext('2d');
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate(t * Math.PI / 2);
  ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
  return out;
}

// Ink pixels (locally darker than their surroundings) of a canvas region, as
// parallel coordinate arrays relative to the page (not the region).
function inkPoints(canvas, rx0, ry0, rx1, ry1, radius) {
  const x0 = Math.max(0, Math.floor(rx0)), y0 = Math.max(0, Math.floor(ry0));
  const w = Math.min(canvas.width, Math.ceil(rx1)) - x0;
  const ht = Math.min(canvas.height, Math.ceil(ry1)) - y0;
  if (w < 8 || ht < 8) return { xs: new Int32Array(0), ys: new Int32Array(0) };
  const { data } = canvas.getContext('2d', { willReadFrequently: true }).getImageData(x0, y0, w, ht);
  const gray = new Float32Array(w * ht);
  for (let i = 0; i < gray.length; i++) {
    gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  }
  const iw = w + 1;
  const integral = new Float64Array(iw * (ht + 1));
  for (let y = 0; y < ht; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += gray[y * w + x];
      integral[(y + 1) * iw + x + 1] = integral[y * iw + x + 1] + row;
    }
  }
  const xs = [], ys = [];
  for (let y = 0; y < ht; y++) {
    const ya = Math.max(0, y - radius), yb = Math.min(ht, y + radius + 1);
    for (let x = 0; x < w; x++) {
      const xa = Math.max(0, x - radius), xb = Math.min(w, x + radius + 1);
      const mean = (integral[yb * iw + xb] - integral[ya * iw + xb] -
        integral[yb * iw + xa] + integral[ya * iw + xa]) / ((xb - xa) * (yb - ya));
      if (gray[y * w + x] < mean * 0.8) { xs.push(x0 + x); ys.push(y0 + y); }
    }
  }
  return { xs: Int32Array.from(xs), ys: Int32Array.from(ys) };
}

// Column profile of ink points in a window after shearing x' = x - s*(y - yRef).
function shearedProfile(ink, win, s, yRef, size) {
  const profile = new Int32Array(size);
  for (let i = 0; i < ink.xs.length; i++) {
    const y = ink.ys[i];
    if (y < win.top || y >= win.bottom) continue;
    const x = Math.round(ink.xs[i] - s * (y - yRef) - win.xMin);
    if (x >= 0 && x < size) profile[x]++;
  }
  return profile;
}

// Measures one column from its heading. Coordinates are in the deskewed frame.
// Returns the sheared-space left/right bounds, the shear and the divider position.
function measureColumn(ink, heading, h, top, bottomLimit, xCap, widthCap) {
  const xMin = Math.floor(heading.x0 - 6 * h);
  const size = Math.ceil(xCap + 3 * h - xMin);
  const win = { xMin, top, bottom: bottomLimit };
  const rows = Math.max(1, bottomLimit - top);
  const epsChannel = Math.max(1, 0.01 * rows);

  // The number/clue channel is the emptiest strip just right of the heading's
  // left edge; the shear that empties it most aligns the columns.
  // Photos are noisy, so look for the lowest-ink valley (mean over a narrow
  // band) rather than a perfectly empty strip.
  const bandW = Math.max(3, Math.round(0.25 * h));
  const lo = Math.round(heading.x0 + 0.2 * h - xMin);
  const hi = Math.round(heading.x0 + 3.5 * h - xMin);
  let best = null;
  for (let s = -0.14; s <= 0.14001; s += 0.005) {
    const profile = shearedProfile(ink, win, s, top, size);
    let sum = 0;
    for (let x = lo; x < Math.min(lo + bandW, size); x++) sum += profile[x];
    let windowSum = 0, n = 0;
    for (let x = lo; x <= Math.min(hi, size - 1); x++) { windowSum += profile[x]; n++; }
    for (let x = lo; x + bandW <= Math.min(hi, size - 1); x++) {
      if (x > lo) sum += profile[x + bandW - 1] - profile[x - 1];
      const score = sum / bandW + 0.02 * rows * Math.abs(s);
      if (!best || score < best.score) best = { score, s, x, profile, mean: windowSum / Math.max(1, n) };
    }
  }
  if (!best || best.score > 0.5 * best.mean) {
    return null;
  }
  const limit = best.score + epsChannel;
  let rs = best.x, re = best.x + bandW - 1;
  while (rs > 0 && best.profile[rs - 1] <= limit) rs--;
  while (re + 1 < size && best.profile[re + 1] <= limit) re++;
  best.run = { start: rs, end: re, width: re - rs + 1 };

  const { s, run, profile } = best;
  const epsGutter = Math.max(1, 0.004 * rows);
  const gap = Math.max(3, Math.round(0.5 * h));
  // Left edge: walk left from the channel until a clear gap (e.g. the grid).
  let left = run.start;
  for (let x = run.start - 1, blank = 0; x >= 0; x--) {
    if (profile[x] <= epsGutter) { blank++; if (blank >= gap) break; } else { blank = 0; left = x; }
  }
  // Right edge: walk right from the channel to the next clear gutter.
  let right = run.end;
  for (let x = run.end + 1, blank = 0; x < profile.length; x++) {
    if (profile[x] <= epsGutter) { blank++; if (blank >= gap) break; } else { blank = 0; right = x; }
  }
  const leftX = xMin + left, rightX = xMin + right;
  return {
    s,
    left: leftX,
    right: widthCap ? Math.min(rightX, leftX + widthCap) : rightX,
    divider: xMin + (run.start + run.end) / 2,
  };
}

// Least-squares line x = a + b*y through points, dropping outliers once.
function robustLine(pts, h) {
  const fit = (list) => {
    const n = list.length;
    let sy = 0, sx = 0, syy = 0, sxy = 0;
    for (const p of list) { sy += p.y; sx += p.x; syy += p.y * p.y; sxy += p.y * p.x; }
    const den = n * syy - sy * sy;
    const b = den ? (n * sxy - sy * sx) / den : 0;
    return { a: (sx - b * sy) / n, b };
  };
  let f = fit(pts);
  const res = pts.map((p) => Math.abs(p.x - (f.a + f.b * p.y)));
  const med = res.slice().sort((p, q) => p - q)[Math.floor(res.length / 2)];
  const kept = pts.filter((p, i) => res[i] <= Math.max(2 * med, 0.3 * h));
  if (kept.length >= 3) f = fit(kept);
  return f;
}
// Follows a near-vertical gap (the number/clue divider) down the column: in
// each horizontal band it finds the lowest-ink valley near where the previous
// band's valley was, so any lean or page curl is tracked without assuming a
// global shear. Returns { s, x } with x the line's position at `top`.
function trackEdge(ink, xTop, s, top, bottom, h, halfW) {
  const bandH = Math.round(4 * h);
  const bandW = Math.max(3, Math.round(0.3 * h));
  const size = Math.ceil(2 * halfW);
  const pts = [];
  let lastX = xTop, lastY = 0, slope = s;
  for (let y0 = top; y0 + bandH <= bottom + 1; y0 += bandH) {
    const yMid = y0 + bandH / 2 - top;
    const centre = lastX + slope * (yMid - lastY);
    const prof = new Int32Array(size);
    for (let i = 0; i < ink.xs.length; i++) {
      const y = ink.ys[i];
      if (y < y0 || y >= y0 + bandH) continue;
      const xi = Math.round(ink.xs[i] - centre + halfW);
      if (xi >= 0 && xi < size) prof[xi]++;
    }
    let sum = 0, total = 0;
    for (let x = 0; x < size; x++) total += prof[x];
    for (let x = 0; x < bandW; x++) sum += prof[x];
    let bestSum = sum, bestX = 0;
    for (let x = 1; x + bandW <= size; x++) {
      sum += prof[x + bandW - 1] - prof[x - 1];
      if (sum < bestSum || (sum === bestSum && Math.abs(x - halfW) < Math.abs(bestX - halfW))) { bestSum = sum; bestX = x; }
    }
    if (bestSum < 0.4 * bandW * total / size) {
      lastX = centre + bestX + bandW / 2 - halfW;
      lastY = yMid;
      pts.push({ y: yMid, x: lastX });
      if (pts.length >= 3) slope = Math.max(-0.2, Math.min(0.2, robustLine(pts, h).b));
    }
  }
  if (pts.length < 3) return { s, x: xTop };
  const f = robustLine(pts, h);
  return { s: f.b, x: f.a };
}
// Last row of text below `top` inside the sheared column, ending at a big gap.
function columnBottom(ink, col, h, top, bottomLimit) {
  const rows = new Int32Array(Math.max(1, bottomLimit - top));
  for (let i = 0; i < ink.xs.length; i++) {
    const y = ink.ys[i];
    if (y < top || y >= bottomLimit) continue;
    const x = ink.xs[i] - col.s * (y - top);
    if (x >= col.divider - 2.2 * h && x <= col.divider) rows[Math.floor(y - top)]++;
  }
  // Only the number strip is used: numbers recur down the whole column, while
  // pictures and headlines below it do not sit in that strip.
  let last = 0, blank = 0;
  for (let y = 0; y < rows.length; y++) {
    if (rows[y] >= 3) { last = y; blank = 0; } else if (++blank > 4 * h) break;
  }
  return Math.min(bottomLimit, top + last + 1 + 3 * h);
}

// Finds the clue columns in a canvas, or returns null / { wrongOrientation }.
async function analyseClueLayout(canvas, report) {
  await report('finding text');
  const raw = await detectTextBoxes(canvas);
  const lineBoxes = raw.filter((b) => (b.x1 - b.x0) >= 2.5 * (b.y1 - b.y0));
  if (lineBoxes.length < 6) return null;

  // Page rotated by 90°: text lines come out taller than wide.
  const tall = raw.filter((b) => (b.y1 - b.y0) > 1.5 * (b.x1 - b.x0)).length;
  if (tall > lineBoxes.length) return { wrongOrientation: true };

  // Detected boxes are padded, so scale down to approximate a text line.
  const h = 0.7 * median(lineBoxes.map((b) => b.y1 - b.y0));

  await report('looking for the Across and Down headings');
  const candidates = raw
    .filter((b) => {
      const w = b.x1 - b.x0, bh = b.y1 - b.y0;
      return bh >= 0.9 * h && w >= 1.8 * bh && w <= 8 * bh;
    })
    .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0)
    .slice(0, AUTO_MAX_HEADING_CANDIDATES);
  let across = null, down = null;
  for (const b of candidates) {
    const kind = headingKind(await recognizeTextBox(canvas, b));
    if (kind === 'across' && !across) across = b;
    if (kind === 'down' && !down) down = b;
    if (across && down) break;
  }
  if (!across || !down || down.x0 <= across.x0) return null;

  // Headings share a baseline, so the line between them gives the page tilt.
  const cy = (b) => (b.y0 + b.y1) / 2;
  const theta = Math.atan2(cy(down) - cy(across), (down.x0 + down.x1) / 2 - (across.x0 + across.x1) / 2);
  if (Math.abs(theta) > 0.16) return null;
  const cos = Math.cos(theta), sin = Math.sin(theta);
  const fwdRaw = (x, y) => ({ x: x * cos + y * sin, y: -x * sin + y * cos });
  const cs = [fwdRaw(0, 0), fwdRaw(canvas.width, 0), fwdRaw(canvas.width, canvas.height), fwdRaw(0, canvas.height)];
  const ox = Math.min(...cs.map((p) => p.x)), oy = Math.min(...cs.map((p) => p.y));
  const fwd = (x, y) => { const p = fwdRaw(x, y); return { x: p.x - ox, y: p.y - oy }; };
  const inv = (x, y) => {
    const xr = x + ox, yr = y + oy;
    return { x: xr * cos - yr * sin, y: xr * sin + yr * cos };
  };
  const hA = { ...fwd(across.x0, cy(across)), y1: fwd(across.x0, across.y1).y };
  const hD = { ...fwd(down.x0, cy(down)), y1: fwd(down.x0, down.y1).y };
  hA.x0 = hA.x; hD.x0 = hD.x;

  await report('measuring the columns');
  const deskewed = document.createElement('canvas');
  deskewed.width = Math.ceil(Math.max(...cs.map((p) => p.x)) - ox);
  deskewed.height = Math.ceil(Math.max(...cs.map((p) => p.y)) - oy);
  const dctx = deskewed.getContext('2d');
  dctx.setTransform(cos, -sin, sin, cos, -ox, -oy);
  dctx.drawImage(canvas, 0, 0);

  const top = Math.max(hA.y1, hD.y1) + 0.3 * h;
  const pitch = hD.x0 - hA.x0;
  const xEnd = hD.x0 + 1.3 * pitch;
  const ink = inkPoints(deskewed, hA.x0 - 6 * h, top, xEnd, deskewed.height, Math.max(6, Math.round(h)));
  if (ink.xs.length < 500) return null;

  // Where the clue block ends, from rows of ink across both columns.
  const spanRows = new Int32Array(deskewed.height);
  for (let i = 0; i < ink.xs.length; i++) {
    if (ink.xs[i] > hA.x0 - 3 * h && ink.xs[i] < hD.x0 + 0.95 * pitch) spanRows[ink.ys[i]]++;
  }
  let lastRow = Math.ceil(top), blank = 0;
  for (let y = Math.ceil(top); y < spanRows.length; y++) {
    if (spanRows[y] >= 5) { lastRow = y; blank = 0; } else if (++blank > 2.5 * h) break;
  }
  const bottomLimit = lastRow + 1;
  if (bottomLimit - top < 8 * h) return null;

  const colA = measureColumn(ink, hA, h, top, bottomLimit, hD.x0 - 0.6 * h, 0);
  if (!colA) return null;
  const dx = hD.x0 - hA.x0;
  // Down is about the same size as Across, so fall back to Across's geometry.
  const colD = measureColumn(ink, hD, h, top, bottomLimit, hD.x0 + pitch, (colA.right - colA.left) * 1.08) || {
    s: colA.s,
    left: colA.left + dx,
    right: colA.right + dx,
    divider: colA.divider + dx,
  };

  const refine = (col) => {
    const d = trackEdge(ink, col.divider, col.s, top, bottomLimit, h, 0.9 * h);
    // Numbers are short and right-justified, so the strip left of the divider is narrow;
    // a wider one means the walk ran into the neighbouring grid.
    const off = Math.min(col.divider - col.left, 2.2 * h);
    const gap = col.right - col.divider;
    col.s = d.s; col.divider = d.x; col.left = d.x - off;
    // Right edge: in each band, walk right from the clue text start to the
    // first clear gutter, then fit a line (its slope may differ from the left).
    const bandH = Math.round(3 * h), nBands = Math.floor((bottomLimit - top) / bandH);
    const maxW = (gap + off) * 1.15, gw = Math.max(3, Math.round(0.6 * h));
    const pts = [];
    for (let bi = 0; bi < nBands; bi++) {
      const y0 = top + bi * bandH;
      const size = Math.ceil(maxW + 2 * h);
      const prof = new Int32Array(size);
      for (let i = 0; i < ink.xs.length; i++) {
        const y = ink.ys[i];
        if (y < y0 || y >= y0 + bandH) continue;
        const xi = Math.round(ink.xs[i] - col.s * (y - top) - col.divider);
        if (xi >= 0 && xi < size) prof[xi]++;
      }
      let end = 0, blank = 0;
      for (let x = Math.round(2 * h); x < size; x++) {
        if (prof[x] <= 1) { if (++blank >= gw) break; } else { blank = 0; end = x; }
      }
      if (end > 6 * h) pts.push({ y: (bi + 0.5) * bandH, x: col.divider + end });
    }
    if (pts.length >= 4) {
      // Lines beside an inset picture end early, so repeatedly fit the slope
      // (Theil-Sen) and drop bands well short of the others: the edge follows
      // the full-width lines.
      const slopeOf = (list) => {
        const slopes = [];
        for (let i = 0; i < list.length; i++) {
          for (let j = i + 1; j < list.length; j++) {
            if (list[j].y - list[i].y >= 4 * h) slopes.push((list[j].x - list[i].x) / (list[j].y - list[i].y));
          }
        }
        slopes.sort((p, q) => p - q);
        return slopes.length ? Math.max(-0.08, Math.min(0.08, slopes[Math.floor(slopes.length / 2)])) : 0;
      };
      let use = pts, b = 0;
      for (let it = 0; it < 3; it++) {
        b = slopeOf(use);
        const offs = pts.map((p) => p.x - b * p.y).sort((p, q) => p - q);
        const thr = offs[Math.floor(offs.length * 0.7)] - 1.5 * h;
        const next = pts.filter((p) => p.x - b * p.y >= thr);
        if (next.length < 4) break;
        use = next;
      }
      const offs = use.map((p) => p.x - b * p.y).sort((p, q) => p - q);
      const medOff = offs[Math.floor(offs.length / 2)];
      // Outer envelope of the genuine line ends, ignoring far-out strays.
      const inliers = offs.filter((o) => o <= medOff + 1.2 * h);
      col.sR = col.s + b;
      col.right = inliers[inliers.length - 1];    } else {
      col.sR = col.s; col.right = col.divider + (col.fallbackGap || gap);
    }
    return col;
  };
  colD.left = colD.divider - (colA.divider - colA.left);
  refine(colA);
  colD.fallbackGap = colA.right - colA.divider;
  refine(colD);

  // The two blocks end at about the same height; use the lower end for both,
  // since a picture can leave a long gap in one column's numbers.
  const bottomAll = Math.max(columnBottom(ink, colA, h, top, bottomLimit), columnBottom(ink, colD, h, top, bottomLimit));
  const results = [];
  for (const [direction, col] of [['across', colA], ['down', colD]]) {
    const bottom = bottomAll;
    const pad = 0.2 * h;
    const l = col.left - pad, r = col.right + 0.6 * h;
    const shearTo = (x, y, s) => {
      const p = inv(x + s * (y - top), y);
      return { x: Math.round(p.x), y: Math.round(p.y) };
    };
    const split = Math.min(0.6, Math.max(0.01, (col.divider - l) / (r - l)));
    results.push({
      corners: {
        tl: shearTo(l, top, col.s), tr: shearTo(r, top, col.sR),
        br: shearTo(r, bottom + pad, col.sR), bl: shearTo(l, bottom + pad, col.s),
      },
      direction,
      split,
    });
  }
  return { boxes: results };
}

// Tries the page upright first (or sideways first if the text lines are tall),
// then the other orientations. Returns { canvas, boxes } or null.
async function autoDetectClueBoxes(photo, onProgress) {
  const report = async (msg) => {
    if (onProgress) onProgress(msg);
    await new Promise((r) => setTimeout(r, 0));
  };
  let order = [0, 2, 1, 3];
  for (let i = 0; i < order.length; i++) {
    const canvas = rotateCanvasQuarter(photo, order[i]);
    const result = await analyseClueLayout(canvas, report);
    if (result && result.boxes) return { canvas, boxes: result.boxes };
    if (result && result.wrongOrientation && i === 0) order = [0, 1, 3, 2];
  }
  return null;
}
