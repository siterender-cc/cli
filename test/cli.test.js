// @ts-check
import assert from "node:assert/strict";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { BRAND, cliEnv, fixtureSpec, runCli, sendJson, startServer, tempDir } from "./helpers.js";

const KEY = "1337_test_cli000000000000000000000000";

/** @type {Awaited<ReturnType<typeof startServer>>} */
let api;
/** @type {any} */
let spec = fixtureSpec();
/** @type {(r: import("./helpers.js").Seen, res: import("node:http").ServerResponse) => boolean} */
let override = () => false;

const page = (/** @type {string} */ url) => ({ id: url, url, title: "T", markdown: `# ${url}`, text: url });
const ok = (/** @type {string[]} */ urls) => ({ requestId: "req_ok", results: urls.map(page), statuses: urls.map((u) => ({ id: u, status: "success", error: null })) });

before(async () => {
  api = await startServer((r, res) => {
    if (override(r, res)) return;
    if (r.url === "/openapi.json") return sendJson(res, 200, spec, { etag: '"v1"' });
    if (r.url === "/api/v1/account") {
      if (r.headers.authorization !== `Bearer ${KEY}`) return sendJson(res, 401, { error: { code: 401, tag: "INVALID_API_KEY", message: "Invalid API key." }, requestId: "req_401" }, { "x-request-id": "req_401" });
      return sendJson(res, 200, { plan: "starter", credits: { total: 5 } });
    }
    if (r.url === "/api/v1/contents") return sendJson(res, 200, ok(JSON.parse(r.body).urls));
    sendJson(res, 404, { error: { code: 404, tag: "NOT_FOUND", message: r.url } });
  });
});
after(() => api.close());

/** Env against the test server, with a valid key unless `extra` says otherwise. */
const env = (/** @type {string} */ home, /** @type {Record<string, string>} */ extra = {}) =>
  cliEnv(home, { LIVE_WEB_DATA_SPEC_URL: `${api.url}/openapi.json`, LIVE_WEB_DATA_API_BASE_URL: `${api.url}/api`, LIVE_WEB_DATA_API_KEY: KEY, ...extra });
/** The same without a key. */
const noKey = (/** @type {string} */ home, /** @type {Record<string, string>} */ extra = {}) => {
  /** @type {Record<string, string>} */
  const rest = env(home);
  delete rest.LIVE_WEB_DATA_API_KEY;
  return { ...rest, ...extra };
};

const lastBody = (/** @type {string} */ path) => JSON.parse([...api.seen].reverse().find((r) => r.url === path)?.body ?? "null");

describe("commands follow the spec", () => {
  it("a field the API adds gets a flag, and a new operation a command, without a code change", async () => {
    spec = fixtureSpec();
    spec.components.schemas.ContentsRequest.properties.screenshot = { type: "boolean", description: "New: attach a screenshot." };
    spec.components.schemas.ContentsRequest.properties.extract = { type: "object", properties: { selector: { type: "string" } } };
    spec.paths["/v1/search"] = { post: { operationId: "searchWeb", summary: "Search the web", requestBody: { content: { "application/json": { schema: { type: "object", required: ["query"], properties: { query: { type: "string" } } } } } } } };
    override = (r, res) => (r.url === "/api/v1/search" ? (sendJson(res, 200, { hits: [JSON.parse(r.body).query] }), true) : false);
    const home = tempDir();

    const help = await runCli(["fetch", "--help"], { env: env(home) });
    assert.match(help.stdout, /--screenshot, --no-screenshot\s+New: attach a screenshot\./);
    assert.match(help.stdout, /--extract\.selector <string>/);

    const r = await runCli(["fetch", "https://a.example", "--screenshot", "--extract.selector", "main"], { env: env(home) });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(lastBody("/api/v1/contents"), { urls: ["https://a.example"], screenshot: true, extract: { selector: "main" } });

    const s = await runCli(["search-web", "--query", "mcp"], { env: env(home) });
    assert.equal(s.code, 0, s.stderr);
    assert.deepEqual(JSON.parse(s.stdout), { hits: ["mcp"] });
    assert.match((await runCli(["--help"], { env: env(home) })).stdout, /search-web\s+Search the web/);
    spec = fixtureSpec();
    override = () => false;
  });

  it("the cached spec is used within the hour: no second download", async () => {
    const home = tempDir();
    const before = api.seen.filter((r) => r.url === "/openapi.json").length;
    await runCli(["fetch", "--help"], { env: env(home) });
    await runCli(["account", "--help"], { env: env(home) });
    assert.equal(api.seen.filter((r) => r.url === "/openapi.json").length, before + 1);
  });

  it("without the network the commands come from the bundled spec", async () => {
    const home = tempDir();
    const r = await runCli(["--help"], { env: cliEnv(home, { LIVE_WEB_DATA_SPEC_URL: "http://127.0.0.1:9/openapi.json" }) });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout.replace(/\s+/g, " "), /now: the copy bundled with this version/);
    assert.match(r.stdout, /account/);
  });
});

