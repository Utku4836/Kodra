import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import {
  DEFAULT_THEME_ID,
  THEME_STORAGE_KEY,
  createThemeRegistry,
  createThemeRuntime,
  validateThemeDefinition,
} from "../src/themes/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("the builtin registry exposes Kodra, Mist, and Ember in a stable order", () => {
  const registry = createThemeRegistry();
  assert.deepEqual(registry.list().map((theme) => theme.id), ["kodra", "mist", "ember"]);
  assert.equal(registry.get("mist").transparency, "frosted");
});

test("custom themes accept known safe tokens and reject CSS injection or unknown tokens", () => {
  const valid = validateThemeDefinition({
    id: "quiet-blue",
    label: "Quiet Blue",
    version: 1,
    tokens: { "text.primary": "#f7fbff", "glass.blur": "18px" },
  });
  assert.equal(valid.ok, true);

  const unsafe = validateThemeDefinition({
    id: "unsafe",
    label: "Unsafe",
    version: 1,
    tokens: { "canvas.background": "url(https://example.test/x)", "made.up": "red" },
  });
  assert.equal(unsafe.ok, false);
  assert.match(unsafe.errors.join(" "), /Unsafe|Unknown/);
});

test("theme runtime restores a preference, applies semantic variables, and falls back safely", () => {
  const dom = new JSDOM("<!doctype html><html data-theme='kodra'><body></body></html>", { url: "https://local.test" });
  dom.window.localStorage.setItem(THEME_STORAGE_KEY, "mist");
  const runtime = createThemeRuntime({
    documentRef: dom.window.document,
    storage: dom.window.localStorage,
    registry: createThemeRegistry(),
  });

  assert.equal(runtime.restore().id, "mist");
  assert.equal(dom.window.document.documentElement.dataset.theme, "mist");
  assert.equal(dom.window.document.documentElement.style.getPropertyValue("--theme-glass-blur"), "24px");

  assert.equal(runtime.apply("missing-theme").id, DEFAULT_THEME_ID);
  assert.equal(dom.window.localStorage.getItem(THEME_STORAGE_KEY), DEFAULT_THEME_ID);
});

test("the client wires /themes into the shared compact modal and loads the pre-paint stylesheet", () => {
  const main = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");
  const commands = fs.readFileSync(path.join(__dirname, "../src/command-registry.js"), "utf8");
  const userThemes = fs.readFileSync(path.join(__dirname, "../src/features/themes/user-theme-service.js"), "utf8");
  const html = fs.readFileSync(path.join(__dirname, "../src/index.html"), "utf8");
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, "../src-tauri/tauri.conf.json"), "utf8"));

  assert.match(commands, /id: "themes"/);
  assert.match(main, /openThemeMenu\(\)/);
  assert.match(main, /modalMode === "themes"/);
  assert.match(main, /current: userThemeService\.current/);
  assert.match(userThemes, /list_user_themes/);
  assert.match(userThemes, /open_theme_directory/);
  assert.match(html, /themes\/theme-bootstrap\.js/);
  assert.match(html, /themes\/themes\.css/);
  assert.equal(config.app.windows[0].transparent, true);
  assert.deepEqual(config.app.windows[0].windowEffects.effects, ["acrylic"]);
});
