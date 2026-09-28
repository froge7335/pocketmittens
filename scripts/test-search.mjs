// Covers the parts of the extension that can silently produce a wrong answer rather than an
// obvious failure: position derivation, the board encoding the model was trained on, and the
// search. Run: npm test
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import { runMcts, select } from '../src/common/search.js';
import { deriveFen } from '../src/content/derive-fen.js';
import { fenToPlanes } from '../src/common/encoding.js';

const priorsFor = (legalUcis) => new Map(legalUcis.map((u) => [u, 1 / legalUcis.length]));

// Plane 17 (en passant file) of an encoding, and a plane with only file f lit.
const epPlane = (planes) => [...planes.slice(17 * 64, 18 * 64)];
const onlyFile = (f) => Array.from({ length: 64 }, (_, i) => (i % 8 === f ? 1 : 0));

// A constant value would claim whoever is to move is winning, which is self-contradictory:
// the parent and its children would disagree about who is better. Evaluators below are
// consistent, so the parent value FPU inherits means what it says.
const forSide = (winner) => async (fen, legalUcis, turn) => ({
  priors: priorsFor(legalUcis),
  value: turn === winner ? 0.8 : -0.8,
});

const PIECE_VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

// Material from the side to move's view, squashed into (-1, 1).
const byMaterial = async (fen, legalUcis) => {
  const [placement, turn] = fen.split(' ');
  let score = 0;
  for (const ch of placement) {
    const v = PIECE_VALUE[ch.toLowerCase()];
    if (v !== undefined) score += ch === ch.toUpperCase() ? v : -v;
  }
  return { priors: priorsFor(legalUcis), value: Math.tanh((turn === 'w' ? score : -score) / 8) };
};

function replay(sans) {
  const chess = new Chess();
  const fens = [chess.fen()];
  for (const san of sans) {
    chess.move(san);
    fens.push(chess.fen());
  }
  return fens;
}

// What a scraper reports for a position: one entry per piece, rank 0 = rank 1.
const piecesFrom = (fen) => new Chess(fen).board().flatMap((row, i) => row
  .map((sq, file) => sq && { file, rank: 7 - i, color: sq.color, type: sq.type })
  .filter(Boolean));

const round = (x) => Math.round(x * 1e6) / 1e6;

// Puts every prior on one line, so the search walks that line and nothing else, and returns
// value 0, so the only value reaching the root is the mate at the end of it.
function alongLine(fen, sans) {
  const chess = new Chess(fen);
  const forced = new Map();
  for (const san of sans) {
    const m = chess.move(san);
    forced.set(m.before, m.from + m.to + (m.promotion || ''));
  }
  return async (f, legalUcis) => ({
    priors: new Map(legalUcis.map((u) => [u, u === forced.get(f) ? 1 : 0])),
    value: 0,
  });
}

// What the mate ending a forced line backs up, read back off the root: root.n is sims, every
// sim past the sans.length that build the line hits the mate, and backup flips it once per ply.
async function mateValue(fen, sans, sims, options) {
  const { q } = await runMcts(fen, alongLine(fen, sans), sims, options);
  const atRoot = q * sims / (sims - sans.length);
  return sans.length % 2 ? -atRoot : atRoot;
}

