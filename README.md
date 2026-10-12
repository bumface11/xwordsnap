# xwordsnap
Mobile PWA: photograph an empty crossword grid, detect cells (no AI/OCR), and open it in html5-crossword-solver via a serialized URL

## Develop

```sh
npm install   # installs pinned deps (package-lock.json) and vendors libs into lib/
npm start     # serve on http://localhost:8080
```

Libraries are pinned in `package.json` / `package-lock.json` and copied into
`lib/` by `scripts/vendor.js` (runs on `postinstall`):

- `@techstark/opencv-js` â€” grid detection pipeline (port of xwordscan steps 1â€“5)
- `onnxruntime-web` + PP-OCR (PaddleOCR) ONNX models — offline clue OCR (`lib/ocr/`, fetched by `npm run vendor`)
- `html5-crossword-solver` (git, pinned commit) â€” `JSCrossword` serialization for share URLs

## Layout

- `index.html` â€” camera capture, review, and share flow
- `js/detect.js` â€” OpenCV.js grid detection (preprocess â†’ bbox â†’ size â†’ cell classify)
- `js/puzzle.js` â€” build `JSCrossword` + generate solver share URL
- `js/app.js` â€” UI wiring + service worker registration
- `sw.js` / `manifest.json` â€” PWA shell (cache-first; bump `CACHE_NAME` on deploy)
- `scripts/` â€” vendoring, icon generation, and the dev server
