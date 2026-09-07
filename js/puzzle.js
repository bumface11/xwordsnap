/* global JSCrossword */
// Builds a JSCrossword from detected grid data (mirrors xwordscan.build_puz)
// and produces a solver share URL (mirrors sharePuzzle() in src/export.js).
//
// Shapes match what jscrossword's own parsers produce:
//   metadata: { title, author, copyright, description, height, width, crossword_type }
//   cell:     { x, y, solution, number, type: 'block'|null, value, letter,
//               'background-color', 'background-shape', top_right_number, is_void, clue }
//   word:     { id, cells: [[x, y], ...] }
//   clues:    [{ title, clue: [{ word, number, text }] }]

// Point this at your deployed copy of html5-crossword-solver:
const SOLVER_BASE = 'https://bumface11.github.io/html5-crossword-solver/index.html';

function buildPuzzle(rows, cols, blackCells, title = 'Scanned Crossword') {
  const cells = [];
  const words = [];
  const across = { title: 'Across', clue: [] };
  const down = { title: 'Down', clue: [] };
  let clueNum = 1;

  // Standard numbering, ported from xwordscan.build_puz
  const isBlock = (r, c) =>
    r < 0 || c < 0 || r >= rows || c >= cols || blackCells[r][c];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = {
        x: c, y: r, solution: null, number: null, type: null,
        letter: null, value: null, 'background-color': null,
        'background-shape': null, top_right_number: null, is_void: false, clue: null,
      };
      if (blackCells[r][c]) {
        cell.type = 'block';
        cells.push(cell);
        continue;
      }
      cell.solution = '-';   // unknown — user fills in the solver
      const startsAcross = isBlock(r, c - 1) && !isBlock(r, c + 1);
      const startsDown = isBlock(r - 1, c) && !isBlock(r + 1, c);
      if (startsAcross || startsDown) {
        cell.number = String(clueNum++);
        if (startsAcross) {
          const wordCells = [];
          for (let cc = c; !isBlock(r, cc); cc++) wordCells.push([cc, r]);
          words.push({ id: cell.number, cells: wordCells });
          across.clue.push({ word: cell.number, number: cell.number, text: '---' });
        }
        if (startsDown) {
          const wordCells = [];
          for (let rr = r; !isBlock(rr, c); rr++) wordCells.push([c, rr]);
          words.push({ id: cell.number, cells: wordCells });
          down.clue.push({ word: cell.number, number: cell.number, text: '---' });
        }
      }
      cells.push(cell);
    }
  }

  const xw = new JSCrossword(
    {
      title, author: '', copyright: '', description: '',
      height: rows, width: cols, crossword_type: 'crossword',
    },
    cells,
    words,
    [across, down]
  );
  return xw;
}

function shareUrlFor(xw) {
  const encoded = xw.serialize();   // LZ-string, URI-safe — same as sharePuzzle()
  return `${SOLVER_BASE}#${encoded}`;
}
