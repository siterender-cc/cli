// @ts-check
/**
 * The CLI: global options, the built-in commands (help, login, logout, spec) and one command per API operation.
 * Exit codes: 0 ok, 1 API error (or every item failed with -o text, or still pending), 2 usage, 3 network.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildCommands, buildRequest, findCommand, requestUrl, UsageError } from "./commands.js";
import { cacheDir, configFile, envNames, envValue, loadBrand, loadVersion, removeApiKey, resolveApiKey, ROOT, saveApiKey } from "./config.js";
import { commandHelp, mainHelp } from "./help.js";
import { send } from "./http.js";
import { json, render } from "./output.js";
import { loadSpec } from "./spec.js";
import { updateNotice } from "./update.js";

/**
 * @typedef {object} IO
 * @property {Record<string, string | undefined>} env
 * @property {NodeJS.ReadStream | { isTTY?: boolean } & AsyncIterable<any>} stdin
 * @property {{ write(s: string): unknown, isTTY?: boolean }} stdout
 * @property {{ write(s: string): unknown, isTTY?: boolean }} stderr
 * @property {string} [root]       package root (brand.json, package.json, openapi.json)
 * @property {typeof fetch} [fetchImpl]
 */

/** @typedef {{ apiKey?: string, baseUrl?: string, specUrl?: string, offline: boolean, output: string, data?: string, timeout?: number, maxWait?: number, help: boolean, version: boolean, rest: string[] }} Globals */

const VALUE_OPTIONS = /** @type {const} */ ({ "--api-key": "apiKey", "--base-url": "baseUrl", "--spec-url": "specUrl", "-o": "output", "--output": "output", "-d": "data", "--data": "data", "--timeout": "timeout", "--max-wait": "maxWait" });

/** Takes the global options out of argv, anywhere before `--`. */
export function parseGlobals(/** @type {string[]} */ argv) {
  /** @type {Globals} */
  const g = { offline: false, output: "json", help: false, version: false, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      g.rest.push(...argv.slice(i));
      break;
    }
    if (arg === "-h" || arg === "--help") g.help = true;
    else if (arg === "-v" || arg === "--version") g.version = true;
    else if (arg === "--offline") g.offline = true;
    else {
      const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
      const name = eq === -1 ? arg : arg.slice(0, eq);
      const key = /** @type {Record<string, string>} */ (VALUE_OPTIONS)[name];
      if (!key) {
        g.rest.push(arg);
        continue;
      }
      let value;
      if (eq !== -1) value = arg.slice(eq + 1);
      else if (i + 1 < argv.length) value = argv[++i];
      else throw new UsageError(`${name} needs a value`);
      if (key === "timeout" || key === "maxWait") {
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0) throw new UsageError(`${name} needs a number of seconds, got "${value}"`);
        /** @type {any} */ (g)[key] = n;
      } else /** @type {any} */ (g)[key] = value;
    }
  }
  return g;
}

