#!/usr/bin/env node
/**
 * schemica CLI
 *
 * Usage:
 *   schemica inspect <url> [--header "Name: Value"] [--json]
 *   schemica --version
 *   schemica --help
 */

import { inspect, version } from "./index.js";

/**
 * Terminal color support, following the `ls --color` convention.
 *
 * Precedence (highest first):
 *   1. --color=always|never   (explicit CLI flag always wins)
 *   2. NO_COLOR env var       (https://no-color.org - any non-empty value disables)
 *   3. FORCE_COLOR env var    (any non-empty, non-"0" value enables)
 *   4. --color=auto (default): color only when stdout is a TTY
 *
 * Kept dependency-free: a handful of SGR codes, no chalk/picocolors needed.
 */

const CODES = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
};

/**
 * @param {"always"|"never"|"auto"} mode
 * @param {{ isTTY?: boolean }} [stream] defaults to process.stdout
 */
export function shouldUseColor(mode, stream = process.stdout) {
  if (mode === "always") return true;
  if (mode === "never") return false;
  // mode === "auto" from here down
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0") return true;
  return !!stream.isTTY;
}

/**
 * Build a colorizer bound to a single on/off decision, so call sites never
 * re-check the condition — makes it impossible to color half a message.
 * @param {boolean} enabled
 */
export function createColorizer(enabled) {
  const wrap = (code) => (text) => (enabled ? `${code}${text}${CODES.reset}` : text);
  return {
    enabled,
    bold: wrap(CODES.bold),
    dim: wrap(CODES.dim),
    red: wrap(CODES.red),
    green: wrap(CODES.green),
    yellow: wrap(CODES.yellow),
    blue: wrap(CODES.blue),
    magenta: wrap(CODES.magenta),
    cyan: wrap(CODES.cyan),
  };
}

const HELP = `schemica ${version} — inspect API and MCP server schemas

Usage:
  schemica inspect <url>         Show the tool/endpoint surface of a target
  schemica --version             Print version
  schemica --help                This message

Options:
  --header "Name: Value"         Add a request header (repeatable)
  --json                         Output raw JSON instead of a summary
  --color=always|never|auto      Control colored output (default: auto)

Examples:
  schemica inspect https://example.com/mcp
  schemica inspect https://api.example.com/openapi.json --json
  schemica inspect https://example.com/mcp --header "Authorization: Bearer TOKEN"

Docs: https://schemica.dev
`;

/**
 * @typedef {Object} ParsedArgs
 * @property {string[]} _
 * @property {Record<string,string>} headers
 * @property {boolean} json
 * @property {"always"|"never"|"auto"} color
 * @property {boolean} [help]
 * @property {boolean} [version]
 */

/**
 * @param {string[]} argv
 * @returns {ParsedArgs}
 */
function parseArgs(argv) {
  /** @type {ParsedArgs} */
  const args = { _: [], headers: {}, json: false, color: "auto" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--version" || a === "-v") args.version = true;
    else if (a === "--json") args.json = true;
    else if (a === "--header" || a === "-H") {
      const raw = argv[++i] ?? "";
      const idx = raw.indexOf(":");
      if (idx > 0) {
        args.headers[raw.slice(0, idx).trim()] = raw.slice(idx + 1).trim();
      }
    } else if (a === "--color") {
      // Bare --color (no =value), matching ls: treated as "always".
      args.color = "always";
    } else if (a.startsWith("--color=")) {
      const value = a.slice("--color=".length);
      if (!["always", "never", "auto"].includes(value)) {
        console.error(`Invalid --color value: "${value}" (expected always|never|auto)`);
        process.exit(1);
      }
      // The check above guarantees value is one of the three literals;
      // TS can't narrow through Array#includes on its own.
      args.color = /** @type {"always"|"never"|"auto"} */ (value);
    } else args._.push(a);
  }
  return args;
}

