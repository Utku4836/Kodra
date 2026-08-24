import test from "node:test";
import assert from "node:assert/strict";

import {
  compactThresholdFor,
  contextLimitOf,
  defaultCompactionState,
  estimateTokens,
  normalizeSessionIntelligence,
  outputReserveOf,
  turnCostUsd,
} from "../src/session-metrics.js";

test("context metrics enforce safe limits, output reserve, and the 80 percent default", () => {
  assert.equal(contextLimitOf({ contextLimit: 2_000 }), 131_072);
  assert.equal(contextLimitOf({ contextLimit: 128_000 }), 128_000);
  assert.equal(outputReserveOf({ contextLimit: 128_000, maxOutputTokens: 16_000 }), 16_000);
  assert.equal(compactThresholdFor({ contextLimit: 128_000, maxOutputTokens: 16_000 }), 89_600);
});

test("token estimation includes structured content without counting absent fields", () => {
  const plain = estimateTokens([{ role: "user", content: "12345678" }]);
  const structured = estimateTokens([{ role: "assistant", content: "", toolCalls: [{ id: "x" }], reasoningContent: "abcd" }]);
  assert.equal(plain, 6);
  assert.ok(structured > 5);
});

test("session intelligence normalizes legacy values and cost respects cached pricing", () => {
  const record = normalizeSessionIntelligence({ usage: { apiCalls: 2 }, compaction: { threshold: 2 } });
  assert.equal(record.compaction.threshold, defaultCompactionState().threshold);
  assert.equal(record.usage.apiCalls, 2);
  assert.equal(turnCostUsd(
    { inputTokens: 1_000_000, cachedTokens: 500_000, outputTokens: 1_000_000 },
    { inputPricePerMillion: 2, cachedInputPricePerMillion: 1, outputPricePerMillion: 4 },
  ), 5.5);
});
