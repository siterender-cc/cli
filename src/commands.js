// @ts-check
/**
 * Commands and flags from the OpenAPI document. One command per operation: `x-cli.command`, else the operationId in
 * kebab case without a leading get/list/create (getContents → contents). Flags come from the operation's parameters
 * and the request body's properties, nested objects as dotted flags (--text.max-characters). A body field the API
 * adds tomorrow is a flag tomorrow, without a new CLI release; --data covers anything a flag cannot express.
 *
 * Optional hints in the operation's `x-cli` object: command, aliases[], positional (the body property positional
 * arguments fill), output { items, fields[], heading, errors } for `-o text`, hidden.
 */

export class UsageError extends Error {}

const METHODS = ["get", "post", "put", "patch", "delete"];

/** fooBar / Foo-Bar / foo_bar → foo-bar */
export function kebab(/** @type {string} */ s) {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

/** getContents → contents, getAccount → account; without an operationId: post-v1-contents. */
export function commandName(/** @type {string | undefined} */ operationId, /** @type {string} */ method, /** @type {string} */ path) {
  if (operationId) return kebab(operationId).replace(/^(get|list|create)-(?=.)/, "");
  return kebab(`${method} ${path}`);
}

/** Resolves a local $ref (#/…); anything else is returned as is. */
export function deref(/** @type {any} */ spec, /** @type {any} */ schema, depth = 0) {
  if (!schema || typeof schema !== "object" || typeof schema.$ref !== "string" || depth > 20) return schema;
  if (!schema.$ref.startsWith("#/")) return {};
  let node = spec;
  for (const part of schema.$ref.slice(2).split("/")) node = node?.[part.replace(/~1/g, "/").replace(/~0/g, "~")];
  return deref(spec, node ?? {}, depth + 1);
}

/**
 * @typedef {object} Flag
 * @property {string} name          kebab, dotted for nested body fields
 * @property {"body" | "header" | "query" | "path"} in
 * @property {string[]} path        body path, or [parameter name]
 * @property {"string" | "integer" | "number" | "boolean" | "array" | "json"} kind
 * @property {string} [itemKind]    array items
 * @property {boolean} [toggle]     a boolean-or-object field: --x / --no-x plus nested flags
 * @property {boolean} required
 * @property {boolean} hidden
 * @property {string} description
 * @property {any[]} [enum]
 * @property {string} [format]
 */

/**
 * @typedef {object} Command
 * @property {string} name
 * @property {string[]} aliases
 * @property {string} method
 * @property {string} path
 * @property {any} op
 * @property {any} cli               the x-cli hints ({} without)
 * @property {Flag[]} flags
 * @property {string | null} positional  body property filled by positional arguments
 * @property {boolean} hasBody
 * @property {string[]} requiredBody
 * @property {Flag | null} idempotencyKey
 * @property {boolean} needsAuth
 */

const typeOf = (/** @type {any} */ s) => {
  if (!s || typeof s !== "object") return undefined;
  const t = Array.isArray(s.type) ? s.type.find((/** @type {string} */ x) => x !== "null") : s.type;
  if (t) return t;
  if ("const" in s) return typeof s.const === "number" ? (Number.isInteger(s.const) ? "integer" : "number") : typeof s.const;
  if (Array.isArray(s.enum)) return typeof s.enum[0];
  return undefined;
};

const leafKind = (/** @type {string | undefined} */ t) =>
  t === "string" || t === "integer" || t === "number" || t === "boolean" ? t : "json";

/** Body flags for one property, recursing into objects. */
function bodyFlags(/** @type {any} */ spec, /** @type {any} */ raw, /** @type {string[]} */ path, /** @type {boolean} */ required, /** @type {Flag[]} */ out) {
  const s = deref(spec, raw);
  const name = path.map(kebab).join(".");
  const description = String(s?.description ?? "").trim();
  const hidden = s?.deprecated === true;
  const variants = (s?.anyOf ?? s?.oneOf ?? []).map((/** @type {any} */ v) => deref(spec, v));
  const object = [s, ...variants].find((v) => typeOf(v) === "object" && v.properties && typeof v.properties === "object");
  const hasBool = variants.some((/** @type {any} */ v) => typeOf(v) === "boolean");

  if (object) {
    out.push({ name, in: "body", path, kind: hasBool ? "boolean" : "json", toggle: hasBool, required, hidden: hidden || !hasBool, description });
    for (const [key, child] of Object.entries(object.properties)) bodyFlags(spec, child, [...path, key], false, out);
    return;
  }
  const t = typeOf(s) ?? (variants.length ? typeOf(variants.find((/** @type {any} */ v) => typeOf(v))) : undefined);
  if (t === "array") {
    const items = deref(spec, s.items);
    out.push({ name, in: "body", path, kind: "array", itemKind: leafKind(typeOf(items)), required, hidden, description, enum: items?.enum, format: items?.format });
    return;
  }
  out.push({ name, in: "body", path, kind: leafKind(t), required, hidden, description, enum: s?.enum ?? ("const" in (s ?? {}) ? [s.const] : undefined), format: s?.format });
}

/** All commands of a spec, in document order. */
export function buildCommands(/** @type {any} */ spec) {
  /** @type {Command[]} */
  const commands = [];
  const taken = new Set();
  for (const [path, rawItem] of Object.entries(spec?.paths ?? {})) {
    const item = deref(spec, rawItem);
    if (!item || typeof item !== "object") continue;
    for (const method of METHODS) {
      const op = item[method];
      if (!op || typeof op !== "object") continue;
      const cli = op["x-cli"] && typeof op["x-cli"] === "object" ? op["x-cli"] : {};
      if (cli.hidden === true) continue;
      let name = typeof cli.command === "string" && cli.command ? kebab(cli.command) : commandName(op.operationId, method, path);
      if (taken.has(name)) name = `${name}-${method}`;
      taken.add(name);
      /** @type {string[]} */
      const aliases = (Array.isArray(cli.aliases) ? cli.aliases : []).map(String).map(kebab).filter((/** @type {string} */ a) => a && !taken.has(a));
      aliases.forEach((a) => taken.add(a));

      /** @type {Flag[]} */
      const flags = [];
      /** @type {Map<string, any>} */
      const params = new Map();
      for (const p of [...(item.parameters ?? []), ...(op.parameters ?? [])].map((p) => deref(spec, p))) {
        if (p && typeof p.name === "string" && ["header", "query", "path"].includes(p.in)) params.set(`${p.in}:${p.name}`, p);
      }
      for (const p of params.values()) {
        const s = deref(spec, p.schema);
        const t = typeOf(s);
        flags.push({
          name: kebab(p.name),
          in: p.in,
          path: [p.name],
          kind: t === "array" ? "array" : leafKind(t),
          itemKind: t === "array" ? leafKind(typeOf(deref(spec, s.items))) : undefined,
          required: p.required === true || p.in === "path",
          hidden: p.deprecated === true,
          description: String(p.description ?? s?.description ?? "").trim(),
          enum: s?.enum,
          format: s?.format,
        });
      }

      const bodySchema = deref(spec, op.requestBody)?.content?.["application/json"]?.schema;
      const body = deref(spec, bodySchema);
      /** @type {string[]} */
      const requiredBody = Array.isArray(body?.required) ? body.required.map(String) : [];
      if (body?.properties && typeof body.properties === "object") {
        const names = new Set(flags.map((f) => f.name));
        /** @type {Flag[]} */
        const fromBody = [];
        for (const [key, child] of Object.entries(body.properties)) bodyFlags(spec, child, [key], requiredBody.includes(key), fromBody);
        for (const f of fromBody) if (!names.has(f.name)) flags.push(f);
      }

      // Positional arguments fill x-cli.positional, else the only required array field of the body (urls).
      let positional = typeof cli.positional === "string" && body?.properties?.[cli.positional] ? cli.positional : null;
      if (!positional) {
        const arrays = requiredBody.filter((k) => typeOf(deref(spec, body?.properties?.[k])) === "array");
        if (arrays.length === 1) positional = arrays[0];
      }

      const security = op.security ?? spec.security ?? [];
      commands.push({
        name,
        aliases,
        method,
        path,
        op,
        cli,
        flags,
        positional,
        hasBody: !!bodySchema,
        requiredBody,
        idempotencyKey: flags.find((f) => f.in === "header" && f.name === "idempotency-key") ?? null,
        needsAuth: Array.isArray(security) && security.length > 0 && security.every((r) => r && Object.keys(r).length > 0),
      });
    }
  }
  return commands;
}

export function findCommand(/** @type {Command[]} */ commands, /** @type {string} */ name) {
  const k = kebab(name);
  return commands.find((c) => c.name === k || c.aliases.includes(k)) ?? null;
}

const TRUE = new Set(["true", "1", "yes", "on"]);
const FALSE = new Set(["false", "0", "no", "off"]);

/** One flag value from the command line into its JSON type. */
export function coerce(/** @type {Flag} */ flag, /** @type {string} */ raw, /** @type {string} */ kind = flag.kind) {
  /** @type {any} */
  let v;
  if (kind === "string") v = raw;
  else if (kind === "integer") {
    if (!/^-?\d+$/.test(raw.trim())) throw new UsageError(`--${flag.name} needs an integer, got "${raw}"`);
    v = Number(raw);
  } else if (kind === "number") {
    v = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(v)) throw new UsageError(`--${flag.name} needs a number, got "${raw}"`);
  } else if (kind === "boolean") {
    const k = raw.trim().toLowerCase();
    if (TRUE.has(k)) v = true;
    else if (FALSE.has(k)) v = false;
    else throw new UsageError(`--${flag.name} needs true or false, got "${raw}"`);
  } else {
    try {
      v = JSON.parse(raw);
    } catch {
      throw new UsageError(`--${flag.name} needs JSON, got "${raw}"`);
    }
  }
  const allowed = kind === flag.kind || flag.kind === "array" ? flag.enum : undefined;
  if (Array.isArray(allowed) && allowed.length && !allowed.includes(v)) {
    throw new UsageError(`--${flag.name} must be one of ${allowed.map((a) => JSON.stringify(a)).join(", ")}, got ${JSON.stringify(v)}`);
  }
  return v;
}

