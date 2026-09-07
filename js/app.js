/* global detectGrid, buildPuzzle, shareUrlFor, whenCvReady */
let detection = null;

// Show "Ready." once the OpenCV WASM runtime has finished initializing
whenCvReady().then(() => {
  document.getElementById('status').textContent = 'Ready.';
});

document.getElementById('camera').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const status = document.getElementById('status');
  status.textContent = 'Detecting grid…';
  const img = document.getElementById('photo');
  img.src = URL.createObjectURL(file);
  await img.decode();

  // Downscale for speed — detection doesn't need full camera resolution
  const canvas = document.createElement('canvas');
  const scale = Math.min(1, 1200 / img.naturalWidth);
  canvas.width = img.naturalWidth * scale;
  canvas.height = img.naturalHeight * scale;
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);

  try {
    detection = await detectGrid(canvas);   // js/detect.js
    renderReview();
    document.getElementById('review').hidden = false;
    document.getElementById('result').hidden = true;
    status.textContent = 'Tap cells to fix mistakes, then share.';
  } catch (err) {
    status.textContent = '⚠️ ' + err.message;
  }
});

function renderReview() {
  const { rows, cols, blackCells } = detection;
  document.getElementById('dims').textContent = `${rows} × ${cols} grid`;
  const preview = document.getElementById('gridPreview');
  preview.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  preview.innerHTML = '';
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const cell = document.createElement('button');
    cell.className = 'cell' + (blackCells[r][c] ? ' block' : '');
    cell.onclick = () => {
      blackCells[r][c] = !blackCells[r][c];
      cell.classList.toggle('block');
    };
    preview.appendChild(cell);
  }
}

document.getElementById('shareBtn').addEventListener('click', () => {
  const { rows, cols, blackCells } = detection;
  const title = document.getElementById('title').value.trim() || 'Scanned Crossword';
  const xw = buildPuzzle(rows, cols, blackCells, title);
  const url = shareUrlFor(xw);
  document.getElementById('shareLink').value = url;
  document.getElementById('openBtn').href = url;
  document.getElementById('result').hidden = false;
});

document.getElementById('copyBtn').addEventListener('click', () =>
  navigator.clipboard.writeText(document.getElementById('shareLink').value));

// PWA registration (same pattern as the solver's index.html)
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
