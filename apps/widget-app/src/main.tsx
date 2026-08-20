import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './index.css';

const params = new URLSearchParams(window.location.search);
const apiUrl = params.get('api');
const publicKey = params.get('key');
// Captured by the loader (which runs in the parent page's own context) and
// forwarded here via the iframe's src — the browser's own Origin header on
// this app's outgoing requests always reports this iframe's OWN origin
// instead, never the embedding page's, so it can't be used for this.
const parentOrigin = params.get('origin') ?? undefined;

const root = document.getElementById('root')!;

if (!apiUrl || !publicKey) {
  root.innerHTML =
    '<div style="padding:16px;font-family:sans-serif;color:#b91c1c">' +
    'Widget misconfigured: missing key or api parameter.</div>';
} else {
  createRoot(root).render(
    <StrictMode>
      <App apiUrl={apiUrl} publicKey={publicKey} parentOrigin={parentOrigin} />
    </StrictMode>,
  );
}
