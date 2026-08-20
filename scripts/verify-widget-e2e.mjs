/**
 * Loads the REAL built widget-app bundle in jsdom (real script execution, real
 * React mount, real fetch/SSE) against the REAL running API server, and drives
 * it the way a visitor would: type a question, submit, read the streamed
 * answer back out of the DOM.
 *
 * This is not a substitute for a real browser — no rendering/painting is
 * verified, and jsdom's DOM implementation has known gaps. It exists because
 * no browser binary is available in this environment (see the loader/App
 * component tests for the DOM-level coverage that runs everywhere). What this
 * script proves that component tests cannot: the production Vite build boots
 * cleanly from a cold script execution, and the origin-allowlist gate behaves
 * correctly over a real HTTP round trip to a real server, not an injected fetch.
 *
 * Run with: node scripts/verify-widget-e2e.mjs
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { eq } from 'drizzle-orm';

const API_PORT = 3901;
// The ONE real origin the widget bundle is actually hosted at — analogous to
// wherever Groundwork would serve the widget app from in production. Client
// sites below are simulated values only; they are never actually served from,
// which is the whole point: the widget bundle always loads from here
// regardless of which page embeds it.
const WIDGET_PORT = 5701;
const CLIENT_SITE_ORIGIN = 'https://client-site.example';
const OTHER_SITE_ORIGIN = 'https://unrelated-site.example';

const { buildApp } = await import('../apps/api/src/app.ts');
const { db, pool } = await import('../apps/api/src/db/client.ts');
const { organization } = await import('../apps/api/src/db/schema/index.ts');
const { workerPool } = await import('../apps/api/src/modules/ingestion/queue.ts');
const { publicPool } = await import('../apps/api/src/modules/widget-keys/service.ts');
const { l2Normalize } = await import('../apps/api/src/modules/ingestion/vectors.ts');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

function serveStatic(rootDir, port) {
  const server = createServer(async (req, res) => {
    // A plain string split on '?' only special-cases the exact literal '/',
    // so a request with a query string (exactly what an iframe src="...?key=..."
    // produces) fell through to reading the directory itself and 404'd.
    let path = new URL(req.url, `http://${req.headers.host}`).pathname;
    if (path === '/') path = '/index.html';
    try {
      const body = await readFile(join(rootDir, path));
      res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

function assert(cond, message) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
  console.log(`  ok: ${message}`);
}

const flat = l2Normalize(Array.from({ length: 768 }, (_, i) => Math.sin(i)));
const embedder = {
  embedDocuments: async (t) => t.map(() => flat),
  embedQuery: async () => flat,
};
const chat = {
  async *stream() {
    for (const part of ['Refunds ', 'take ', '14 days ', '[1].']) yield part;
    return { inputTokens: 900, outputTokens: 40 };
  },
};

console.log('booting API server...');
const { app: apiApp, worker } = await buildApp({ embedder, chat, logger: false });
await apiApp.listen({ port: API_PORT, host: '127.0.0.1' });

const email = `jsdom-${randomUUID()}@example.com`;
const signup = await apiApp.inject({
  method: 'POST', url: '/api/auth/sign-up/email', headers: { origin: 'http://localhost:3000' },
  payload: { email, password: 'supersecret123', name: 'JSDOM' },
});
const cookie = signup.headers['set-cookie'].toString().split(';')[0];
const h = { cookie, origin: 'http://localhost:3000' };

const orgRes = await apiApp.inject({
  method: 'POST', url: '/api/auth/organization/create', headers: h,
  payload: { name: 'JSDOM Co', slug: `jsdom-${randomUUID()}` },
});
const orgId = orgRes.json().id;
await apiApp.inject({
  method: 'POST', url: '/api/auth/organization/set-active', headers: h,
  payload: { organizationId: orgId },
});
await apiApp.inject({
  method: 'POST', url: '/v1/documents/text', headers: h,
  payload: { title: 'Policy', text: '# Refunds\n\nRefunds take 14 days to process.' },
});
await worker.drained();

const keyRes = await apiApp.inject({
  method: 'POST', url: '/v1/widget-keys', headers: h,
  payload: { name: 'jsdom test', allowedOrigins: [CLIENT_SITE_ORIGIN] },
});
const publicKey = keyRes.json().publicKey;
console.log(`widget key issued, allowlisted for ${CLIENT_SITE_ORIGIN}\n`);

const HOSTING_ORIGIN = `http://127.0.0.1:${WIDGET_PORT}`;
console.log(`serving built widget-app on ${HOSTING_ORIGIN}...`);
const staticServer = await serveStatic('apps/widget-app/dist', WIDGET_PORT);

/**
 * simulatedParentOrigin stands in for what the LOADER would have captured
 * from window.location.origin on the real embedding page, and forwarded via
 * the iframe's src as `?origin=...`. The widget bundle is always fetched from
 * HOSTING_ORIGIN regardless of this value — it never needs its own server,
 * which is the point: an iframe's own outgoing requests always report its own
 * hosting origin via the browser's Origin header, never the parent page's, so
 * the widget-app cannot and must not rely on the real HTTP Origin header for
 * the allowlist decision (see public-chat-routes.ts and
 * docs/phases/phase-3-widget.md — this was caught by an actual browser click,
 * not by an earlier, less realistic version of this very script).
 */
