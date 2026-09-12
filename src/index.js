/**
 * Schemica — inspect API and MCP server schemas.
 *
 * Zero dependencies by design: nothing to audit, nothing to break, and no
 * supply-chain surface for a tool people run against their own infrastructure.
 *
 * This is an early release. The API surface below is small and may change
 * before 1.0.
 */

/**
 * Parse an RFC 9110 / RFC 9728 WWW-Authenticate header.
 *
 * MCP servers implementing the spec's authorization profile answer an
 * unauthenticated request with 401 plus, for example:
 *
 *   www-authenticate: Bearer realm="OAuth",
 *     resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"
 *
 * That is far more useful than a bare 401: it names the scheme AND points at
 * a metadata document describing which authorization server to talk to.
 *
 * @param {string|null} header
 * @returns {{ scheme: string|null, params: Record<string,string> }}
 */
export function parseWwwAuthenticate(header) {
  if (!header) return { scheme: null, params: {} };
  const schemeMatch = header.match(/^\s*([A-Za-z][A-Za-z0-9._-]*)/);
  const scheme = schemeMatch ? schemeMatch[1] : null;
  const params = {};
  // key="quoted value" or key=token
  const re = /([A-Za-z][A-Za-z0-9._-]*)\s*=\s*(?:"([^"]*)"|([^,\s]+))/g;
  let m;
  while ((m = re.exec(header)) !== null) {
    params[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : m[3];
  }
  return { scheme, params };
}

/**
 * Error thrown when a target requires credentials we do not have.
 * Carries structured detail so callers can render something useful instead
 * of "HTTP 401".
 */
export class AuthRequiredError extends Error {
  constructor(detail) {
    super(detail.message);
    this.name = "AuthRequiredError";
    Object.assign(this, detail);
  }
}

/**
 * Given a 401 response, work out what kind of credential is wanted.
 * Fetches the RFC 9728 protected-resource-metadata document when the server
 * advertises one — that document is deliberately unauthenticated, so we can
 * always read it.
 *
 * @param {string} url
 * @param {Headers} responseHeaders
 * @returns {Promise<AuthRequiredError>}
 */
export async function describeAuthRequirement(url, responseHeaders) {
  const raw = responseHeaders.get("www-authenticate");
  const { scheme, params } = parseWwwAuthenticate(raw);
  const detail = {
    url,
    scheme: scheme ?? "unknown",
    realm: params.realm ?? null,
    resourceMetadataUrl: params.resource_metadata ?? null,
    authorizationServers: [],
    scopesSupported: [],
    kind: "unknown",
    message: "",
  };

  if (detail.resourceMetadataUrl) {
    detail.kind = "oauth";
    try {
      const { status, text } = await fetchCapped(detail.resourceMetadataUrl);
      if (status === 200) {
        const meta = JSON.parse(text);
        detail.authorizationServers = meta.authorization_servers ?? [];
        detail.scopesSupported = meta.scopes_supported ?? [];
        detail.resourceDocumentation = meta.resource_documentation ?? null;
      }
    } catch {
      // Metadata is a nice-to-have; the OAuth verdict already stands.
    }
    detail.message =
      `${url} requires OAuth. Schemica does not perform the OAuth flow yet — ` +
      `obtain a token from your provider and pass it with ` +
      `--header "Authorization: Bearer <token>".`;
  } else if ((scheme ?? "").toLowerCase() === "bearer") {
    detail.kind = "bearer";
    detail.message =
      `${url} requires a bearer token. Pass one with ` +
      `--header "Authorization: Bearer <token>".`;
  } else if (scheme) {
    detail.kind = scheme.toLowerCase();
    detail.message =
      `${url} requires ${scheme} authentication, which Schemica does not support.`;
  } else {
    detail.message =
      `${url} returned 401 without a WWW-Authenticate header, so the required ` +
      `credential type is unknown. If you have a token, pass it with ` +
      `--header "Authorization: Bearer <token>".`;
  }

  return new AuthRequiredError(detail);
}

