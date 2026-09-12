import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldUseColor, createColorizer } from "../src/cli.js";

test("shouldUseColor: --color=always wins regardless of TTY or env", () => {
  const savedNoColor = process.env.NO_COLOR;
  process.env.NO_COLOR = "1";
  try {
    assert.equal(shouldUseColor("always", { isTTY: false }), true);
  } finally {
    if (savedNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = savedNoColor;
  }
});

test("shouldUseColor: --color=never wins regardless of TTY or env", () => {
  const savedForce = process.env.FORCE_COLOR;
  process.env.FORCE_COLOR = "1";
  try {
    assert.equal(shouldUseColor("never", { isTTY: true }), false);
  } finally {
    if (savedForce === undefined) delete process.env.FORCE_COLOR;
    else process.env.FORCE_COLOR = savedForce;
  }
});

test("shouldUseColor: auto follows isTTY when no env vars are set", () => {
  const savedNoColor = process.env.NO_COLOR;
  const savedForce = process.env.FORCE_COLOR;
  delete process.env.NO_COLOR;
  delete process.env.FORCE_COLOR;
  try {
    assert.equal(shouldUseColor("auto", { isTTY: true }), true);
    assert.equal(shouldUseColor("auto", { isTTY: false }), false);
  } finally {
    if (savedNoColor !== undefined) process.env.NO_COLOR = savedNoColor;
    if (savedForce !== undefined) process.env.FORCE_COLOR = savedForce;
  }
});

test("shouldUseColor: NO_COLOR takes precedence over FORCE_COLOR under auto", () => {
  const savedNoColor = process.env.NO_COLOR;
  const savedForce = process.env.FORCE_COLOR;
  process.env.NO_COLOR = "1";
  process.env.FORCE_COLOR = "1";
  try {
    assert.equal(shouldUseColor("auto", { isTTY: false }), false);
  } finally {
    if (savedNoColor === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = savedNoColor;
    if (savedForce === undefined) delete process.env.FORCE_COLOR; else process.env.FORCE_COLOR = savedForce;
  }
});

test("createColorizer(false) returns text unchanged", () => {
  const c = createColorizer(false);
  assert.equal(c.bold("x"), "x");
  assert.equal(c.red("x"), "x");
});

test("createColorizer(true) wraps text in SGR codes and always resets", () => {
  const c = createColorizer(true);
  const out = c.bold("x");
  assert.ok(out.startsWith("\x1b["));
  assert.ok(out.endsWith("\x1b[0m"));
  assert.ok(out.includes("x"));
});
