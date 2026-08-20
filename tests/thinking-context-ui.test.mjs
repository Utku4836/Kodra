import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("index.html contains the new floating working capsule, thinking chip, and SVG context gauge", () => {
  const html = fs.readFileSync(path.join(__dirname, "../src/index.html"), "utf8");
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  // 1. Floating AI capsule
  const workingCapsule = doc.getElementById("stream-actions");
  assert.ok(workingCapsule, "stream-actions capsule exists");
  assert.ok(workingCapsule.classList.contains("ai-working-capsule"), "capsule has ai-working-capsule class");
  assert.ok(doc.getElementById("stream-stop"), "stream-stop button exists");
  assert.ok(doc.querySelector(".ai-wave-indicator"), "ai-wave-indicator exists");

  // 2. Thinking chip & modal
  const thinkingChip = doc.getElementById("thinking-chip");
  assert.ok(thinkingChip, "thinking-chip button exists");
  assert.ok(doc.getElementById("thinking-name"), "thinking-name exists");
  assert.ok(doc.getElementById("thinking-modal"), "thinking-modal exists");
  assert.ok(doc.getElementById("thinking-slider-track"), "thinking-slider-track exists");

  // 3. SVG context gauge
  const ctxStatus = doc.getElementById("ctx-status");
  assert.ok(ctxStatus, "ctx-status exists");
  assert.ok(doc.getElementById("ctx-gauge-fill"), "ctx-gauge-fill circle exists");
  assert.ok(doc.getElementById("ctx-pct"), "ctx-pct span exists");
});

test("context gauge calculations produce smooth offsets and threshold states", () => {
  const circumference = 53.407;

  function calcGauge(total, limit) {
    const pct = limit > 0 ? Math.min(100, Math.max(0, (total / limit) * 100)) : 0;
    const offset = total > 0
      ? circumference - Math.max(1.8, (pct / 100) * circumference)
      : circumference;
    const isMid = pct > 70 && pct <= 90;
    const isHigh = pct > 90;
    return { pct, offset, isMid, isHigh };
  }

  // 0 tokens
  const zero = calcGauge(0, 128000);
  assert.equal(zero.pct, 0);
  assert.equal(zero.offset, circumference);
  assert.equal(zero.isMid, false);
  assert.equal(zero.isHigh, false);

  // Small token count (500 tokens / 128k = 0.39%)
  const small = calcGauge(500, 128000);
  assert.ok(small.pct < 1);
  // Ensured visible baseline notch > 0
  assert.ok(small.offset < circumference);
  assert.equal(small.offset, circumference - 1.8);

  // 75% tokens (mid warning)
  const mid = calcGauge(96000, 128000);
  assert.equal(mid.pct, 75);
  assert.equal(mid.isMid, true);
  assert.equal(mid.isHigh, false);

  // 95% tokens (high alert)
  const high = calcGauge(121600, 128000);
  assert.equal(high.pct, 95);
  assert.equal(high.isMid, false);
  assert.equal(high.isHigh, true);
});
