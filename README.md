# schemica

Inspect API and MCP server schemas from the command line.

When an MCP server changes a tool's parameter name, type, or description, nothing errors. There is no 404, no exception, no CI failure — the model simply adapts to the new schema and starts behaving differently. `schemica` shows you what a server actually exposes right now, so you can see what you're wiring into.

> **Early release (0.0.x).** The CLI works and is useful today, but the API surface is small and may change before 1.0. Pin the version if you depend on it.

## Install

```bash
npm install -g schemica
# or run without installing
npx schemica inspect https://example.com/mcp
```

Requires Node 18 or later. **Zero dependencies** — nothing to audit, and no supply-chain surface for a tool you point at your own infrastructure.

## Usage

```bash
# Inspect an MCP server's tool surface
schemica inspect https://example.com/mcp

# Inspect an OpenAPI document
schemica inspect https://api.example.com/openapi.json

# Authenticated targets
schemica inspect https://example.com/mcp --header "Authorization: Bearer TOKEN"

# Machine-readable output
schemica inspect https://example.com/mcp --json
```

### Color

Output is colored automatically when connected to a terminal, following the
same convention as `ls`, `grep`, and most modern CLIs:

```bash
schemica inspect https://example.com/mcp --color=always   # force on (e.g. piping to `less -R`)
schemica inspect https://example.com/mcp --color=never    # force off
schemica inspect https://example.com/mcp                  # auto: on for a TTY, off when piped
```

`NO_COLOR` ([no-color.org](https://no-color.org)) and `FORCE_COLOR`
environment variables are respected under the default `auto` mode.

### Example

```
$ schemica inspect https://example.com/mcp

MCP server — 3 tool(s)

  search_files
    Search for files matching a pattern
    params: pattern, path (required: pattern)

  read_file
    Read the contents of a file
    params: path (required: path)

  write_file
    Write content to a file
    params: path, content (required: path, content)
```

## Library use

```js
import { inspect, normalize } from "schemica";

const result = await inspect("https://example.com/mcp");
console.log(result.kind);     // "mcp" | "openapi" | "json"
console.log(result.summary);  // tool/endpoint surface
```

`normalize(doc)` returns a stable, key-sorted representation so two fetches of an unchanged schema compare equal — useful for building your own change detection.

## Authentication

Many MCP servers require OAuth. Schemica does not run the OAuth flow yet, but
it detects the requirement precisely and tells you what the server wants,
using the RFC 9728 metadata the server advertises:

```
$ schemica inspect https://mcp.cloudflare.com/mcp
Authentication required

  requires OAuth. Schemica does not perform the OAuth flow yet - obtain a
  token from your provider and pass it with
  --header "Authorization: Bearer <token>".

  Authorization server(s):
    https://mcp.cloudflare.com
  Scopes: account:read, zone:read, workers:write
```

Once you have a token, pass it directly:

```bash
schemica inspect https://mcp.cloudflare.com/mcp --header "Authorization: Bearer $TOKEN"
```

Exit code `2` means "authentication required", distinct from `1` for other
errors, so scripts and CI can branch on it.

## Limits

- Responses are capped at 2 MB.
- Requests time out after 15 seconds.
- MCP support covers **Streamable HTTP**, including responses framed as
  `text/event-stream` (Cloudflare's hosted MCP servers respond this way).
  Servers still on the older **HTTP+SSE** transport (protocol `2024-11-05`,
  which needs a `GET` to open a stream first) are *detected*, not spoken:
  Schemica reads the `Allow` header (falling back to
  `access-control-allow-methods` when that's absent) on a 405 and, if `GET`
  is offered, briefly probes for the legacy handshake so the error names the
  actual transport instead of showing a bare status code. Exit code `3`
  means "wrong transport, not wrong URL." Exit code `4` means the server
  answered 200 but the body couldn't be parsed as JSON-RPC.
- OAuth is detected but not performed; supply a token yourself.

## Roadmap

Scheduled monitoring, severity-classified diffs, and alerting are in development at [schemica.dev](https://schemica.dev).

## License

MIT
