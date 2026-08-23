import { diffStats, renderDiffViewer } from "./diff-viewer.js";

const ICONS = Object.freeze({
  activity: '<svg viewBox="0 0 16 16"><path d="M3 8h2l1.2-3.2L8.3 12l1.5-4H13"/></svg>',
  thinking: '<svg viewBox="0 0 16 16"><path d="M8 2.5v2M8 11.5v2M2.5 8h2M11.5 8h2M4.1 4.1l1.4 1.4M10.5 10.5l1.4 1.4M11.9 4.1l-1.4 1.4M5.5 10.5l-1.4 1.4"/></svg>',
  file: '<svg viewBox="0 0 16 16"><path d="M4 2.5h5l3 3V13.5H4zM9 2.5v3h3M6 8h4M6 10.5h3"/></svg>',
  folder: '<svg viewBox="0 0 16 16"><path d="M2.5 4h4l1.2 1.5h5.8v7h-11z"/></svg>',
  search: '<svg viewBox="0 0 16 16"><circle cx="6.8" cy="6.8" r="3.7"/><path d="m9.6 9.6 3.2 3.2"/></svg>',
  globe: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.5"/><path d="M2.8 8h10.4M8 2.5c2.2 2.1 2.2 8.9 0 11M8 2.5c-2.2 2.1-2.2 8.9 0 11"/></svg>',
  edit: '<svg viewBox="0 0 16 16"><path d="m3 11.8.5-2.6 6.8-6.7 2.2 2.2-6.8 6.7zM3 11.8l2.7-.4"/></svg>',
  terminal: '<svg viewBox="0 0 16 16"><rect x="2.5" y="3" width="11" height="10" rx="1.5"/><path d="m5 6 2 2-2 2M8.5 10h2.5"/></svg>',
  memory: '<svg viewBox="0 0 16 16"><path d="M5 3.5h6v9H5zM3 6h2M3 9h2M11 6h2M11 9h2M7 6h2M7 9h2"/></svg>',
  process: '<svg viewBox="0 0 16 16"><path d="M3 4h7M10 4l-2-2M10 4 8 6M13 12H6M6 12l2-2M6 12l2 2"/></svg>',
  github: '<svg viewBox="0 0 16 16"><path d="M5 3.5h6v4H5zM8 7.5v5M4 12.5h8M3 5.5H1.8v7H4M12 5.5h2.2v7H12"/></svg>',
  agent: '<svg viewBox="0 0 16 16"><circle cx="5" cy="4" r="1.5"/><circle cx="11" cy="8" r="1.5"/><circle cx="5" cy="12" r="1.5"/><path d="M6.5 4h1A2.5 2.5 0 0 1 10 6.5M6.5 12h1A2.5 2.5 0 0 0 10 9.5"/></svg>',
  tool: '<svg viewBox="0 0 16 16"><path d="M9.5 3.1a3 3 0 0 0-3.6 3.8l-3.4 3.4 3.2 3.2 3.4-3.4a3 3 0 0 0 3.8-3.6l-2 2-2.4-.7-.7-2.4z"/></svg>',
});

