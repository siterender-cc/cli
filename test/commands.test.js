// @ts-check
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildCommands, buildRequest, commandName, findCommand, kebab, merge, requestUrl, UsageError } from "../src/commands.js";
import { exampleLine } from "../src/help.js";
import { fixtureSpec } from "./helpers.js";

const fetchCmd = () => /** @type {import("../src/commands.js").Command} */ (findCommand(buildCommands(fixtureSpec()), "fetch"));

describe("command names", () => {
  it("x-cli.command and aliases, else the operationId without get/list/create", () => {
    const commands = buildCommands(fixtureSpec());
    assert.deepEqual(commands.map((c) => [c.name, c.aliases]), [["fetch", ["contents"]], ["account", []]]);
    assert.equal(findCommand(commands, "contents")?.name, "fetch");
    assert.equal(commandName("getContents", "post", "/v1/contents"), "contents");
    assert.equal(commandName("listCrawlJobs", "get", "/x"), "crawl-jobs");
    assert.equal(commandName("searchWeb", "post", "/x"), "search-web");
    assert.equal(commandName(undefined, "post", "/v1/contents"), "post-v1-contents");
    assert.equal(kebab("Idempotency-Key"), "idempotency-key");
    assert.equal(kebab("maxCharacters"), "max-characters");
  });

  it("without x-cli hints (today's live spec) the only required array is positional", () => {
    const spec = fixtureSpec();
    delete (/** @type {any} */ (spec.paths["/v1/contents"].post))["x-cli"];
    const c = /** @type {import("../src/commands.js").Command} */ (findCommand(buildCommands(spec), "contents"));
    assert.equal(c.positional, "urls");
    assert.deepEqual(buildRequest(c, ["https://a.example"]).body, { urls: ["https://a.example"] });
  });

  it("an operation marked x-cli.hidden has no command; security decides needsAuth", () => {
    const spec = /** @type {any} */ (fixtureSpec());
    spec.paths["/v1/account"].get["x-cli"].hidden = true;
    spec.paths["/healthz"] = { get: { operationId: "getHealth", security: [] } };
    const commands = buildCommands(spec);
    assert.equal(findCommand(commands, "account"), null);
    assert.equal(findCommand(commands, "health")?.needsAuth, false);
    assert.equal(findCommand(commands, "fetch")?.needsAuth, true);
  });
});

describe("buildRequest", () => {
  it("rejects what the spec does not allow", () => {
    const c = fetchCmd();
    for (const [args, re] of /** @type {[string[], RegExp][]} */ ([
      [["--nope", "1"], /unknown option --nope/],
      [[], /needs urls: pass it as an argument or with --urls/],
      [["x", "--text.verbosity", "loud"], /must be one of "compact", "full"/],
      [["x", "--livecrawl-timeout", "abc"], /needs an integer/],
      [["x", "--max-age-hours", "3"], /must be one of 0/],
      [["x", "--render=maybe"], /needs true or false/],
      [["x", "--no-text", "--text.max-characters", "5"], /cannot be combined/],
      [["x", "--country-code"], /needs a value/],
    ])) assert.throws(() => buildRequest(c, args), (e) => e instanceof UsageError && re.test(e.message), args.join(" "));
  });

  it("flags override --data, deep", () => {
    const req = buildRequest(fetchCmd(), ["--text.max-characters", "5"], { urls: ["a"], text: { verbosity: "full" }, extra: 1 });
    assert.deepEqual(req.body, { urls: ["a"], text: { verbosity: "full", maxCharacters: 5 }, extra: 1 });
    assert.deepEqual(merge({ a: { b: 1, c: 2 } }, { a: { b: 3 } }), { a: { b: 3, c: 2 } });
  });

  it("--text alone is true; header parameters become headers", () => {
    const req = buildRequest(fetchCmd(), ["x", "--text", "--idempotency-key", "abc12345"]);
    assert.deepEqual(req.body, { urls: ["x"], text: true });
    assert.deepEqual(req.headers, { "Idempotency-Key": "abc12345" });
    assert.equal(req.idempotencyKey, "abc12345");
  });
});

describe("requestUrl", () => {
  it("stays on the base URL's origin and encodes path parameters", () => {
    const spec = /** @type {any} */ (fixtureSpec());
    spec.paths["/v1/jobs/{id}"] = { get: { operationId: "getJob", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }, { name: "full", in: "query", schema: { type: "boolean" } }] } };
    spec.paths["//evil.example/x"] = { get: { operationId: "getEvil" } };
    const commands = buildCommands(spec);
    const job = /** @type {any} */ (findCommand(commands, "job"));
    const url = requestUrl("https://livewebdata.com/api", job, buildRequest(job, ["--id", "a/b?c", "--full"]));
    assert.equal(url.href, "https://livewebdata.com/api/v1/jobs/a%2Fb%3Fc?full=true");
    const evil = /** @type {any} */ (findCommand(commands, "evil"));
    assert.equal(requestUrl("https://livewebdata.com/api", evil, buildRequest(evil, [])).origin, "https://livewebdata.com");
  });
});

describe("help", () => {
  it("turns the first request example into a command line", () => {
    assert.equal(exampleLine("fetchmcp", fetchCmd()), "fetchmcp fetch https://example.com/article");
  });
});