const isObject = (/** @type {any} */ v) => !!v && typeof v === "object" && !Array.isArray(v);

/** Deep merge of plain objects; `over` wins. */
export function merge(/** @type {any} */ base, /** @type {any} */ over) {
  if (!isObject(base) || !isObject(over)) return over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = k in out ? merge(out[k], v) : v;
  return out;
}

function setPath(/** @type {any} */ obj, /** @type {string[]} */ path, /** @type {any} */ value) {
  let node = obj;
  for (const key of path.slice(0, -1)) {
    if (!isObject(node[key])) node[key] = {};
    node = node[key];
  }
  node[path[path.length - 1]] = value;
}

/** Flag lookup accepting the kebab name and the spec's own spelling (--country-code, --countryCode). */
function flagIndex(/** @type {Command} */ command) {
  const index = new Map();
  for (const f of command.flags) index.set(f.name, f);
  return (/** @type {string} */ given) => index.get(given.split(".").map(kebab).join("."));
}

/**
 * @typedef {object} Request
 * @property {Record<string, string>} headers
 * @property {Record<string, string | string[]>} query
 * @property {Record<string, string>} pathParams
 * @property {any} body          undefined when the operation takes none
 * @property {string | null} idempotencyKey
 */

/**
 * Command arguments (everything after the command name, global options already removed) into a request.
 * @param {Command} command
 * @param {string[]} args
 * @param {any} [data]   parsed --data, merged under the flags
 * @returns {Request}
 */
