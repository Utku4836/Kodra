import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { renderToolResult, toolIcon, toolLabel, toolTarget } from "../src/tool-renderers.js";

test("registry gives tool families distinct compact icons and state-aware labels", () => {
  assert.notEqual(toolIcon("read_file").name, toolIcon("execute_command").name);
  assert.notEqual(toolIcon("execute_command").name, toolIcon("web_fetch").name);
  assert.equal(toolLabel("edit_file", "ok"), "Edited");
  assert.equal(toolTarget("execute_command", { command: "npm test" }), "npm test");
});

test("registry renders bounded escaped directory output without main.js branches", () => {
  const rendered = renderToolResult("list_dir", {}, { entries: [{ name: "<script>x</script>", is_dir: false }] });
  const dom = new JSDOM(rendered.html);
  assert.equal(rendered.kind, "html");
  assert.equal(dom.window.document.querySelector("script"), null);
  assert.match(dom.window.document.body.textContent, /<script>x<\/script>/);
});
