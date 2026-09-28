import { Chess } from 'chess.js';
import { epAfter } from './encoding.js';

// PUCT MCTS mirroring the training harness's search (play mode: no Dirichlet
// noise, no temperature). Nodes store the child FEN (chess.js Move.after), so each
// sim replays from a fresh Chess(fen). A fresh Chess has no move history, so a
// repetition can't be seen at the leaf; it is detected along the path instead.

class Node {
  constructor(prior, fen, ep) {
    this.prior = prior;
    this.fen = fen;
    this.ep = ep;
    this.children = null;
    this.n = 0;
    this.w = 0;
  }

  get q() {
    return this.n ? this.w / this.n : 0;
  }
}

// True macrotask yield. ORT's single-thread WASM run() settles without leaving the
// current task, so a bare await never lets queued chrome.runtime messages dispatch;
// MessageChannel gives a real macrotask boundary without setTimeout's nested 4 ms clamp.
function breathe() {
  return new Promise((resolve) => {
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = () => {
      port1.close();
      resolve();
    };
    port2.postMessage(null);
  });
}

const toUci = (m) => m.from + m.to + (m.promotion || '');

// Placement, side to move, castling and en passant: what makes two positions the same
// for repetition. chess.js fen() prints en passant only when the capture is legal.
const positionKey = (fen) => fen.split(' ').slice(0, 4).join(' ');

// PUCT with FPU reduction, mirroring mcts.py::_select. Without it an unvisited child
// scores q = 0, which outranks every explored child whenever the parent is worse than a
// draw, so the search fans out over all legal moves instead of deepening.
export function select(node, cPuct, fpuReduction) {
  const sqrtN = Math.sqrt(node.n);
  let exploredPrior = 0;
  for (const child of node.children.values()) if (child.n) exploredPrior += child.prior;
  // node.q is already in this node's perspective (children are negated, it is not)
  const fpu = node.q - fpuReduction * Math.sqrt(exploredPrior);
  const bonus = cPuct * sqrtN;
  let best = null;
  let bestScore = -Infinity;
  for (const child of node.children.values()) {
    const q = child.n ? -child.w / child.n : fpu;
    const score = q + bonus * child.prior / (1 + child.n);
    if (score > bestScore) {
      bestScore = score;
      best = child;
    }
  }
  return best;
}

function expand(node, moves, priors) {
  node.children = new Map();
  for (const m of moves) {
    const uci = toUci(m);
    node.children.set(uci, new Node(priors.get(uci), m.after, epAfter(m)));
  }
}

function backup(path, value) {
  for (let i = path.length - 1; i >= 0; i--) {
    path[i].n += 1;
    path[i].w += value;
    value = -value;
  }
}

// Exact forced-mate search, used because the tree plays a mate in 2 or 3 it has already proven only
// about a third of the time: visit counts outvote it. Our plies try checks only. That is what makes
// it cheap - a couple of hundred nodes at worst instead of millions - and also what makes it
// incomplete: a mate whose key move is quiet is missed. It is never wrong in the other direction,
// because it plays out the mate before claiming it.
//
// These walk one board with move/undo and read check and mate off plain SAN. Building a fresh Chess
// per node and asking for verbose moves is the obvious way to write it and measured 3.8x slower,
// which matters because the worst positions for this are the check-heavy ones.

// Every reply to the check just played runs into a mate within `plies`.
function repliesAllMated(board, plies, budget) {
  const replies = board.moves();
  // no replies would make every() vacuously true, i.e. claim a mate without one
  return replies.length > 0 && replies.every((reply) => {
    board.move(reply);
    const mated = forcesMate(board, plies, budget);
    board.undo();
    return mated;
  });
}

// budget is shared across the whole recursion; running out reads as "no mate" and falls through to
// the search, so the cap can only cost a missed mate, never a wrong move.
function forcesMate(board, plies, budget) {
  if (budget.n <= 0) return false;
  budget.n -= 1;
  const moves = board.moves();
  if (moves.some((san) => san.endsWith('#'))) return true; // chess.js marks mate in SAN
  if (plies < 3) return false;
  for (const san of moves) {
    if (!san.endsWith('+')) continue;
    board.move(san);
    const forced = repliesAllMated(board, plies - 2, budget);
    board.undo();
    if (forced) return true;
  }
  return false;
}

