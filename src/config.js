// @ts-check
/**
 * Brand, version, directories and the API key. The brand (brand.json) is the only thing that differs between the 7
 * site CLIs; everything else is the same code.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * @typedef {object} Brand
 * @property {string} name        site name, e.g. "FetchMCP"
 * @property {string} tagline
 * @property {string} domain      e.g. "fetchmcp.net"
 * @property {string} bin         command name, e.g. "fetchmcp"
 * @property {string} npm         npm package name
 * @property {string} org         GitHub org
 * @property {string} repo        GitHub repo in the org
 * @property {string} siteUrl
 * @property {string} docsUrl
 * @property {string} apiName     e.g. "FetchMCP API"
 * @property {string} envPrefix   e.g. "FETCHMCP": FETCHMCP_API_KEY, FETCHMCP_API_BASE_URL, FETCHMCP_SPEC_URL
 * @property {string} apiBaseUrl  where requests (and the key) go, on the site's own domain
 * @property {string} specUrl     where the commands come from
 */

/** The package root (bin/, src/, brand.json, openapi.json, package.json). */
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** @returns {Brand} */
export function loadBrand(root = ROOT) {
  return JSON.parse(readFileSync(join(root, "brand.json"), "utf8"));
}

/** @returns {string} */
export function loadVersion(root = ROOT) {
  return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
}

export const BUNDLED_SPEC = join(ROOT, "openapi.json");

/** @typedef {Record<string, string | undefined>} Env */

/** First of `names` that is set and not empty. */
export function envValue(/** @type {Env} */ env, /** @type {string[]} */ ...names) {
  for (const name of names) if (env[name]) return env[name];
  return undefined;
}

/**
 * The environment variables of each setting, in the order they are read. The brand's own come first and are the only
 * ones help and errors name; the others are fallbacks, so a setup from before the per-site names keeps working.
 * @returns {{ apiKey: string[], baseUrl: string[], specUrl: string[] }}
 */
export function envNames(/** @type {Pick<Brand, "envPrefix">} */ brand) {
  const names = (/** @type {string} */ suffix, /** @type {string[]} */ fallbacks) => [...new Set([brand.envPrefix, ...fallbacks].map((p) => `${p}_${suffix}`))];
  return {
    apiKey: names("API_KEY", ["LIVE_WEB_DATA", "TENEO"]),
    baseUrl: names("API_BASE_URL", ["LIVE_WEB_DATA", "TENEO"]),
    specUrl: names("SPEC_URL", ["LIVE_WEB_DATA"]),
  };
}

const home = (/** @type {Env} */ env) => env.HOME || homedir();

/** `${XDG_CACHE_HOME:-~/.cache}/<bin>`: the spec cache and the update check. */
export function cacheDir(/** @type {Env} */ env, /** @type {string} */ bin) {
  return join(env.XDG_CACHE_HOME || join(home(env), ".cache"), bin);
}

/** `${XDG_CONFIG_HOME:-~/.config}/<bin>`: config.json with the saved key. */
export function configDir(/** @type {Env} */ env, /** @type {string} */ bin) {
  return join(env.XDG_CONFIG_HOME || join(home(env), ".config"), bin);
}

export const configFile = (/** @type {Env} */ env, /** @type {string} */ bin) => join(configDir(env, bin), "config.json");

/** @returns {{ apiKey?: string }} */
export function readConfig(/** @type {string} */ file) {
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

/** Writes the key readable by the owner only (0600, directory 0700), also when the file existed with wider modes. */
export function saveApiKey(/** @type {string} */ file, /** @type {string} */ apiKey) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...readConfig(file), apiKey }, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

/** @returns {boolean} whether a saved key was removed */
export function removeApiKey(/** @type {string} */ file) {
  if (!existsSync(file)) return false;
  const { apiKey, ...rest } = readConfig(file);
  if (Object.keys(rest).length) writeFileSync(file, JSON.stringify(rest, null, 2) + "\n", { mode: 0o600 });
  else rmSync(file, { force: true });
  return apiKey !== undefined;
}

/**
 * The key, in this order: --api-key, <envPrefix>_API_KEY, LIVE_WEB_DATA_API_KEY, the legacy TENEO_API_KEY, the saved
 * key. `from` names where it came from: the flag, the variable that was set, or the config file.
 * @returns {{ apiKey?: string, from?: string }}
 */
export function resolveApiKey(/** @type {string | undefined} */ flag, /** @type {Env} */ env, /** @type {Pick<Brand, "bin" | "envPrefix">} */ brand) {
  if (flag) return { apiKey: flag, from: "--api-key" };
  for (const name of envNames(brand).apiKey) if (env[name]) return { apiKey: env[name], from: name };
  const file = configFile(env, brand.bin);
  const saved = readConfig(file).apiKey;
  return saved ? { apiKey: saved, from: file } : {};
}
