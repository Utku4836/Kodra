import assert from "node:assert/strict";
import test from "node:test";
import {
  publicReasoningOptions,
  resolveThinkingMode,
  thinkingModesForModel,
} from "../src/thinking-modes.js";

test("thinking menu uses only the active model's API-provided modes", () => {
  const modes = thinkingModesForModel({
    supportsReasoning: true,
    reasoningOptions: ["minimal", "low", "medium", "high", "high"],
  });
  assert.deepEqual(modes.map((mode) => mode.id), ["minimal", "low", "medium", "high"]);
  assert.deepEqual(modes.map((mode) => mode.label), ["Minimal", "Low", "Medium", "High"]);
});

test("non-reasoning and unspecified models fall back safely to Standard", () => {
  assert.deepEqual(thinkingModesForModel({ supportsReasoning: false }), [
    { id: "off", label: "Standard", budget: 0 },
  ]);
  assert.deepEqual(thinkingModesForModel(null), [
    { id: "off", label: "Standard", budget: 0 },
  ]);
});

test("structured API modes preserve safe budgets and resolve the current selection", () => {
  const modes = thinkingModesForModel({
    reasoningOptions: [
      { id: "balanced", label: "Balanced", budgetTokens: 2048 },
      { value: "deep", budget: 8192 },
    ],
  });
  assert.deepEqual(modes, [
    { id: "balanced", label: "Balanced", budget: 2048 },
    { id: "deep", label: "Deep", budget: 8192 },
  ]);
  assert.equal(resolveThinkingMode(modes, "DEEP").id, "deep");
  assert.equal(resolveThinkingMode(modes, "removed-mode").id, "balanced");
});

test("offline model cache keeps only normalized public reasoning options", () => {
  const options = publicReasoningOptions({
    reasoningOptions: [
      { id: "low", budget: 1024, apiKey: "must-not-survive" },
      { id: "high", label: "High" },
    ],
  });
  assert.deepEqual(options, [
    { id: "low", label: "Low", budget: 1024 },
    { id: "high", label: "High" },
  ]);
  assert.equal(JSON.stringify(options).includes("must-not-survive"), false);
});
