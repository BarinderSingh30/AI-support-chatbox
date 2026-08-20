import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient } from '../src/lib/api.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('createApiClient', () => {
  it('sends credentials and a JSON content-type on GET', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    const client = createApiClient({ baseUrl: 'https://api.test', fetchImpl });
    const result = await client.get<{ ok: boolean }>('/v1/documents');
    expect(result).toEqual({ ok: true });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.test/v1/documents');
    expect(init.credentials).toBe('include');
    expect(init.headers['content-type']).toBe('application/json');
  });

  it('serializes the body on post and put', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: '1' }));
    const client = createApiClient({ baseUrl: 'https://api.test', fetchImpl });
    await client.post('/v1/documents/text', { title: 'x', text: 'y' });
    const [, init] = fetchImpl.mock.calls[0]!;
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ title: 'x', text: 'y' });
  });

  it('throws an ApiError carrying the status and server message on a non-2xx response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: 'not found' }, 404));
    const client = createApiClient({ baseUrl: 'https://api.test', fetchImpl });
    await expect(client.get('/v1/conversations/x')).rejects.toMatchObject(
      new ApiError(404, 'not found'),
    );
  });

  it('returns undefined for a 204 response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const client = createApiClient({ baseUrl: 'https://api.test', fetchImpl });
    expect(await client.del('/v1/widget-keys/x')).toBeUndefined();
  });

  it('uploads FormData without setting a JSON content-type', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: '1' }, 201));
    const client = createApiClient({ baseUrl: 'https://api.test', fetchImpl });
    const form = new FormData();
    form.append('file', new Blob(['hi']), 'a.txt');
    await client.upload('/v1/documents', form);
    const [, init] = fetchImpl.mock.calls[0]!;
    expect(init.method).toBe('POST');
    expect(init.body).toBe(form);
    expect(init.headers).toBeUndefined();
  });
});
