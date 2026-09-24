import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

const PUT_ONE = 'put one exported .onnx in models/ - see the README for how to get one';

// Path of the single .onnx in dir; anything else throws with what to do, so the build never guesses.
export function findModel(dir) {
  const files = existsSync(dir) ? readdirSync(dir) : [];
  const onnx = files.filter((f) => f.endsWith('.onnx'));
  if (onnx.length === 1) return path.join(dir, onnx[0]);
  if (onnx.length > 1) {
    throw new Error(`models/ has ${onnx.length} .onnx files (${onnx.join(', ')}); keep exactly one`);
  }
  let message = `No model: ${PUT_ONE}`;
  const pt = files.find((f) => f.endsWith('.pt'));
  if (pt) {
    message += '\nA .pt is a PyTorch checkpoint and cannot run in the browser. Export it to ONNX'
      + ' with the training harness first:'
      + `\n  python -m harness export --checkpoint "${path.join(dir, pt)}" --device cpu`;
  }
  throw new Error(message);
}
