/* global Tesseract, whenCvReady */
// Step 3 support: preprocess a clue photo for OCR, run Tesseract on one or
// more user-drawn boxes, and parse the recognized text into clue numbers.

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

// Applies a conservative document-OCR pipeline without changing grid detection.
async function preprocessForOcr(sourceCanvas) {
  const cv = await whenCvReady();
  const src = cv.imread(sourceCanvas);
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

  const denoised = new cv.Mat();
  cv.medianBlur(gray, denoised, 3);

  // Find the median angle of near-horizontal text strokes, then deskew before
  // local contrast enhancement and thresholding.
  const deskewProbe = new cv.Mat();
  const deskewLines = new cv.Mat();
  cv.adaptiveThreshold(denoised, deskewProbe, 255,
    cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 25, 15);
  cv.HoughLines(deskewProbe, deskewLines, 1, Math.PI / 180,
    Math.max(80, Math.round(sourceCanvas.width / 8)));
  const angles = [];
  for (let i = 0; i < deskewLines.rows; i++) {
    const angle = deskewLines.data32F[i * 2 + 1] * 180 / Math.PI - 90;
    if (Math.abs(angle) < 10) angles.push(angle);
  }
  angles.sort((a, b) => a - b);
  const skew = angles.length ? angles[Math.floor(angles.length / 2)] : 0;
  deskewProbe.delete();
  deskewLines.delete();

  const deskewed = new cv.Mat();
  if (Math.abs(skew) >= 0.5) {
    const center = new cv.Point(denoised.cols / 2, denoised.rows / 2);
    const transform = cv.getRotationMatrix2D(center, skew, 1);
    cv.warpAffine(denoised, deskewed, transform,
      new cv.Size(denoised.cols, denoised.rows), cv.INTER_CUBIC,
      cv.BORDER_REPLICATE, new cv.Scalar());
    transform.delete();
  } else {
    denoised.copyTo(deskewed);
  }

  const contrast = new cv.Mat();
  if (typeof cv.createCLAHE === 'function') {
    const clahe = cv.createCLAHE(2, new cv.Size(8, 8));
    clahe.apply(deskewed, contrast);
    clahe.delete();
  } else {
    cv.normalize(deskewed, contrast, 0, 255, cv.NORM_MINMAX);
    // Use histogram equalization instead of CLAHE
    // const contrast = new cv.Mat();
    // cv.equalizeHist(deskewed, contrast);
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

  const out = document.createElement('canvas');
  out.width = clean.cols;
  out.height = clean.rows;
  cv.imshow(out, clean);

  [src, gray, denoised, deskewed, contrast, resized, binary, clean, kernel]
    .forEach((m) => m.delete());
  return out;
}


function cropCanvas(source, rect) {
  const padding = 20;
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(rect.w + padding * 2));
  out.height = Math.max(1, Math.round(rect.h + padding * 2));
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(source, rect.x, rect.y, rect.w, rect.h,
    padding, padding, Math.round(rect.w), Math.round(rect.h));
  return out;
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

// Runs OCR on each box (in the order given) and merges the parsed clues into
// { across: {number: text}, down: {number: text} }, keyed by the box's
// user-assigned direction.
async function recognizeClueBoxes(processedCanvas, boxes, onProgress) {
  const worker = await getOcrWorker();
  const acrossText = {};
  const downText = {};
  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i];
    const crop = cropCanvas(processedCanvas, box.rect);
    const { data } = await worker.recognize(crop);
    const bucket = box.direction === 'down' ? downText : acrossText;
    for (const { number, text } of parseClueLines(data.text)) bucket[number] = text;
    if (onProgress) onProgress((i + 1) / boxes.length);
  }
  return { across: acrossText, down: downText };
}
