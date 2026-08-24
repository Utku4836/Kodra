import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { createWindowShell } from "../src/window-shell.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function fixture() {
  const dom = new JSDOM(`<!doctype html><div id="root"><div id="drag"></div><button id="origin">Origin</button><div id="menu" role="menu" hidden>
    <button role="menuitem" data-window-action="minimize">Minimize</button>
    <button role="menuitem" data-window-action="toggle-maximize">Maximize / Restore</button>
    <button role="menuitem" data-window-action="close">Close</button>
  </div>`);
  const calls = [];
  const currentWindow = {
    minimize: async () => calls.push("minimize"),
    toggleMaximize: async () => calls.push("toggle-maximize"),
    close: async () => calls.push("close"),
    startDragging: async () => calls.push("drag"),
  };
  const root = dom.window.document.getElementById("root");
  const menu = dom.window.document.getElementById("menu");
  createWindowShell({
    root,
    dragRegion: dom.window.document.getElementById("drag"),
    menu,
    windowApi: { getCurrentWindow: () => currentWindow },
    documentRef: dom.window.document,
    windowRef: dom.window,
  });
  return { dom, root, menu, calls };
}

test("right click opens a keyboard menu and Escape restores focus", () => {
  const { dom, root, menu } = fixture();
  const origin = dom.window.document.getElementById("origin");
  origin.focus();
  root.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, clientX: 40, clientY: 30 }));
  assert.equal(menu.hidden, false);
  assert.equal(dom.window.document.activeElement.dataset.windowAction, "minimize");
  menu.dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" }));
  assert.equal(dom.window.document.activeElement.dataset.windowAction, "toggle-maximize");
  menu.dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
  assert.equal(menu.hidden, true);
  assert.equal(dom.window.document.activeElement, origin);
});

test("menu actions and the invisible drag rail use native window methods", async () => {
  const { dom, root, menu, calls } = fixture();
  root.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true }));
  menu.querySelector('[data-window-action="toggle-maximize"]').click();
  await Promise.resolve();
  dom.window.document.getElementById("drag").dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true, button: 0, detail: 1 }));
  await Promise.resolve();
  assert.deepEqual(calls, ["toggle-maximize", "drag"]);
});

test("frameless shell removes traffic lights and keeps the user chevron in the shared gutter", () => {
  const html = fs.readFileSync(path.join(__dirname, "../src/index.html"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "../src/styles.css"), "utf8");
  assert.doesNotMatch(html, /traffic-lights|btn-close|btn-min|btn-max/);
  assert.match(html, /bottom-bar[\s\S]*dock-workspace[\s\S]*id="path"/);
  assert.doesNotMatch(html, /composer-mode-tab|attachment-menu|<div class="dock-workspace"[^>]*>\s*<svg/);
  assert.match(html, /command-input-wrap[\s\S]*command-prompt[\s\S]*attachment-tray[\s\S]*cmd-input/);
  assert.match(css, /--conversation-copy-inset:\s*26px/);
  assert.match(css, /\.log\s*\{[^}]*padding-left:\s*var\(--conversation-copy-inset\)/);
  assert.match(css, /\.user-block::before\s*\{[^}]*left:\s*calc\(var\(--conversation-copy-inset\) \* -1\)/);
});

test("input, user messages, and assistant copy share one conversation scale", () => {
  const css = fs.readFileSync(path.join(__dirname, "../src/styles.css"), "utf8");
  const markdownCss = fs.readFileSync(path.join(__dirname, "../src/markdown-ui.css"), "utf8");
  assert.match(css, /--conversation-font-size:\s*15px/);
  assert.match(css, /--conversation-line-height:\s*1\.62/);
  assert.match(css, /\.user-block\s*\{[^}]*font-size:\s*var\(--conversation-font-size\)[^}]*line-height:\s*var\(--conversation-line-height\)/s);
  assert.match(css, /\.log-line\s*\{[^}]*font-size:\s*var\(--conversation-font-size\)[^}]*line-height:\s*var\(--conversation-line-height\)/s);
  assert.match(css, /\.command-input\s*\{[^}]*font-size:\s*var\(--conversation-font-size\)[^}]*line-height:\s*var\(--conversation-line-height\)/s);
  assert.match(markdownCss, /\.rich-message\s*\{[^}]*font-size:\s*var\(--conversation-font-size\)[^}]*line-height:\s*var\(--conversation-line-height\)/s);
  assert.match(css, /\.streaming-message\s*\{[^}]*margin:\s*2px 0 var\(--conversation-row-gap\)/s);
});
