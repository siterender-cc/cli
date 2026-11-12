// @ts-check
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { configFile, envNames, resolveApiKey, saveApiKey } from "../src/config.js";
import { main } from "../src/main.js";
import { BRAND, cliEnv, fixtureSpec, tempDir } from "./helpers.js";

/** A made-up site's brand, shaped like the generated brand.json: the tests run unchanged in every site's repo. */
const SITE = {
  ...BRAND,
  name: "Example",
  domain: "example.com",
  bin: "example",
  npm: "@example-com/cli",
  org: "example-com",
  siteUrl: "https://example.com",
  docsUrl: "https://example.com/docs",
  apiName: "Example API",
  envPrefix: "EXAMPLE",
  apiBaseUrl: "https://example.com/api",
  specUrl: "https://example.com/openapi.json",
};

/** The fallback names: read after the site's own, never named in help or errors. */
const FALLBACKS = /LIVE_WEB_DATA/;

/**
 * Runs main() in-process as SITE's CLI (a package root with its brand.json and the fixture spec bundled). Every
 * request goes to a stand-in fetch that records it and answers with the fixture spec or `{ plan }`.
 */
async function runSite(/** @type {string[]} */ args, /** @type {Record<string, string>} */ extra = {}) {
  const root = tempDir();
  writeFileSync(join(root, "brand.json"), JSON.stringify(SITE));
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "0.1.0" }));
  writeFileSync(join(root, "openapi.json"), JSON.stringify({ ...fixtureSpec(), info: { title: "The Spec's Own Title", version: "1.0.0" } }));
  /** @type {{ url: string, headers: Record<string, string> }[]} */
  const calls = [];
  /** @type {typeof fetch} */
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), headers: /** @type {Record<string, string>} */ (init?.headers ?? {}) });
    const body = String(url).endsWith("/openapi.json") ? fixtureSpec() : { plan: "starter" };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  let stdout = "";
  let stderr = "";
  const code = await main(args, {
    env: cliEnv(tempDir(), extra),
    stdin: { isTTY: false, async *[Symbol.asyncIterator]() {} },
    stdout: { write: (/** @type {string} */ s) => (stdout += s) },
    stderr: { write: (/** @type {string} */ s) => (stderr += s) },
    root,
    fetchImpl,
  });
  return { code, stdout, stderr, calls };
}

