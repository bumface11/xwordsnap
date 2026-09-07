// Minimal static file server for local dev: `npm start` then open http://localhost:8080
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const port = process.env.PORT || 8080;
const types = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.wasm': 'application/wasm',
};

http.createServer((req, res) => {
  let file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (file.endsWith(path.sep)) file = path.join(file, 'index.html');
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(port, () => console.log(`Serving on http://localhost:${port}`));
