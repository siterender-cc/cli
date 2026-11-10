// @ts-check
/** Help texts. Command help is generated from the spec: summary, description, flags, enums and the request examples. */
import { kebab } from "./commands.js";

const WIDTH = 100;

/** Word wrap with a hanging indent. */
export function wrap(/** @type {string} */ text, /** @type {number} */ indent, width = WIDTH) {
  const lines = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (line && indent + line.length + 1 + word.length > width) {
        lines.push(line);
        line = word;
      } else line = line ? `${line} ${word}` : word;
    }
    lines.push(line);
  }
  return lines.join("\n" + " ".repeat(indent));
}

/** Two columns: names padded to the longest (capped), descriptions wrapped under each other. */
function columns(/** @type {[string, string][]} */ rows) {
  const w = Math.min(34, Math.max(...rows.map(([a]) => a.length)) + 2);
  return rows.map(([a, b]) => (a.length + 2 > w ? `  ${a}\n${" ".repeat(w + 2)}${wrap(b, w + 2)}` : `  ${a.padEnd(w)}${wrap(b, w + 2)}`)).join("\n");
}

/** @param {import("./commands.js").Flag} f */
function placeholder(f) {
  if (f.kind === "boolean") return "";
  const one = (/** @type {string | undefined} */ kind) =>
    Array.isArray(f.enum) && f.enum.length ? `<${f.enum.join("|")}>` : f.format === "uri" ? "<url>" : `<${kind === "json" ? "json" : kind}>`;
  return f.kind === "array" ? ` ${one(f.itemKind)}…` : ` ${one(f.kind)}`;
}

/** @param {import("./commands.js").Flag} f */
function flagLabel(f) {
  if (f.kind === "boolean") return `--${f.name}, --no-${f.name}`;
  return `--${f.name}${placeholder(f)}`;
}

/** The first request example of an operation as a command line, when every field maps to a flag. */
export function exampleLine(/** @type {string} */ bin, /** @type {import("./commands.js").Command} */ c) {
  const examples = c.op?.requestBody?.content?.["application/json"]?.examples;
  const first = examples && typeof examples === "object" ? Object.values(examples)[0] : undefined;
  const value = first?.value ?? c.op?.requestBody?.content?.["application/json"]?.example;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const parts = [bin, c.name];
  const walk = (/** @type {any} */ obj, /** @type {string[]} */ path) => {
    for (const [k, v] of Object.entries(obj)) {
      const p = [...path, k];
      const name = p.map(kebab).join(".");
      const flag = c.flags.find((f) => f.name === name);
      if (path.length === 0 && k === c.positional && Array.isArray(v)) parts.push(...v.map(String));
      else if (flag?.kind === "array" && Array.isArray(v)) v.forEach((x) => parts.push(`--${name}`, String(x)));
      else if (v && typeof v === "object" && !Array.isArray(v)) walk(v, p);
      else if (flag?.kind === "boolean") parts.push(v ? `--${name}` : `--no-${name}`);
      else if (flag) parts.push(`--${name}`, String(v));
      else return false;
    }
    return true;
  };
  return walk(value, []) ? parts.join(" ") : null;
}

/**
 * @param {import("./config.js").Brand} brand
 * @param {import("./commands.js").Command[]} commands
 * @param {{ source: string }} spec
 */
export function mainHelp(brand, commands, spec) {
  const b = brand.bin;
  const rows = /** @type {[string, string][]} */ ([
    ...commands.map((c) => /** @type {[string, string]} */ ([[c.name, ...c.aliases].join(", "), String(c.op.summary ?? c.op.operationId ?? `${c.method.toUpperCase()} ${c.path}`)])),
    ["login", "Save your API key for this CLI"],
    ["logout", "Remove the saved API key"],
    ["spec [refresh]", "Show or refresh the API spec the commands come from"],
  ]);
  return `${brand.name}: ${brand.tagline}
${wrap(`The ${b} command line client for the ${brand.apiName}: live web pages as clean Markdown, text or HTML.`, 0)}

Usage: ${b} <command> [options]

Commands:
${columns(rows)}

Options for every command:
${columns([
  ["--api-key <key>", `API key. Default: env LIVE_WEB_DATA_API_KEY, then the key saved by \`${b} login\``],
  ["--base-url <url>", `API base URL. Default: env LIVE_WEB_DATA_API_BASE_URL, then ${brand.apiBaseUrl}`],
  ["--spec-url <url>", `API spec URL. Default: env LIVE_WEB_DATA_SPEC_URL, then ${brand.specUrl}`],
  ["--offline", "Use the cached or bundled spec, do not download it"],
  ["-o, --output <mode>", "json (default), text, or one field of each result, e.g. markdown, html, title"],
  ["-d, --data <json>", "Request body as JSON, @file or - (stdin); options override its fields"],
  ["--timeout <seconds>", "Per attempt. Default 120"],
  ["--max-wait <seconds>", "How long to repeat a 202 (still fetching) answer. Default 300"],
  ["-h, --help", `Help; for one command: ${b} <command> --help`],
  ["-v, --version", "Print the version"],
])}

${wrap(`The commands and their options come from the live API spec (${spec.source === "bundled" ? "now: the copy bundled with this version" : "cached for an hour"}), so new API features show up here without an update.`, 0)}
Docs: ${brand.docsUrl}
`;
}

/** @param {import("./config.js").Brand} brand @param {import("./commands.js").Command} c */
export function commandHelp(brand, c) {
  // Body fields first, then headers and query/path parameters.
  const visible = [...c.flags.filter((f) => !f.hidden && f.in === "body"), ...c.flags.filter((f) => !f.hidden && f.in !== "body")];
  const usage = `${brand.bin} ${c.name}${c.positional ? ` <${kebab(c.positional)}…>` : ""}${visible.length ? " [options]" : ""}`;
  const rows = visible.map((f) => /** @type {[string, string]} */ ([flagLabel(f), `${f.required ? "Required. " : ""}${f.in === "header" ? "(header) " : f.in === "query" ? "(query) " : ""}${f.description}`]));
  const example = exampleLine(brand.bin, c);
  return [
    `${brand.bin} ${c.name}: ${c.op.summary ?? ""}`.trimEnd(),
    c.aliases.length ? `Alias: ${c.aliases.join(", ")}` : "",
    "",
    `Usage: ${usage}`,
    c.op.description ? `\n${wrap(String(c.op.description), 0)}` : "",
    rows.length ? `\nOptions:\n${columns(rows)}` : "",
    c.hasBody ? `\n${wrap("-d/--data takes the whole request body as JSON (or @file, or - for stdin); options override its fields. Any API field works there, also one without an option.", 0)}` : "",
    example ? `\nExample:\n  ${example}` : "",
    "",
  ]
    .filter((s, i, all) => s !== "" || (i > 0 && all[i - 1] !== ""))
    .join("\n");
}
