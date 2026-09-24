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

// evaluate(fen, legalUcis, turn, ep) -> Promise<{priors: Map<uci, prob>, value: number}>.
// ep: en passant square as training sets it (see epAfter); the ep option gives the root's.
// history: game FENs since the last capture or pawn move. A position repeating one of
// them, or one earlier on the same line, scores as a draw (twofold: the repeating side
// can force the threefold), so a winning side avoids repetition and a losing side seeks it.
// A mate at the root is played at once (visit counts can outvote a proven mate), and a mate
// found deeper loses matePenalty per ply, so a shorter mate outranks a longer one.
// Returns {uci, visits, q} for the most-visited root move, or null if cancelled.
export async function runMcts(fen, evaluate, sims,
  { cPuct = 1.5, fpuReduction = 0.2, matePenalty = 0.005, isCancelled = () => false, history = [], ep = fen.split(' ')[3] } = {}) {
  const past = new Set(history.map(positionKey));
  past.add(positionKey(fen));
  const root = new Node(0, fen, ep);
  const chess = new Chess(fen);
  const moves = chess.moves({ verbose: true });
  const mate = moves.find((m) => m.san.endsWith('#')); // chess.js marks mate in SAN
  if (mate) return { uci: toUci(mate), visits: 1, q: 1.0 };
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
