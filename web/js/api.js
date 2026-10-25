import { setState } from './store.js';

export class ApiError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

/**
 * JSON request to our own backend. Throws ApiError with the server's error code
 * for non-2xx responses. A 401 means the session is gone, so it also drops the
 * app back to the login screen.
 */
export async function api(method, path, body) {
  const options = { method, headers: { Accept: 'application/json' } };
  if (method !== 'GET') {
    // Writes must be JSON (the server's CSRF rule), even without a payload.
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body ?? {});
  }

  const response = await fetch(path, options);
  if (response.status === 401) setState({ user: null });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new ApiError(response.status, data.error ?? 'unknown');
  }
  return response.status === 204 ? null : response.json();
}
