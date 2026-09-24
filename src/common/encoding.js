import { NUM_PLANES, DIRECTIONS, KNIGHT_OFFSETS, UNDERPROMOTIONS } from './constants.js';

const PIECE_TYPES = 'pnbrqk';

// python-chess sets ep_square after every double push, capturable or not; training encodes that.
export const epAfter = (m) => m.flags.includes('b') ? m.from[0] + (m.color === 'w' ? '3' : '6') : '-';

// FEN -> Float32Array(18*8*8), flat [plane][rank][file], from the side-to-move's
// perspective (board mirrored vertically for black). Planes: 0-5 my P N B R Q K,
// 6-11 theirs, 12 white-to-move, 13-16 castling (my K/Q, their K/Q), 17 ep file.
export function fenToPlanes(fen, ep = fen.split(' ')[3]) {
  const [placement, turn, castling] = fen.split(' ');
  const planes = new Float32Array(NUM_PLANES * 64);
  const flip = turn === 'b';
  let rank = 7;
  let file = 0;
  for (const ch of placement) {
    if (ch === '/') {
      rank--;
      file = 0;
    } else if (ch >= '1' && ch <= '8') {
      file += Number(ch);
    } else {
      const mine = (ch === ch.toLowerCase()) === flip;
      const plane = (mine ? 0 : 6) + PIECE_TYPES.indexOf(ch.toLowerCase());
      const r = flip ? 7 - rank : rank;
      planes[plane * 64 + r * 8 + file] = 1;
      file++;
    }
  }
  if (turn === 'w') planes.fill(1, 12 * 64, 13 * 64);
  const letters = turn === 'w' ? ['K', 'Q', 'k', 'q'] : ['k', 'q', 'K', 'Q'];
  letters.forEach((letter, i) => {
    if (castling.includes(letter)) planes.fill(1, (13 + i) * 64, (14 + i) * 64);
  });
  if (ep !== '-') {
    const f = ep.charCodeAt(0) - 97;
    for (let r = 0; r < 8; r++) planes[17 * 64 + r * 8 + f] = 1;
  }
  return planes;
}

// UCI move -> policy index (from_square * 73 + move_plane), mirrored for black.
function moveToPolicyIndex(uci, turn) {
  const ff = uci.charCodeAt(0) - 97;
  let fr = uci.charCodeAt(1) - 49;
  const tf = uci.charCodeAt(2) - 97;
  let tr = uci.charCodeAt(3) - 49;
  const promo = uci[4];
  if (turn === 'b') {
    fr = 7 - fr;
    tr = 7 - tr;
  }
  const df = tf - ff;
  const dr = tr - fr;
  let plane;
  const knight = KNIGHT_OFFSETS.findIndex(([a, b]) => a === df && b === dr);
  if (promo && promo !== 'q') {
    plane = 64 + UNDERPROMOTIONS.indexOf(promo) * 3 + (df + 1);
  } else if (knight >= 0) {
    plane = 56 + knight;
  } else {
    const dir = DIRECTIONS.findIndex(([a, b]) => a === Math.sign(df) && b === Math.sign(dr));
    plane = dir * 7 + Math.max(Math.abs(df), Math.abs(dr)) - 1;
  }
  return (fr * 8 + ff) * 73 + plane;
}

// Softmax of the policy over legal moves only -> Map<uci, prob> (mirrors
// make_batch_evaluator in the training harness).
export function policyPriors(policy, legalUcis, turn) {
  const logits = legalUcis.map((uci) => policy[moveToPolicyIndex(uci, turn)]);
  const max = Math.max(...logits);
  let sum = 0;
  const exps = logits.map((l) => {
    const e = Math.exp(l - max);
    sum += e;
    return e;
  });
  return new Map(legalUcis.map((uci, i) => [uci, exps[i] / sum]));
}

// Argmax of the policy over legal moves only.
export function pickBestMove(policy, legalUcis, turn) {
  let best = null;
  let bestScore = -Infinity;
  for (const uci of legalUcis) {
    const score = policy[moveToPolicyIndex(uci, turn)];
    if (score > bestScore) {
      bestScore = score;
      best = uci;
    }
  }
  return best;
}
