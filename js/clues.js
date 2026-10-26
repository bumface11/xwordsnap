/* global whenCvReady, detectTextBoxes, recognizeTextBox */
// Step 3 support: perspective-correct each user-drawn quadrilateral against
// the raw clue photo, enhance it for OCR, run PP-OCR, and parse the
// recognized text into clue numbers.

// Where the clue numbers end, as a fraction of the box width from its left edge.
const DEFAULT_SPLIT = 0.05;

// The number/clue divider: the box's left edge shifted right by `split` of the
// box width, so it stays parallel to that edge however the quad is skewed.
function splitLinePoints(corners, split) {
  const { tl, tr, bl, br } = corners;
  const w = { x: ((tr.x - tl.x) + (br.x - bl.x)) / 2, y: ((tr.y - tl.y) + (br.y - bl.y)) / 2 };
  return {
    top: { x: tl.x + w.x * split, y: tl.y + w.y * split },
    bottom: { x: bl.x + w.x * split, y: bl.y + w.y * split },
  };
}

function splitHandlePoint(corners, split) {
  const { top, bottom } = splitLinePoints(corners, split);
  return { x: (top.x + bottom.x) / 2, y: (top.y + bottom.y) / 2 };
}

// Inverse of splitLinePoints: the split fraction whose line passes through p.
function splitFromPoint(corners, p) {
  const { tl, tr, bl, br } = corners;
  const w = { x: ((tr.x - tl.x) + (br.x - bl.x)) / 2, y: ((tr.y - tl.y) + (br.y - bl.y)) / 2 };
  const mid = { x: (tl.x + bl.x) / 2, y: (tl.y + bl.y) / 2 };
  return ((p.x - mid.x) * w.x + (p.y - mid.y) * w.y) / ((w.x * w.x + w.y * w.y) || 1);
}

// Flattens uneven lighting (shadows, glare, gradients across the page) by
// dividing each pixel by a heavily-blurred version of itself, which
// estimates the local background illumination. This is a cheap stand-in for
// CLAHE that only needs GaussianBlur/convertTo/divide — all present even in
// opencv.js builds that omit cv.createCLAHE. Caller owns and must delete
// the returned Mat.
function flattenIllumination(cv, gray) {
  const bg = new cv.Mat();
  cv.GaussianBlur(gray, bg, new cv.Size(0, 0), gray.cols / 20);
 
  const bgF = new cv.Mat();
  const grayF = new cv.Mat();
  const normF = new cv.Mat();
  const norm = new cv.Mat();
  gray.convertTo(grayF, cv.CV_32F);
  bg.convertTo(bgF, cv.CV_32F, 1, 1); // +1 avoids divide-by-zero
 
  cv.divide(grayF, bgF, normF, 255.0);
  normF.convertTo(norm, cv.CV_8U);
 
  [bg, bgF, grayF, normF].forEach((m) => m.delete());
  return norm;
}

