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
const WIDGET_PORT = 5701;
const OTHER_SITE_PORT = 5702; // serves the SAME widget-app build, standing in for an unrelated site the key was never issued for
const ALLOWED_ORIGIN = `http://127.0.0.1:${WIDGET_PORT}`;

const { buildApp } = await import('../apps/api/src/app.ts');
const { db, pool } = await import('../apps/api/src/db/client.ts');
const { organization } = await import('../apps/api/src/db/schema/index.ts');
const { workerPool } = await import('../apps/api/src/modules/ingestion/queue.ts');
const { publicPool } = await import('../apps/api/src/modules/widget-keys/service.ts');
const { l2Normalize } = await import('../apps/api/src/modules/ingestion/vectors.ts');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

function serveStatic(rootDir, port) {
  const server = createServer(async (req, res) => {
    const path = req.url === '/' ? '/index.html' : req.url.split('?')[0];
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
  payload: { name: 'jsdom test', allowedOrigins: [ALLOWED_ORIGIN] },
});
const publicKey = keyRes.json().publicKey;
console.log(`widget key issued, allowlisted for ${ALLOWED_ORIGIN}\n`);

console.log(`serving built widget-app on ${ALLOWED_ORIGIN}...`);
const staticServer = await serveStatic('apps/widget-app/dist', WIDGET_PORT);
const otherSiteServer = await serveStatic('apps/widget-app/dist', OTHER_SITE_PORT);

async function loadWidgetPage(origin) {
  const url = `${origin}/?key=${publicKey}&api=http://127.0.0.1:${API_PORT}`;
  const html = await (await fetch(`${origin}/index.html`)).text();
  const dom = new JSDOM(html, {
    url, runScripts: 'dangerously', pretendToBeVisual: true,
  });
  // jsdom has no fetch/ReadableStream of its own; Node's is real and streams.
  // The one gap: a real browser auto-attaches an Origin header derived from
  // page context, which Node's fetch has no concept of and won't add. That
  // header is the ONLY thing shimmed here — method, the x-widget-key header,
  // and the body all come untouched from the app's real request construction,
  // so the origin-allowlist check on the server is still exercised for real.
  dom.window.fetch = (resource, init = {}) =>
    fetch(resource, { ...init, headers: { ...init.headers, origin: dom.window.location.origin } });
  const scriptSrc = /<script[^>]*\btype="module"[^>]*\bsrc="([^"]+)"/.exec(html)[1];
  const bundle = await (await fetch(`${origin}${scriptSrc}`)).text();
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
const dom = await loadWidgetPage(ALLOWED_ORIGIN);
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
const rejectedDom = await loadWidgetPage(`http://127.0.0.1:${OTHER_SITE_PORT}`); // NOT the allowlisted origin
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
otherSiteServer.close();
await apiApp.close();
await db.delete(organization).where(eq(organization.id, orgId));
await db.execute(`DELETE FROM "user" WHERE email = '${email}'`);
await pool.end();
await workerPool.end();
await publicPool.end();
