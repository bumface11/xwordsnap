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

// Perspective-warps a (possibly skewed) quadrilateral out of the raw photo
// into an upright rectangle, then runs a conservative document-OCR pipeline
// on just that crop. Using the quad's own corners for the perspective
// transform deskews it exactly, rather than guessing a single whole-image
// rotation angle.
async function warpAndEnhanceQuad(sourceCanvas, corners) {
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
  const warped = new cv.Mat();
  cv.warpPerspective(src, warped, transform, new cv.Size(width, height),
    cv.INTER_CUBIC, cv.BORDER_REPLICATE, new cv.Scalar());

  const gray = new cv.Mat();
  cv.cvtColor(warped, gray, cv.COLOR_RGBA2GRAY);

  const denoised = new cv.Mat();
  cv.medianBlur(gray, denoised, 3);

  const contrast = new cv.Mat();
  if (typeof cv.createCLAHE === 'function') {
    const clahe = cv.createCLAHE(2, new cv.Size(8, 8));
    clahe.apply(denoised, contrast);
    clahe.delete();
  } else {
    cv.normalize(denoised, contrast, 0, 255, cv.NORM_MINMAX);
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
// user-assigned direction. `sourceCanvas` is the raw (unprocessed) clue
// photo — each box's quad is perspective-corrected and enhanced individually.
async function recognizeClueBoxes(sourceCanvas, boxes, onProgress) {
  const worker = await getOcrWorker();
  const acrossText = {};
  const downText = {};
  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i];
    const crop = await warpAndEnhanceQuad(sourceCanvas, box.corners);
    const { data } = await worker.recognize(crop);
    const bucket = box.direction === 'down' ? downText : acrossText;
    for (const { number, text } of parseClueLines(data.text)) bucket[number] = text;
    if (onProgress) onProgress((i + 1) / boxes.length);
  }
  return { across: acrossText, down: downText };
}
