// @ts-check
/**
 * Update notice: at most once a day, ask the npm registry for the latest version of this package and print one line on
 * stderr when it is newer. Never in CI, never when stderr is not a terminal, never with <BIN>_NO_UPDATE_NOTIFIER or
 * NO_UPDATE_NOTIFIER set. Commands do not depend on it: they follow the live spec anyway.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const UPDATE_CHECK_MS = 24 * 60 * 60 * 1000;
export const REGISTRY = "https://registry.npmjs.org";

/** EXAMPLE_NO_UPDATE_NOTIFIER for bin "example". */
export const noUpdateVar = (/** @type {string} */ bin) => `${bin.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_NO_UPDATE_NOTIFIER`;

/** a > b for x.y.z versions (a pre-release suffix counts as older). */
export function newer(/** @type {string} */ a, /** @type {string} */ b) {
  const parse = (/** @type {string} */ v) => {
    const [core, pre] = String(v).replace(/^v/, "").split("-", 2);
    return { nums: core.split(".").map((n) => Number(n) || 0), pre: pre !== undefined };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if ((x.nums[i] ?? 0) !== (y.nums[i] ?? 0)) return (x.nums[i] ?? 0) > (y.nums[i] ?? 0);
  return !x.pre && y.pre;
}

/**
 * @param {object} o
 * @param {string} o.bin
 * @param {string} o.npm
 * @param {string} o.version
 * @param {string} o.cacheDir
 * @param {Record<string, string | undefined>} o.env
 * @param {boolean} o.isTTY
 * @param {number} [o.now]
 * @param {string} [o.registry]
 * @param {typeof fetch} [o.fetchImpl]
 * @returns {Promise<string | null>}
 */
export async function updateNotice(o) {
  if (!o.isTTY || o.env.CI || o.env[noUpdateVar(o.bin)] || o.env.NO_UPDATE_NOTIFIER) return null;
  const now = o.now ?? Date.now();
  const file = join(o.cacheDir, "update-check.json");
  let latest = null;
  try {
    const cached = JSON.parse(readFileSync(file, "utf8"));
    if (now - cached.checkedAt < UPDATE_CHECK_MS) latest = cached.latest;
  } catch {
    // no check yet
  }
  if (latest === null) {
    try {
      const res = await (o.fetchImpl ?? fetch)(`${o.registry ?? REGISTRY}/${encodeURIComponent(o.npm).replace(/^%40/, "@")}/latest`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(1500),
      });
      latest = res.ok ? String((await res.json()).version ?? "") : "";
    } catch {
      latest = "";
    }
    try {
      mkdirSync(o.cacheDir, { recursive: true });
      writeFileSync(file, JSON.stringify({ checkedAt: now, latest }) + "\n");
    } catch {
      // checked again next time
    }
  }
  if (!latest || !newer(latest, o.version)) return null;
  return `${o.bin} ${latest} is available (you have ${o.version}). Update: npm install -g ${o.npm}`;
}
