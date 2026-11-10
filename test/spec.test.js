// @ts-check
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { buildCommands } from "../src/commands.js";
import { commandHelp, mainHelp } from "../src/help.js";
import { isSpec, loadSpec, SPEC_TTL_MS } from "../src/spec.js";
import { fixtureSpec, ROOT, sendJson, startServer, tempDir } from "./helpers.js";

const BUNDLED = join(ROOT, "openapi.json");

/** @type {Awaited<ReturnType<typeof startServer>>} */
let server;
let mode = "ok";
before(async () => {
  server = await startServer((r, res) => {
    if (mode === "html") return void (res.writeHead(200, { "content-type": "text/html" }), res.end("<html>maintenance</html>"));
    if (mode === "down") return sendJson(res, 503, {});
    if (r.headers["if-none-match"] === '"e1"') return void (res.writeHead(304), res.end());
    sendJson(res, 200, fixtureSpec(), { etag: '"e1"' });
  });
});
after(() => server.close());

describe("loadSpec", () => {
  it("downloads, caches with the ETag, revalidates after the TTL with If-None-Match, falls back to the stale cache", async () => {
    mode = "ok";
    const dir = tempDir();
    const url = `${server.url}/openapi.json`;
    const t0 = 1_000_000;
    const first = await loadSpec({ url, cacheDir: dir, bundledPath: BUNDLED, now: t0 });
    assert.equal(first.source, "network");
    assert.equal(first.etag, '"e1"');
    assert.ok(existsSync(join(dir, "openapi.json")));

    const n = server.seen.length;
    const cached = await loadSpec({ url, cacheDir: dir, bundledPath: BUNDLED, now: t0 + 1000 });
    assert.equal(cached.source, "cache");
    assert.equal(server.seen.length, n);

    const revalidated = await loadSpec({ url, cacheDir: dir, bundledPath: BUNDLED, now: t0 + SPEC_TTL_MS + 1 });
    assert.equal(revalidated.source, "cache");
    assert.equal(server.seen.at(-1)?.headers["if-none-match"], '"e1"');
    assert.equal(revalidated.fetchedAt, t0 + SPEC_TTL_MS + 1);

    mode = "down";
    const stale = await loadSpec({ url, cacheDir: dir, bundledPath: BUNDLED, now: t0 + 3 * SPEC_TTL_MS });
    assert.equal(stale.source, "stale-cache");
    assert.match(String(stale.error), /HTTP 503/);
    assert.deepEqual(stale.spec, fixtureSpec());
  });

  it("never caches an answer that is not an OpenAPI document; uses the bundled copy instead", async () => {
    mode = "html";
    const dir = tempDir();
    const r = await loadSpec({ url: `${server.url}/openapi.json`, cacheDir: dir, bundledPath: BUNDLED });
    assert.equal(r.source, "bundled");
    assert.ok(!existsSync(join(dir, "openapi.json")));
    assert.deepEqual(r.spec, JSON.parse(readFileSync(BUNDLED, "utf8")));
  });

  it("--offline makes no request; a cache of another spec URL is ignored", async () => {
    mode = "ok";
    const dir = tempDir();
    const n = server.seen.length;
    assert.equal((await loadSpec({ url: `${server.url}/openapi.json`, cacheDir: dir, bundledPath: BUNDLED, offline: true })).source, "bundled");
    assert.equal(server.seen.length, n);
    writeFileSync(join(dir, "openapi.json"), JSON.stringify(fixtureSpec()));
    writeFileSync(join(dir, "openapi.meta.json"), JSON.stringify({ url: "https://other.example/openapi.json", etag: null, fetchedAt: Date.now() }));
    assert.equal((await loadSpec({ url: `${server.url}/openapi.json`, cacheDir: dir, bundledPath: BUNDLED, offline: true })).source, "bundled");
  });

  it("isSpec wants openapi 3 and a paths object", () => {
    assert.ok(isSpec({ openapi: "3.1.0", paths: {} }));
    for (const bad of [null, "x", { openapi: "2.0", paths: {} }, { swagger: "2.0", paths: {} }, { openapi: "3.0.0", paths: [] }, { openapi: "3.0.0" }]) assert.ok(!isSpec(bad));
  });
});

describe("the bundled spec", () => {
  it("is an OpenAPI document whose every command builds and renders help (the release workflow runs this after a spec sync)", () => {
    const spec = JSON.parse(readFileSync(BUNDLED, "utf8"));
    assert.ok(isSpec(spec));
    const commands = buildCommands(spec);
    assert.ok(commands.length > 0);
    const brand = JSON.parse(readFileSync(join(ROOT, "brand.json"), "utf8"));
    assert.ok(mainHelp(brand, commands, { source: "bundled" }).includes(commands[0].name));
    for (const c of commands) assert.ok(commandHelp(brand, c).startsWith(`${brand.bin} ${c.name}`));
  });
});
