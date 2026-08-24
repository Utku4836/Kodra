import assert from "node:assert/strict";
import test from "node:test";
import {
  addActivityThinking,
  addActivityTool,
  appendTranscriptEntry,
  createActivityTranscript,
  createTranscriptEntry,
  migrateMessagesToTranscript,
} from "../src/session-transcript.js";

test("structured transcript keeps presentation data separate from provider messages", () => {
  const transcript = [];
  appendTranscriptEntry(transcript, createTranscriptEntry("user", { text: "Inspect src" }));
  const activity = createActivityTranscript(transcript, 10);
  addActivityThinking(activity, "Inspecting", "I will read the file.");
  addActivityTool(activity, { id: "call-1", name: "read_file", arguments: { path: "src/main.js" } }, { content: "line" }, { summary: "line", durationMs: 15 });
  assert.deepEqual(transcript.map((entry) => entry.type), ["user", "activity"]);
  assert.equal(activity.tools[0].toolId, "read_file");
  assert.equal(activity.tools[0].result.content, "line");
});

test("legacy provider history migrates into explicit activity records", () => {
  const transcript = migrateMessagesToTranscript([
    { role: "user", content: "Read" },
    { role: "assistant", content: "Checking", reasoningContent: "Need the file", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "a" } }] },
    { role: "tool", toolCallId: "c1", content: "[tool:read_file] contents" },
    { role: "assistant", content: "Done", toolCalls: [] },
  ]);
  assert.deepEqual(transcript.map((entry) => entry.type), ["user", "activity", "assistant"]);
  assert.equal(transcript[1].tools[0].toolId, "read_file");
  assert.equal(transcript[2].text, "Done");
});