const DEFINITIONS = Object.freeze({
  read_file: { icon: "file", labels: ["Reading", "Read", "Read failed"], target: ["path"] },
  list_dir: { icon: "folder", labels: ["Listing", "Listed", "List failed"], target: ["path"] },
  search_code: { icon: "search", labels: ["Searching", "Searched", "Search failed"], target: ["pattern", "query", "path"] },
  glob_files: { icon: "search", labels: ["Finding", "Found", "Find failed"], target: ["pattern", "path"] },
  web_fetch: { icon: "globe", labels: ["Fetching", "Fetched", "Fetch failed"], target: ["url"] },
  analyze_codebase: { icon: "search", labels: ["Analyzing", "Analyzed", "Analysis failed"], target: ["path", "query"] },
  write_file: { icon: "edit", labels: ["Writing", "Wrote", "Write failed"], target: ["path"], diff: true },
  edit_file: { icon: "edit", labels: ["Editing", "Edited", "Edit failed"], target: ["path"], diff: true },
  create_dir: { icon: "folder", labels: ["Creating", "Created", "Create failed"], target: ["path"] },
  apply_diff: { icon: "edit", labels: ["Applying", "Applied", "Apply failed"], target: ["path"], diff: true },
  delete_file: { icon: "file", labels: ["Deleting", "Deleted", "Delete failed"], target: ["path"] },
  execute_command: { icon: "terminal", labels: ["Running", "Ran", "Command failed"], target: ["command", "cmd"] },
  manage_memory: { icon: "memory", labels: ["Updating memory", "Updated memory", "Memory update failed"], target: ["path", "action"] },
  browser_automation: { icon: "globe", labels: ["Using browser", "Used browser", "Browser action failed"], target: ["url", "action"] },
  manage_background_process: { icon: "process", labels: ["Managing process", "Managed process", "Process action failed"], target: ["action", "pid", "command"] },
  github_action: { icon: "github", labels: ["Updating GitHub", "Updated GitHub", "GitHub action failed"], target: ["action", "repository", "repo"] },
  spawn_sub_agent: { icon: "agent", labels: ["Delegating", "Delegated", "Delegation failed"], target: ["task", "prompt"] },
});

function escapeHtml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fallbackLabel(toolId) {
  const words = String(toolId || "Tool").replace(/[_-]+/g, " ").trim().split(/\s+/).filter(Boolean);
  return words.length ? words.map((word, index) => index ? word.toLowerCase() : word[0].toUpperCase() + word.slice(1)).join(" ") : "Tool";
}

export function getToolRenderer(toolId) {
  return DEFINITIONS[toolId] || { icon: "tool", labels: null, target: ["path", "url", "pattern", "query", "name"] };
}

export function toolIcon(toolId) {
  const key = toolId === "__activity" ? "activity" : toolId === "__thinking" ? "thinking" : getToolRenderer(toolId).icon;
  return { name: key, svg: ICONS[key] || ICONS.tool };
}

export function toolLabel(toolId, status = "run") {
  const index = status === "err" ? 2 : status === "ok" ? 1 : 0;
  return getToolRenderer(toolId).labels?.[index] || fallbackLabel(toolId);
}

export function toolTarget(toolId, params = {}, shorten = (value) => String(value || "")) {
  for (const field of getToolRenderer(toolId).target) {
    const value = params?.[field];
    if (value === undefined || value === null || value === "") continue;
    const normalized = typeof value === "string" ? value : JSON.stringify(value);
    const result = shorten(normalized);
    if (result) return String(result).replace(/\s+/g, " ").slice(0, 92);
  }
  return "";
}

export function toolDetailRows(toolId, params = {}, shorten = (value) => String(value || "")) {
  const rows = [{ label: "Tool", value: String(toolId || "tool") }];
  for (const [label, value] of [
    ["Path", params.path], ["Command", params.command ?? params.cmd], ["URL", params.url],
    ["Query", params.query ?? params.pattern], ["Action", params.action], ["Repository", params.repository ?? params.repo],
  ]) {
    if (value === undefined || value === null || value === "") continue;
    rows.push({ label, value: shorten(typeof value === "string" ? value : JSON.stringify(value)) });
  }
  return rows;
}

export function toolSummary(toolId, result = {}) {
  switch (toolId) {
    case "read_file": return String(result.content || "").slice(0, 2000);
    case "list_dir": return (result.entries || []).map((entry) => entry.is_dir ? `${entry.name}/` : entry.name).join(", ").slice(0, 1000);
    case "search_code": return (result.matches || []).map((match) => `${match.file}:${match.line} ${match.text}`).join("\n").slice(0, 1500);
    case "glob_files": return (result.files || []).join("\n").slice(0, 1000) || "(no matches)";
    case "web_fetch": return String(result.content || "").slice(0, 2000);
    case "analyze_codebase": return result.tree
      ? (result.tree || []).join("\n").slice(0, 1500)
      : (result.matches || []).map((match) => `${match.file}:${match.line} ${match.text}`).join("\n").slice(0, 1500);
    case "manage_background_process": return JSON.stringify(result).slice(0, 800);
    case "spawn_sub_agent": return String(result.sub_agent_reply || "").slice(0, 2000);
    case "execute_command": {
      let text = String(result.stdout || "").slice(0, 1500);
      if (result.stderr) text += `\nSTDERR: ${String(result.stderr).slice(0, 500)}`;
      if (result.exit_code !== 0) text += `\nexit code: ${result.exit_code}`;
      return text || "(no output)";
    }
    default: return result.message || "completed";
  }
}

