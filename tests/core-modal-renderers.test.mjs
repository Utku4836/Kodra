import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { renderCoreModalRows } from "../src/features/modals/core-modal-renderers.js";

function fixture() {
  const dom = new JSDOM("<!doctype html><div id='list'></div>");
  return { document: dom.window.document, list: dom.window.document.getElementById("list") };
}

test("model rows are grouped by provider without noisy counts or metadata badges", () => {
  const { document, list } = fixture();
  const result = renderCoreModalRows({
    mode: "models",
    items: [
      { id: "gpt", displayName: "GPT", providerName: "OpenAI" },
      { id: "gemini", displayName: "Gemini", providerName: "Google" },
    ],
    documentRef: document,
    list,
  });
  assert.equal(result.rows.length, 2);
  assert.deepEqual([...list.querySelectorAll(".modal-category")].map((node) => node.textContent), ["Google", "OpenAI"]);
  assert.equal(list.textContent.includes("1"), false);
  assert.equal(list.querySelectorAll(".model-meta, .model-badge").length, 0);
});

test("access mode uses the shared selected row instead of adding a checkmark", () => {
  const { document, list } = fixture();
  const result = renderCoreModalRows({
    mode: "mode",
    items: [{ id: "smart", name: "Smart" }, { id: "strict", name: "Strict" }],
    documentRef: document,
    list,
    context: { activeAccessMode: "strict" },
  });
  assert.equal(result.selectedIndex, 1);
  assert.equal(list.textContent.includes("✓"), false);
});

test("theme and composer menus return one stable selected index", () => {
  for (const [mode, currentKey, currentValue] of [
    ["themes", "currentThemeId", "mist"],
    ["composer-mode", "composerMode", "plan"],
  ]) {
    const { document, list } = fixture();
    const result = renderCoreModalRows({
      mode,
      items: [
        { id: mode === "themes" ? "kodra" : "auto", label: "First", name: "First" },
        { id: currentValue, label: "Second", name: "Second" },
      ],
      documentRef: document,
      list,
      context: { [currentKey]: currentValue },
    });
    assert.equal(result.selectedIndex, 1);
    assert.equal(result.rows.length, 2);
  }
});