export function buildRequest(command, args, data) {
  const find = flagIndex(command);
  /** @type {string[]} */
  const positionals = [];
  /** @type {{ flag: Flag, value: any }[]} */
  const toggles = [];
  /** @type {{ flag: Flag, value: any }[]} */
  const values = [];
  /** @type {Map<Flag, any[]>} */
  const arrays = new Map();

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--") || arg === "-") {
      if (arg.startsWith("-") && arg !== "-" && !/^-\d/.test(arg)) throw new UsageError(`unknown option ${arg}`);
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const given = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    let flag = find(given);
    let negated = false;
    if (!flag && given.startsWith("no-")) {
      const f = find(given.slice(3));
      if (f && f.kind === "boolean") {
        flag = f;
        negated = true;
      }
    }
    if (!flag) throw new UsageError(`unknown option --${given} for "${command.name}" (see ${command.name} --help)`);
    if (flag.kind === "boolean") {
      if (negated && eq !== -1) throw new UsageError(`--no-${flag.name} takes no value`);
      const value = negated ? false : eq === -1 ? true : coerce(flag, arg.slice(eq + 1));
      (flag.toggle ? toggles : values).push({ flag, value });
      continue;
    }
    let raw;
    if (eq !== -1) raw = arg.slice(eq + 1);
    else {
      if (i + 1 >= args.length) throw new UsageError(`--${flag.name} needs a value`);
      raw = args[++i];
    }
    if (flag.kind === "array") {
      const list = arrays.get(flag) ?? [];
      list.push(coerce(flag, raw, flag.itemKind));
      arrays.set(flag, list);
    } else values.push({ flag, value: coerce(flag, raw) });
  }

  /** @type {Request} */
  const req = { headers: {}, query: {}, pathParams: {}, body: undefined, idempotencyKey: null };
  /** @type {any} */
  let body = command.hasBody ? (isObject(data) ? structuredClone(data) : {}) : undefined;
  if (data !== undefined && !command.hasBody) throw new UsageError(`"${command.name}" takes no request body (--data)`);
  if (data !== undefined && !isObject(data)) body = data;

  if (positionals.length) {
    if (!command.positional) throw new UsageError(`"${command.name}" takes no arguments, got "${positionals[0]}"`);
    const flag = command.flags.find((f) => f.in === "body" && f.path.length === 1 && f.path[0] === command.positional);
    const list = arrays.get(/** @type {Flag} */ (flag)) ?? [];
    for (const p of positionals) list.push(flag?.kind === "array" ? coerce(flag, p, flag.itemKind) : p);
    if (flag?.kind === "array") arrays.set(flag, list);
    else if (flag) values.push({ flag, value: coerce(flag, positionals.join(" ")) });
  }

  const assign = (/** @type {Flag} */ flag, /** @type {any} */ value) => {
    if (flag.in === "body") {
      if (!isObject(body)) throw new UsageError(`--${flag.name} cannot be combined with a non-object --data`);
      setPath(body, flag.path, value);
    } else if (flag.in === "header") req.headers[flag.path[0]] = String(value);
    else if (flag.in === "query") req.query[flag.path[0]] = Array.isArray(value) ? value.map(String) : String(value);
    else req.pathParams[flag.path[0]] = String(value);
  };
  // Toggles first (--text), so a nested flag (--text.max-characters) turns `true` into an object.
  for (const { flag, value } of toggles) {
    const nested = values.some((v) => v.flag.in === "body" && v.flag.path.length > flag.path.length && flag.path.every((k, j) => v.flag.path[j] === k));
    if (value === false && nested) throw new UsageError(`--no-${flag.name} cannot be combined with --${flag.name}.* options`);
    if (!nested) assign(flag, value);
  }
  for (const { flag, value } of values) assign(flag, value);
  for (const [flag, list] of arrays) assign(flag, list);

  for (const f of command.flags) {
    if (!f.required) continue;
    const present = f.in === "body" ? isObject(body) && body[f.path[0]] !== undefined : f.in === "header" ? f.path[0] in req.headers : f.in === "query" ? f.path[0] in req.query : f.path[0] in req.pathParams;
    if (!present) {
      const how = command.positional === f.path[0] ? `pass it as an argument or with --${f.name}` : `pass --${f.name}`;
      throw new UsageError(`"${command.name}" needs ${f.path[0]}: ${how}`);
    }
  }
  req.body = body;
  if (command.idempotencyKey) req.idempotencyKey = req.headers[command.idempotencyKey.path[0]] ?? null;
  return req;
}

/** The request URL on the base URL. Path parameters are encoded; the result must stay on the base URL's origin. */
export function requestUrl(/** @type {string} */ baseUrl, /** @type {Command} */ command, /** @type {Request} */ req) {
  const path = command.path.replace(/\{([^}]+)\}/g, (_, name) => {
    if (!(name in req.pathParams)) throw new UsageError(`"${command.name}" needs --${kebab(name)}`);
    return encodeURIComponent(req.pathParams[name]);
  });
  const base = new URL(baseUrl);
  const url = new URL(baseUrl.replace(/\/+$/, "") + (path.startsWith("/") ? path : `/${path}`));
  if (url.origin !== base.origin) throw new UsageError(`refusing a request outside ${base.origin}: ${url.href}`);
  for (const [k, v] of Object.entries(req.query)) for (const one of Array.isArray(v) ? v : [v]) url.searchParams.append(k, one);
  return url;
}
