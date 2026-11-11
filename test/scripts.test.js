// @ts-check
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { planRelease } from "../scripts/release.js";
import { normalize, syncSpec } from "../scripts/sync-spec.js";
import { newer, noUpdateVar, updateNotice } from "../src/update.js";
import { fixtureSpec, sendJson, startServer, tempDir } from "./helpers.js";

/** @type {Awaited<ReturnType<typeof startServer>>} */
let server;
/** @type {any} */
let served = fixtureSpec();
before(async () => {
  server = await startServer((r, res) => {
    if (r.url === "/example/latest") return sendJson(res, 200, { version: "0.2.0" });
    if (typeof served === "string") return void (res.writeHead(200, { "content-type": "text/html" }), res.end(served));
    sendJson(res, 200, served);
  });
});
after(() => server.close());

describe("sync-spec", () => {
  it("writes the normalized spec only when it changed, and never an error page", async () => {
    const file = join(tempDir(), "openapi.json");
    const url = `${server.url}/openapi.json`;
    served = fixtureSpec();
    assert.deepEqual(await syncSpec({ url, file }), { changed: true, version: "1.0.0" });
    assert.equal(readFileSync(file, "utf8"), normalize(fixtureSpec()));
    assert.equal((await syncSpec({ url, file })).changed, false);
    served = { ...fixtureSpec(), info: { title: "Example API", version: "1.1.0" } };
    assert.deepEqual(await syncSpec({ url, file }), { changed: true, version: "1.1.0" });
    served = "<html>down</html>";
    const before = readFileSync(file, "utf8");
    await assert.rejects(syncSpec({ url, file }));
    assert.equal(readFileSync(file, "utf8"), before);
  });
});

describe("release plan", () => {
  it("waits for the first publish by hand", () => {
    assert.deepEqual(planRelease({ version: "0.1.0", npmVersions: null, lastTag: null, changed: true }).publish, false);
  });

  it("after the hand-made placeholder 0.0.0 the workflow publishes package.json's version, changed or not", () => {
    assert.deepEqual(planRelease({ version: "0.1.0", npmVersions: ["0.0.0"], lastTag: null, changed: false }), { publish: true, tag: true, version: "0.1.0", reason: "v0.1.0 (package.json) is newer than npm and the tags" });
    assert.equal(planRelease({ version: "0.1.0", npmVersions: ["0.0.0", "0.1.0"], lastTag: "v0.1.0", changed: false }).publish, false);
  });

  it("tags a first version published by hand, then releases the next patch on a change", () => {
    assert.deepEqual(planRelease({ version: "0.1.0", npmVersions: ["0.1.0"], lastTag: null, changed: false }), { publish: false, tag: true, version: "0.1.0", reason: "v0.1.0 is on npm without a tag: tagging it" });
    assert.deepEqual(planRelease({ version: "0.1.0", npmVersions: ["0.1.0"], lastTag: "v0.1.0", changed: true }).version, "0.1.1");
    assert.equal(planRelease({ version: "0.1.0", npmVersions: ["0.1.0", "0.1.1"], lastTag: "v0.1.1", changed: false }).publish, false);
  });

  it("a regenerated repo (package.json back at 0.1.0) still moves forward; a deliberate bump wins", () => {
    assert.equal(planRelease({ version: "0.1.0", npmVersions: ["0.1.0", "0.1.4"], lastTag: "v0.1.4", changed: true }).version, "0.1.5");
    assert.equal(planRelease({ version: "0.2.0", npmVersions: ["0.1.4"], lastTag: "v0.1.4", changed: true }).version, "0.2.0");
  });
});

describe("update notice", () => {
  it("compares versions", () => {
    assert.ok(newer("0.1.10", "0.1.9"));
    assert.ok(!newer("0.1.0", "0.1.0"));
    assert.ok(newer("1.0.0", "1.0.0-rc.1"));
    assert.equal(noUpdateVar("agentfetch"), "AGENTFETCH_NO_UPDATE_NOTIFIER");
  });

  it("asks the registry at most once a day and stays quiet outside a terminal, in CI or when switched off", async () => {
    const cacheDir = tempDir();
    const o = { bin: "example", npm: "example", version: "0.1.0", cacheDir, env: {}, isTTY: true, registry: server.url, now: 1_000_000 };
    assert.equal(await updateNotice(o), "example 0.2.0 is available (you have 0.1.0). Update: npm install -g example");
    const n = server.seen.length;
    assert.ok(await updateNotice({ ...o, now: 1_000_000 + 60_000 }));
    assert.equal(server.seen.length, n);
    for (const quiet of [{ isTTY: false }, { env: { CI: "true" } }, { env: { EXAMPLE_NO_UPDATE_NOTIFIER: "1" } }, { version: "0.2.0" }]) {
      assert.equal(await updateNotice({ ...o, ...quiet }), null, JSON.stringify(quiet));
    }
    writeFileSync(join(cacheDir, "update-check.json"), "not json");
    assert.ok(await updateNotice(o));
  });
});