function renderMcp(summary, c) {
  console.log(`${c.bold("MCP server")} — ${c.cyan(summary.toolCount)} tool(s)\n`);
  for (const t of summary.tools) {
    const req = t.required.length
      ? ` ${c.dim("(required:")} ${c.yellow(t.required.join(", "))}${c.dim(")")}`
      : "";
    console.log(`  ${c.bold(t.name)}`);
    if (t.description) console.log(`    ${c.dim(t.description)}`);
    if (t.parameters.length) {
      console.log(`    ${c.dim("params:")} ${t.parameters.join(", ")}${req}`);
    }
    console.log();
  }
}

const METHOD_COLOR = { GET: "green", DELETE: "red" }; // others default to yellow

function renderOpenApi(summary, c) {
  const title = summary.title ? `${summary.title} ` : "";
  const ver = summary.version ? `v${summary.version} ` : "";
  console.log(
    `${c.bold("OpenAPI")} — ${title}${ver}— ${c.cyan(summary.pathCount)} path(s)\n`,
  );
  for (const p of summary.paths.slice(0, 50)) {
    const methods = p.methods
      .map((m) => {
        const upper = m.toUpperCase();
        const colorFn = c[METHOD_COLOR[upper] ?? "yellow"];
        return colorFn(upper.padEnd(6));
      })
      .join(" ");
    console.log(`  ${methods} ${c.bold(p.path)}`);
  }
  if (summary.paths.length > 50) {
    console.log(`  ${c.dim(`... and ${summary.paths.length - 50} more`)}`);
  }
  console.log();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const c = createColorizer(shouldUseColor(args.color));

  if (args.version) {
    console.log(version);
    return;
  }
  if (args.help || args._.length === 0) {
    console.log(HELP);
    return;
  }

  const [command, url] = args._;
  if (command !== "inspect") {
    console.error(c.bold(c.red(`Unknown command: ${command}`)) + "\n");
    console.error(HELP);
    process.exitCode = 1;
    return;
  }
  if (!url) {
    console.error(c.red("Usage: schemica inspect <url>"));
    process.exitCode = 1;
    return;
  }

  try {
    const result = await inspect(url, args.headers);
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (result.kind === "mcp") renderMcp(result.summary, c);
    else if (result.kind === "openapi") renderOpenApi(result.summary, c);
    else {
      console.log(`${c.bold("JSON document")} — top-level keys:`);
      console.log(`  ${result.summary.topLevelKeys.join(", ")}\n`);
    }
  } catch (err) {
    if (err.name === "AuthRequiredError") {
      console.error(c.bold(c.red("Authentication required")) + "\n");
      console.error(`  ${err.message}\n`);
      if (err.kind === "oauth") {
        if (err.authorizationServers?.length) {
          console.error(`  ${c.dim("Authorization server(s):")}`);
          for (const s of err.authorizationServers) console.error(`    ${c.cyan(s)}`);
        }
        if (err.scopesSupported?.length) {
          console.error(`  ${c.dim("Scopes:")} ${err.scopesSupported.join(", ")}`);
        }
        if (err.resourceMetadataUrl) {
          console.error(`  ${c.dim("Metadata:")} ${c.cyan(err.resourceMetadataUrl)}`);
        }
        if (err.resourceDocumentation) {
          console.error(`  ${c.dim("Docs:")} ${c.cyan(err.resourceDocumentation)}`);
        }
        console.error();
      }
      process.exitCode = 2; // distinct from 1, so CI can branch on "needs auth"
      return;
    }
    if (err.name === "UnsupportedTransportError") {
      console.error(c.bold(c.yellow("Unsupported transport")) + "\n");
      console.error(`  ${err.message}\n`);
      if (err.allow) console.error(`  ${c.dim("Allow:")} ${err.allow}`);
      if (err.discoveredEndpoint) {
        console.error(`  ${c.dim("Discovered message endpoint:")} ${c.cyan(err.discoveredEndpoint)}`);
      }
      console.error();
      process.exitCode = 3; // distinct from 1/2: "we understood it, can't speak it"
      return;
    }
    if (err.name === "MalformedResponseError") {
      console.error(c.bold(c.yellow("Unexpected response")) + "\n");
      console.error(`  ${err.message}\n`);
      process.exitCode = 4; // "we got a 200 but couldn't make sense of it"
      return;
    }
    console.error(c.bold(c.red("Error:")) + ` ${err.message}`);
    process.exitCode = 1;
  }
}

main();
