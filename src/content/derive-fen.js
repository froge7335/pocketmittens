import { Chess } from 'chess.js';
import { epAfter } from '../common/encoding.js';

function placementOf(pieces) {
  const grid = Array.from({ length: 8 }, () => Array(8).fill(null));
  for (const p of pieces) {
    grid[p.rank][p.file] = p.color === 'w' ? p.type.toUpperCase() : p.type;
  }
  const ranks = [];
  for (let rank = 7; rank >= 0; rank--) {
    let row = '';
    let empty = 0;
    for (let file = 0; file < 8; file++) {
      const piece = grid[rank][file];
      if (!piece) {
        empty++;
      } else {
        if (empty) row += empty;
        empty = 0;
        row += piece;
      }
    }
    if (empty) row += empty;
    ranks.push(row);
  }
  return ranks.join('/');
}

// Game positions up to ply i that can still recur: those since the last capture or
// pawn move, which the halfmove clock (5th FEN field) counts.
function recurrable(fens, i) {
  const clock = Number(fens[i].split(' ')[4]) || 0;
  return fens.slice(Math.max(0, i - clock), i + 1);
}

// Primary: replay the SAN move list (exact FEN), reconciling against the raw piece
// scrape so scroll-back resolves to the ply actually on screen. Fallback: build an
// approximate FEN from the raw scrape alone, with no history.
// Returns { fen, history, ep }; history feeds the search's repetition detection, ep is the
// training-convention en passant square (fallback omits it: its FEN already has that square).
// fen is null when no position can be derived, including when the fallback cannot tell whose
// turn it is — the caller clears the overlay rather than showing an arrow.
export function deriveFen({ pieces, sans, lastMove }) {
  if (sans && sans.length) {
    const chess = new Chess();
    const fens = [chess.fen()];
    const eps = ['-'];
    let ok = true;
    for (const san of sans) {
      let move;
      try {
        move = chess.move(san);
      } catch {
        ok = false;
        break;
      }
      fens.push(chess.fen());
      eps.push(epAfter(move));
    }
    if (ok) {
      const last = fens.length - 1;
      if (!pieces || !pieces.length) return { fen: fens[last], history: recurrable(fens, last), ep: eps[last] };
      const scraped = placementOf(pieces);
      for (let i = last; i >= 0; i--) {
        if (fens[i].split(' ')[0] === scraped) return { fen: fens[i], history: recurrable(fens, i), ep: eps[i] };
      }
    }
  }
  return { fen: fallbackFen({ pieces, lastMove }), history: [] };
}

function fallbackFen({ pieces, lastMove }) {
  if (!pieces || !pieces.length) return null;
  const at = new Map(pieces.map((p) => [p.file * 8 + p.rank, p]));
  const piece = (file, rank) => at.get(file * 8 + rank);
  const is = (file, rank, color, type) => {
    const p = piece(file, rank);
    return p && p.color === color && p.type === type;
  };
  // The side to move can only be read off the last-move highlight. Guessing it produces a
  // legal FEN for the wrong player, so the arrow and eval label are confidently backwards
  // with nothing to signal it; no arrow is strictly better. Undeterminable when the site
  // draws no highlight (a FEN URL with no moves yet) or draws extra ones (chess.com reuses
  // the highlight class for user-marked squares).
  let turn = null;
  let ep = '-';
  if (lastMove && lastMove.length === 2) {
    const occupied = lastMove.filter((sq) => piece(sq.file, sq.rank));
    if (occupied.length === 1) {
      const to = occupied[0];
      const from = lastMove.find((sq) => sq !== to);
      const mover = piece(to.file, to.rank);
      turn = mover.color === 'w' ? 'b' : 'w';
      if (mover.type === 'p' && from.file === to.file && Math.abs(from.rank - to.rank) === 2) {
        ep = String.fromCharCode(97 + to.file) + ((from.rank + to.rank) / 2 + 1);
      }
    }
  }
  if (!turn) return null;
  let castling = '';
  if (is(4, 0, 'w', 'k')) {
    if (is(7, 0, 'w', 'r')) castling += 'K';
    if (is(0, 0, 'w', 'r')) castling += 'Q';
  }
  if (is(4, 7, 'b', 'k')) {
    if (is(7, 7, 'b', 'r')) castling += 'k';
    if (is(0, 7, 'b', 'r')) castling += 'q';
  }
  const fen = `${placementOf(pieces)} ${turn} ${castling || '-'} ${ep} 0 1`;
  try {
    new Chess(fen);
  } catch {
    return null;
  }
  return fen;
}