const tests = {
  async 'losing side steers into a repetition'() {
    // after 1.Nf3 Nf6 2.Ng1, ...Ng8 returns to the start position
    const history = replay(['Nf3', 'Nf6', 'Ng1']);
    const fen = history[history.length - 1];
    // black is losing everywhere, so the draw at 0 beats every alternative
    const result = await runMcts(fen, forSide('w'), 200, { history });
    assert.equal(result.uci, 'f6g8');
  },

  async 'scroll-back resolves to the ply shown on the board'() {
    // the move list runs to 2.Nf3 but the board displays the position after 1.e4, so the
    // replayed line has to be reconciled backwards against the scraped pieces
    const sans = ['e4', 'e5', 'Nf3'];
    const fens = replay(sans);
    const { fen, history } = deriveFen({ pieces: piecesFrom(fens[1]), sans, lastMove: null });
    assert.equal(fen, fens[1]);
    assert.equal(history[history.length - 1], fens[1]);
  },

  async 'history stops at the last capture or pawn move'() {
    const sans = ['e4', 'd5', 'exd5', 'Nf6', 'Nf3', 'Ng8'];
    const fens = replay(sans);
    const { fen, history } = deriveFen({ pieces: [], sans, lastMove: null });
    assert.equal(fen, fens[fens.length - 1]);
    assert.deepEqual(history, fens.slice(-4)); // halfmove clock 3 -> 4 positions
  },

  // The decision FPU exists to change. The parent is losing (q = -0.8); one child is well
  // explored and confirms it, the other is a move the net dislikes and has never been tried.
  // Without the reduction the untried move wins and the search goes wide and shallow exactly
  // when it can least afford it. The priors are tuned so the two settings disagree -- most
  // values pick the explored line either way, which would make this assert nothing.
  async 'FPU keeps the search on an explored line when the parent is losing'() {
    const mk = (prior, n, w) => ({ prior, n, w, get q() { return this.n ? this.w / this.n : 0; } });
    const explored = mk(0.5, 50, 40);   // -w/n = -0.8 from the parent's view
    const junk = mk(0.015, 0, 0);       // low prior, never visited
    const parent = mk(0, 100, -80);     // q = -0.8
    parent.children = new Map([['explored', explored], ['junk', junk]]);

    assert.equal(select(parent, 1.5, 0.2), explored);
    assert.equal(select(parent, 1.5, 0), junk, 'no reduction: the untried move should win');
  },

  async 'search still finds a winning capture while losing'() {
    // white is down a queen, but Rxd5 wins a rook back
    const fen = 'q3k3/8/8/3r4/8/8/8/3RK3 w - - 0 1';
    const result = await runMcts(fen, byMaterial, 400);
    assert.equal(result.uci, 'd1d5');
  },

  // Visit counts alone can keep a high-prior capture ahead of a mate the search has proven,
  // so a mate at the root skips the search entirely.
  async 'a mate in 1 is played without evaluating anything'() {
    const fen = '6k1/5ppp/8/8/8/8/8/R3K3 w - - 0 1'; // Ra8#
    let calls = 0;
    const evaluate = async () => {
      calls += 1;
      return { priors: new Map(), value: 0 };
    };
    assert.deepEqual(await runMcts(fen, evaluate, 256), { uci: 'a1a8', visits: 1, q: 1.0 });
    assert.equal(calls, 0);
  },

  // Visit counts outvote a mate two or three moves out as well, which the net plays only about a
  // third of the time, so those are answered exactly too and cost no evaluations either.
  async 'a forced mate in 2 is played without evaluating anything'() {
    const fen = '6k1/pp4p1/2p5/2bp4/8/P5Pb/1P3rrP/2BRRN1K b - - 0 1'; // Rg1+ Nxg1 Rxh2#
    let calls = 0;
    const evaluate = async () => {
      calls += 1;
      return { priors: new Map(), value: 0 };
    };
    assert.deepEqual(await runMcts(fen, evaluate, 256), { uci: 'g2g1', visits: 1, q: 1.0 });
    assert.equal(calls, 0);
  },

  async 'a forced mate in 3 is played, and a three-ply budget does not reach it'() {
    const fen = '5rk1/5Npp/8/8/8/8/Q7/K7 w - - 0 1'; // Nh6+ Kh8 Qg8+ Rxg8 Nf7#
    let calls = 0;
    const evaluate = async (f, legalUcis) => {
      calls += 1;
      return { priors: priorsFor(legalUcis), value: 0 };
    };
    assert.deepEqual(await runMcts(fen, evaluate, 256), { uci: 'f7h6', visits: 1, q: 1.0 });
    assert.equal(calls, 0);
    // five plies out, so three plies has to fall through to the search
    await runMcts(fen, evaluate, 8, { mateDepth: 3 });
    assert.ok(calls > 0);
  },

  // The other half of the mate search: it must never claim a mate that is not there.
  async 'a quiet position still reaches the evaluator'() {
    const fen = 'r1bq1rk1/pp2bppp/2n1pn2/3p4/3P4/2N1PN2/PP2BPPP/R1BQ1RK1 w - - 8 10';
    let calls = 0;
    const evaluate = async (f, legalUcis) => {
      calls += 1;
      return byMaterial(f, legalUcis);
    };
    const { uci } = await runMcts(fen, evaluate, 32);
    assert.ok(calls > 0);
    assert.ok(new Chess(fen).moves({ verbose: true }).some((m) => m.from + m.to === uci));
  },

  // Allowing mate in 1 is never better than the alternative, whatever the policy thinks.
  async 'a root move allowing mate in 1 is never played'() {
    const fen = 'r6k/6pp/8/8/8/8/6PP/1R5K w - - 0 1'; // Ra1 hands black Rxa1#
    const wantsIt = async (f, legalUcis) => ({
      priors: new Map(legalUcis.map((u) => [u, u === 'b1a1' ? 1 : 0])),
      value: 0,
    });
    assert.notEqual((await runMcts(fen, wantsIt, 64)).uci, 'b1a1');
  },

  async 'a move is still returned when every move allows mate in 1'() {
    // Kb1 is white's only legal move, and it walks into Rd1#
    const fen = '3r2k1/8/8/8/8/1p6/2r5/K7 w - - 0 1';
    const result = await runMcts(fen, byMaterial, 32);
    assert.equal(result.uci, 'a1b1');
  },

  async 'a mate at depth d backs up -(1 - matePenalty * d)'() {
    // a two-ply mate needs a root where every move allows one, the rest being pruned
    const lost = '3r2k1/8/8/8/8/1p6/2r5/K7 w - - 0 1'; // Kb1 is forced, and walks into Rd1#
    assert.equal(round(await mateValue(lost, ['Kb1', 'Rd1#'], 40)), -0.99);
    const scholars = replay(['e4', 'e5', 'Bc4', 'Nc6']).pop(); // 3.Qh5 Nf6 4.Qxf7#
    assert.equal(round(await mateValue(scholars, ['Qh5', 'Nf6', 'Qxf7#'], 40)), -0.985);
    // deeper is worth less, so the search prefers the shorter mate
    assert.equal(round(await mateValue(scholars, ['Qf3', 'a6', 'Qh5', 'b5', 'Qxf7#'], 40)), -0.975);
  },

  async 'fallback reads the side to move off the last move, and has no history'() {
    const pieces = [
      { file: 4, rank: 1, color: 'w', type: 'k' },   // white king on e2
      { file: 4, rank: 7, color: 'b', type: 'k' },
    ];
    const lastMove = [{ file: 4, rank: 0 }, { file: 4, rank: 1 }];  // e1 -> e2, only e2 occupied
    const { fen, history } = deriveFen({ pieces, sans: [], lastMove });
    assert.equal(fen, '4k3/8/8/8/8/8/4K3/8 b - - 0 1');   // white just moved, so black is to move
    assert.deepEqual(history, []);
  },

  // A guessed side to move yields a legal FEN for the wrong player, so the arrow and the eval
  // label come back confidently backwards with nothing to signal it. No arrow is better.
  async 'fallback refuses to guess the side to move'() {
    const pieces = [
      { file: 4, rank: 1, color: 'w', type: 'k' },
      { file: 4, rank: 7, color: 'b', type: 'k' },
    ];
    // no highlight at all: a board set up from a FEN, before any move is played
    assert.equal(deriveFen({ pieces, sans: [], lastMove: null }).fen, null);
    assert.equal(deriveFen({ pieces, sans: [], lastMove: [] }).fen, null);
    // too many: chess.com reuses the highlight class for right-click square marks
    const marked = [{ file: 4, rank: 0 }, { file: 4, rank: 1 }, { file: 0, rank: 0 }];
    assert.equal(deriveFen({ pieces, sans: [], lastMove: marked }).fen, null);
  },

  // Training (python-chess ep_square) lights the ep file after every double push;
  // chess.js fen() prints the square only when the capture is legal.
  async 'double push sets ep even when no capture is legal'() {
    const { fen, ep } = deriveFen({ pieces: [], sans: ['e4'], lastMove: null });
    assert.equal(fen.split(' ')[3], '-');
    assert.equal(ep, 'e3');
    const planes = fenToPlanes(fen, ep);
    assert.deepEqual(epPlane(planes), onlyFile(4));
    assert.deepEqual(planes.slice(0, 17 * 64), fenToPlanes(fen).slice(0, 17 * 64));
  },

  async 'ep is set only right after a double push'() {
    assert.equal(deriveFen({ pieces: [], sans: ['Nf3', 'd5'], lastMove: null }).ep, 'd6');
    const afterNf3 = deriveFen({ pieces: [], sans: ['Nf3'], lastMove: null });
    assert.equal(afterNf3.ep, '-');
    assert.deepEqual(epPlane(fenToPlanes(afterNf3.fen, afterNf3.ep)), Array(64).fill(0));
  },

  async 'the search gives the evaluator each node\'s ep'() {
    const eps = new Map();
    // only e2e4 and g1f3 have prior, so 3 sims evaluate the root and both of them
    const evaluate = async (fen, legalUcis, turn, ep) => {
      eps.set(fen, ep);
      return { priors: new Map(legalUcis.map((u) => [u, ['e2e4', 'g1f3'].includes(u) ? 0.5 : 0])), value: 0 };
    };
    const [start, afterE4] = replay(['e4']);
    const [, afterNf3] = replay(['Nf3']);
    await runMcts(start, evaluate, 3);
    assert.equal(eps.get(start), '-');
    assert.equal(eps.get(afterE4), 'e3');
    assert.equal(eps.get(afterNf3), '-');

    // the root's ep option overrides what the FEN alone would give (that would be '-')
    eps.clear();
    await runMcts(afterE4, evaluate, 1, { ep: 'e3' });
    assert.equal(eps.get(afterE4), 'e3');
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`FAIL ${name}\n     ${e.message.split('\n')[0]}`);
  }
}
console.log(`\n${Object.keys(tests).length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