async function readAll(/** @type {AsyncIterable<any>} */ stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/** --data: JSON, @file or - (stdin). */
async function readData(/** @type {string} */ raw, /** @type {IO} */ io) {
  let text = raw;
  if (raw === "-") text = await readAll(/** @type {AsyncIterable<any>} */ (io.stdin));
  else if (raw.startsWith("@")) {
    try {
      text = readFileSync(raw.slice(1), "utf8");
    } catch (e) {
      throw new UsageError(`--data ${raw}: ${/** @type {Error} */ (e).message}`);
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new UsageError(`--data is not valid JSON`);
  }
}

/** Reads a line without echo (the API key). */
function promptHidden(/** @type {string} */ question, /** @type {any} */ stdin, /** @type {IO["stderr"]} */ stderr) {
  return new Promise((resolve, reject) => {
    stderr.write(question);
    let value = "";
    const done = () => {
      stdin.setRawMode?.(false);
      stdin.pause();
      stdin.off("data", onData);
      stderr.write("\n");
    };
    const onData = (/** @type {string} */ chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          done();
          return resolve(value);
        }
        if (ch === "\u0003") {
          done();
          return reject(new UsageError("cancelled"));
        }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.setRawMode?.(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    stdin.on("data", onData);
  });
}

/** @typedef {import("./config.js").Brand} Brand */

const BUILTIN_HELP = {
  login: (/** @type {Brand} */ { bin: b, envPrefix }) => `Usage: ${b} login [--api-key <key>]\n\nSaves your API key (asked without echo, or piped in: echo $KEY | ${b} login) to ~/.config/${b}/config.json, readable\nonly by you. --api-key and env ${envNames({ envPrefix }).apiKey[0]} take precedence over the saved key.\n`,
  logout: (/** @type {Brand} */ { bin: b }) => `Usage: ${b} logout\n\nRemoves the saved API key.\n`,
  spec: (/** @type {Brand} */ { bin: b }) => `Usage: ${b} spec [refresh]\n\nShows where the commands come from: the live API spec, cached for an hour, or the copy bundled with this version.\n\`refresh\` downloads it now.\n`,
};

const ago = (/** @type {number} */ ms) => (ms < 90_000 ? `${Math.round(ms / 1000)} s ago` : ms < 5_400_000 ? `${Math.round(ms / 60_000)} min ago` : `${Math.round(ms / 3_600_000)} h ago`);

/**
 * @param {string[]} argv
 * @param {IO} io
 * @returns {Promise<number>} exit code
 */
export async function main(argv, io) {
  const root = io.root ?? ROOT;
  const brand = loadBrand(root);
  const version = loadVersion(root);
  const { env, stdout, stderr } = io;
  const fail = (/** @type {Error} */ e) => {
    stderr.write(`${brand.bin}: ${e.message}\n`);
    return 2;
  };

  /** @type {Globals} */
  let g;
  try {
    g = parseGlobals(argv);
  } catch (e) {
    return fail(/** @type {Error} */ (e));
  }
  if (g.version) {
    stdout.write(`${version}\n`);
    return 0;
  }

  const userAgent = `${brand.bin}-cli/${version} (+https://${brand.domain})`;
  const vars = envNames(brand);
  const cache = cacheDir(env, brand.bin);
  const notice = updateNotice({ bin: brand.bin, npm: brand.npm, version, cacheDir: cache, env, isTTY: !!stderr.isTTY, fetchImpl: io.fetchImpl });
  let code;
  try {
    code = await run(g);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    code = fail(e);
  }
  const line = await notice;
  if (line) stderr.write(`${line}\n`);
  return code;

  /** @param {Globals} g */
  async function run(g) {
    const [name, ...args] = g.rest;
    const specUrl = g.specUrl ?? envValue(env, ...vars.specUrl) ?? brand.specUrl;
    const spec = () =>
      loadSpec({
        url: specUrl,
        cacheDir: cache,
        bundledPath: join(root, "openapi.json"),
        offline: g.offline,
        headers: { "User-Agent": userAgent },
        fetchImpl: io.fetchImpl,
      });

    const builtin = BUILTIN_HELP[/** @type {keyof typeof BUILTIN_HELP} */ (name === "help" ? args[0] : name)];
    if (builtin && (g.help || name === "help")) {
      stdout.write(builtin(brand));
      return 0;
    }
    if (name === "login") {
      let key = g.apiKey;
      if (!key) key = io.stdin.isTTY ? await promptHidden("API key: ", io.stdin, stderr) : (await readAll(/** @type {AsyncIterable<any>} */ (io.stdin))).trim();
      if (!key || /\s/.test(key)) throw new UsageError("no API key given (paste it at the prompt, pipe it in, or pass --api-key)");
      const file = configFile(env, brand.bin);
      saveApiKey(file, key);
      stderr.write(`Saved the API key to ${file} (readable only by you).\n`);
      return 0;
    }
    if (name === "logout") {
      const file = configFile(env, brand.bin);
      stderr.write(removeApiKey(file) ? `Removed the saved API key from ${file}.\n` : "No saved API key.\n");
      return 0;
    }
    if (name === "spec") {
      if (args[0] !== undefined && args[0] !== "refresh") throw new UsageError(`unknown "spec ${args[0]}" (spec, spec refresh)`);
      const refresh = args[0] === "refresh";
      if (refresh && g.offline) throw new UsageError("spec refresh cannot run --offline");
      const loaded = refresh
        ? await loadSpec({ url: specUrl, cacheDir: cache, bundledPath: join(root, "openapi.json"), force: true, headers: { "User-Agent": userAgent }, fetchImpl: io.fetchImpl })
        : await spec();
      const commands = buildCommands(loaded.spec);
      stdout.write(
        [
          `Spec:     ${loaded.url}`,
          `Source:   ${loaded.source}${loaded.fetchedAt ? ` (downloaded or checked ${ago(Date.now() - loaded.fetchedAt)})` : " (bundled with this version)"}${loaded.etag ? `, ETag ${loaded.etag}` : ""}`,
          // The brand's API name, not the spec's title: every site domain serves the same document.
          `API:      ${brand.apiName} ${loaded.spec.info?.version ?? ""}`.trimEnd(),
          `Commands: ${commands.map((c) => c.name).join(", ")}`,
          ...(loaded.error ? [`Note:     could not download it: ${loaded.error}`] : []),
          "",
        ].join("\n"),
      );
      return refresh && loaded.error ? 3 : 0;
    }

    const loaded = await spec();
    const commands = buildCommands(loaded.spec);
    if (name === undefined || (name === "help" && args.length === 0)) {
      stdout.write(mainHelp(brand, commands, loaded));
      return 0;
    }
    const helpFor = name === "help" ? args[0] : g.help ? name : null;
    const command = findCommand(commands, helpFor ?? name);
    if (!command) {
      const known = [...commands.flatMap((c) => [c.name, ...c.aliases]), "login", "logout", "spec"];
      throw new UsageError(`unknown command "${helpFor ?? name}". Commands: ${known.join(", ")} (see ${brand.bin} --help)`);
    }
    if (helpFor) {
      stdout.write(commandHelp(brand, command));
      return 0;
    }

    const data = g.data !== undefined ? await readData(g.data, io) : undefined;
    const req = buildRequest(command, args, data);
    let idempotencyKey = req.idempotencyKey;
    if (command.idempotencyKey && !idempotencyKey) {
      idempotencyKey = `cli_${randomUUID()}`;
      req.headers[command.idempotencyKey.path[0]] = idempotencyKey;
    }
    const baseUrl = g.baseUrl ?? envValue(env, ...vars.baseUrl) ?? brand.apiBaseUrl;
    if (!/^https?:\/\/[^/]/.test(baseUrl)) throw new UsageError(`the base URL must be http(s)://…, got "${baseUrl}"`);
    // The target comes from the base URL only: never from the spec's servers.
    const url = requestUrl(baseUrl, command, req);
    const { apiKey } = resolveApiKey(g.apiKey, env, brand);
    if (!apiKey && command.needsAuth) stderr.write(`${brand.bin}: no API key. Run \`${brand.bin} login\` or set ${vars.apiKey[0]}.\n`);

    const outcome = await send({
      url,
      method: command.method,
      headers: { Accept: "application/json", "User-Agent": userAgent, ...(apiKey && { Authorization: `Bearer ${apiKey}` }), ...req.headers },
      body: req.body,
      repeatable: command.method === "get" || !!idempotencyKey,
      timeoutMs: (g.timeout ?? 120) * 1000,
      maxWaitMs: (g.maxWait ?? 300) * 1000,
      onPending: ({ retryAfter }) => stderr.write(`${brand.bin}: still fetching, asking again in ${retryAfter} s (Idempotency-Key ${idempotencyKey})\n`),
      fetchImpl: io.fetchImpl,
    });
    const again = idempotencyKey ? `Run the same command again with --idempotency-key ${idempotencyKey} within 15 minutes to get the result without a new charge.` : undefined;

    if (outcome.kind === "ok") {
      const out = render(outcome.body, g.output, command.cli.output);
      stdout.write(out.stdout);
      if (out.stderr) stderr.write(out.stderr);
      return out.failed ? 1 : 0;
    }
    if (outcome.kind === "network") {
      stderr.write(json({ error: { tag: "CONNECTION_ERROR", message: outcome.error }, requestId: outcome.requestId, ...(idempotencyKey && { idempotencyKey, hint: `The API may have received the request. ${again}` }) }));
      return 3;
    }
    const body = outcome.body && typeof outcome.body === "object" && !Array.isArray(outcome.body) ? outcome.body : { error: { message: String(outcome.body ?? "").slice(0, 2000) } };
    stderr.write(json({ status: outcome.status, ...body, requestId: body.requestId ?? outcome.requestId, ...(idempotencyKey && { idempotencyKey }), ...(outcome.kind === "pending" && again && { hint: `Still fetching. ${again}` }) }));
    return 1;
  }
}
