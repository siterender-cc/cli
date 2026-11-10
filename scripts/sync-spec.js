#!/usr/bin/env node
// @ts-check
/**
 * node scripts/sync-spec.js [--url <spec url>] [--file openapi.json]
 *
 * Downloads the live API spec (default: brand.json specUrl) and writes it to the bundled openapi.json when it changed,
 * normalized (2-space JSON, trailing newline) so an unchanged spec is byte-identical. Prints "changed" or "unchanged"
 * and sets `changed=true|false` in $GITHUB_OUTPUT. Exit 1 when the download fails or is not an OpenAPI 3 document:
 * the bundled copy is never replaced by an error page.
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadBrand, ROOT } from "../src/config.js";
import { isSpec } from "../src/spec.js";

export const normalize = (/** @type {any} */ spec) => JSON.stringify(spec, null, 2) + "\n";

/**
 * @param {{ url: string, file: string, fetchImpl?: typeof fetch }} o
 * @returns {Promise<{ changed: boolean, version: string }>}
 */
export async function syncSpec(o) {
  const res = await (o.fetchImpl ?? fetch)(o.url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${o.url}: HTTP ${res.status}`);
  const spec = JSON.parse(await res.text());
  if (!isSpec(spec)) throw new Error(`${o.url}: not an OpenAPI 3 document`);
  const next = normalize(spec);
  let current = "";
  try {
    current = readFileSync(o.file, "utf8");
  } catch {
    // first sync
  }
  const changed = current !== next;
  if (changed) writeFileSync(o.file, next);
  return { changed, version: String(spec.info?.version ?? "") };
}

async function cli() {
  const args = process.argv.slice(2);
  const opt = (/** @type {string} */ name) => {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args[i + 1];
  };
  const { changed } = await syncSpec({ url: opt("--url") ?? loadBrand().specUrl, file: opt("--file") ?? join(ROOT, "openapi.json") });
  console.log(changed ? "changed" : "unchanged");
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  cli().catch((e) => {
    console.error(`sync-spec: ${e.message}`);
    process.exitCode = 1;
  });
}