// The move that forces mate within `plies`, or null. Separate from forcesMate only because the root
// needs to know which move it is, not just that one exists.
function findMate(chess, plies, budget) {
  const moves = chess.moves({ verbose: true });
  const mate = moves.find((m) => m.san.endsWith('#'));
  if (mate) return mate;
  if (plies < 3) return null;
  const board = new Chess(chess.fen());
  for (const m of moves) {
    if (!m.san.endsWith('+')) continue;
    board.move(m.san);
    const forced = repliesAllMated(board, plies - 2, budget);
    board.undo();
    if (forced) return m;
  }
  return null;
}

// Allowing mate in 1 is never better than the alternative, so those moves are dropped before the net
// scores the root and the priors renormalise over what is left. If every move allows it the position
// is lost anyway and the search still needs something to return.
function safeMoves(moves) {
  const safe = moves.filter((m) => !new Chess(m.after).moves().some((san) => san.endsWith('#')));
  return safe.length ? safe : moves;
}

// evaluate(fen, legalUcis, turn, ep) -> Promise<{priors: Map<uci, prob>, value: number}>.
// ep: en passant square as training sets it (see epAfter); the ep option gives the root's.
// history: game FENs since the last capture or pawn move. A position repeating one of
// them, or one earlier on the same line, scores as a draw (twofold: the repeating side
// can force the threefold), so a winning side avoids repetition and a losing side seeks it.
// A forced mate within mateDepth plies is played at once (see findMate), and a mate the tree finds
// deeper loses matePenalty per ply, so a shorter mate outranks a longer one.
// Returns {uci, visits, q} for the most-visited root move, or null if cancelled.
export async function runMcts(fen, evaluate, sims,
  { cPuct = 1.5, fpuReduction = 0.2, matePenalty = 0.005, mateDepth = 5, mateBudget = 400,
    isCancelled = () => false, history = [], ep = fen.split(' ')[3] } = {}) {
  const past = new Set(history.map(positionKey));
  past.add(positionKey(fen));
  const root = new Node(0, fen, ep);
  const chess = new Chess(fen);
  const mate = findMate(chess, mateDepth, { n: mateBudget });
  if (mate) return { uci: toUci(mate), visits: 1, q: 1.0 };
  const moves = safeMoves(chess.moves({ verbose: true }));
  const rootEval = await evaluate(fen, moves.map(toUci), chess.turn(), ep);
  expand(root, moves, rootEval.priors);
  backup([root], rootEval.value);
  for (let i = 1; i < sims; i++) {
    await breathe();
    if (isCancelled()) return null;
    let node = root;
    const path = [root];
    const seen = new Set();
    let draw = false;
    while (node.children) {
      node = select(node, cPuct, fpuReduction);
      path.push(node);
      const key = positionKey(node.fen);
      if (past.has(key) || seen.has(key)) {
        draw = true;
        break;
      }
      seen.add(key);
    }
    if (draw) {
      backup(path, 0.0);
      continue;
    }
    const leaf = new Chess(node.fen);
    const leafMoves = leaf.moves({ verbose: true });
    let value;
    if (!leafMoves.length) {
      // a mate further from the root is worth less, so the shorter mate wins
      value = leaf.isCheckmate() ? -(1.0 - matePenalty * (path.length - 1)) : 0.0;
    } else if (leaf.isDraw()) {
      value = 0.0;
    } else {
      const { priors, value: v } = await evaluate(node.fen, leafMoves.map(toUci), leaf.turn(), node.ep);
      expand(node, leafMoves, priors);
      value = v;
    }
    backup(path, value);
  }
  if (isCancelled()) return null;
  let bestUci = null;
  let best = null;
  for (const [uci, child] of root.children) {
    if (!best || child.n > best.n) {
      bestUci = uci;
      best = child;
    }
  }
  return { uci: bestUci, visits: best.n, q: root.q };
}