async function loadWidgetPage(simulatedParentOrigin) {
  // Fetch the URL an iframe would actually be given (root path + query
  // string), not /index.html directly — a static server that only handles
  // the bare root path can 404 on this exact request while looking fine in
  // every other check.
  const url =
    `${HOSTING_ORIGIN}/?key=${publicKey}&api=http://127.0.0.1:${API_PORT}` +
    `&origin=${encodeURIComponent(simulatedParentOrigin)}`;
  const html = await (await fetch(url)).text();
  const dom = new JSDOM(html, {
    url, runScripts: 'dangerously', pretendToBeVisual: true,
  });
  // jsdom has no fetch/ReadableStream of its own; Node's is real and streams.
  dom.window.fetch = (resource, init = {}) => fetch(resource, init);
  const scriptSrc = /<script[^>]*\btype="module"[^>]*\bsrc="([^"]+)"/.exec(html)[1];
  const bundle = await (await fetch(`${HOSTING_ORIGIN}${scriptSrc}`)).text();
  dom.window.eval(bundle.replace(/^import\s+[^;]+;\s*/gm, '')); // strip the one bare CSS import Vite emits
  return dom;
}

async function waitFor(fn, label, timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = fn();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

function setReactInputValue(el, value) {
  const setter = Object.getOwnPropertyDescriptor(el.__proto__, 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new el.ownerDocument.defaultView.Event('input', { bubbles: true }));
}

console.log('\n── loading widget-app fresh in jsdom (real bundle, real React) ──');
const dom = await loadWidgetPage(CLIENT_SITE_ORIGIN);
const { document } = dom.window;

const textarea = await waitFor(() => document.querySelector('textarea'), 'chat input to mount');
assert(!!textarea, 'React mounted a real <textarea>');

setReactInputValue(textarea, 'How long do refunds take?');
const form = textarea.closest('form');
form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));

try {
  await waitFor(
    () => [...document.querySelectorAll('div')].some((d) => d.textContent.includes('Refunds take 14 days')),
    'streamed answer to appear in the DOM',
    2000,
  );
} catch (e) {
  console.log('--- DOM snapshot on failure ---');
  console.log(document.getElementById('root').innerHTML);
  throw e;
}
assert(true, 'streamed answer rendered inside a fresh jsdom-loaded page');

const citation = await waitFor(() => document.querySelector('li'), 'citation to render');
assert(citation.textContent.includes('Policy'), 'citation names the source document');
assert(citation.textContent.includes('p. 1') || citation.textContent.includes('Refunds'), 'citation carries section/page detail');

assert(!citation.querySelector('blockquote'), 'the quoted excerpt starts collapsed');
citation.querySelector('button').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
await waitFor(() => citation.querySelector('blockquote'), 'excerpt to appear on click');
assert(citation.querySelector('blockquote').textContent.includes('14 days'), 'the revealed excerpt is the real chunk text, not a placeholder');

console.log('\n── verifying the origin allowlist over a REAL HTTP round trip ──');
const rejectedDom = await loadWidgetPage(OTHER_SITE_ORIGIN); // NOT on the allowlist
const rejTextarea = await waitFor(() => rejectedDom.window.document.querySelector('textarea'), 'second page to mount');
setReactInputValue(rejTextarea, 'anything');
rejTextarea.closest('form').dispatchEvent(new rejectedDom.window.Event('submit', { bubbles: true, cancelable: true }));
await waitFor(
  () => [...rejectedDom.window.document.querySelectorAll('div')]
    .some((d) => d.textContent.toLowerCase().includes('origin not allowed')),
  'origin rejection message to appear',
);
assert(true, 'a request from a non-allowlisted origin is refused end-to-end, and the widget shows it readably');

console.log('\nALL CHECKS PASSED\n');

staticServer.close();
await apiApp.close();
await db.delete(organization).where(eq(organization.id, orgId));
await db.execute(`DELETE FROM "user" WHERE email = '${email}'`);
await pool.end();
await workerPool.end();
await publicPool.end();
