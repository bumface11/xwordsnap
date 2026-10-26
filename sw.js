const CACHE_NAME = 'xwordsnap-v37'; // bump on every deploy (same rule as the solver)
const ASSETS = [
  './', './index.html', './manifest.json', './css/app.css',
  './js/app.js', './js/detect.js', './js/puzzle.js', './js/clues.js', './js/autoboxes.js',
  './lib/jscrossword_combined.js', './lib/opencv.js',
  './js/ocr.js', './lib/ort.wasm.min.js', './lib/ort-wasm-simd-threaded.mjs',
  './lib/ort-wasm-simd-threaded.wasm', './lib/ocr/det.onnx', './lib/ocr/rec.onnx', './lib/ocr/dict.txt',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-512-maskable.png'
];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS)));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(names => Promise.all(names.map(n => n !== CACHE_NAME && caches.delete(n))))
    .then(() => clients.claim()));
});
self.addEventListener('fetch', e => {
  e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request)));
});