export function toolFailed(result = {}) {
  return result.exit_code !== undefined && result.exit_code !== 0
    && !result.message && !result.content && !result.entries && !result.matches && !result.files && !result.sub_agent_reply;
}

export function renderToolResult(toolId, params = {}, result = {}, options = {}) {
  const renderer = getToolRenderer(toolId);
  if (renderer.diff) {
    const stats = diffStats(toolId, params);
    return {
      kind: "diff",
      html: renderDiffViewer(toolId, params, options),
      text: "",
      summary: `files: 1 · +${stats.additions} -${stats.deletions}`,
    };
  }
  if (toolId === "list_dir") {
    const entries = result.entries || [];
    const body = entries.length
      ? entries.slice(0, 120).map((entry) => `<span class="${entry.is_dir ? "dir" : "file"}">${escapeHtml(entry.name)}${entry.is_dir ? "/" : ""}</span>`).join("")
      : '<span class="activity-empty">(empty)</span>';
    return { kind: "html", html: `<div class="dir-grid">${body}</div>`, text: "", summary: toolSummary(toolId, result) };
  }
  if (toolId === "execute_command") {
    const stdout = String(result.stdout || "").split("\n").filter((line) => line.trim());
    const stderr = String(result.stderr || "").split("\n").filter((line) => line.trim());
    const hidden = Math.max(0, stdout.length + stderr.length - 60);
    const parts = [stdout.slice(0, hidden ? 45 : stdout.length).join("\n")];
    if (stderr.length) parts.push(`[stderr]\n${stderr.slice(0, hidden ? 15 : stderr.length).join("\n")}`);
    if (hidden) parts.push(`… ${hidden} lines hidden`);
    if (result.exit_code !== 0) parts.push(`[exit] ${result.exit_code}`);
    return { kind: "text", html: "", text: parts.filter(Boolean).join("\n\n") || "(no output)", summary: toolSummary(toolId, result) };
  }
  if (toolId === "read_file") {
    const lines = String(result.content || "").split("\n");
    const text = lines.slice(0, 80).map((line, index) => `${String(index + 1).padStart(4, " ")} | ${line}`).join("\n")
      + (lines.length > 80 ? `\n… ${lines.length - 80} more lines` : "");
    return { kind: "text", html: "", text, summary: toolSummary(toolId, result) };
  }
  if (toolId === "search_code" || toolId === "analyze_codebase") {
    const text = (result.matches || []).slice(0, 40).map((match) => `${String(match.file).split(/[\\/]/).pop()}:${match.line}  ${match.text}`).join("\n") || "(no matches)";
    return { kind: "text", html: "", text, summary: toolSummary(toolId, result) };
  }
  if (toolId === "web_fetch") return { kind: "text", html: "", text: String(result.content || "").slice(0, 4000), summary: toolSummary(toolId, result) };
  if (toolId === "glob_files") return { kind: "text", html: "", text: (result.files || []).join("\n"), summary: toolSummary(toolId, result) };
  return { kind: "text", html: "", text: result.message || "", summary: toolSummary(toolId, result) };
}

export function renderToolApproval(toolId, params = {}, options = {}) {
  if (getToolRenderer(toolId).diff) return renderDiffViewer(toolId, params, options);
  const text = toolId === "execute_command"
    ? `› ${params.command || params.cmd || ""}`
    : params.path || params.pattern || params.url || JSON.stringify(params);
  return `<div class="diff-line diff-context"><span class="diff-num"></span><span class="diff-num"></span><span class="diff-sign"> </span><span>${escapeHtml(text)}</span></div>`;
}
