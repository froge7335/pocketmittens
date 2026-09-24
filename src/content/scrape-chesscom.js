import { SAN_RE } from '../common/constants.js';

// Every chess.com selector lives here — when their DOM churns, fix it in one place.
export const SELECTORS = {
  board: 'wc-chess-board, chess-board',
  piece: '.piece',
  pieceClass: /^(w|b)([pnbrqk])$/,
  squareClass: /^square-([1-8])([1-8])$/, // square-<file><rank>, 1-based, white's frame
  flippedClass: 'flipped',
  moveList: 'wc-simple-move-list, wc-move-list',
  moveNode: '.node.main-line-ply .node-highlight-content',
  figurine: '[data-figurine]',
  highlight: '.highlight',
};


export function findBoard() {
  return document.querySelector(SELECTORS.board);
}

function squareFromClasses(el) {
  for (const cls of el.classList) {
    const m = SELECTORS.squareClass.exec(cls);
    if (m) return { file: Number(m[1]) - 1, rank: Number(m[2]) - 1 };
  }
  return null;
}

export function scrape(board) {
  const orientation = board.classList.contains(SELECTORS.flippedClass) ? 'black' : 'white';
  const pieces = [];
  for (const el of board.querySelectorAll(SELECTORS.piece)) {
    const sq = squareFromClasses(el);
    if (!sq) continue;
    for (const cls of el.classList) {
      const m = SELECTORS.pieceClass.exec(cls);
      if (m) {
        pieces.push({ ...sq, color: m[1], type: m[2] });
        break;
      }
    }
  }
  const lastMove = [];
  for (const el of board.querySelectorAll(SELECTORS.highlight)) {
    const sq = squareFromClasses(el);
    if (sq) lastMove.push(sq);
  }
  return { pieces, orientation, sans: scrapeMoveList(), lastMove };
}

function scrapeMoveList() {
  const list = document.querySelector(SELECTORS.moveList);
  if (!list) return [];
  const sans = [];
  for (const node of list.querySelectorAll(SELECTORS.moveNode)) {
    // Piece letter is rendered as an icon carrying data-figurine; the text holds the rest.
    const figurine = node.querySelector(SELECTORS.figurine);
    const san = (figurine ? figurine.getAttribute('data-figurine') : '') + node.textContent.trim();
    if (SAN_RE.test(san)) sans.push(san);
  }
  return sans;
}
