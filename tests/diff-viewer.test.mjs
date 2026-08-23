import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { diffStats, pairSplitRows, parseUnifiedDiff, renderDiffViewer, setDiffViewMode } from "../src/diff-viewer.js";

test("unified diff parser preserves hunks, line numbers, statistics, and inferred path", () => {
  const parsed = parseUnifiedDiff([
    "--- a/src/main.js",
    "+++ b/src/main.js",
    "@@ -7,2 +7,2 @@",
    " old line",
    "-removed",
    "+added",
  ].join("\n"));

  assert.equal(parsed.inferredPath, "src/main.js");
  assert.equal(parsed.additions, 1);
  assert.equal(parsed.deletions, 1);
  assert.equal(parsed.lines.find((line) => line.type === "delete").old, 8);
  assert.equal(parsed.lines.find((line) => line.type === "add").new, 8);
});

test("single-line edit viewer highlights only the changed words and exposes file metadata", () => {
  const html = renderDiffViewer("edit_file", {
    path: "C:\\workspace\\src\\styles.css",
    old_string: "color: gray;",
    new_string: "color: white;",
  }, { shortenPath: (value) => value.replace("C:\\workspace", "~") });
  const dom = new JSDOM(html);
  const root = dom.window.document;

  assert.equal(root.querySelector(".tool-diff-identity strong").textContent, "styles.css");
  assert.match(root.querySelector(".tool-diff-identity span").textContent, /~\/src/);
  assert.equal(root.querySelectorAll('[data-mode="unified"] .tool-diff-row.is-delete').length, 1);
  assert.equal(root.querySelectorAll('[data-mode="unified"] .tool-diff-row.is-add').length, 1);
  assert.equal(root.querySelectorAll('[data-mode="unified"] .tool-diff-word').length, 2);
  assert.match(root.querySelector(".tool-diff-stats").textContent, /\+1/);
  assert.match(root.querySelector(".tool-diff-stats").textContent, /−1/);
});

test("new files are bounded and untrusted content stays text", () => {
  const content = ["<script>alert(1)</script>", ...Array.from({ length: 40 }, (_, index) => `line ${index}`)].join("\n");
  const html = renderDiffViewer("write_file", { path: "src/new.js", content }, { maxLines: 20 });
  const dom = new JSDOM(html);
  const root = dom.window.document;

  assert.equal(root.querySelector("script"), null);
  assert.match(root.body.textContent, /<script>alert\(1\)<\/script>/);
  assert.equal(root.querySelectorAll('[data-mode="unified"] .tool-diff-row.is-add').length, 20);
  assert.match(root.querySelector(".tool-diff-fold").textContent, /21 more lines/);
  assert.deepEqual(diffStats("write_file", { content }), { additions: 41, deletions: 0 });
});

test("split diff pairs replacement lines and exposes an accessible persistent toggle", () => {
  const html = renderDiffViewer("edit_file", { path: "src/a.js", old_string: "old", new_string: "new" });
  const dom = new JSDOM(html);
  const viewer = dom.window.document.querySelector(".tool-diff");
  assert.equal(pairSplitRows([{ type: "delete", old: 1, text: "old" }, { type: "add", new: 1, text: "new" }]).length, 1);
  assert.equal(viewer.querySelectorAll(".tool-diff-split-row").length, 1);
  assert.equal(setDiffViewMode(viewer, "split"), "split");
  assert.equal(viewer.dataset.view, "split");
  assert.equal(viewer.querySelector('[data-diff-mode="split"]').getAttribute("aria-pressed"), "true");
});
