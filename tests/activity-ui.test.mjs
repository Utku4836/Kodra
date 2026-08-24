import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  activitySummary,
  createActivityGroup,
  toolDetailRows,
  toolLabel,
  toolTarget,
} from "../src/activity-ui.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function fixture() {
  const dom = new JSDOM("<!doctype html><main id='log'></main>");
  const log = dom.window.document.getElementById("log");
  const animations = [];
  const activity = createActivityGroup({
    documentRef: dom.window.document,
    mount: (element) => log.appendChild(element),
    animate: (element, kind) => animations.push({ element, kind }),
    startedAt: 100,
  });
  return { dom, log, animations, activity };
}

test("tool copy uses compact human verbs for running, completed, and failed states", () => {
  assert.equal(toolLabel("read_file", "run"), "Reading");
  assert.equal(toolLabel("read_file", "ok"), "Read");
  assert.equal(toolLabel("execute_command", "ok"), "Ran");
  assert.equal(toolLabel("edit_file", "err"), "Edit failed");
  assert.equal(toolLabel("custom_tool", "ok"), "Custom tool");
});

test("activity summary does not repeat tool rows in the outer disclosure", () => {
  assert.equal(activitySummary([], 1), "Thinking");
  assert.equal(activitySummary(["read_file"]), "Worked");
  assert.equal(activitySummary(["read_file", "list_dir", "execute_command"], 1), "Thinking");
  assert.equal(activitySummary(["edit_file", "execute_command", "web_fetch"]), "Worked");
});

test("tool summaries and detail rows keep only meaningful user-facing fields", () => {
  assert.equal(toolTarget("execute_command", { command: "npm test" }), "npm test");
  assert.equal(toolTarget("read_file", { path: "C:\\repo\\src\\main.js" }, (value) => value.replace("C:\\repo", "~")), "~\\src\\main.js");
  assert.deepEqual(toolDetailRows("search_code", { path: "src", pattern: "Thinking" }), [
    { label: "Path", value: "src" },
    { label: "Query", value: "Thinking" },
  ]);
});

test("activity group is a nested keyboard disclosure with independent thinking and tool rows", () => {
  const { dom, log, activity, animations } = fixture();
  const groupButton = log.querySelector(".activity-group-trigger");
  const groupPanel = log.querySelector(".activity-group-panel");

  assert.equal(groupButton.tagName, "BUTTON");
  assert.equal(groupButton.getAttribute("aria-expanded"), "false");
  assert.equal(groupPanel.getAttribute("aria-hidden"), "true");
  assert.equal(groupPanel.inert, true);
  assert.equal(groupButton.querySelector(".activity-status"), null);

  const thinking = activity.addThinking("Inspecting the current tool flow.");
  thinking.setComplete();
  const tool = activity.addTool({
    toolId: "read_file",
    params: { path: "C:\\repo\\src\\main.js" },
    target: "~\\src\\main.js",
  });
  tool.body.textContent = "184 lines read";
  tool.revealOutput();
  tool.setTime("0.2s");
  tool.setStatus("ok");

  assert.equal(activity.entries.length, 2);
  assert.equal(log.querySelectorAll(".activity-entry-trigger").length, 2);
  assert.equal(thinking.trigger.querySelector(".activity-status"), null);
  assert.ok(tool.trigger.querySelector(".activity-status"));
  assert.equal(tool.label.textContent, "Read");
  assert.equal(tool.panel.getAttribute("aria-label"), "Read details");
  assert.equal(tool.target.textContent, "~\\src\\main.js");
  assert.equal(tool.body.hidden, false);
  assert.doesNotMatch(tool.panelInner.textContent, /read_file|Duration/);
  assert.match(tool.panelInner.textContent, /main\.js/);
  assert.equal(tool.time.textContent, "0.2s");
  assert.deepEqual(animations.map(({ kind }) => kind), ["group", "entry", "status", "entry", "status"]);

  groupButton.click();
  assert.equal(groupButton.getAttribute("aria-expanded"), "true");
  assert.equal(groupPanel.inert, false);

  tool.trigger.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.equal(tool.trigger.getAttribute("aria-expanded"), "true");
  assert.equal(thinking.trigger.getAttribute("aria-expanded"), "false");
  assert.equal(animations.filter(({ kind }) => kind === "toggle").length, 2);
});

test("completed activity keeps details collapsed and exposes a concise elapsed summary", () => {
  const { log, activity } = fixture();
  activity.addTool({ toolId: "execute_command", params: { command: "npm test" } }).setStatus("ok");
  activity.finish("ok", 6420);

  const root = log.querySelector(".activity-group");
  assert.equal(root.dataset.status, "ok");
  assert.equal(root.getAttribute("aria-busy"), "false");
  assert.equal(root.querySelector(".activity-label").textContent, "Worked");
  assert.equal(root.querySelector(".activity-time").textContent, "6.4s");
  assert.equal(root.querySelector(".activity-group-trigger").getAttribute("aria-expanded"), "false");
});

test("restored activity can omit an invented duration", () => {
  const { log, activity } = fixture();
  activity.addThinking("Saved reasoning").setComplete();
  activity.finish("ok", false);
  assert.equal(log.querySelector(".activity-time").textContent, "");
  assert.equal(log.querySelector(".activity-group-trigger").getAttribute("aria-label"), "Thinking. Show activity details");
});

test("main stream and session restore route provider reasoning and tools through activity groups", () => {
  const main = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "../src/styles.css"), "utf8");

  assert.match(main, /reasoningDelta[\s\S]*ensureResponseActivity\(\)\.addThinking\(\)/);
  assert.match(main, /processToolItem\(call, activity, responseActivityRecord\)/);
  assert.match(main, /renderStructuredSession[\s\S]*activity\.addThinking\(\)/);
  assert.match(main, /sessionTranscript[\s\S]*createActivityTranscript/);
  assert.doesNotMatch(main, /closest\("\.log-item"\)/);
  assert.match(css, /\.activity-group-panel/);
  assert.match(css, /\.activity-entry-panel/);
  assert.match(css, /prefers-reduced-motion/);
});
