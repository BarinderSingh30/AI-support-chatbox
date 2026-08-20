/**
 * Boots the real API against live Gemini, serves the real built widget bundle
 * and loader, and serves the demo host page — so the embed can be opened in an
 * actual browser and clicked through by hand.
 *
 * No browser binary is available in this environment, so this is what closes
 * that gap: everything here is real (real server, real Gemini, real built
 * assets); only the click-through itself needs a human.
 *
 * Prerequisites: `npm run build` in apps/widget-app and apps/widget-loader.
 * Run with: node scripts/demo-embed.mjs
 * Then open: http://127.0.0.1:5700/test-host.html
 */
import { createServer } from 'node:http';
import { readFile, access } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const API_PORT = 3900;
const WIDGET_PORT = 5701;
const HOST_SITE_PORT = 5700;

const { buildApp } = await import('../apps/api/src/app.ts');
const { workerPool } = await import('../apps/api/src/modules/ingestion/queue.ts');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

function serveDirs(dirs, port, transform) {
  const server = createServer(async (req, res) => {
    // A plain string split on '?' only special-cases the exact literal '/',
    // so a request with a query string (exactly what an iframe src="...?key=..."
    // produces) fell through to reading the directory itself and 404'd.
    let path = new URL(req.url, `http://${req.headers.host}`).pathname;
    if (path === '/') path = '/index.html';
    for (const dir of dirs) {
      try {
        await access(join(dir, path));
        let body = await readFile(join(dir, path));
        if (transform && extname(path) === '.html') body = Buffer.from(transform(body.toString()));
        res.writeHead(200, {
          'content-type': MIME[extname(path)] ?? 'application/octet-stream',
          // No caching: this server restarts with fresh org/doc/key data every
          // run, and a browser serving a stale cached page would embed a
          // widget key from a previous run that no longer exists.
          'cache-control': 'no-store',
        });
        return res.end(body);
      } catch { /* try next dir */ }
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

console.log('booting API (live Gemini)...');
const { app, worker } = await buildApp({});
await app.listen({ port: API_PORT, host: '127.0.0.1' });

const email = `demo-embed-${randomUUID()}@example.com`;
const signup = await app.inject({
  method: 'POST', url: '/api/auth/sign-up/email', headers: { origin: 'http://localhost:3000' },
  payload: { email, password: 'supersecret123', name: 'Demo' },
});
const cookie = signup.headers['set-cookie'].toString().split(';')[0];
const h = { cookie, origin: 'http://localhost:3000' };

const org = await app.inject({
  method: 'POST', url: '/api/auth/organization/create', headers: h,
  payload: { name: 'Acme Robotics', slug: `acme-${randomUUID()}` },
});
await app.inject({
  method: 'POST', url: '/api/auth/organization/set-active', headers: h,
  payload: { organizationId: org.json().id },
});
await app.inject({
  method: 'POST', url: '/v1/documents/text', headers: h,
  payload: {
    title: 'Acme Support Handbook',
    text: '# Warranty\n\nAll Acme robots carry a 24-month limited warranty covering parts and labour.\n\n# Returns\n\nReturns are accepted within 30 days of delivery.\n\n# Shipping\n\nShipping is free on orders over fifty dollars.',
  },
});
await worker.drained();

const key = await app.inject({
  method: 'POST', url: '/v1/widget-keys', headers: h,
  payload: { name: 'demo', allowedOrigins: [`http://127.0.0.1:${HOST_SITE_PORT}`] },
});
const publicKey = key.json().publicKey;

await serveDirs(['apps/widget-app/dist', 'apps/widget-loader/dist'], WIDGET_PORT);
await serveDirs(
  ['apps/widget-loader/demo'],
  HOST_SITE_PORT,
  (html) => html.replace('__WIDGET_KEY__', publicKey),
);

console.log(`
Ready. Open in a real browser:

  http://127.0.0.1:${HOST_SITE_PORT}/test-host.html

Ctrl+C to stop.
`);