/**
 * Extract the endpoint URI from a legacy MCP HTTP+SSE handshake.
 * Under protocol version 2024-11-05, a client opens a GET/SSE stream and the
 * server's first event is:
 *
 *   event: endpoint
 *   data: /messages?sessionId=...
 *
 * telling the client where to POST subsequent JSON-RPC messages. Streamable
 * HTTP (the current transport) does not need this — a bare POST to the main
 * URL works — so seeing this event is itself the signal that a server is on
 * the older transport.
 *
 * Pure function so it is testable without a network call.
 * @param {string} raw
 */
export function parseSseEndpointEvent(raw) {
  const match = raw.match(/event:\s*endpoint\s*\r?\n\s*data:\s*([^\r\n]+)/i);
  return match ? match[1].trim() : null;
}

/**
 * Briefly open a GET/SSE connection and read just enough to see whether the
 * server announces a legacy `endpoint` event. Reads a bounded number of
 * bytes with its own short timeout and cancels the stream afterward — an SSE
 * connection is kept open by the server, so we must not wait for it to
 * close (fetchCapped's res.text() would hang until the outer 15s timeout).
 *
 * @param {string} url
 * @param {Record<string,string>} [headers]
 * @param {number} [timeoutMs]
 */
export async function probeLegacySse(url, headers = {}, timeoutMs = 4000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { "user-agent": USER_AGENT, accept: "text/event-stream", ...headers },
      signal: controller.signal,
    });
    if (!res.body) return { endpoint: null };
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      while (buf.length < 4096) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        if (buf.includes("\n\n")) break; // one full SSE event is enough
      }
    } finally {
      try { await reader.cancel(); } catch {}
    }
    return { endpoint: parseSseEndpointEvent(buf) };
  } catch {
    return { endpoint: null };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Error thrown when a target's transport is not one Schemica speaks.
 */
export class MalformedResponseError extends Error {
  constructor(detail) {
    super(detail.message);
    this.name = "MalformedResponseError";
    Object.assign(this, detail);
  }
}

export class UnsupportedTransportError extends Error {
  constructor(detail) {
    super(detail.message);
    this.name = "UnsupportedTransportError";
    Object.assign(this, detail);
  }
}

/**
 * Build a diagnostic for a 405 on the MCP endpoint: read Allow, and if GET
 * is permitted, probe for the legacy HTTP+SSE handshake so the message names
 * the actual transport mismatch instead of a bare status code.
 * @param {string} url
 * @param {Headers} responseHeaders
 * @param {Record<string,string>} requestHeaders
 */
async function describeTransportMismatch(url, responseHeaders, requestHeaders) {
  // Some Workers/CORS-middleware setups only ever send the CORS-specific
  // access-control-allow-methods header and never the HTTP-standard Allow
  // header a 405 is supposed to carry. Fall back to it - it answers the
  // same question ("which methods work here") even though it exists for a
  // different reason (CORS preflight, not 405 semantics).
  const allow = responseHeaders.get("allow") || responseHeaders.get("access-control-allow-methods");
  const allowsGet = !!allow && /\bGET\b/i.test(allow);
  const probe = allowsGet ? await probeLegacySse(url, requestHeaders) : { endpoint: null };

  // MCP's spec only expects Content-Type/Accept/Authorization/
  // MCP-Protocol-Version/Mcp-Session-Id on these requests. Anything else
  // advertised in access-control-allow-headers is a signal the server
  // speaks a custom protocol on top of plain MCP - e.g. routing by a
  // header rather than by JSON-RPC method in the body - which a bare
  // POST will never satisfy no matter how it's diagnosed here.
  const KNOWN_MCP_HEADERS = new Set([
    "content-type", "accept", "authorization",
    "mcp-protocol-version", "mcp-session-id",
  ]);
  const advertisedHeaders = (responseHeaders.get("access-control-allow-headers") || "")
    .split(",").map((h) => h.trim()).filter(Boolean);
  const unexpectedHeaders = advertisedHeaders.filter(
    (h) => h && !KNOWN_MCP_HEADERS.has(h.toLowerCase()),
  );

  let message;
  if (probe.endpoint) {
    message =
      `${url} rejects POST (405) and speaks the legacy MCP HTTP+SSE transport ` +
      `(protocol 2024-11-05): it wants a GET to open a stream, then a POST to a ` +
      `session-specific endpoint (${probe.endpoint}) it hands back. ` +
      `Schemica currently only speaks Streamable HTTP and does not follow this ` +
      `handshake yet.`;
  } else if (allowsGet) {
    message =
      `${url} rejects POST (405, allowed methods: ${allow}). This looks like the ` +
      `legacy MCP HTTP+SSE transport, which Schemica does not support yet — only ` +
      `Streamable HTTP.`;
  } else if (unexpectedHeaders.length > 0) {
    message =
      `${url} rejects POST (405${allow ? `, allowed methods: ${allow}` : ""}), and ` +
      `advertises non-standard header(s) beyond plain MCP: ${unexpectedHeaders.join(", ")}. ` +
      `This server likely expects a custom routing scheme on top of MCP — e.g. naming a ` +
      `target via a header rather than a JSON-RPC method in the body — which a generic ` +
      `POST cannot satisfy. Check that server's own documentation for what these headers ` +
      `expect.`;
  } else {
    message =
      `${url} rejects POST (405${allow ? `, allowed methods: ${allow}` : ""}). ` +
      `This does not look like an MCP endpoint Schemica can talk to.`;
  }

  return new UnsupportedTransportError({
    url,
    allow: allow ?? null,
    unexpectedHeaders,
    discoveredEndpoint: probe.endpoint,
    message,
  });
}

/**
 * Parse a text/event-stream body into its discrete messages.
 *
 * A real Streamable HTTP response frames its JSON-RPC payload as an SSE
 * event, e.g.:
 *
 *   event: message
 *   data: {"result":{"tools":[...]},"jsonrpc":"2.0","id":1}
 *
 * SSE also allows multiple `data:` lines per event (joined with `\n` per
 * the spec) and an implicit `event: message` when no `event:` line is
 * present. Naively checking whether the body starts with `"data:"` misses
 * the far more common case where an `event:` line comes first.
 *
 * @param {string} raw
 * @returns {Array<{event: string, data: string}>}
 */
export function parseSseMessages(raw) {
  const blocks = raw.split(/\r?\n\r?\n/).filter((b) => b.trim().length > 0);
  const messages = [];
  for (const block of blocks) {
    let event = "message";
    const dataLines = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith(":")) continue; // SSE comment/heartbeat
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length > 0) messages.push({ event, data: dataLines.join("\n") });
  }
  return messages;
}

