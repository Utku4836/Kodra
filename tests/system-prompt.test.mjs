import test from "node:test";
import assert from "node:assert/strict";

import { buildSystemPrompt } from "../src/system-prompt.js";

test("system prompt receives model, workspace context, and composer mode explicitly", () => {
  const prompt = buildSystemPrompt({
    config: { model: "test-model" },
    homeDir: "C:\\Users\\Example",
    composerMode: "plan",
  });
  assert.match(prompt, /test-model/);
  assert.match(prompt, /C:\\Users\\Example/);
  assert.match(prompt, /Current composer mode: PLAN/);
  assert.match(prompt, /critical|destructive/i);
});
