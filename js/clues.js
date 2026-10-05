/* global Tesseract, whenCvReady */
// Step 3 support: perspective-correct each user-drawn quadrilateral against
// the raw clue photo, enhance it for OCR, run Tesseract, and parse the
// recognized text into clue numbers.

let ocrWorkerPromise = null;

// Lazily create a single Tesseract worker, pointed at the locally vendored
// core/worker/language files so the app keeps working offline.
function getOcrWorker() {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = Tesseract.createWorker('eng', 1, {
      workerPath: 'lib/worker.min.js',
      corePath: 'lib/',
      langPath: 'lib',
    });
  }
  return ocrWorkerPromise;
}

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

  const gray = new cv.Mat();
  cv.cvtColor(warped, gray, cv.COLOR_RGBA2GRAY);

  const denoised = new cv.Mat();
  cv.medianBlur(gray, denoised, 3);

  let contrast;
  if (typeof cv.createCLAHE === 'function') {
    contrast = new cv.Mat();
    const clahe = cv.createCLAHE(2, new cv.Size(8, 8));
    clahe.apply(denoised, contrast);
    clahe.delete();
  } else {
    contrast = flattenIllumination(cv, denoised);
  }

  const scale = contrast.cols < 1600 ? 1600 / contrast.cols : 1;
  const resized = new cv.Mat();
  if (scale > 1) {
    cv.resize(contrast, resized, new cv.Size(0, 0), scale, scale, cv.INTER_CUBIC);
  } else {
    contrast.copyTo(resized);
  }

  const binary = new cv.Mat();
  cv.adaptiveThreshold(resized, binary, 255,
    cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 25, 15);

  const clean = new cv.Mat();
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(2, 2));
  cv.morphologyEx(binary, clean, cv.MORPH_OPEN, kernel);

  const padded = new cv.Mat();
  cv.copyMakeBorder(clean, padded, 20, 20, 20, 20, cv.BORDER_CONSTANT, new cv.Scalar(255));

  const out = document.createElement('canvas');
  out.width = padded.cols;
  out.height = padded.rows;
  cv.imshow(out, padded);

  [src, srcPts, dstPts, transform, warped, gray, denoised, contrast, resized, binary, clean, kernel, padded]
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

// Flattens Tesseract's blocks > paragraphs > lines > words tree into words
// with their pixel boxes.
function wordsFromBlocks(blocks) {
  const words = [];
  for (const block of blocks || []) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) {
        for (const w of line.words || []) {
          const text = (w.text || '').trim();
          if (text) words.push({ text, x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1 });
        }
      }
    }
  }
  return words;
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
      textWords.push({ ...w, yc });
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

  for (const line of lines) {
    let owner = null;
    for (const c of clues) if (c.yc <= line.yc + tol) owner = c;
    if (!owner) continue;
    owner.parts.push(line.words.sort((a, b) => a.x0 - b.x0).map((w) => w.text).join(' '));
  }
  return clues
    .filter((c) => c.parts.length)
    .map((c) => ({ number: c.number, text: c.parts.join(' ').replace(/\s+/g, ' ').trim() }));
}

// Runs OCR on each box (in the order given) and merges the parsed clues into
// { across: {number: text}, down: {number: text} }, keyed by the box's
// user-assigned direction. `sourceCanvas` is the raw (unprocessed) clue
// photo — each box's quad is perspective-corrected and enhanced individually.
async function recognizeClueBoxes(sourceCanvas, boxes, onProgress) {
  const worker = await getOcrWorker();
  const acrossText = {};
  const downText = {};
  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i];
    const { canvas, splitLine } = await warpAndEnhanceQuad(
      sourceCanvas, box.corners, box.split ?? DEFAULT_SPLIT);
    const { data } = await worker.recognize(canvas, {}, { text: true, blocks: true });
    const bucket = box.direction === 'down' ? downText : acrossText;
    let clues = parseClueWords(wordsFromBlocks(data.blocks), splitLine);
    // Nothing found left of the divider — fall back to matching numbers in the plain text.
    if (!clues.length) clues = parseClueLines(data.text);
    for (const { number, text } of clues) bucket[number] = text;
    if (onProgress) onProgress((i + 1) / boxes.length);
  }
  return { across: acrossText, down: downText };
}