/**
 * Extract a JSON-RPC payload from a response body, using the declared
 * content-type as the authoritative signal rather than guessing from the
 * body's shape.
 * @param {string} text
 * @param {string} contentType
 */
function extractJsonRpcPayload(text, contentType) {
  if (contentType.includes("text/event-stream")) {
    const messages = parseSseMessages(text);
    const msg = messages.find((m) => m.event === "message") ?? messages[0];
    return msg?.data ?? null;
  }
  return text;
}

const USER_AGENT = "schemica/0.0.1 (+https://schemica.dev)";
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_BYTES = 2 * 1024 * 1024;

/**
 * Fetch a URL with a timeout and a size cap.
 * @param {string} url
 * @param {{ headers?: Record<string,string>, method?: string, body?: string, timeoutMs?: number }} [opts]
 * @returns {Promise<{ status: number, text: string, headers: Headers }>}
 */
export async function fetchCapped(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  try {
    const res = await fetch(url, {
      method: opts.method ?? "GET",
      headers: { "user-agent": USER_AGENT, ...(opts.headers ?? {}) },
      body: opts.body,
      signal: controller.signal,
    });
    const text = await res.text();
    if (text.length > MAX_BYTES) {
      throw new Error(
        `response exceeds ${MAX_BYTES} byte cap (got ${text.length})`,
      );
    }
    return { status: res.status, text, headers: res.headers };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask an MCP server for its tool list over Streamable HTTP.
 * Returns null if the endpoint does not answer as an MCP server.
 * @param {string} url
 * @param {Record<string,string>} [headers]
 */
export async function fetchMcpTools(url, headers = {}) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {},
  });
  try {
    const { status, text, headers: resHeaders } = await fetchCapped(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...headers,
      },
      body,
    });
    if (status === 401 || status === 403) {
      throw await describeAuthRequirement(url, resHeaders);
    }
    if (status === 405) {
      throw await describeTransportMismatch(url, resHeaders, headers);
    }
    if (status !== 200) return null;
    const contentType = resHeaders.get("content-type") || "";
    const payload = extractJsonRpcPayload(text, contentType);
    if (!payload) return null;
    // A 200 with a body we cannot parse as JSON-RPC is a REAL problem to
    // report, not silence: the server answered successfully, so falling
    // through to "maybe this is an OpenAPI spec instead" would send a GET
    // to a POST-only endpoint and produce a confusing, unrelated 405 -
    // exactly the failure this comment exists to prevent.
    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch (e) {
      throw new MalformedResponseError({
        url,
        contentType,
        message:
          `${url} returned 200 (content-type: ${contentType || "unknown"}) but the ` +
          `body could not be parsed as JSON-RPC: ${e.message}`,
      });
    }
    return parsed?.result?.tools ?? null;
  } catch (err) {
    // An auth requirement or a transport mismatch is a real, reportable
    // answer - never swallow either into "this isn't an MCP server".
    if (
      err instanceof AuthRequiredError ||
      err instanceof UnsupportedTransportError ||
      err instanceof MalformedResponseError
    ) {
      throw err;
    }
    return null;
  }
}