describe("environment variables", () => {
  it("the site's own first, then LIVE_WEB_DATA_*", () => {
    assert.deepEqual(envNames(SITE), {
      apiKey: ["EXAMPLE_API_KEY", "LIVE_WEB_DATA_API_KEY"],
      baseUrl: ["EXAMPLE_API_BASE_URL", "LIVE_WEB_DATA_API_BASE_URL"],
      specUrl: ["EXAMPLE_SPEC_URL", "LIVE_WEB_DATA_SPEC_URL"],
    });
  });

  it("each name once when the site's own prefix is LIVE_WEB_DATA", () => {
    assert.deepEqual(envNames({ envPrefix: "LIVE_WEB_DATA" }), {
      apiKey: ["LIVE_WEB_DATA_API_KEY"],
      baseUrl: ["LIVE_WEB_DATA_API_BASE_URL"],
      specUrl: ["LIVE_WEB_DATA_SPEC_URL"],
    });
  });

  it("the key: --api-key, the site's variable, LIVE_WEB_DATA_API_KEY, the saved key; `from` names the one used", () => {
    const env = cliEnv(tempDir());
    const file = configFile(env, SITE.bin);
    saveApiKey(file, "saved");
    const all = { ...env, EXAMPLE_API_KEY: "own", LIVE_WEB_DATA_API_KEY: "lwd", OTHER_API_KEY: "legacy" };
    assert.deepEqual(resolveApiKey("flag", all, SITE), { apiKey: "flag", from: "--api-key" });
    assert.deepEqual(resolveApiKey(undefined, all, SITE), { apiKey: "own", from: "EXAMPLE_API_KEY" });
    assert.deepEqual(resolveApiKey(undefined, { ...all, EXAMPLE_API_KEY: "" }, SITE), { apiKey: "lwd", from: "LIVE_WEB_DATA_API_KEY" });
    // No other variable is read: a key in any other variable is never picked up or sent.
    assert.deepEqual(resolveApiKey(undefined, { ...env, OTHER_API_KEY: "legacy" }, SITE), { apiKey: "saved", from: file });
    assert.deepEqual(resolveApiKey(undefined, env, SITE), { apiKey: "saved", from: file });
  });

  it("requests go to the site's own domain; its variables win over LIVE_WEB_DATA_*; no other variable is read", async () => {
    const plain = await runSite(["account", "--offline"], { EXAMPLE_API_KEY: "own" });
    assert.equal(plain.code, 0, plain.stderr);
    assert.equal(plain.calls[0]?.url, "https://example.com/api/v1/account");
    assert.equal(plain.calls[0]?.headers["User-Agent"], "example-cli/0.1.0 (+https://example.com)");

    const sent = async (/** @type {Record<string, string>} */ extra) => (await runSite(["account", "--offline"], extra)).calls.map((c) => `${c.url} ${c.headers.Authorization}`);
    const legacy = { OTHER_API_BASE_URL: "https://legacy.test/api", OTHER_API_KEY: "legacy" };
    const lwd = { ...legacy, LIVE_WEB_DATA_API_BASE_URL: "https://lwd.test/api", LIVE_WEB_DATA_API_KEY: "lwd" };
    assert.deepEqual(await sent({ ...lwd, EXAMPLE_API_BASE_URL: "https://own.test/api", EXAMPLE_API_KEY: "own" }), ["https://own.test/api/v1/account Bearer own"]);
    assert.deepEqual(await sent(lwd), ["https://lwd.test/api/v1/account Bearer lwd"]);
    // Any other variable is ignored: neither its base URL nor its key is used.
    for (const line of await sent(legacy)) assert.ok(line.startsWith("https://example.com/api/") && !line.includes("legacy"), line);
  });

  it("the spec comes from the site's own domain; EXAMPLE_SPEC_URL wins over LIVE_WEB_DATA_SPEC_URL", async () => {
    const asked = async (/** @type {Record<string, string>} */ extra) => (await runSite(["spec", "refresh"], extra)).calls.map((c) => c.url);
    assert.deepEqual(await asked({}), ["https://example.com/openapi.json"]);
    assert.deepEqual(await asked({ EXAMPLE_SPEC_URL: "https://own.test/openapi.json", LIVE_WEB_DATA_SPEC_URL: "https://lwd.test/openapi.json" }), ["https://own.test/openapi.json"]);
    assert.deepEqual(await asked({ LIVE_WEB_DATA_SPEC_URL: "https://lwd.test/openapi.json" }), ["https://lwd.test/openapi.json"]);
    // The API is named after the site, not after the spec's own title (the same document on every domain).
    const shown = (await runSite(["spec", "--offline"])).stdout;
    assert.match(shown, /^API: {6}Example API 1\.0\.0$/m);
    assert.doesNotMatch(shown, /Own Title/);
  });

  it("help, login help and the missing-key hint name only the site's own variables", async () => {
    const help = await runSite(["--help", "--offline"]);
    assert.equal(help.code, 0, help.stderr);
    const flat = help.stdout.replace(/\s+/g, " ");
    // The first line says what the tool does, not a tagline.
    assert.ok(flat.startsWith("The example command line client for the Example API: live web pages as clean Markdown, text or HTML. Usage: example <command>"), help.stdout);
    assert.match(flat, /Default: env EXAMPLE_API_KEY, then the key saved by `example login`/);
    assert.match(flat, /Default: env EXAMPLE_API_BASE_URL, then https:\/\/example\.com\/api/);
    assert.match(flat, /Default: env EXAMPLE_SPEC_URL, then https:\/\/example\.com\/openapi\.json/);
    assert.doesNotMatch(help.stdout, FALLBACKS);

    const login = await runSite(["login", "--help"]);
    assert.match(login.stdout.replace(/\s+/g, " "), /--api-key and env EXAMPLE_API_KEY take precedence/);
    assert.doesNotMatch(login.stdout, FALLBACKS);

    const noKey = await runSite(["account", "--offline"]);
    assert.ok(noKey.stderr.startsWith("example: no API key. Run `example login` or set EXAMPLE_API_KEY.\n"), noKey.stderr);
    assert.doesNotMatch(noKey.stderr, FALLBACKS);
  });
});
