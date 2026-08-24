import test from "node:test";
import assert from "node:assert/strict";
import {
  attachmentKind,
  attachmentPolicy,
  attachmentTokenEstimate,
  pastedContentDescriptor,
  validateAttachment,
} from "../src/attachment-support.js";

test("attachment policy follows the selected model capability instead of provider-wide vision", () => {
  const providerInfo = { protocol: "openai_chat", capabilities: { vision: true } };
  assert.equal(attachmentPolicy({ model: { supportsVision: false }, providerInfo }).images, false);
  assert.equal(attachmentPolicy({ model: { supportsVision: true }, providerInfo }).images, true);
  assert.equal(attachmentPolicy({ providerInfo }).images, true);
});

test("PDF is exposed only for native Anthropic and Gemini protocols", () => {
  assert.equal(attachmentPolicy({ protocol: "openai_chat" }).documents, false);
  assert.equal(attachmentPolicy({ protocol: "anthropic_messages" }).documents, true);
  assert.equal(attachmentPolicy({ protocol: "gemini_generate_content" }).documents, true);
});

test("attachment validation bounds type, count, individual size and total payload", () => {
  const policy = { text: true, images: true, documents: false };
  assert.equal(attachmentKind({ name: "app.ts", type: "" }), "text");
  assert.equal(validateAttachment({ name: "shot.png", type: "image/png", size: 1024 }, policy, []).ok, true);
  assert.match(validateAttachment({ name: "paper.pdf", type: "application/pdf", size: 1024 }, policy, []).reason, /not supported/i);
  assert.match(validateAttachment({ name: "huge.txt", type: "text/plain", size: 300 * 1024 }, policy, []).reason, /256 KB/);
  assert.match(validateAttachment({ name: "x.txt", type: "text/plain", size: 10 }, policy, [{}, {}, {}, {}]).reason, /up to 4/);
});

test("token estimates count text without accidentally charging base64 length", () => {
  const estimate = attachmentTokenEstimate([
    { kind: "text", text: "a".repeat(400) },
    { kind: "image", dataUrl: "x".repeat(1_000_000) },
  ]);
  assert.equal(estimate, 1200);
});

test("large or code-heavy clipboard text becomes a named paste attachment", () => {
  assert.equal(pastedContentDescriptor("A short sentence").attach, false);
  const code = pastedContentDescriptor("function demo() {\n  const value = 1;\n  return value;\n}\n// more\n// lines\n");
  assert.equal(code.attach, true);
  assert.equal(code.code, true);
  assert.equal(code.name, "Pasted code");
  const prose = pastedContentDescriptor("paragraph\n".repeat(8));
  assert.equal(prose.attach, true);
  assert.equal(prose.name, "Pasted text");
});
