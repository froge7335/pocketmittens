import { MSG, TARGET, STORAGE_KEYS, DEFAULT_SIMS } from '../common/constants.js';

const $ = (id) => document.getElementById(id);

// MODEL_NAME is the bundled model's file name, inlined by the build (esbuild define).
$('status').textContent = `Model: ${MODEL_NAME}`;

chrome.storage.local.get([STORAGE_KEYS.ENABLED, STORAGE_KEYS.SIMS]).then((v) => {
  $('enabled').checked = !!v[STORAGE_KEYS.ENABLED];
  $('sims').value = String(v[STORAGE_KEYS.SIMS] ?? DEFAULT_SIMS);
});

$('enabled').addEventListener('change', (e) => {
  chrome.storage.local.set({ [STORAGE_KEYS.ENABLED]: e.target.checked });
});

$('sims').addEventListener('change', (e) => {
  chrome.storage.local.set({ [STORAGE_KEYS.SIMS]: Number(e.target.value) });
});

chrome.tabs.query({ active: true, currentWindow: true }).then(async ([tab]) => {
  if (!tab?.id) return;
  try {
    const state = await chrome.tabs.sendMessage(tab.id, { target: TARGET.CONTENT, type: MSG.GET_STATE });
    $('fen').textContent = state?.fen || 'No position detected on this tab';
  } catch {
    $('fen').textContent = 'No board on this tab';
  }
});