// Perspective-warps a (possibly skewed) quadrilateral out of the raw photo
// into an upright rectangle, then runs a conservative document-OCR pipeline
// on just that crop. Using the quad's own corners for the perspective
// transform deskews it exactly, rather than guessing a single whole-image
// rotation angle.
async function warpAndEnhanceQuad(sourceCanvas, corners, split = DEFAULT_SPLIT) {
  const cv = await whenCvReady();
  const src = cv.imread(sourceCanvas);

  const { tl, tr, br, bl } = corners;
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const width = Math.max(2, Math.round(Math.max(dist(tl, tr), dist(bl, br))));
  const height = Math.max(2, Math.round(Math.max(dist(tl, bl), dist(tr, br))));

  const srcPts = cv.matFromArray(4, 1, cv.CV_32FC2,
    [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y]);
  const dstPts = cv.matFromArray(4, 1, cv.CV_32FC2,
    [0, 0, width - 1, 0, width - 1, height - 1, 0, height - 1]);
  const transform = cv.getPerspectiveTransform(srcPts, dstPts);

  // Carry the divider line through the same perspective transform so it can
  // be located in the warped, enhanced image the OCR words are measured in.
  const tm = transform.data64F;
  const toWarped = (p) => {
    const d = tm[6] * p.x + tm[7] * p.y + tm[8];
    return { x: (tm[0] * p.x + tm[1] * p.y + tm[2]) / d, y: (tm[3] * p.x + tm[4] * p.y + tm[5]) / d };
  };
  const dividerPts = splitLinePoints(corners, split);
  const warpedTop = toWarped(dividerPts.top);
  const warpedBottom = toWarped(dividerPts.bottom);
  const warped = new cv.Mat();
  cv.warpPerspective(src, warped, transform, new cv.Size(width, height),
    cv.INTER_CUBIC, cv.BORDER_REPLICATE, new cv.Scalar());

  // PP-OCR works best on the natural image, so no blur/contrast filtering;
  // only upscale genuinely small crops.
  const scale = warped.cols < 1000 ? Math.min(2, 1000 / warped.cols) : 1;
  const resized = new cv.Mat();
  if (scale > 1) {
    cv.resize(warped, resized, new cv.Size(0, 0), scale, scale, cv.INTER_CUBIC);
  } else {
    warped.copyTo(resized);
  }

  const padded = new cv.Mat();
  cv.copyMakeBorder(resized, padded, 20, 20, 20, 20, cv.BORDER_CONSTANT, new cv.Scalar(255, 255, 255, 255));

  const out = document.createElement('canvas');
  out.width = padded.cols;
  out.height = padded.rows;
  cv.imshow(out, padded);

  [src, srcPts, dstPts, transform, warped, resized, padded]
    .forEach((m) => m.delete());
  // Same upscale and 20px padding the pipeline applied above.
  const toFinal = (p) => ({ x: p.x * scale + 20, y: p.y * scale + 20 });
  return { canvas: out, splitLine: { top: toFinal(warpedTop), bottom: toFinal(warpedBottom) } };
}


// Clue text wraps across OCR lines; a clue ends once a line finishes with a
// bracketed answer length like "(5)", "(4,3)" or "(3-4)". The next non-empty
// line then starts with the next clue's number.
const CLUE_START_RE = /^(\d+)\.?\s+(.*)$/;
const CLUE_END_RE = /\(\s*\d+(?:[\s,-]+\d+)*\s*\)\s*[.,]?\s*$/;

function parseClueLines(rawText) {
  const lines = rawText.split('\n').map((l) => l.trim()).filter(Boolean);
  const clues = [];
  let current = null;

  const finish = (c) => ({ number: c.number, text: c.parts.join(' ').replace(/\s+/g, ' ').trim() });

  for (const line of lines) {
    const startMatch = line.match(CLUE_START_RE);
    if (startMatch && current) {
      // Previous clue never hit its bracketed length — close it out anyway
      // rather than lose it, then start the new one.
      clues.push(finish(current));
      current = null;
    }
    if (startMatch) {
      current = { number: startMatch[1], parts: [startMatch[2]] };
    } else if (current) {
      current.parts.push(line);
    }
    if (current && CLUE_END_RE.test(line)) {
      clues.push(finish(current));
      current = null;
    }
  }
  if (current) clues.push(finish(current));
  return clues;
}

// A token left of the divider should be a clue number, so common digit
// look-alikes are corrected before non-digits are dropped.
function numberFromToken(text) {
  const digits = text
    .replace(/[Oo]/g, '0').replace(/[Il|!]/g, '1').replace(/[Ss]/g, '5')
    .replace(/B/g, '8').replace(/[Zz]/g, '2')
    .replace(/\D/g, '');
  const n = parseInt(digits, 10);
  return n > 0 ? String(n) : null;
}

