import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import {
  RUNTIME_PERFORMANCE_BUDGETS,
  createFrameCoalescer,
  modelCacheState,
  parsePublicModelCache,
  publicModelCatalog,
} from "../src/performance-runtime.js";

test("frame coalescer ayni frame icindeki isi teke indirir ve son veriyi kullanir", () => {
  const queue = [];
  const calls = [];
  const scheduler = createFrameCoalescer((value) => calls.push(value), {
    requestFrame: (callback) => { queue.push(callback); return queue.length; },
  });
  scheduler.schedule("ilk");
  scheduler.schedule("son");
  scheduler.schedule("en-son");
  assert.equal(queue.length, RUNTIME_PERFORMANCE_BUDGETS.maxFrameJobsPerScheduler);
  queue.shift()();
  assert.deepEqual(calls, ["en-son"]);
  assert.equal(scheduler.pending, false);
});

test("model katalogu fresh stale ve expired durumlarini ayirir", () => {
  const now = 10_000;
  assert.equal(modelCacheState(null, now), "miss");
  assert.equal(modelCacheState({ items: [1], expiresAt: now + 1, staleUntil: now + 2 }, now), "fresh");
  assert.equal(modelCacheState({ items: [1], expiresAt: now - 1, staleUntil: now + 2 }, now), "stale");
  assert.equal(modelCacheState({ items: [1], expiresAt: now - 2, staleUntil: now - 1 }, now), "expired");
});

test("offline model snapshot yalniz public katalog alanlarini saklar", () => {
  const items = publicModelCatalog([{
    id: "gemini-test",
    displayName: "Gemini Test",
    providerId: "gemini",
    providerName: "Google Gemini",
    contextWindow: 1000,
    supportsTools: true,
    recommended: true,
    apiKey: "secret",
    headers: [{ name: "x-secret", value: "hidden" }],
  }]);
  assert.equal(items.length, 1);
  assert.equal(JSON.stringify(items).includes("secret"), false);
  assert.equal(JSON.stringify(items).includes("hidden"), false);
  const restored = parsePublicModelCache(JSON.stringify({
    items,
    expiresAt: 10,
    staleUntil: 20,
    apiKey: "still-secret",
  }));
  assert.equal(restored.items[0].id, "gemini-test");
  assert.equal(restored.expiresAt, 10);
});

test("uzun oturum ve compositor butceleri kaynakta korunur", () => {
  const css = fs.readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const markdownCss = fs.readFileSync(new URL("../src/markdown-ui.css", import.meta.url), "utf8");
  const codeBlockRule = markdownCss.match(/\.md-code-block\s*\{([^}]*)\}/s)?.[1] || "";
  assert.match(css, /content-visibility:\s*auto/);
  assert.doesNotMatch(css, /\.log-item[^}]*translateZ\(0\)/s);
  assert.doesNotMatch(codeBlockRule, /backdrop-filter/);
});
