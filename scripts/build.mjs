import { build, context } from 'esbuild';
import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findModel } from './find-model.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'src');
const dist = path.join(root, 'dist');
const models = path.join(root, 'models');
const ortDist = path.join(root, 'node_modules', 'onnxruntime-web', 'dist');

let model;
try {
  model = findModel(models);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

// Everything esbuild does not produce. Runs after every rebuild, watch included: it used to
// run once at startup, so a model swapped during a watch session kept serving the old weights
// while the bundles looked freshly built.
function copyStatic() {
  mkdirSync(path.join(dist, 'vendor'), { recursive: true });
  for (const file of ['manifest.json', 'offscreen/offscreen.html', 'popup/popup.html', 'styles/overlay.css']) {
    cpSync(path.join(src, file), path.join(dist, file));
  }
  cpSync(path.join(root, 'assets', 'mittens.png'), path.join(dist, 'mittens.png'));

  // The popup's model name is baked in at startup, so a rename needs a restart to show up.
  const current = findModel(models);
  if (path.basename(current) !== path.basename(model)) {
    console.error(`\n  models/ now holds ${path.basename(current)}, not ${path.basename(model)}.`
      + ' Restart the build so the popup reports the right name.\n');
  }
  cpSync(current, path.join(dist, 'model.onnx'));

  // onnxruntime-web is not bundled: its UMD build and the WASM it loads are copied as-is.
  // Use the wasm-only build, not ort.min.js. The two differ in which module they import at
  // runtime: ort.min.js pulls ort-wasm-simd-threaded.jsep.mjs and so drags in the 21 MB WebGPU
  // binary even when only the 'wasm' provider is requested, while ort.wasm.min.js pulls the
  // plain .mjs. Verified in a browser - dropping the .jsep. files under ort.min.js fails with
  // "no available backend found".
  for (const file of readdirSync(ortDist)) {
    const wanted = file === 'ort.wasm.min.js' || file.startsWith('ort-wasm');
    if (wanted && !file.includes('.jsep.')) {
      cpSync(path.join(ortDist, file), path.join(dist, 'vendor', file));
    }
  }
}

rmSync(dist, { recursive: true, force: true });

const options = {
  entryPoints: {
    'background/service-worker': path.join(src, 'background', 'service-worker.js'),
    'offscreen/offscreen': path.join(src, 'offscreen', 'offscreen.js'),
    'content/content': path.join(src, 'content', 'content.js'),
    'popup/popup': path.join(src, 'popup', 'popup.js'),
  },
  outdir: dist,
  bundle: true,
  format: 'iife',
  target: ['chrome116'],
  define: { MODEL_NAME: JSON.stringify(path.basename(model)) },
  logLevel: 'info',
  plugins: [{ name: 'copy-static', setup: (b) => b.onEnd(copyStatic) }],
};

if (process.argv.includes('--watch')) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
}
