import * as lichess from './scrape-lichess.js';
import * as chesscom from './scrape-chesscom.js';
import { deriveFen } from './derive-fen.js';
import { createOverlay } from './overlay.js';
import { MSG, TARGET, STORAGE_KEYS, DEFAULT_SIMS } from '../common/constants.js';

const site = location.hostname.includes('lichess') ? lichess : chesscom;
const overlay = createOverlay();

let enabled = false;
let sims = DEFAULT_SIMS;
let board = null;
let observer = null;
let pollTimer = null;
let debounceTimer = null;
let seq = 0;
const last = { fen: null, orientation: null, reply: null };

chrome.storage.local.get([STORAGE_KEYS.ENABLED, STORAGE_KEYS.SIMS]).then((v) => {
  sims = v[STORAGE_KEYS.SIMS] ?? DEFAULT_SIMS;
  setEnabled(!!v[STORAGE_KEYS.ENABLED]);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[STORAGE_KEYS.ENABLED]) {
    setEnabled(!!changes[STORAGE_KEYS.ENABLED].newValue);
  }
  if (changes[STORAGE_KEYS.SIMS]) {
    sims = changes[STORAGE_KEYS.SIMS].newValue ?? DEFAULT_SIMS;
    last.fen = null; // re-hint the current position at the new strength
    if (enabled) scheduleUpdate();
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== TARGET.CONTENT) return;
  if (msg.type === MSG.GET_STATE) sendResponse({ fen: last.fen });
});

document.addEventListener('visibilitychange', () => {
  if (!enabled || document.hidden) return;
  if (!last.reply) last.fen = null; // re-ask if a search was superseded while hidden
  scheduleUpdate();
});

function setEnabled(on) {
  if (on === enabled) return;
  enabled = on;
  if (on) start();
  else stop();
}

function start() {
  // Reconnection polling: pages replace the board element on new game/rematch.
  pollTimer = setInterval(() => {
    if (board?.isConnected) return;
    detachBoard();
    const el = site.findBoard();
    if (el) attachBoard(el);
  }, 1000);
  const el = site.findBoard();
  if (el) attachBoard(el);
}

function stop() {
  clearInterval(pollTimer);
  clearTimeout(debounceTimer);
  detachBoard();
  overlay.remove();
}

function attachBoard(el) {
  board = el;
  last.fen = null;
  observer = new MutationObserver(scheduleUpdate);
  observer.observe(el, { subtree: true, childList: true, attributes: true, characterData: true });
  scheduleUpdate();
}

function detachBoard() {
  observer?.disconnect();
  observer = null;
  board = null;
  seq++; // invalidate any in-flight reply
}

function scheduleUpdate() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(update, 150);
}

async function update() {
  if (!enabled || !board?.isConnected || document.hidden) return;
  const state = site.scrape(board);
  if (state.dragging) return;
  const { fen, history, ep } = deriveFen(state);
  if (!fen) {
    last.fen = null;
    overlay.clear();
    return;
  }
  if (fen === last.fen) {
    if (state.orientation !== last.orientation && last.reply) {
      last.orientation = state.orientation;
      overlay.draw(board, last.reply, state.orientation);
    }
    return;
  }
  last.fen = fen;
  last.orientation = state.orientation;
  last.reply = null;
  overlay.clear();
  const mySeq = ++seq;
  let reply;
  try {
    reply = await chrome.runtime.sendMessage({ target: TARGET.SW, type: MSG.INFER, fen, history, ep, sims });
  } catch {
    reply = null;
  }
  if (mySeq !== seq) return; // stale reply — a newer position superseded it
  if (!reply?.ok) {
    overlay.clear();
    return;
  }
  // the net's value is for the side to move; the label reads from White's side
  if (fen.split(' ')[1] === 'b') reply.value = -reply.value;
  last.reply = reply;
  overlay.draw(board, reply, last.orientation);
}