// Words left of the divider are clue numbers, each starting a new clue; words
// right of it are clue text, joined to the nearest number at or above them.
function parseClueWords(words, splitLine) {
  if (!words.length) return [];
  const heights = words.map((w) => w.y1 - w.y0).sort((a, b) => a - b);
  const tol = 0.6 * (heights[Math.floor(heights.length / 2)] || 1);
  const { top, bottom } = splitLine;
  const dy = bottom.y - top.y;
  const dividerX = (y) => (dy ? top.x + (bottom.x - top.x) * (y - top.y) / dy : top.x);

  const clues = [];
  const textWords = [];
  for (const w of words) {
    const yc = (w.y0 + w.y1) / 2;
    if ((w.x0 + w.x1) / 2 < dividerX(yc)) {
      const number = numberFromToken(w.text);
      if (number) clues.push({ number, yc, parts: [] });
    } else {
      textWords.push({ ...w, yc: w.yl ?? yc });
    }
  }
  clues.sort((a, b) => a.yc - b.yc);

  textWords.sort((a, b) => a.yc - b.yc);
  const lines = [];
  for (const w of textWords) {
    const last = lines[lines.length - 1];
    if (last && w.yc - last.yc <= tol) {
      last.words.push(w);
      last.yc += (w.yc - last.yc) / last.words.length;
    } else {
      lines.push({ yc: w.yc, words: [w] });
    }
  }

  // A clue ends with its enumeration, e.g. "(6,5)" (OCR may drop the closing
  // bracket). Text after that with no number of its own belongs to a clue whose
  // number was missed, so it must not be glued onto the clue above.
  const endsClue = (s) => /\(\s*\d+(?:[\s,.'’-]+\d+)*\s*\)?\s*[.,]?\s*$/.test(s);
  for (const line of lines) {
    let owner = null;
    for (const c of clues) if (c.yc <= line.yc + tol) owner = c;
    if (!owner) continue;
    const lineText = line.words.sort((a, b) => a.x0 - b.x0).map((w) => w.text).join(' ');
    if (owner.closed) {
      continue;
    }
    owner.parts.push(lineText);
    if (endsClue(lineText)) owner.closed = true;
  }
  return clues
    .filter((c) => c.parts.length)
    .map((c) => ({ number: c.number, yc: c.yc, text: c.parts.join(' ').replace(/\s+/g, ' ').trim() }));
}

// Straightened box images and where each scanned clue sits in them, so the
// review step can show the area where a missing clue should be.
let lastClueScan = { across: [], down: [] };

// Crops the straightened image where clue `num` should be, guessed from the
// scanned clues either side of it. `numbers` is the full sorted number list.
function missingClueSnippet(dirKey, num, numbers) {
  const idx = numbers.indexOf(num);
  const entries = lastClueScan[dirKey] || [];
  const posOf = (e, n) => (e.ys[n] === undefined ? null : e.ys[n]);
  for (const e of entries) {
    let a = null;
    let b = null;
    for (let i = idx - 1; i >= 0 && a === null; i--) if (posOf(e, numbers[i]) !== null) a = i;
    for (let i = idx + 1; i < numbers.length && b === null; i++) if (posOf(e, numbers[i]) !== null) b = i;
    if (a === null && b === null) continue;
    const h = e.h;
    let top;
    let bottom;
    if (a !== null && b !== null) {
      const ya = e.ys[numbers[a]];
      const yb = e.ys[numbers[b]];
      const slots = b - a;
      const step = (yb - ya) / slots;
      const centre = ya + step * (idx - a);
      top = centre - Math.max(step * 0.6, 1.8 * h);
      bottom = centre + Math.max(step * 0.6, 1.8 * h);
    } else if (a !== null) {
      top = e.ys[numbers[a]] + h * 0.5;
      bottom = top + 4 * h;
    } else {
      bottom = e.ys[numbers[b]] - h * 0.5;
      top = bottom - 4 * h;
    }
    top = Math.max(0, Math.floor(top));
    bottom = Math.min(e.canvas.height, Math.ceil(bottom));
    if (bottom - top < 8) continue;
    const out = document.createElement('canvas');
    out.width = e.canvas.width;
    out.height = bottom - top;
    out.getContext('2d').drawImage(e.canvas, 0, top, out.width, out.height, 0, 0, out.width, out.height);
    return out;
  }
  return null;
}

// Vertical centre of the ink in the first few ems of a line box. A sloping
// line's box centre sits lower than its start, so the start is what should be
// compared with the clue number on the left.
function leftInkY(canvas, b) {
  const x0 = Math.max(0, Math.floor(b.x0));
  const y0 = Math.max(0, Math.floor(b.y0));
  const h = Math.min(canvas.height, Math.ceil(b.y1)) - y0;
  const w = Math.min(canvas.width, Math.ceil(b.x1), x0 + Math.round(4 * h)) - x0;
  if (w < 3 || h < 3) return (b.y0 + b.y1) / 2;
  const data = canvas.getContext('2d').getImageData(x0, y0, w, h).data;
  let sum = 0;
  let n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (data[i] * 0.3 + data[i + 1] * 0.59 + data[i + 2] * 0.11 < 110) { sum += y; n++; }
    }
  }
  return n ? y0 + sum / n : (b.y0 + b.y1) / 2;
}

// Splits a text-line box wherever the upper part of the line (above the
// baseline, so a "fill-in" underline doesn't count) is blank for more than
// ~3 ems. Returns [{x0,x1,gapBefore}] plus whether a gap trails the last piece.
function splitAtGaps(canvas, b, dividerLeft) {
  const x0 = Math.max(0, Math.floor(b.x0));
  const x1 = Math.min(canvas.width, Math.ceil(b.x1));
  const y0 = Math.max(0, Math.floor(b.y0));
  const y1 = Math.min(canvas.height, Math.ceil(b.y1));
  const w = x1 - x0;
  const h = y1 - y0;
  if (w < 4 || h < 4) return { pieces: [{ x0: b.x0, x1: b.x1, gapBefore: false }], gapAfter: false };
  const minGap = 2.25 * h;
  const rows = Math.max(1, Math.floor(h * 0.62));
  const data = canvas.getContext('2d').getImageData(x0, y0, w, rows).data;
  const inked = new Uint8Array(w);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (data[i] * 0.3 + data[i + 1] * 0.59 + data[i + 2] * 0.11 < 110) inked[x] = 1;
    }
  }
  const pieces = [];
  let start = -1;
  let blank = 0;
  let gapBefore = x0 - dividerLeft > minGap;
  let lastInk = -1;
  for (let x = 0; x < w; x++) {
    if (inked[x]) {
      if (start < 0) {
        start = x;
        if (x > minGap && pieces.length === 0) gapBefore = true;
      } else if (blank > minGap) {
        pieces.push({ x0: x0 + start, x1: x0 + lastInk + 1, gapBefore });
        start = x;
        gapBefore = true;
      }
      blank = 0;
      lastInk = x;
    } else {
      blank++;
    }
  }
  if (start < 0) return { pieces: [], gapAfter: false };
  pieces.push({ x0: x0 + start, x1: x0 + lastInk + 1, gapBefore });
  return { pieces, gapAfter: w - 1 - lastInk > minGap };
}

