/* global JSCrossword */
// Builds a JSCrossword from detected grid data (mirrors xwordscan.build_puz)
// and produces a solver share URL (mirrors sharePuzzle() in src/export.js).

// Point this at your deployed copy of html5-crossword-solver:
const SOLVER_BASE = 'https://bumface11.github.io/html5-crossword-solver/index.html';

function buildPuzzle(rows, cols, blackCells, title = 'Scanned Crossword') {
  const cells = [];
  let clueNum = 1;
  const acrossClues = [], downClues = [];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (blackCells[r][c]) {
        cells.push({ x: c, y: r, type: 'block' });
        continue;
      }
      // Standard numbering, ported from xwordscan.build_puz
      const startsAcross = (c === 0 || blackCells[r][c - 1]) &&
                           c + 1 < cols && !blackCells[r][c + 1];
      const startsDown = (r === 0 || blackCells[r - 1][c]) &&
                         r + 1 < rows && !blackCells[r + 1][c];
      let number = null;
      if (startsAcross || startsDown) {
        number = String(clueNum++);
        if (startsAcross) acrossClues.push({ word: number, number, text: '---' });
        if (startsDown) downClues.push({ word: number, number, text: '---' });
      }
      cells.push({ x: c, y: r, solution: '-', number });
    }
  }

  const xw = new JSCrossword(
    { title, author: '', width: cols, height: rows, kind: 'crossword' },
    cells,
    null,
    [
      { title: 'Across', clues: acrossClues },
      { title: 'Down', clues: downClues }
    ]
  );
  return xw;
}

function shareUrlFor(xw) {
  const encoded = xw.serialize();   // LZ-string, URI-safe — same as sharePuzzle()
  return `${SOLVER_BASE}#${encoded}`;
}