/**
 * Fetch and parse an OpenAPI/JSON schema document.
 * @param {string} url
 * @param {Record<string,string>} [headers]
 */
export async function fetchJsonSchema(url, headers = {}) {
  const { status, text, headers: resHeaders } = await fetchCapped(url, { headers });
  if (status === 401 || status === 403) {
    throw await describeAuthRequirement(url, resHeaders);
  }
  if (status !== 200) {
    throw new Error(`HTTP ${status} fetching ${url}`);
  }
  return JSON.parse(text);
}

/**
 * @typedef {Object} McpToolSummary
 * @property {string} name
 * @property {string|null} description
 * @property {string[]} required
 * @property {string[]} parameters
 */
/**
 * @typedef {Object} McpSummary
 * @property {number} toolCount
 * @property {McpToolSummary[]} tools
 */
/**
 * @typedef {Object} OpenApiPathSummary
 * @property {string} path
 * @property {string[]} methods
 */
/**
 * @typedef {Object} OpenApiSummary
 * @property {string|null} title
 * @property {string|null} version
 * @property {number} pathCount
 * @property {OpenApiPathSummary[]} paths
 */
/**
 * @typedef {Object} JsonSummary
 * @property {string[]} topLevelKeys
 */
/**
 * @typedef {{ kind: "mcp", summary: McpSummary }
 *         | { kind: "openapi", summary: OpenApiSummary }
 *         | { kind: "json", summary: JsonSummary }} InspectResult
 */

/**
 * Identify what kind of schema a URL serves and summarise its surface.
 * @param {string} url
 * @param {Record<string,string>} [headers]
 * @returns {Promise<InspectResult>}
 */
export async function inspect(url, headers = {}) {
  const tools = await fetchMcpTools(url, headers);
  if (tools) {
    return {
      kind: "mcp",
      summary: {
        toolCount: tools.length,
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description ?? null,
          required: t.inputSchema?.required ?? [],
          parameters: Object.keys(t.inputSchema?.properties ?? {}),
        })),
      },
    };
  }

  const doc = await fetchJsonSchema(url, headers);
  if (doc.openapi || doc.swagger) {
    const paths = Object.keys(doc.paths ?? {});
    return {
      kind: "openapi",
      summary: {
        title: doc.info?.title ?? null,
        version: doc.info?.version ?? null,
        pathCount: paths.length,
        paths: paths.map((p) => ({
          path: p,
          methods: Object.keys(doc.paths[p] ?? {}).filter((m) =>
            ["get", "post", "put", "patch", "delete", "head", "options"].includes(
              m.toLowerCase(),
            ),
          ),
        })),
      },
    };
  }

  return {
    kind: "json",
    summary: { topLevelKeys: Object.keys(doc) },
  };
}

/**
 * Stable, order-independent representation of a document, so that two
 * fetches of an unchanged schema compare equal.
 * @param {unknown} value
 */
export function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = normalize(value[key]);
    return out;
  }
  return value;
}

export const version = "0.0.1";
