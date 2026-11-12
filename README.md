# SiteRender CLI

What a page sends, what a browser builds, and which one you actually need.

`siterender` fetches live web pages as clean Markdown, text or HTML, straight from your terminal or your agent's shell.
It is the command line client for the [SiteRender API](https://siterender.cc).

## Quick start

```bash
npx @siterender-cc/cli login                                   # paste your API key (not echoed)
npx @siterender-cc/cli fetch https://example.com -o text       # the page as Markdown
```

Get a key at [siterender.cc](https://siterender.cc). Node.js 18 or later.

## Install

```bash
npm install -g @siterender-cc/cli
siterender --help
```

## Use

```bash
siterender fetch https://example.com/a https://example.com/b      # up to 10 URLs; JSON with results[] and statuses[]
siterender fetch https://example.com -o text                      # just the content (Markdown, else text, else HTML)
siterender fetch https://example.com -o html --html               # the page HTML
siterender fetch https://example.com --country-code de --render   # from Germany, rendered in a real browser
siterender fetch --data @request.json                             # the whole request body from a file (- for stdin)
siterender account                                                # plan, credits and rate limit
siterender fetch --help                                           # every option, with the API's own descriptions
```

A fetch that is still running after about 100 seconds is collected automatically with the same
`Idempotency-Key`, so it is charged once.

## MCP server

The SiteRender API is also a remote MCP server (Streamable HTTP) at `https://siterender.cc/mcp`, with the tools
`get_page_contents` and `get_account_status`. It takes the same API key as a bearer token.

```bash
claude mcp add --transport http siterender https://siterender.cc/mcp \
  --header "Authorization: Bearer $SITERENDER_API_KEY"
```

Any other client: URL `https://siterender.cc/mcp`, header `Authorization: Bearer <key>`. Config for Cursor, VS Code and
Claude Desktop: [MCP docs](https://siterender.cc/docs/mcp). The server's entry for the MCP Registry is [server.json](server.json)
(`cc.siterender/siterender`).

## Agent plugin and skill

This repo is also a plugin for Claude Code, Grok Build and Gemini CLI, and holds an agent skill. Each one connects the
MCP server above and teaches the agent when to fetch a page with it or with `siterender`.

```bash
npx skills add siterender-cc/cli                                    # the skill, for any agent that reads SKILL.md
claude plugin marketplace add siterender-cc/cli && claude plugin install siterender@siterender
gemini extensions install https://github.com/siterender-cc/cli
```

Network and credentials: the plugin calls `https://siterender.cc/mcp` only. The CLI calls `https://siterender.cc/api` and
`https://siterender.cc/openapi.json`, and `https://registry.npmjs.org` (`npx` and a once-a-day update check, off with
`SITERENDER_NO_UPDATE_NOTIFIER=1`). Both need one credential, your SiteRender API key,
read from `SITERENDER_API_KEY` or saved by `siterender login`. No hooks, no scripts run on install.

## The commands follow the live API

`siterender` builds its commands and options from the API's OpenAPI document at
[https://siterender.cc/openapi.json](https://siterender.cc/openapi.json), cached for an hour. When the API gains a field or an endpoint, the
option or command is there on your next run, without updating the CLI. Offline, it uses the last cached
copy, then the copy bundled with the installed version (`siterender spec` shows which one; `--offline` skips the
download). An hourly job here publishes a new version whenever the API spec changed.

## Configuration

| Setting | Option | Environment | Default |
|---|---|---|---|
| API key | `--api-key` | `SITERENDER_API_KEY` | the key saved by `siterender login` (`~/.config/siterender/config.json`, mode 0600) |
| API base URL | `--base-url` | `SITERENDER_API_BASE_URL` | `https://siterender.cc/api` |
| API spec URL | `--spec-url` | `SITERENDER_SPEC_URL` | `https://siterender.cc/openapi.json` |
| Output | `-o json\|text\|<field>` | | `json` |
| Update notice | | `SITERENDER_NO_UPDATE_NOTIFIER=1` turns it off | once a day, terminals only |

Requests and your key only ever go to the base URL, never to a server named in the spec.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | OK |
| 1 | The API answered with an error (JSON on stderr, with its `requestId`), every URL failed with `-o text`, or the fetch was still running at `--max-wait` |
| 2 | Usage: unknown command or option, a value the API does not accept |
| 3 | Network: no answer. The error carries the `Idempotency-Key` to collect the result without a new charge |

## Links

- [siterender.cc](https://siterender.cc)
- [CLI docs](https://siterender.cc/docs/cli)
- [API docs](https://siterender.cc/docs)
- [API spec](https://siterender.cc/openapi.json)

## License

MIT, © siterender.cc
