import assert from "node:assert/strict";
import test from "node:test";
import {
  createProviderObservation,
  diagnosticExport,
  diagnosticStateLabel,
  mergeDiagnosticReport,
} from "../src/provider-diagnostics.js";

test("son provider istegi yalniz guvenli telemetry alanlarini tasir", () => {
  const observation = createProviderObservation(
    { provider: "gemini", model: "gemini-test", apiKey: "secret" },
    { model: "gemini-response", usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 }, secret: "hidden" },
    123.6,
    42,
  );
  assert.deepEqual(observation, {
    provider: "gemini",
    requestedModel: "gemini-test",
    responseModel: "gemini-response",
    latencyMs: 124,
    inputTokens: 12,
    outputTokens: 4,
    reasoningTokens: 0,
    cachedTokens: 0,
    totalTokens: 16,
    observedAt: 42,
  });
  assert.equal(JSON.stringify(observation).includes("secret"), false);
});

test("diagnostic export allowlist disindaki secret alanlarini atar", () => {
  const exported = diagnosticExport({
    providerId: "openai",
    providerName: "OpenAI",
    overall: "healthy",
    endpoint: "https://api.openai.com",
    requestId: "req_safe-123",
    account: { limitUsd: 10, remainingUsd: 7.5, usageUsd: 2.5, tier: "paid", secret: "hidden" },
    apiKey: "sk-secret",
    checks: [{ id: "auth", title: "Auth", state: "healthy", detail: "ok", token: "secret" }],
  });
  const json = JSON.stringify(exported);
  assert.equal(json.includes("sk-secret"), false);
  assert.equal(json.includes('"token"'), false);
  assert.equal(json.includes('"secret"'), false);
  assert.equal(exported.endpoint, "https://api.openai.com");
  assert.equal(exported.requestId, "req_safe-123");
  assert.deepEqual(exported.account, {
    limitUsd: 10,
    remainingUsd: 7.5,
    usageUsd: 2.5,
    resetAt: null,
    tier: "paid",
  });
});

test("yalniz ayni providera ait son istek rapora eklenir", () => {
  const report = { providerId: "groq", checks: [] };
  assert.equal(mergeDiagnosticReport(report, { provider: "openai" }).lastRequest, null);
  assert.equal(mergeDiagnosticReport(report, { provider: "groq", latencyMs: 20 }).lastRequest.latencyMs, 20);
});

test("diagnostic states map to stable user labels", () => {
  assert.equal(diagnosticStateLabel("healthy"), "Healthy");
  assert.equal(diagnosticStateLabel("rate_limited"), "Rate limited");
  assert.equal(diagnosticStateLabel("unknown"), "Unknown");
});
