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
