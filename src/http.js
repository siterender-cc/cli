// @ts-check
/**
 * One API call. A request that carries an Idempotency-Key (or is a GET) is repeated after a network error, a cut 2xx
 * answer, a 429 or a 5xx: the key makes the repeat rejoin the first request instead of being charged again. A 202
 * "pending" answer (a fetch still running after ~100 s) is repeated with the same key after Retry-After until the
 * result arrives or maxWaitMs runs out.
 */

/**
 * @typedef {object} Outcome
 * @property {"ok" | "api" | "pending" | "network"} kind
 * @property {number} status        0 for network
 * @property {any} body             parsed JSON, else the text
 * @property {string | null} requestId
 * @property {string} [error]       network: what went wrong
 */

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/** Exponential backoff with jitter: ~0.5 s, 1 s, 2 s (capped at 8 s). */
const backoffMs = (/** @type {number} */ attempt) => {
  const base = Math.min(8000, 500 * 2 ** attempt);
  return base / 2 + Math.random() * (base / 2);
};

const isPending = (/** @type {any} */ body) => !!body && typeof body === "object" && body.status === "pending";

/**
 * @param {object} o
 * @param {URL} o.url
 * @param {string} o.method
 * @param {Record<string, string>} o.headers
 * @param {any} [o.body]
 * @param {boolean} o.repeatable      safe to send again (GET, or an Idempotency-Key is set)
 * @param {number} o.timeoutMs        per attempt
 * @param {number} o.maxWaitMs        202 repeats
 * @param {number} [o.retries]
 * @param {(info: { retryAfter: number, idempotencyKey: string | null }) => void} [o.onPending]
 * @param {typeof fetch} [o.fetchImpl]
 * @returns {Promise<Outcome>}
 */
export async function send(o) {
  const fetchImpl = o.fetchImpl ?? fetch;
  const retries = o.retries ?? 2;
  const until = Date.now() + o.maxWaitMs;
  const payload = o.body === undefined ? undefined : JSON.stringify(o.body);
  const headers = { ...o.headers, ...(payload !== undefined && { "Content-Type": "application/json" }) };

  for (let attempt = 0; ; ) {
    const canRetry = o.repeatable && attempt < retries;
    /** @type {Response} */
    let res;
    try {
      res = await fetchImpl(o.url, { method: o.method.toUpperCase(), headers, body: payload, signal: AbortSignal.timeout(o.timeoutMs) });
    } catch (e) {
      if (canRetry) {
        await sleep(backoffMs(attempt++));
        continue;
      }
      const err = /** @type {Error} */ (e);
      return { kind: "network", status: 0, body: null, requestId: null, error: err.name === "TimeoutError" ? `no answer within ${Math.round(o.timeoutMs / 1000)} s` : String(err.cause ?? err.message) };
    }
    const requestId = res.headers.get("x-request-id");
    const json = /json/i.test(res.headers.get("content-type") ?? "");
    /** @type {any} */
    let body;
    try {
      const text = await res.text();
      body = json ? JSON.parse(text) : text;
    } catch (e) {
      // A cut 2xx answer is a lost answer, not a result: repeat with the same key, then report it as a network error.
      if (res.ok && canRetry) {
        await sleep(backoffMs(attempt++));
        continue;
      }
      if (res.ok) return { kind: "network", status: 0, body: null, requestId, error: `HTTP ${res.status} answer cut or not JSON: ${/** @type {Error} */ (e).message}` };
      body = null;
    }

    if (res.status === 202 && isPending(body)) {
      const retryAfter = Math.min(30, Math.max(1, Number(res.headers.get("retry-after") ?? body.retryAfter) || 1));
      if (!o.repeatable || Date.now() + retryAfter * 1000 >= until) return { kind: "pending", status: 202, body, requestId };
      o.onPending?.({ retryAfter, idempotencyKey: body.idempotencyKey ?? null });
      await sleep(retryAfter * 1000);
      continue;
    }
    if (res.ok) return { kind: "ok", status: res.status, body, requestId };
    if ((res.status === 429 || res.status >= 500) && canRetry) {
      const ra = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 30) * 1000 : backoffMs(attempt));
      attempt++;
      continue;
    }
    return { kind: "api", status: res.status, body, requestId };
  }
}
