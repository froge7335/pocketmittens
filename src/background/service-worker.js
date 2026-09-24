import { MSG, TARGET } from '../common/constants.js';

let offscreenReady = null;

// One shared promise, so parallel messages can't race to create the document.
function ensureOffscreen() {
  offscreenReady ??= (async () => {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (contexts.length) return;
    await chrome.offscreen.createDocument({
      url: 'offscreen/offscreen.html',
      reasons: ['WORKERS'],
      justification: 'Runs WebAssembly ONNX inference to compute move hints',
    });
  })().catch((e) => {
    offscreenReady = null;
    throw e;
  });
  return offscreenReady;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== TARGET.SW) return;
  if (msg.type === MSG.INFER) {
    ensureOffscreen()
      .then(() => chrome.runtime.sendMessage({ ...msg, target: TARGET.OFFSCREEN }))
      .then(sendResponse)
      .catch((e) => {
        offscreenReady = null; // recreate a dead offscreen document on the next request
        sendResponse({ ok: false, error: String(e.message || e) });
      });
    return true;
  }
});
