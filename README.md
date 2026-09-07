# xwordsnap
Mobile PWA: photograph an empty crossword grid, detect cells (no AI/OCR), and open it in html5-crossword-solver via a serialized URL

## Develop

```sh
npm install   # installs pinned deps (package-lock.json) and vendors libs into lib/
npm start     # serve on http://localhost:8080
```

Libraries are pinned in `package.json` / `package-lock.json` and copied into
`lib/` by `scripts/vendor.js` (runs on `postinstall`):

- `@techstark/opencv-js` — grid detection pipeline (port of xwordscan steps 1–5)
- `html5-crossword-solver` (git, pinned commit) — `JSCrossword` serialization for share URLs

## Layout

- `index.html` — camera capture, review, and share flow
- `js/detect.js` — OpenCV.js grid detection (preprocess → bbox → size → cell classify)
- `js/puzzle.js` — build `JSCrossword` + generate solver share URL
- `js/app.js` — UI wiring + service worker registration
- `sw.js` / `manifest.json` — PWA shell (cache-first; bump `CACHE_NAME` on deploy)
- `scripts/` — vendoring, icon generation, and the dev server