describe("requests", () => {
  it("sends the key only to the base URL, never to a server the spec names", async () => {
    const trap = await startServer((_r, res) => sendJson(res, 200, {}));
    spec = fixtureSpec({ serverUrl: `${trap.url}/api` });
    const home = tempDir();
    const r = await runCli(["account"], { env: env(home) });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(trap.seen.length, 0);
    const call = [...api.seen].reverse().find((x) => x.url === "/api/v1/account");
    assert.equal(call?.headers.authorization, `Bearer ${KEY}`);
    assert.match(String(call?.headers["user-agent"]), new RegExp(`^${BRAND.bin}-cli/\\d+\\.\\d+\\.\\d+ \\(\\+https://${BRAND.domain.replace(".", "\\.")}\\)$`));
    await trap.close();
    spec = fixtureSpec();
  });

  it("maps flags, nested flags, toggles, the spec's own spelling and positional URLs", async () => {
    const home = tempDir();
    const r = await runCli(["fetch", "https://a.example", "https://b.example", "--countryCode", "de", "--text.max-characters", "500", "--text.verbosity=full", "--render", "--no-html"], { env: env(home) });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(lastBody("/api/v1/contents"), { urls: ["https://a.example", "https://b.example"], countryCode: "de", text: { maxCharacters: 500, verbosity: "full" }, render: true, html: false });
    await runCli(["contents", "--urls", "https://c.example", "--no-text"], { env: env(home) });
    assert.deepEqual(lastBody("/api/v1/contents"), { urls: ["https://c.example"], text: false });
  });

  it("merges --data under the flags: JSON, @file and stdin", async () => {
    const home = tempDir();
    await runCli(["fetch", "--data", '{"urls":["https://a.example"],"countryCode":"de","text":{"verbosity":"full"}}', "--country-code", "fr", "--text.max-characters", "9"], { env: env(home) });
    assert.deepEqual(lastBody("/api/v1/contents"), { urls: ["https://a.example"], countryCode: "fr", text: { verbosity: "full", maxCharacters: 9 } });
    const file = join(home, "body.json");
    writeFileSync(file, '{"urls":["https://file.example"],"futureField":{"x":1}}');
    await runCli(["fetch", "-d", `@${file}`], { env: env(home) });
    assert.deepEqual(lastBody("/api/v1/contents"), { urls: ["https://file.example"], futureField: { x: 1 } });
    await runCli(["fetch", "--data", "-"], { env: env(home), stdin: '{"urls":["https://stdin.example"]}' });
    assert.deepEqual(lastBody("/api/v1/contents"), { urls: ["https://stdin.example"] });
  });

  it("sends an Idempotency-Key and keeps it across a retry and a 202", async () => {
    let calls = 0;
    override = (r, res) => {
      if (r.url !== "/api/v1/contents") return false;
      calls++;
      if (calls === 1) sendJson(res, 503, { error: { code: 503, tag: "SERVICE_UNAVAILABLE", message: "busy" } });
      else if (calls === 2) sendJson(res, 202, { status: "pending", requestId: "req_p", idempotencyKey: r.headers["idempotency-key"], retryAfter: 1 }, { "retry-after": "1" });
      else sendJson(res, 200, ok(["https://a.example"]));
      return true;
    };
    const home = tempDir();
    const r = await runCli(["fetch", "https://a.example"], { env: env(home) });
    override = () => false;
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /still fetching, asking again in 1 s/);
    const keys = api.seen.filter((x) => x.url === "/api/v1/contents").slice(-3).map((x) => x.headers["idempotency-key"]);
    assert.equal(new Set(keys).size, 1);
    assert.match(String(keys[0]), /^cli_[0-9a-f-]{36}$/);
    await runCli(["fetch", "https://a.example", "--idempotency-key", "my-key-123"], { env: env(home) });
    assert.equal(api.seen.at(-1)?.headers["idempotency-key"], "my-key-123");
  });
});

