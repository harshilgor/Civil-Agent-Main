/**
 * Tiny API client for the CivilAgent FastAPI service.
 *
 * Wires together three concerns the rest of the frontend wants to ignore:
 *
 *   1. **Base URL.**  Read from `window.CIVILAGENT_API_URL` if the host
 *      app sets it. On localhost, default to `http://localhost:8000` (Docker).
 *      On any other host (e.g. Vercel), default to `window.location.origin`
 *      so the UI talks to the same FastAPI deployment.
 *
 *   2. **Authentication.**  In dev we use the API's `AUTH_DEV_BYPASS=true`
 *      escape hatch with `X-Dev-User` and `X-Dev-Org` headers. Both can
 *      be overridden via `window.CIVILAGENT_DEV_USER / _DEV_ORG` or
 *      localStorage so engineers running multiple sessions get distinct
 *      principals. A stable random UUID is generated on first use and
 *      persisted to localStorage so reloads keep the same identity.
 *
 *   3. **Error normalisation.**  The API returns `{ code, message,
 *      context }` for failures; this client turns those into a typed
 *      `ApiError` so callers can branch on `err.code` instead of parsing
 *      JSON twice.
 *
 * All entry points are async and never throw on network problems unless
 * the caller asks (`request()` does throw on 4xx/5xx; `isApiReachable()`
 * swallows everything and returns a boolean).
 */

const STORAGE_KEY_USER = "civilagent.devUser";
const STORAGE_KEY_ORG = "civilagent.devOrg";

const DEFAULT_API_BASE = "http://localhost:8000";

/** When the UI is served from the same host as the API (e.g. Vercel), use same-origin. */
function resolveApiBase() {
  if (typeof window === "undefined") return DEFAULT_API_BASE;
  if (window.CIVILAGENT_API_URL) return window.CIVILAGENT_API_URL;
  const host = window.location.hostname;
  if (host === "localhost" || host === "127.0.0.1") return DEFAULT_API_BASE;
  return window.location.origin;
}

const NAMESPACE_UUID = "11111111-1111-4111-9111-111111111111";

function uuidv4() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // RFC4122 v4 fallback for older browsers.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function readStored(key, fallbackFactory) {
  try {
    const v = window.localStorage?.getItem(key);
    if (v) return v;
    const fresh = fallbackFactory();
    window.localStorage?.setItem(key, fresh);
    return fresh;
  } catch {
    return fallbackFactory();
  }
}

export const API_BASE = resolveApiBase();

export const WS_BASE = API_BASE.replace(/^http/i, (m) =>
  m.toLowerCase() === "https" ? "wss" : "ws",
);

export const DEV_USER =
  (typeof window !== "undefined" && window.CIVILAGENT_DEV_USER) ||
  readStored(STORAGE_KEY_USER, uuidv4);

export const DEV_ORG =
  (typeof window !== "undefined" && window.CIVILAGENT_DEV_ORG) ||
  readStored(STORAGE_KEY_ORG, () => NAMESPACE_UUID);

/** Structured error thrown by `request` for any non-2xx response. */
export class ApiError extends Error {
  constructor(code, message, status, context = {}) {
    super(message || code || "Request failed");
    this.name = "ApiError";
    this.code = code || "REQUEST_FAILED";
    this.status = status;
    this.context = context;
  }
}

function authHeaders() {
  return {
    "X-Dev-User": DEV_USER,
    "X-Dev-Org": DEV_ORG,
  };
}

/**
 * Issue a JSON request to the API.
 * @param {string} path - path beginning with `/`
 * @param {object} options - fetch options; if `body` is an object it is
 *   stringified and `Content-Type: application/json` is added.
 */
export async function request(path, options = {}) {
  const url = `${API_BASE}${path}`;
  const headers = { ...authHeaders(), ...(options.headers || {}) };

  let body = options.body;
  if (body && typeof body === "object" && !(body instanceof FormData) && !(body instanceof Blob)) {
    headers["Content-Type"] = headers["Content-Type"] || "application/json";
    body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(url, { ...options, headers, body });
  } catch (err) {
    throw new ApiError("NETWORK_ERROR", err?.message || "Network error", 0);
  }

  const text = await res.text();
  let payload = null;
  if (text) {
    try { payload = JSON.parse(text); } catch { /* non-JSON */ }
  }

  if (!res.ok) {
    // FastAPI HTTPExceptions wrap our `{code, message, context}` inside `detail`.
    const detail = payload?.detail ?? payload ?? {};
    throw new ApiError(
      detail.code || `HTTP_${res.status}`,
      detail.message || res.statusText,
      res.status,
      detail.context || {},
    );
  }
  return payload;
}

/** Lightweight liveness probe. Returns `true` only if `/health` responds 2xx. */
export async function isApiReachable(timeoutMs = 1500) {
  if (!API_BASE) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_BASE}/health`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Build a WebSocket URL with dev-bypass credentials in the query string. */
export function wsUrl(path) {
  const params = new URLSearchParams({
    org_id: DEV_ORG,
    user_id: DEV_USER,
  });
  return `${WS_BASE}${path}?${params.toString()}`;
}

/** Compute SHA-256 of a Blob/File in the browser; returns hex. */
export async function sha256Hex(blob) {
  if (!crypto?.subtle) {
    // Older browsers — caller can fall back to skipping the hash field
    // (the server treats it as optional, only forces it before parse).
    return null;
  }
  const buf = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  const bytes = new Uint8Array(digest);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}
