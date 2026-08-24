import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createComposerWorkflow } from "../src/composer-workflow.js";

function fixture() {
  const dom = new JSDOM(`<!doctype html><body>
    <div id="shell">
      <section id="panel" hidden><span id="eyebrow"></span><h2 id="title"></h2><span id="meta"></span>
      <div id="body"></div><textarea id="feedback" hidden></textarea><div id="actions"></div></section>
      <input id="input"></div></body>`, { url: "https://local.test" });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.localStorage = dom.window.localStorage;
  const byId = (id) => dom.window.document.getElementById(id);
  const workflow = createComposerWorkflow({
    shell: byId("shell"), panel: byId("panel"), eyebrow: byId("eyebrow"), title: byId("title"),
    meta: byId("meta"), body: byId("body"), feedback: byId("feedback"), actions: byId("actions"),
    input: byId("input"),
  }, { reducedMotion: () => true });
  return { dom, workflow, byId };
}

test("Auto, Build, and Plan modes are persisted without a connected label", () => {
  const { workflow, byId } = fixture();
  assert.equal(workflow.mode, "auto");
  assert.equal(byId("shell").dataset.mode, "auto");
  workflow.setMode("build");
  assert.equal(workflow.mode, "build");
  workflow.setMode("plan");
  assert.equal(workflow.mode, "plan");
  assert.equal(byId("shell").dataset.mode, "plan");
  assert.equal(localStorage.getItem("kodra-composer-mode"), "plan");
});

test("tool approval is composer-attached and supports mouse decisions", async () => {
  const { workflow, byId } = fixture();
  const decision = workflow.requestApproval({ toolId: "write_file", risk: "medium", detailHtml: "<pre>demo</pre>" });
  assert.equal(byId("panel").hidden, false);
  assert.equal(byId("title").textContent, "write file");
  assert.equal(byId("actions").querySelector("kbd"), null);
  byId("actions").querySelector('[data-action="once"]').click();
  assert.equal(await decision, "once");
  assert.equal(byId("panel").hidden, true);
});

test("plan review renders ordered steps and returns requested feedback", async () => {
  const { workflow, byId, dom } = fixture();
  const result = workflow.requestPlan({ title: "Ship it", steps: ["Inspect", "Implement", "Verify"], timeoutSeconds: 90 });
  assert.equal(byId("body").querySelectorAll("li").length, 3);
  byId("actions").querySelector('[data-action="change"]').click();
  byId("feedback").value = "Add a visual smoke test";
  byId("feedback").dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
  assert.deepEqual(await result, { decision: "change", feedback: "Add a visual smoke test" });
});
