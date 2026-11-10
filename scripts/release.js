#!/usr/bin/env node
// @ts-check
/**
 * node scripts/release.js plan   (the release workflow; prints key=value lines for $GITHUB_OUTPUT)
 *
 * Decides whether this repo publishes a new version. The version line is owned by the git tags (vX.Y.Z) and npm:
 * the next version is package.json's when that is higher (a deliberate bump), else the patch after the highest tag or
 * published version. A release happens when package.json's version is higher than anything on npm or tagged, or when a
 * shipped file (bin/, src/, openapi.json, brand.json, README.md, LICENSE, package.json apart from its version) differs
 * from the last tag; with no tag yet, from HEAD.
 *
 * Outputs: publish (npm publish this version), tag (commit + tag + GitHub release), version, reason.
 * Not on npm yet: nothing happens. npm trusts a repo only for a package that exists, so a placeholder 0.0.0 is
 * published once by hand and this repo's release.yml made its trusted publisher (`npm trust github`); the workflow
 * then publishes package.json's version (0.1.0) and every later one, without a token or an approval (user, 2026-11-10).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { newer } from "../src/update.js";

export const SHIPPED = ["bin", "src", "openapi.json", "brand.json", "README.md", "LICENSE"];

const bump = (/** @type {string} */ v) => {
  const [major, minor, patch] = v.split("-")[0].split(".").map((n) => Number(n) || 0);
  return `${major}.${minor}.${patch + 1}`;
};

const highest = (/** @type {string[]} */ versions) => versions.reduce((a, b) => (a === null || newer(b, a) ? b : a), /** @type {string | null} */ (null));

/**
 * @param {object} o
 * @param {string} o.version              package.json
 * @param {string[] | null} o.npmVersions null: the package is not on npm
 * @param {string | null} o.lastTag       highest vX.Y.Z tag
 * @param {boolean} o.changed             shipped files differ from the last tag (no tag: from HEAD)
 * @returns {{ publish: boolean, tag: boolean, version: string, reason: string }}
 */
export function planRelease(o) {
  if (o.npmVersions === null) {
    return { publish: false, tag: false, version: o.version, reason: "not on npm yet: publish a placeholder 0.0.0 by hand and make this repo its trusted publisher (npm trust github)" };
  }
  const last = highest([...o.npmVersions, ...(o.lastTag ? [o.lastTag.replace(/^v/, "")] : [])]);
  if (last === null || newer(o.version, last)) return { publish: true, tag: true, version: o.version, reason: `v${o.version} (package.json) is newer than npm and the tags` };
  if (!o.changed) {
    if (!o.lastTag && o.npmVersions.includes(o.version)) return { publish: false, tag: true, version: o.version, reason: `v${o.version} is on npm without a tag: tagging it` };
    return { publish: false, tag: false, version: last ?? o.version, reason: `nothing changed since ${o.lastTag ?? `v${o.version}`}` };
  }
  const version = last === null || newer(o.version, last) ? o.version : bump(last);
  return { publish: true, tag: true, version, reason: o.lastTag ? `changed since ${o.lastTag}` : "changed since the first publish" };
}

const git = (/** @type {string[]} */ args) => execFileSync("git", args, { encoding: "utf8" }).trim();

/** package.json without its version, for comparing. */
const pkgShape = (/** @type {string} */ text) => {
  const { version, ...rest } = JSON.parse(text);
  void version;
  return JSON.stringify(rest);
};

function changedSince(/** @type {string} */ ref) {
  try {
    execFileSync("git", ["diff", "--quiet", ref, "--", ...SHIPPED], { stdio: "ignore" });
  } catch {
    return true;
  }
  return pkgShape(git(["show", `${ref}:package.json`])) !== pkgShape(readFileSync("package.json", "utf8"));
}

function npmVersions(/** @type {string} */ name) {
  try {
    const out = execFileSync("npm", ["view", name, "versions", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const v = JSON.parse(out || "[]");
    return Array.isArray(v) ? v : [String(v)];
  } catch (e) {
    const err = /** @type {{ stdout?: string, stderr?: string }} */ (e);
    if (/E404|404 Not Found/.test(`${err.stdout ?? ""}${err.stderr ?? ""}`)) return null;
    throw e;
  }
}

function cli() {
  if (process.argv[2] !== "plan") throw new Error("usage: node scripts/release.js plan");
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const tags = git(["tag", "--list", "v*"]).split("\n").filter((t) => /^v\d+\.\d+\.\d+$/.test(t));
  const lastTag = highest(tags.map((t) => t.slice(1)));
  const plan = planRelease({
    version: pkg.version,
    npmVersions: npmVersions(pkg.name),
    lastTag: lastTag ? `v${lastTag}` : null,
    changed: changedSince(lastTag ? `v${lastTag}` : "HEAD"),
  });
  console.log(Object.entries(plan).map(([k, v]) => `${k}=${v}`).join("\n"));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) cli();
