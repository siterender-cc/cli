// @ts-check
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const BIN = join(ROOT, "bin", "cli.js");
/** This package's brand: the tests run unchanged in every site's repo. */
export const BRAND = JSON.parse(readFileSync(join(ROOT, "brand.json"), "utf8"));

/** A spec shaped like the live one: contents (with x-cli hints) and account. */
export function fixtureSpec(/** @type {{ serverUrl?: string }} */ o = {}) {
  return {
    openapi: "3.1.0",
    info: { title: "Example API", version: "1.0.0" },
    servers: [{ url: o.serverUrl ?? "https://example.com/api" }],
    security: [{ bearerAuth: [] }],
    paths: {
      "/v1/contents": {
        post: {
          operationId: "getContents",
          summary: "Fetch page contents",
          description: "Fetch 1–10 URLs live.",
          "x-cli": { command: "fetch", aliases: ["contents"], positional: "urls", output: { items: "results", fields: ["markdown", "text", "html"], heading: "url", errors: "statuses" } },
          parameters: [{ name: "Idempotency-Key", in: "header", required: false, description: "Your id for this request.", schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ContentsRequest" },
                examples: { single: { summary: "One URL", value: { urls: ["https://example.com/article"] } } },
              },
            },
          },
          responses: { "200": { description: "ok" } },
        },
      },
      "/v1/account": { get: { operationId: "getAccount", summary: "Get account status", "x-cli": { command: "account" }, responses: { "200": { description: "ok" } } } },
    },
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
      schemas: {
        ContentsRequest: {
          type: "object",
          required: ["urls"],
          properties: {
            urls: { type: "array", minItems: 1, maxItems: 10, items: { type: "string", format: "uri" }, description: "Pages to fetch." },
            countryCode: { type: "string", description: "Country." },
            text: {
              description: "Content options.",
              anyOf: [
                { type: "boolean" },
                { type: "object", properties: { maxCharacters: { type: "integer" }, verbosity: { type: "string", enum: ["compact", "full"] } }, additionalProperties: false },
              ],
            },
            maxAgeHours: { type: "number", const: 0, description: "Only 0." },
            html: { type: "boolean" },
            livecrawlTimeout: { type: "integer" },
            render: { type: "boolean" },
          },
          additionalProperties: false,
        },
      },
    },
  };
}

/**
 * @typedef {{ method: string, url: string, headers: import("node:http").IncomingHttpHeaders, body: string }} Seen
 * @typedef {(req: Seen, res: import("node:http").ServerResponse) => void} Handler
 */

/** A local HTTP server that records every request. */
export async function startServer(/** @type {Handler} */ handler) {
  /** @type {Seen[]} */
  const seen = [];
  const server = createServer((req, res) => {
    /** @type {Buffer[]} */
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const r = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
      seen.push(r);
      handler(r, res);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", () => r(undefined)));
  const addr = /** @type {import("node:net").AddressInfo} */ (server.address());
  return {
    url: `http://127.0.0.1:${addr.port}`,
    seen,
    close: () => new Promise((r) => server.close(() => r(undefined))),
  };
}

export const sendJson = (/** @type {import("node:http").ServerResponse} */ res, /** @type {number} */ status, /** @type {any} */ body, /** @type {Record<string, string>} */ headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

export const tempDir = () => mkdtempSync(join(tmpdir(), "lwda-cli-"));

/** Env for a CLI run: an empty home, no key, no update check, the given spec and API URLs. */
export function cliEnv(/** @type {string} */ home, /** @type {Record<string, string>} */ extra = {}) {
  return {
    PATH: process.env.PATH ?? "",
    HOME: home,
    XDG_CACHE_HOME: join(home, "cache"),
    XDG_CONFIG_HOME: join(home, "config"),
    NO_UPDATE_NOTIFIER: "1",
    ...extra,
  };
}

/**
 * Runs bin/cli.js in a child process (async: the test's own HTTP server keeps serving).
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string }>}
 */
export function runCli(/** @type {string[]} */ args, /** @type {{ env: Record<string, string>, stdin?: string }} */ o) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: o.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(o.stdin ?? "");
  });
}
