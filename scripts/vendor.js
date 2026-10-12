// Copies browser libraries out of node_modules into lib/ so the PWA can be
// served as a fully static site. Re-run with `npm run vendor`.
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const libDir = path.join(root, 'lib');
fs.mkdirSync(libDir, { recursive: true });

const files = [
  ['node_modules/@techstark/opencv-js/dist/opencv.js', 'lib/opencv.js'],
  ['node_modules/html5-crossword-solver/lib/jscrossword_combined.js', 'lib/jscrossword_combined.js'],
  // ONNX Runtime Web (single-threaded WASM) runs the PP-OCR models; the .mjs
  // loader is fetched at runtime from the same folder as the .wasm.
  ['node_modules/onnxruntime-web/dist/ort.wasm.min.js', 'lib/ort.wasm.min.js'],
  ['node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs', 'lib/ort-wasm-simd-threaded.mjs'],
  ['node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm', 'lib/ort-wasm-simd-threaded.wasm'],
];

for (const [src, dest] of files) {
  const from = path.join(root, src);
  const to = path.join(root, dest);
  if (!fs.existsSync(from)) {
    console.error(`Missing ${src} â€” run npm install first.`);
    process.exit(1);
  }
  fs.copyFileSync(from, to);
  console.log(`vendored ${src} -> ${dest}`);
}

// PP-OCR models (ONNX, from RapidOCR / PaddleOCR) aren't on npm — fetch them
// once and cache them in lib/ocr/.
const HF = 'https://huggingface.co/SWHL/RapidOCR/resolve/main/';
const models = [
  [HF + 'PP-OCRv4/ch_PP-OCRv4_det_infer.onnx', 'det.onnx'],
  [HF + 'PP-OCRv3/en_PP-OCRv3_rec_infer.onnx', 'rec.onnx'],
  ['https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/release/2.7/ppocr/utils/en_dict.txt', 'dict.txt'],
];
const ocrDir = path.join(libDir, 'ocr');
fs.mkdirSync(ocrDir, { recursive: true });

async function vendorModels() {
  for (const [url, name] of models) {
    const dest = path.join(ocrDir, name);
    if (fs.existsSync(dest)) {
      console.log(`ocr/${name} already present, skipping download`);
      continue;
    }
    console.log(`downloading ${url} -> lib/ocr/${name}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to download ${name} (HTTP ${res.status})`);
    fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  }
}

vendorModels().catch((err) => {
  console.error(err.message);
  console.error('OCR models could not be vendored — run `npm run vendor` again once you have network access.');
  process.exit(1);
});