// Copies the MediaPipe WASM runtime out of node_modules and downloads the
// stock detector model into public/, so the app serves (and caches) both
// itself instead of depending on a CDN at the gym.
import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const wasmSrc = join(root, 'node_modules/@mediapipe/tasks-vision/wasm');
const wasmDst = join(root, 'public/mediapipe/wasm');
const MODELS = {
  'efficientdet_lite0.tflite':
    'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/int8/latest/efficientdet_lite0.tflite',
  'efficientdet_lite2.tflite':
    'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite2/float16/latest/efficientdet_lite2.tflite',
};

async function exists(path) {
  try {
    return (await stat(path)).size > 0;
  } catch {
    return false;
  }
}

await mkdir(wasmDst, { recursive: true });
// The detector runs in a module worker, which needs the "_module" build.
for (const name of ['vision_wasm_module_internal.js', 'vision_wasm_module_internal.wasm']) {
  await copyFile(join(wasmSrc, name), join(wasmDst, name));
}

for (const [name, url] of Object.entries(MODELS)) {
  const dst = join(root, 'public/models', name);
  if (await exists(dst)) continue;
  console.log('Downloading', url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Model download failed: ${res.status} ${url}`);
  await mkdir(dirname(dst), { recursive: true });
  await writeFile(dst, Buffer.from(await res.arrayBuffer()));
}
console.log('Assets ready.');
