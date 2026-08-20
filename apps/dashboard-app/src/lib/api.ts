export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface ApiClientConfig {
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

export interface ApiClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  put<T>(path: string, body?: unknown): Promise<T>;
  del(path: string): Promise<void>;
  upload<T>(path: string, form: FormData): Promise<T>;
}

async function parseBody<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

/** Every admin fetch: cookie-authenticated, JSON in/out unless uploading a file. */
export function createApiClient({ baseUrl, fetchImpl = fetch }: ApiClientConfig): ApiClient {
  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetchImpl(`${baseUrl}${path}`, { ...init, credentials: 'include' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new ApiError(res.status, body.error ?? `Request failed (${res.status})`);
    }
    return parseBody<T>(res);
  }

  return {
    get: (path) => request(path, {
      headers: { 'content-type': 'application/json' },
    }),
    post: (path, body) => request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    put: (path, body) => request(path, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    del: (path) => request(path, { method: 'DELETE' }),
    upload: (path, form) => request(path, { method: 'POST', body: form }),
  };
}

export const api = createApiClient({
  baseUrl: import.meta.env.VITE_API_URL ?? 'http://localhost:3000',
});
