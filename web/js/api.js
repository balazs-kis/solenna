import { missingFromSnapshot } from './snapshot.js';
import { getState, SIGNED_OUT, setState } from './store.js';

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
 * app back to the login screen. If the server can't be reached at all, the
 * code is 'network' (status 0), and the app switches to its offline state.
 */
export async function api(method, path, body) {
  const options = { method, headers: { Accept: 'application/json' } };
  if (method !== 'GET') {
    // Writes must be JSON (the server's CSRF rule), even without a payload.
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body ?? {});
  }

  let response;
  try {
    response = await fetch(path, options);
  } catch {
    // No connection, or the server is down: show the offline banner, disable
    // saving until the app reconnects, and show this device's copy of any
    // data not loaded yet.
    setState({ offline: true, ...missingFromSnapshot(getState()) });
    throw new ApiError(0, 'network');
  }
  if (response.status === 401) setState(SIGNED_OUT);
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new ApiError(response.status, data.error ?? 'unknown');
  }
  return response.status === 204 ? null : response.json();
}
