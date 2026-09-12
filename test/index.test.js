import { test } from "node:test";
import assert from "node:assert/strict";
import { normalize, version, parseWwwAuthenticate, parseSseEndpointEvent, parseSseMessages } from "../src/index.js";

test("version is exported", () => {
  assert.equal(typeof version, "string");
});

test("normalize sorts object keys deterministically", () => {
  const a = normalize({ b: 1, a: 2, c: { z: 1, y: 2 } });
  const b = normalize({ a: 2, c: { y: 2, z: 1 }, b: 1 });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test("normalize preserves array order", () => {
  assert.deepEqual(normalize([3, 1, 2]), [3, 1, 2]);
});

test("normalize handles primitives and null", () => {
  assert.equal(normalize(null), null);
  assert.equal(normalize("x"), "x");
  assert.equal(normalize(42), 42);
});

test("parseWwwAuthenticate handles the Cloudflare MCP header", () => {
  const h = 'Bearer realm="OAuth", resource_metadata="https://mcp.cloudflare.com/.well-known/oauth-protected-resource/mcp"';
  const { scheme, params } = parseWwwAuthenticate(h);
  assert.equal(scheme, "Bearer");
  assert.equal(params.realm, "OAuth");
  assert.equal(
    params.resource_metadata,
    "https://mcp.cloudflare.com/.well-known/oauth-protected-resource/mcp",
  );
});

test("parseWwwAuthenticate handles unquoted params", () => {
  const { scheme, params } = parseWwwAuthenticate("Bearer error=invalid_token");
  assert.equal(scheme, "Bearer");
  assert.equal(params.error, "invalid_token");
});

test("parseWwwAuthenticate handles a missing header", () => {
  const { scheme, params } = parseWwwAuthenticate(null);
  assert.equal(scheme, null);
  assert.deepEqual(params, {});
});

test("parseWwwAuthenticate is case-insensitive on param names", () => {
  const { params } = parseWwwAuthenticate('Bearer Realm="x", Resource_Metadata="y"');
  assert.equal(params.realm, "x");
  assert.equal(params.resource_metadata, "y");
});

test("parseSseEndpointEvent extracts the legacy handshake endpoint", () => {
  const raw = "event: endpoint\ndata: /messages?sessionId=abc123\n\n";
  assert.equal(parseSseEndpointEvent(raw), "/messages?sessionId=abc123");
});

test("parseSseEndpointEvent handles CRLF line endings", () => {
  const raw = "event: endpoint\r\ndata: /messages?sessionId=xyz\r\n\r\n";
  assert.equal(parseSseEndpointEvent(raw), "/messages?sessionId=xyz");
});

test("parseSseEndpointEvent returns null for unrelated SSE events", () => {
  const raw = "event: ping\ndata: {}\n\n";
  assert.equal(parseSseEndpointEvent(raw), null);
});

test("parseSseEndpointEvent returns null for empty input", () => {
  assert.equal(parseSseEndpointEvent(""), null);
});

test("parseSseMessages handles a real Streamable HTTP frame", () => {
  const raw = 'event: message\ndata: {"result":{"tools":[]},"jsonrpc":"2.0","id":1}\n\n';
  const messages = parseSseMessages(raw);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].event, "message");
  assert.equal(JSON.parse(messages[0].data).jsonrpc, "2.0");
});

test("parseSseMessages defaults to 'message' when no event: line is present", () => {
  const raw = 'data: {"a":1}\n\n';
  const messages = parseSseMessages(raw);
  assert.equal(messages[0].event, "message");
});

test("parseSseMessages joins multiple data: lines per SSE spec", () => {
  const raw = "event: message\ndata: line1\ndata: line2\n\n";
  const messages = parseSseMessages(raw);
  assert.equal(messages[0].data, "line1\nline2");
});

test("parseSseMessages skips SSE comment lines", () => {
  const raw = ": heartbeat\nevent: message\ndata: {}\n\n";
  const messages = parseSseMessages(raw);
  assert.equal(messages.length, 1);
});

test("parseSseMessages returns empty array for a bare newline", () => {
  assert.deepEqual(parseSseMessages("\n\n"), []);
});
