// @ts-check
/**
 * The API spec the commands come from. Read at run time so an API change reaches every installed CLI without a new
 * release: a cache younger than SPEC_TTL_MS, else a conditional GET of the live spec (If-None-Match), else the stale
 * cache, else the copy bundled with the package. The spec only describes commands and flags: requests go to the base
 * URL (brand.apiBaseUrl / --base-url), never to the spec's `servers`.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SPEC_TTL_MS = 60 * 60 * 1000;
export const SPEC_TIMEOUT_MS = 3000;

/** @typedef {{ url: string, etag: string | null, fetchedAt: number }} SpecMeta */
/**
 * @typedef {object} LoadedSpec
 * @property {any} spec
 * @property {"cache" | "network" | "stale-cache" | "bundled"} source
 * @property {string} url          the spec URL asked for
 * @property {string | null} etag
 * @property {number | null} fetchedAt  ms epoch of the last download or revalidation (null: bundled)
 * @property {string} [error]      why the network was not used, when it was tried
 */

/** Minimal shape check before a downloaded spec replaces the cache. */
export function isSpec(/** @type {any} */ x) {
  return (
    !!x && typeof x === "object" && typeof x.openapi === "string" && /^3\./.test(x.openapi) &&
    !!x.paths && typeof x.paths === "object" && !Array.isArray(x.paths)
  );
}

const readJson = (/** @type {string} */ file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

/** Atomic write; a read-only cache directory is not an error. */
function writeAtomic(/** @type {string} */ file, /** @type {string} */ text) {
  try {
    mkdirSync(join(file, ".."), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, file);
  } catch {
    // no cache then
  }
}

/**
 * @param {object} o
 * @param {string} o.url
 * @param {string} o.cacheDir
 * @param {string} o.bundledPath
 * @param {boolean} [o.offline]   cache or bundled copy only
 * @param {boolean} [o.force]     ignore the TTL (spec refresh)
 * @param {number} [o.now]
 * @param {number} [o.ttlMs]
 * @param {number} [o.timeoutMs]
 * @param {Record<string, string>} [o.headers]
 * @param {typeof fetch} [o.fetchImpl]
 * @returns {Promise<LoadedSpec>}
 */
export async function loadSpec(o) {
  const now = o.now ?? Date.now();
  const specFile = join(o.cacheDir, "openapi.json");
  const metaFile = join(o.cacheDir, "openapi.meta.json");
  /** @type {SpecMeta | null} */
  const meta = readJson(metaFile);
  const cachedSpec = meta && meta.url === o.url ? readJson(specFile) : null;
  const cached = meta && isSpec(cachedSpec) ? { spec: cachedSpec, meta } : null;
  const bundled = () => {
    const spec = JSON.parse(readFileSync(o.bundledPath, "utf8"));
    return { spec, url: o.url, etag: null, fetchedAt: null };
  };

  if (cached && !o.force && (o.offline || now - cached.meta.fetchedAt < (o.ttlMs ?? SPEC_TTL_MS))) {
    return { spec: cached.spec, source: o.offline && now - cached.meta.fetchedAt >= (o.ttlMs ?? SPEC_TTL_MS) ? "stale-cache" : "cache", url: o.url, etag: cached.meta.etag, fetchedAt: cached.meta.fetchedAt };
  }
  if (o.offline) return { ...bundled(), source: "bundled" };

  let error;
  try {
    const res = await (o.fetchImpl ?? fetch)(o.url, {
      headers: { Accept: "application/json", ...o.headers, ...(cached?.meta.etag ? { "If-None-Match": cached.meta.etag } : {}) },
      signal: AbortSignal.timeout(o.timeoutMs ?? SPEC_TIMEOUT_MS),
    });
    if (res.status === 304 && cached) {
      const fresh = { ...cached.meta, fetchedAt: now };
      writeAtomic(metaFile, JSON.stringify(fresh) + "\n");
      return { spec: cached.spec, source: "cache", url: o.url, etag: fresh.etag, fetchedAt: now };
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const spec = JSON.parse(text);
    if (!isSpec(spec)) throw new Error("not an OpenAPI 3 document");
    const etag = res.headers.get("etag");
    writeAtomic(specFile, text);
    writeAtomic(metaFile, JSON.stringify({ url: o.url, etag, fetchedAt: now }) + "\n");
    return { spec, source: "network", url: o.url, etag, fetchedAt: now };
  } catch (e) {
    error = /** @type {Error} */ (e).name === "TimeoutError" ? `timeout after ${o.timeoutMs ?? SPEC_TIMEOUT_MS} ms` : /** @type {Error} */ (e).message;
  }
  if (cached) return { spec: cached.spec, source: "stale-cache", url: o.url, etag: cached.meta.etag, fetchedAt: cached.meta.fetchedAt, error };
  return { ...bundled(), source: "bundled", error };
}