describe("output and exit codes", () => {
  it("prints JSON by default, content with -o text, a field with -o <field>", async () => {
    const home = tempDir();
    const json = await runCli(["fetch", "https://a.example"], { env: env(home) });
    assert.equal(JSON.parse(json.stdout).requestId, "req_ok");
    const text = await runCli(["fetch", "https://a.example", "https://b.example", "-o", "text"], { env: env(home) });
    assert.equal(text.stdout, "==> https://a.example <==\n# https://a.example\n\n==> https://b.example <==\n# https://b.example\n");
    const title = await runCli(["fetch", "https://a.example", "-o", "title"], { env: env(home) });
    assert.equal(title.stdout, "T\n");
    const account = await runCli(["account", "-o", "text"], { env: env(home) });
    assert.equal(account.stdout, "plan: starter\ncredits.total: 5\n");
  });

  it("-o text: failed URLs go to stderr; exit 1 when none succeeded", async () => {
    override = (r, res) =>
      r.url === "/api/v1/contents"
        ? (sendJson(res, 200, { requestId: "r", results: [], statuses: [{ id: "https://x.example", status: "error", error: { tag: "CRAWL_NOT_FOUND", message: "404" } }] }), true)
        : false;
    const home = tempDir();
    const r = await runCli(["fetch", "https://x.example", "-o", "text"], { env: env(home) });
    override = () => false;
    assert.equal(r.code, 1);
    assert.equal(r.stderr, "https://x.example: CRAWL_NOT_FOUND: 404\n");
  });

  it("an API error is JSON on stderr with exit 1, and says how to add a key", async () => {
    const home = tempDir();
    const r = await runCli(["account"], { env: noKey(home) });
    assert.equal(r.code, 1);
    assert.equal(r.stdout, "");
    assert.ok(r.stderr.startsWith(`${BRAND.bin}: no API key. Run \`${BRAND.bin} login\``), r.stderr);
    const body = JSON.parse(r.stderr.slice(r.stderr.indexOf("{")));
    assert.equal(body.status, 401);
    assert.equal(body.error.tag, "INVALID_API_KEY");
    assert.equal(body.requestId, "req_401");
  });

  it("usage errors exit 2; a network error exits 3 with the Idempotency-Key", async () => {
    const home = tempDir();
    for (const args of [["fetch", "--nope"], ["fetch"], ["fetch", "x", "--text.verbosity", "loud"], ["fetch", "x", "--livecrawl-timeout", "1.5"], ["nope"], ["fetch", "x", "--data", "{bad"]]) {
      const r = await runCli(args, { env: env(home) });
      assert.equal(r.code, 2, `${args.join(" ")}: ${r.stderr}`);
      assert.ok(r.stderr.startsWith(`${BRAND.bin}: `), r.stderr);
    }
    const net = await runCli(["fetch", "https://a.example", "--timeout", "2"], { env: env(home, { LIVE_WEB_DATA_API_BASE_URL: "http://127.0.0.1:9/api" }) });
    assert.equal(net.code, 3);
    const body = JSON.parse(net.stderr);
    assert.equal(body.error.tag, "CONNECTION_ERROR");
    assert.match(body.idempotencyKey, /^cli_/);
  });

  it("--version prints the package version", async () => {
    const r = await runCli(["--version"], { env: cliEnv(tempDir()) });
    assert.equal(r.stdout.trim(), JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
  });
});

describe("login", () => {
  it("saves the key readable only by the owner; --api-key and env win over it; logout removes it", async () => {
    const home = tempDir();
    const r = await runCli(["login"], { env: noKey(home), stdin: `${KEY}\n` });
    assert.equal(r.code, 0, r.stderr);
    const file = join(home, "config", BRAND.bin, "config.json");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(join(home, "config", BRAND.bin)).mode & 0o777, 0o700);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { apiKey: KEY });

    assert.equal((await runCli(["account"], { env: noKey(home) })).code, 0);
    assert.equal((await runCli(["account"], { env: noKey(home, { LIVE_WEB_DATA_API_KEY: "1337_test_wrong" }) })).code, 1);
    assert.equal((await runCli(["account", "--api-key", "1337_test_wrong"], { env: noKey(home) })).code, 1);

    const out = await runCli(["logout"], { env: noKey(home) });
    assert.match(out.stderr, /Removed the saved API key/);
    assert.equal((await runCli(["account"], { env: noKey(home) })).code, 1);
    assert.equal((await runCli(["login"], { env: noKey(home), stdin: "" })).code, 2);
  });
});

describe("spec command", () => {
  it("shows the source; refresh exits 3 when the spec cannot be downloaded", async () => {
    const home = tempDir();
    const r = await runCli(["spec"], { env: env(home) });
    assert.match(r.stdout, /Source:   network/);
    assert.match(r.stdout, /Commands: fetch, account/);
    const again = await runCli(["spec", "refresh"], { env: env(home) });
    assert.equal(again.code, 0);
    assert.match(again.stdout, /ETag "v1"/);
    const down = await runCli(["spec", "refresh"], { env: env(home, { LIVE_WEB_DATA_SPEC_URL: "http://127.0.0.1:9/openapi.json" }) });
    assert.equal(down.code, 3);
    assert.match(down.stdout, /could not download it/);
  });
});