// Detects text lines with PP-OCR and recognizes them. Any line crossing the
// number/clue divider is cut there so numbers and clue text are read apart.
// Clue text lines are also cut at long blanks (fill-in gaps) and the gap is
// written as ____ in the transcription.
async function ocrWords(canvas, splitLine, report) {
  const { top, bottom } = splitLine;
  await report(0, 'finding text lines');
  const dy = bottom.y - top.y;
  const dividerX = (y) => (dy ? top.x + (bottom.x - top.x) * (y - top.y) / dy : top.x);
  const parts = [];
  for (const b of await detectTextBoxes(canvas)) {
    const dx = dividerX((b.y0 + b.y1) / 2);
    const minW = (b.y1 - b.y0) * 0.5;
    if (b.x0 < dx - minW && b.x1 > dx + minW) {
      parts.push({ ...b, x1: dx }, { ...b, x0: dx });
    } else {
      parts.push(b);
    }
  }
  const words = [];
  for (let i = 0; i < parts.length; i++) {
    const b = parts[i];
    await report(0.2 + 0.8 * (i / parts.length), `reading line ${i + 1} of ${parts.length}`);
    const dx = dividerX((b.y0 + b.y1) / 2);
    let text;
    if ((b.x0 + b.x1) / 2 < dx) {
      text = await recognizeTextBox(canvas, b);
    } else {
      const { pieces, gapAfter } = splitAtGaps(canvas, b, dx);
      const out = [];
      for (const p of pieces) {
        const t = await recognizeTextBox(canvas, { ...b, x0: p.x0 - 2, x1: p.x1 + 2 });
        if (p.gapBefore && out[out.length - 1] !== '____') out.push('____');
        if (t) out.push(t);
      }
      if (out.length && gapAfter && out[out.length - 1] !== '____') out.push('____');
      text = out.join(' ');
    }
    if (text) words.push({ text, x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1, yl: leftInkY(canvas, b) });
  }
  return words;
}

