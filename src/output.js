// @ts-check
/**
 * Output modes. `json` (default): the answer as pretty JSON. `text`: with an `x-cli.output` hint, the content of each
 * item (the first non-empty of hint.fields, e.g. markdown, then text, then html), and failed entries of hint.errors on
 * stderr; without a hint, one `key.path: value` line per field. Any other mode names one field of each item
 * (`-o html`, `-o title`).
 */

/**
 * @typedef {object} OutputHint
 * @property {string} [items]     array of the answer to print, e.g. "results"
 * @property {string[]} [fields]  content fields in order of preference
 * @property {string} [heading]   item field shown above each item when there are several, e.g. "url"
 * @property {string} [errors]    array of per-item statuses whose `error` is printed on stderr, e.g. "statuses"
 */

export const json = (/** @type {any} */ v) => JSON.stringify(v, null, 2) + "\n";

/** Leaf values as `a.b: value` lines. */
export function flatten(/** @type {any} */ v, prefix = "", /** @type {string[]} */ out = []) {
  if (v && typeof v === "object") {
    const entries = Array.isArray(v) ? v.map((x, i) => [String(i), x]) : Object.entries(v);
    if (!entries.length) out.push(`${prefix}: ${Array.isArray(v) ? "[]" : "{}"}`);
    for (const [k, x] of entries) flatten(x, prefix ? `${prefix}.${k}` : k, out);
  } else out.push(`${prefix}: ${v === null ? "null" : String(v)}`);
  return out;
}

const asText = (/** @type {any} */ v) => (typeof v === "string" ? v : v === null || v === undefined ? "" : JSON.stringify(v));
const withNewline = (/** @type {string} */ s) => (s.endsWith("\n") ? s : `${s}\n`);

/**
 * @param {any} body
 * @param {string} mode
 * @param {OutputHint | undefined} hint
 * @returns {{ stdout: string, stderr: string, failed: boolean }}  failed: nothing printed and every item failed
 */
export function render(body, mode, hint) {
  if (mode === "json") return { stdout: json(body), stderr: "", failed: false };
  if (typeof body === "string") return { stdout: withNewline(body), stderr: "", failed: false };
  const items = hint?.items && Array.isArray(body?.[hint.items]) ? body[hint.items] : null;
  if (!items) {
    if (mode !== "text") return { stdout: withNewline(asText(body?.[mode])), stderr: "", failed: false };
    return { stdout: flatten(body).join("\n") + "\n", stderr: "", failed: false };
  }
  const fields = mode === "text" ? hint?.fields ?? [] : [mode];
  const parts = items.map((/** @type {any} */ item) => {
    const value = fields.map((f) => item?.[f]).find((v) => v !== undefined && v !== null && v !== "");
    return value === undefined && mode === "text" && !fields.length ? json(item) : withNewline(asText(value));
  });
  const stdout = items.length > 1 && hint?.heading
    ? items.map((/** @type {any} */ item, /** @type {number} */ i) => `==> ${asText(item?.[/** @type {string} */ (hint.heading)])} <==\n${parts[i]}`).join("\n")
    : parts.join("\n");
  const errors = (hint?.errors && Array.isArray(body?.[hint.errors]) ? body[hint.errors] : []).filter((/** @type {any} */ s) => s?.error);
  const stderr = errors.map((/** @type {any} */ s) => `${s.id ?? s.url ?? "?"}: ${s.error.tag ?? "ERROR"}: ${s.error.message ?? ""}\n`).join("");
  return { stdout, stderr, failed: items.length === 0 && errors.length > 0 };
}
