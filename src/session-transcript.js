export const SESSION_SCHEMA_VERSION = 2;

const MAX_TRANSCRIPT_ENTRIES = 5000;
const MAX_TEXT_LENGTH = 24_000;

function id(prefix = "entry") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function boundedText(value, limit = MAX_TEXT_LENGTH) {
  const text = String(value ?? "");
  return text.length > limit ? `${text.slice(0, limit)}\n… ${text.length - limit} characters omitted` : text;
}

function boundedArray(value, limit = 160) {
  return Array.isArray(value) ? value.slice(0, limit) : [];
}

function boundedValue(value, depth = 0) {
  if (typeof value === "string") return boundedText(value, 64_000);
  if (value === null || typeof value !== "object") return value;
  if (depth >= 5) return "[nested value omitted]";
  if (Array.isArray(value)) return value.slice(0, 200).map((entry) => boundedValue(entry, depth + 1));
  return Object.fromEntries(Object.entries(value).slice(0, 160).map(([key, entry]) => [key, boundedValue(entry, depth + 1)]));
}

export function compactToolResult(toolId, result = {}) {
  if (!result || typeof result !== "object") return { message: boundedText(result, 4000) };
  const common = result.message ? { message: boundedText(result.message, 4000) } : {};
  switch (toolId) {
    case "read_file": return { ...common, content: boundedText(result.content) };
    case "list_dir": return { ...common, entries: boundedArray(result.entries, 180).map((entry) => ({ name: boundedText(entry?.name, 500), is_dir: Boolean(entry?.is_dir) })) };
    case "search_code":
    case "analyze_codebase":
      return {
        ...common,
        tree: boundedArray(result.tree, 200).map((line) => boundedText(line, 1000)),
        matches: boundedArray(result.matches, 120).map((match) => ({
          file: boundedText(match?.file, 1000),
          line: Number(match?.line || 0),
          text: boundedText(match?.text, 2000),
        })),
      };
    case "glob_files": return { ...common, files: boundedArray(result.files, 300).map((file) => boundedText(file, 1000)) };
    case "web_fetch": return { ...common, content: boundedText(result.content) };
    case "execute_command": return {
      ...common,
      stdout: boundedText(result.stdout, 24_000),
      stderr: boundedText(result.stderr, 12_000),
      exit_code: Number(result.exit_code ?? 0),
    };
    case "spawn_sub_agent": return { ...common, sub_agent_reply: boundedText(result.sub_agent_reply) };
    default: return common;
  }
}

export function normalizeTranscript(record = {}) {
  const transcript = Array.isArray(record.transcript) ? record.transcript : [];
  return transcript
    .filter((entry) => entry && ["user", "assistant", "activity", "system"].includes(entry.type))
    .slice(-MAX_TRANSCRIPT_ENTRIES);
}

export function createTranscriptEntry(type, value = {}) {
  const createdAt = Number(value.createdAt || Date.now());
  if (type === "activity") {
    return {
      id: String(value.id || id("activity")),
      type,
      status: value.status === "err" ? "err" : value.status === "ok" ? "ok" : "run",
      startedAt: Number(value.startedAt || createdAt),
      durationMs: Number.isFinite(Number(value.durationMs)) ? Number(value.durationMs) : null,
      thinking: boundedArray(value.thinking, 64).map((step) => ({
        text: boundedText(step?.text),
        progress: boundedText(step?.progress),
      })),
      tools: boundedArray(value.tools, 256),
      createdAt,
    };
  }
  return {
    id: String(value.id || id(type)),
    type,
    text: boundedText(value.text),
    createdAt,
  };
}

export function appendTranscriptEntry(transcript, entry) {
  const target = Array.isArray(transcript) ? transcript : [];
  target.push(entry);
  if (target.length > MAX_TRANSCRIPT_ENTRIES) target.splice(0, target.length - MAX_TRANSCRIPT_ENTRIES);
  return entry;
}

export function createActivityTranscript(transcript, startedAt = Date.now()) {
  const entry = createTranscriptEntry("activity", { startedAt });
  appendTranscriptEntry(transcript, entry);
  return entry;
}

export function addActivityThinking(activity, text, progress = "") {
  if (!activity) return null;
  const step = { text: boundedText(text), progress: boundedText(progress) };
  activity.thinking ||= [];
  activity.thinking.push(step);
  return step;
}

export function addActivityTool(activity, call, result, details = {}) {
  if (!activity) return null;
  const record = {
    id: String(call?.id || id("tool")),
    toolId: String(call?.name || details.toolId || "tool"),
    params: call?.arguments && typeof call.arguments === "object" ? boundedValue(call.arguments) : {},
    result: compactToolResult(call?.name || details.toolId, result),
    summary: boundedText(details.summary, 6000),
    status: details.status === "err" ? "err" : "ok",
    durationMs: Math.max(0, Number(details.durationMs || 0)),
    order: Number.isFinite(Number(details.order)) ? Number(details.order) : activity.tools?.length || 0,
  };
  activity.tools ||= [];
  activity.tools.push(record);
  return record;
}

export function migrateMessagesToTranscript(messages = []) {
  const transcript = [];
  const calls = new Map();
  let activity = null;
  const finishActivity = () => {
    if (!activity) return;
    activity.status = "ok";
    activity = null;
  };

  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role === "user") {
      finishActivity();
      appendTranscriptEntry(transcript, createTranscriptEntry("user", { text: message.content }));
    } else if (message?.role === "assistant") {
      const toolCalls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
      if (toolCalls.length || message.reasoningContent) {
        activity ||= createActivityTranscript(transcript);
        addActivityThinking(activity, message.reasoningContent || "", toolCalls.length ? message.content || "" : "");
        for (const call of toolCalls) calls.set(call.id, { call, activity });
      }
      if (!toolCalls.length && message.content) {
        finishActivity();
        appendTranscriptEntry(transcript, createTranscriptEntry("assistant", { text: message.content }));
      }
    } else if (message?.role === "tool") {
      const saved = calls.get(message.toolCallId);
      const match = String(message.content || "").match(/^\[tool:([^\]]+)]\s*/);
      const call = saved?.call || { id: message.toolCallId, name: match?.[1] || "tool_result", arguments: {} };
      activity ||= saved?.activity || createActivityTranscript(transcript);
      addActivityTool(activity, call, { message: String(message.content || "").slice(match?.[0]?.length || 0) }, {
        summary: String(message.content || "").slice(match?.[0]?.length || 0),
      });
    }
  }
  finishActivity();
  return transcript;
}
