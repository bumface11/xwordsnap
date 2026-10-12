/* global ort, whenCvReady */
// PP-OCR (PaddleOCR) text detection + recognition running fully offline in the
// browser via onnxruntime-web (WASM). Detection is PP-OCRv4 mobile (DB);
// recognition is the PP-OCRv3 English CTC model.

const OCR_DIR = 'lib/ocr/';
const DET_MAX_SIDE = 1280;
const DET_THRESH = 0.3;
const DET_BOX_THRESH = 0.5;
const DET_UNCLIP_RATIO = 1.6;
const REC_HEIGHT = 48;

let ocrEnginePromise = null;

function getOcrEngine() {
  if (!ocrEnginePromise) {
    ocrEnginePromise = (async () => {
      ort.env.wasm.wasmPaths = new URL('lib/', document.baseURI).href;
      ort.env.wasm.numThreads = 1; // multithreading needs cross-origin isolation
      const opts = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
      const [det, rec, dictText] = await Promise.all([
        ort.InferenceSession.create(OCR_DIR + 'det.onnx', opts),
        ort.InferenceSession.create(OCR_DIR + 'rec.onnx', opts),
        fetch(OCR_DIR + 'dict.txt').then((r) => r.text()),
      ]);
      // CTC classes: index 0 is blank, then the dictionary, then a space.
      const chars = ['', ...dictText.split(/\r?\n/).filter((l) => l.length), ' '];
      return { det, rec, chars };
    })();
    ocrEnginePromise.catch(() => { ocrEnginePromise = null; });
  }
  return ocrEnginePromise;
}

// RGBA Mat -> normalized planar RGB float tensor data.
function toPlanar(rgba, mean, std) {
  const { cols: w, rows: h, data } = rgba;
  const out = new Float32Array(3 * w * h);
  const plane = w * h;
  for (let i = 0; i < plane; i++) {
    for (let c = 0; c < 3; c++) out[c * plane + i] = (data[i * 4 + c] / 255 - mean[c]) / std[c];
  }
  return out;
}

// Finds text-line boxes in a canvas. Returns [{x0,y0,x1,y1}] in canvas pixels.
async function detectTextBoxes(canvas) {
  const cv = await whenCvReady();
  const { det } = await getOcrEngine();
  const src = cv.imread(canvas);
  const scale = Math.min(1, DET_MAX_SIDE / Math.max(src.cols, src.rows));
  const w = Math.max(32, Math.round(src.cols * scale / 32) * 32);
  const h = Math.max(32, Math.round(src.rows * scale / 32) * 32);
  const resized = new cv.Mat();
  cv.resize(src, resized, new cv.Size(w, h), 0, 0, cv.INTER_LINEAR);

  const input = new ort.Tensor('float32',
    toPlanar(resized, [0.485, 0.456, 0.406], [0.229, 0.224, 0.225]), [1, 3, h, w]);
  const result = await det.run({ [det.inputNames[0]]: input });
  const prob = result[det.outputNames[0]].data;

  const mask = new cv.Mat(h, w, cv.CV_8UC1);
  for (let i = 0; i < w * h; i++) mask.data[i] = prob[i] > DET_THRESH ? 255 : 0;
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(mask, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

  const boxes = [];
  for (let i = 0; i < contours.size(); i++) {
    const cnt = contours.get(i);
    const r = cv.boundingRect(cnt);
    cnt.delete();
    if (Math.min(r.width, r.height) < 3) continue;
    // Mean probability inside the box approximates the DB box score.
    let sum = 0;
    for (let y = r.y; y < r.y + r.height; y++) {
      for (let x = r.x; x < r.x + r.width; x++) sum += prob[y * w + x];
    }
    if (sum / (r.width * r.height) < DET_BOX_THRESH) continue;
    // DB predicts a shrunken kernel; unclip by area * ratio / perimeter.
    const d = (r.width * r.height * DET_UNCLIP_RATIO) / (2 * (r.width + r.height));
    boxes.push({
      x0: Math.max(0, (r.x - d) / scale),
      y0: Math.max(0, (r.y - d) / scale),
      x1: Math.min(src.cols, (r.x + r.width + d) / scale),
      y1: Math.min(src.rows, (r.y + r.height + d) / scale),
    });
  }
  [src, resized, mask, contours, hierarchy].forEach((m) => m.delete());
  return boxes;
}

// Recognizes the text inside one box of a canvas.
async function recognizeTextBox(canvas, box) {
  const cv = await whenCvReady();
  const { rec, chars } = await getOcrEngine();
  const src = cv.imread(canvas);
  const x0 = Math.max(0, Math.floor(box.x0));
  const y0 = Math.max(0, Math.floor(box.y0));
  const x1 = Math.min(src.cols, Math.ceil(box.x1));
  const y1 = Math.min(src.rows, Math.ceil(box.y1));
  if (x1 - x0 < 2 || y1 - y0 < 2) { src.delete(); return ''; }

  const crop = src.roi(new cv.Rect(x0, y0, x1 - x0, y1 - y0));
  const rw = Math.min(2048, Math.max(16, Math.ceil(REC_HEIGHT * (x1 - x0) / (y1 - y0))));
  const resized = new cv.Mat();
  cv.resize(crop, resized, new cv.Size(rw, REC_HEIGHT), 0, 0, cv.INTER_LINEAR);
  const input = new ort.Tensor('float32',
    toPlanar(resized, [0.5, 0.5, 0.5], [0.5, 0.5, 0.5]), [1, 3, REC_HEIGHT, rw]);
  [src, crop, resized].forEach((m) => m.delete());

  const result = await rec.run({ [rec.inputNames[0]]: input });
  const out = result[rec.outputNames[0]];
  const [, steps, classes] = out.dims;
  let text = '';
  let prev = 0;
  for (let t = 0; t < steps; t++) {
    let best = 0;
    let bestVal = -Infinity;
    for (let c = 0; c < classes; c++) {
      const v = out.data[t * classes + c];
      if (v > bestVal) { bestVal = v; best = c; }
    }
    if (best !== 0 && best !== prev) text += chars[best] || '';
    prev = best;
  }
  return text.trim();
}
