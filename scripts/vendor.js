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
  ['node_modules/tesseract.js/dist/tesseract.min.js', 'lib/tesseract.min.js'],
  ['node_modules/tesseract.js/dist/worker.min.js', 'lib/worker.min.js'],
  // Only the LSTM-only wasm cores are needed since the app always initializes
  // with oem=1 (LSTM). All three SIMD tiers are required so tesseract.js's
  // feature detection can pick the right one at runtime.
  ['node_modules/tesseract.js-core/tesseract-core-lstm.wasm.js', 'lib/tesseract-core-lstm.wasm.js'],
  ['node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js', 'lib/tesseract-core-simd-lstm.wasm.js'],
  ['node_modules/tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js', 'lib/tesseract-core-relaxedsimd-lstm.wasm.js'],
];

for (const [src, dest] of files) {
  const from = path.join(root, src);
  const to = path.join(root, dest);
  if (!fs.existsSync(from)) {
    console.error(`Missing ${src} — run npm install first.`);
    process.exit(1);
  }
  fs.copyFileSync(from, to);
  console.log(`vendored ${src} -> ${dest}`);
}

// English traineddata isn't published to npm — fetch it once from the same
// jsDelivr CDN tesseract.js itself defaults to, and cache it in lib/.
const LANG_URL = 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz';
const langDest = path.join(libDir, 'eng.traineddata.gz');

async function vendorLangData() {
  if (fs.existsSync(langDest)) {
    console.log('eng.traineddata.gz already present, skipping download');
    return;
  }
  console.log(`downloading ${LANG_URL} -> lib/eng.traineddata.gz`);
  const res = await fetch(LANG_URL);
  if (!res.ok) throw new Error(`Failed to download eng.traineddata.gz (HTTP ${res.status})`);
  fs.writeFileSync(langDest, Buffer.from(await res.arrayBuffer()));
  console.log('vendored eng.traineddata.gz');
}

vendorLangData().catch((err) => {
  console.error(err.message);
  console.error('OCR language data could not be vendored — run `npm run vendor` again once you have network access.');
  process.exit(1);
});
