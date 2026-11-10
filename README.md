# SiteRender CLI

What a page sends, what a browser builds, and which one you actually need.

`siterender` fetches live web pages as clean Markdown, text or HTML, straight from your terminal or your agent's shell.
It is the command line client for the [Live Web Data API](https://siterender.cc) by SiteRender.

## Quick start

```bash
npx siterender login                                   # paste your API key (not echoed)
npx siterender fetch https://example.com -o text       # the page as Markdown
```

Get a key at [siterender.cc](https://siterender.cc). Node.js 18 or later.

## Install

```bash
npm install -g siterender
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

## The commands follow the live API

`siterender` builds its commands and options from the API's OpenAPI document at
[https://livewebdata.com/openapi.json](https://livewebdata.com/openapi.json), cached for an hour. When the API gains a field or an endpoint, the
option or command is there on your next run, without updating the CLI. Offline, it uses the last cached
copy, then the copy bundled with the installed version (`siterender spec` shows which one; `--offline` skips the
download). A daily job here publishes a new version whenever the API spec changed.

## Configuration

| Setting | Option | Environment | Default |
|---|---|---|---|
| API key | `--api-key` | `LIVE_WEB_DATA_API_KEY` | the key saved by `siterender login` (`~/.config/siterender/config.json`, mode 0600) |
| API base URL | `--base-url` | `LIVE_WEB_DATA_API_BASE_URL` | `https://livewebdata.com/api` |
| API spec URL | `--spec-url` | `LIVE_WEB_DATA_SPEC_URL` | `https://livewebdata.com/openapi.json` |
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
- [Docs](https://siterender.cc/docs)
- [API spec](https://livewebdata.com/openapi.json)

## License

MIT, © Teneo Labs Inc.
