import { createHash } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

/**
 * Writes sw.js with the full list of built files, so the app, the WASM
 * runtime and the model are all cached on first visit and work offline.
 */
function serviceWorker(): Plugin {
  return {
    name: 'hoops-service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const publicDir = join(import.meta.dirname, 'public');
      const files = [
        './',
        ...Object.keys(bundle),
        ...listFiles(publicDir).map((f) => relative(publicDir, f).split('\\').join('/')),
        // The optional larger model is cached the first time it's used instead.
      ].filter((f) => !f.endsWith('.map') && f !== 'sw.js' && !f.endsWith('efficientdet_lite2.tflite'));
      const version = createHash('sha256').update(files.join('\n')).digest('hex').slice(0, 12);
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: swSource(version, files) });
    },
  };
}

function swSource(version: string, files: string[]): string {
  return `// Generated at build time by vite.config.ts.
const CACHE = 'hoops-${version}';
const FILES = ${JSON.stringify(files)};

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('hoops-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  if (req.mode === 'navigate') {
    // Network first for the page so updates show up; cache when offline.
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('./', copy));
          return res;
        })
        .catch(() => caches.match('./')),
    );
    return;
  }
  e.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
`;
}

// Relative base so the build works at https://<user>.github.io/<repo>/.
export default defineConfig({
  base: './',
  worker: { format: 'es' },
  build: { target: 'es2022' },
  plugins: [serviceWorker()],
});
