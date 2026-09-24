import { Chess } from 'chess.js';
import { fenToPlanes, pickBestMove, policyPriors } from '../common/encoding.js';
import { runMcts } from '../common/search.js';
import { MSG, TARGET, NUM_PLANES } from '../common/constants.js';

ort.env.wasm.wasmPaths = chrome.runtime.getURL('vendor/');
ort.env.wasm.numThreads = 1;

let sessionPromise = null;
let generation = 0;
let inflight = null;

// Cached as a promise so concurrent first requests share one load.
function ensureSession() {
  sessionPromise ??= ort.InferenceSession.create(chrome.runtime.getURL('model.onnx'), { executionProviders: ['wasm'] });
  return sessionPromise;
}

async function evaluatePosition(s, fen, legalUcis, turn, ep) {
  const input = new ort.Tensor('float32', fenToPlanes(fen, ep), [1, NUM_PLANES, 8, 8]);
  const out = await s.run({ board: input });
  return { priors: policyPriors(out.policy.data, legalUcis, turn), value: out.value.data[0] };
}

async function infer(fen, history, ep, sims, myGen) {
  const chess = new Chess(fen);
  const moves = chess.moves({ verbose: true });
  if (!moves.length) return { ok: false, error: 'No legal moves' };
  const s = await ensureSession();
  // a newer request arrived during the first load
  if (myGen !== generation) return { ok: false, error: 'superseded' };
  const ucis = moves.map((m) => m.from + m.to + (m.promotion || ''));
  if (sims < 1) {
    const input = new ort.Tensor('float32', fenToPlanes(fen, ep), [1, NUM_PLANES, 8, 8]);
    const out = await s.run({ board: input });
    const uci = pickBestMove(out.policy.data, ucis, chess.turn());
    return { ok: true, uci, san: moves[ucis.indexOf(uci)].san, value: out.value.data[0] };
  }
  const result = await runMcts(fen, (f, legal, turn, e) => evaluatePosition(s, f, legal, turn, e), sims, {
    isCancelled: () => myGen !== generation,
    history,
    ep,
  });
  if (!result) {
    console.debug('search superseded', fen);
    return { ok: false, error: 'superseded' };
  }
  return { ok: true, uci: result.uci, san: moves[ucis.indexOf(result.uci)].san, value: result.q };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== TARGET.OFFSCREEN) return;
  if (msg.type === MSG.INFER) {
    const sims = Number.isFinite(msg.sims) ? Math.max(0, Math.floor(msg.sims)) : 0;
    const history = Array.isArray(msg.history) ? msg.history : [];
    // same FEN via a different move order has a different history, so it can't share a search
    const historyKey = history.join('|');
    let entry = inflight;
    if (!entry || entry.fen !== msg.fen || entry.sims !== sims || entry.historyKey !== historyKey
      || entry.ep !== msg.ep) {
      generation += 1;
      entry = { fen: msg.fen, sims, historyKey, ep: msg.ep };
      entry.promise = infer(msg.fen, history, msg.ep, sims, generation);
      inflight = entry;
      const clear = () => {
        if (inflight === entry) inflight = null;
      };
      entry.promise.then(clear, clear);
    }
    entry.promise.then(sendResponse, (e) => {
      console.error(e);
      sendResponse({ ok: false, error: String(e.message || e) });
    });
    return true;
  }
});