// Plain top-to-bottom text of the recognized words, for the line-based fallback.
function wordsToText(words) {
  const sorted = [...words].sort((a, b) => (a.y0 + a.y1) - (b.y0 + b.y1));
  const lines = [];
  for (const w of sorted) {
    const last = lines[lines.length - 1];
    const yc = (w.y0 + w.y1) / 2;
    if (last && yc <= last.y1) last.words.push(w);
    else lines.push({ y1: w.y1, words: [w] });
  }
  return lines.map((l) => l.words.sort((a, b) => a.x0 - b.x0).map((w) => w.text).join(' ')).join('\n');
}

// Runs OCR on each box (in the order given) and merges the parsed clues into
// { across: {number: text}, down: {number: text} }, keyed by the box's
// user-assigned direction. `sourceCanvas` is the raw (unprocessed) clue
// photo — each box's quad is perspective-corrected and enhanced individually.
async function recognizeClueBoxes(sourceCanvas, boxes, onProgress) {
  const acrossText = {};
  const downText = {};
  const scan = { across: [], down: [] };
  lastClueScan = scan;
  // The WASM work blocks the main thread, so yield after each report to let
  // the status text actually paint.
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const emit = async (frac, msg) => {
    if (onProgress) onProgress(frac, msg);
    await tick();
  };
  await emit(0, 'loading OCR models (first run is slower)');
  await getOcrEngine();
  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i];
    const label = `box ${i + 1} of ${boxes.length}`;
    const at = (f) => (i + f) / boxes.length;
    await emit(at(0), `${label}: straightening and enhancing`);
    const { canvas, splitLine } = await warpAndEnhanceQuad(
      sourceCanvas, box.corners, box.split ?? DEFAULT_SPLIT);
    const words = await ocrWords(canvas, splitLine,
      (f, msg) => emit(at(0.1 + 0.9 * f), `${label}: ${msg}`));
    await emit(at(0.98), `${label}: parsing clues`);
    const bucket = box.direction === 'down' ? downText : acrossText;
    let clues = parseClueWords(words, splitLine);
    // Nothing found left of the divider — fall back to matching numbers in the plain text.
    if (!clues.length) clues = parseClueLines(wordsToText(words));
    for (const { number, text } of clues) bucket[number] = text;
    const hs = words.map((w) => w.y1 - w.y0).sort((x, y) => x - y);
    const ys = {};
    for (const c of clues) if (c.yc !== undefined) ys[c.number] = c.yc;
    scan[box.direction === 'down' ? 'down' : 'across'].push({ canvas, ys, h: hs[hs.length >> 1] || 20 });
    if (onProgress) onProgress((i + 1) / boxes.length);
  }
  return { across: acrossText, down: downText };
}