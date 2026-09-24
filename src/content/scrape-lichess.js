import { SAN_RE } from '../common/constants.js';

const ROLES = { pawn: 'p', knight: 'n', bishop: 'b', rook: 'r', queen: 'q', king: 'k' };


export function findBoard() {
  return document.querySelector('.cg-wrap');
}

// Chessground positions pieces with translate(Xpx, Ypx) relative to the rendered
// (orientation-dependent) top-left corner of the board.
function squareAt(el, squareSize, orientation) {
  const m = /translate\((-?[\d.]+)px(?:,\s*(-?[\d.]+)px)?\)/.exec(el.style.transform);
  if (!m) return null;
  const col = Math.round(parseFloat(m[1]) / squareSize);
  const row = Math.round(parseFloat(m[2] || '0') / squareSize);
  if (col < 0 || col > 7 || row < 0 || row > 7) return null;
  return orientation === 'black'
    ? { file: 7 - col, rank: row }
    : { file: col, rank: 7 - row };
}

export function scrape(wrap) {
  const boardEl = wrap.querySelector('cg-board') || wrap;
  const orientation = wrap.classList.contains('orientation-black') ? 'black' : 'white';
  const squareSize = boardEl.getBoundingClientRect().width / 8;
  const pieces = [];
  for (const el of boardEl.querySelectorAll('piece')) {
    if (el.classList.contains('ghost') || el.classList.contains('fading')) continue;
    const sq = squareAt(el, squareSize, orientation);
    if (!sq) continue;
    const role = [...el.classList].find((c) => ROLES[c]);
    if (!role) continue;
    pieces.push({ ...sq, color: el.classList.contains('white') ? 'w' : 'b', type: ROLES[role] });
  }
  const lastMove = [];
  for (const el of boardEl.querySelectorAll('square.last-move')) {
    const sq = squareAt(el, squareSize, orientation);
    if (sq) lastMove.push(sq);
  }
  const dragging = !!boardEl.querySelector('piece.dragging');
  return { pieces, orientation, sans: scrapeMoveList(), lastMove, dragging };
}

function sanText(el) {
  const clone = el.cloneNode(true);
  for (const child of clone.querySelectorAll('eval, glyph, index')) child.remove();
  return clone.textContent.trim();
}

function scrapeMoveList() {
  // Analysis/study/puzzle pages: stable tree view, mainline only (skip variation subtrees).
  const tview = [...document.querySelectorAll('.tview2 move')]
    .filter((el) => !el.closest('lines, interrupt'))
    .map(sanText)
    .filter((t) => SAN_RE.test(t));
  if (tview.length) return tview;
  // Game pages: lichess rotates the move-list tag/class names, so find the SAN
  // moves structurally — the parent element with the most SAN-shaped leaf children.
  const counts = new Map();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  for (let el = walker.nextNode(); el; el = walker.nextNode()) {
    if (el.childElementCount || el.closest('.cg-wrap')) continue;
    const t = el.textContent.trim();
    if (t.length >= 2 && t.length <= 7 && SAN_RE.test(t) && el.parentElement) {
      counts.set(el.parentElement, (counts.get(el.parentElement) || 0) + 1);
    }
  }
  let best = null;
  let bestCount = 0;
  for (const [parent, count] of counts) {
    if (count > bestCount) {
      best = parent;
      bestCount = count;
    }
  }
  if (!best) return [];
  return [...best.children].map((c) => c.textContent.trim()).filter((t) => SAN_RE.test(t));
}
