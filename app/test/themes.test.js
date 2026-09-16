const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const registry = require("../renderer/themes");

const EXPECTED_IDS = [
  "glass", "still-air", "study", "manifesto", "meridian", "paper",
  "matrix", "amber", "blueprint", "sakura-dusk",
];
const XTERM_KEYS = [
  "background", "foreground", "cursor", "cursorAccent", "selectionBackground",
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue",
  "brightMagenta", "brightCyan", "brightWhite",
];

test("every theme is complete: label, full xterm palette, both providers", () => {
  assert.deepEqual(Object.keys(registry.themes).sort(), [...EXPECTED_IDS].sort());
  assert.equal(registry.DEFAULT_THEME, "glass");
  for (const [id, theme] of Object.entries(registry.themes)) {
    assert.ok(theme.label, `${id} has a label`);
    for (const key of XTERM_KEYS) {
      assert.match(String(theme.xterm[key]), /^#[0-9a-f]{6,8}$/i, `${id}.xterm.${key}`);
    }
    // The appearance popover needs a swatch per theme.
    assert.match(String(theme.swatch?.bg), /^#[0-9a-f]{6}$/i, `${id}.swatch.bg`);
    assert.match(String(theme.swatch?.accent), /^#[0-9a-f]{6}$/i, `${id}.swatch.accent`);
    // The wall color belongs to CSS in every theme.
    assert.equal(theme.xterm.background, "#00000000", `${id} terminal background is transparent`);
    for (const provider of ["claude", "codex"]) {
      const p = theme.providers[provider];
      assert.ok(p, `${id} defines ${provider}`);
      for (const key of ["cursor", "cursorAccent", "selectionBackground"]) {
        assert.match(String(p[key]), /^#[0-9a-f]{6}$/i, `${id}.${provider}.${key}`);
      }
    }
  }
});

test("termTheme overlays the provider cursor onto the base palette", () => {
  const base = registry.termTheme("study");
  const claude = registry.termTheme("study", "claude");
  assert.equal(base.foreground, claude.foreground);
  assert.equal(claude.cursor, registry.themes.study.providers.claude.cursor);
  assert.notEqual(base.cursor, claude.cursor);
  // Unknown ids fall back to the default instead of crashing a pane.
  assert.equal(registry.termTheme("nope").cursor, registry.themes.glass.xterm.cursor);
});

test("style.css defines a token block for every non-default theme", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "renderer", "style.css"), "utf8");
  for (const id of EXPECTED_IDS.filter((t) => t !== "glass")) {
    assert.match(css, new RegExp(`body\\[data-theme="${id}"\\]`), `style.css themes ${id}`);
  }
});
