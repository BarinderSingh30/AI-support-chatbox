import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './index.css';

const params = new URLSearchParams(window.location.search);
const apiUrl = params.get('api');
const publicKey = params.get('key');

const root = document.getElementById('root')!;

if (!apiUrl || !publicKey) {
  root.innerHTML =
    '<div style="padding:16px;font-family:sans-serif;color:#b91c1c">' +
    'Widget misconfigured: missing key or api parameter.</div>';
} else {
  createRoot(root).render(
    <StrictMode>
      <App apiUrl={apiUrl} publicKey={publicKey} />
    </StrictMode>,
  );
}
