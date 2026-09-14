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

// Grayscale + upscale + adaptive threshold — OCR engines do far better on
// clean black-on-white text than on a raw phone photo of a newspaper page.
async function preprocessForOcr(sourceCanvas) {
  const cv = await whenCvReady();
  const src = cv.imread(sourceCanvas);
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

  const scale = sourceCanvas.width < 1600 ? 1600 / sourceCanvas.width : 1;
  const resized = new cv.Mat();
  if (scale > 1) {
    cv.resize(gray, resized, new cv.Size(0, 0), scale, scale, cv.INTER_CUBIC);
  } else {
    gray.copyTo(resized);
  }

  const normalized = new cv.Mat();
  cv.normalize(resized, normalized, 0, 255, cv.NORM_MINMAX);

  const binary = new cv.Mat();
  cv.adaptiveThreshold(normalized, binary, 255,
    cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 25, 15);

  const out = document.createElement('canvas');
  out.width = binary.cols;
  out.height = binary.rows;
  cv.imshow(out, binary);

  [src, gray, resized, normalized, binary].forEach((m) => m.delete());
  return out;
}


function cropCanvas(source, rect) {
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(rect.w));
  out.height = Math.max(1, Math.round(rect.h));
  out.getContext('2d').drawImage(
    source, rect.x, rect.y, rect.w, rect.h, 0, 0, out.width, out.height);
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
