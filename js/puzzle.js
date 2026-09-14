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

function buildPuzzle(rows, cols, blackCells, title = 'Scanned Crossword', clueText = null) {
  const acrossText = (clueText && clueText.across) || {};
  const downText = (clueText && clueText.down) || {};
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
          const wordId = `${cell.number}-across`;
          words.push({ id: wordId, cells: wordCells });
          across.clue.push({ word: wordId, number: cell.number, text: acrossText[cell.number] || '---' });
        }
        if (startsDown) {
          const wordCells = [];
          for (let rr = r; !isBlock(rr, c); rr++) wordCells.push([c, rr]);
          const wordId = `${cell.number}-down`;
          words.push({ id: wordId, cells: wordCells });
          down.clue.push({ word: wordId, number: cell.number, text: downText[cell.number] || '---' });
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

// Builds a plain ipuz v2 object (https://www.ipuz.org/) straight from the
// detected grid, for debugging the structure independent of the solver's
// own LZ-string encoding. No solution letters are known yet, so the
// "solution" section is omitted — only shape + clue numbering + clue text.
function buildIpuz(rows, cols, blackCells, title = 'Scanned Crossword', clueText = null) {
  const acrossText = (clueText && clueText.across) || {};
  const downText = (clueText && clueText.down) || {};
  const isBlock = (r, c) =>
    r < 0 || c < 0 || r >= rows || c >= cols || blackCells[r][c];

  const puzzleGrid = [];
  const acrossClues = [];
  const downClues = [];
  let clueNum = 1;

  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < cols; c++) {
      if (blackCells[r][c]) {
        row.push('#');
        continue;
      }
      const startsAcross = isBlock(r, c - 1) && !isBlock(r, c + 1);
      const startsDown = isBlock(r - 1, c) && !isBlock(r + 1, c);
      if (startsAcross || startsDown) {
        const number = clueNum++;
        row.push(number);
        if (startsAcross) acrossClues.push([number, acrossText[String(number)] || '']);
        if (startsDown) downClues.push([number, downText[String(number)] || '']);
      } else {
        row.push(0);
      }
    }
    puzzleGrid.push(row);
  }

  return {
    version: 'http://ipuz.org/v2',
    kind: ['http://ipuz.org/crossword#1'],
    dimensions: { width: cols, height: rows },
    title,
    puzzle: puzzleGrid,
    clues: { Across: acrossClues, Down: downClues },
  };
}