import { toolDetailRows, toolIcon, toolLabel, toolTarget } from "./tool-renderers.js";

export { toolDetailRows, toolLabel, toolTarget } from "./tool-renderers.js";

const SUMMARY_GROUPS = Object.freeze([
  { ids: ["write_file", "edit_file", "create_dir", "apply_diff", "delete_file"], one: "Edited a file", many: "Edited files" },
  { ids: ["read_file", "list_dir", "analyze_codebase"], one: "Read a file", many: "Read files" },
  { ids: ["search_code", "glob_files"], one: "Searched code", many: "Searched code" },
  { ids: ["execute_command", "manage_background_process"], one: "Ran a command", many: "Ran commands" },
  { ids: ["web_fetch"], one: "Browsed the web", many: "Browsed the web" },
  { ids: ["browser_automation"], one: "Used the browser", many: "Used the browser" },
  { ids: ["github_action"], one: "Updated GitHub", many: "Updated GitHub" },
  { ids: ["manage_memory"], one: "Updated memory", many: "Updated memory" },
  { ids: ["spawn_sub_agent"], one: "Delegated a task", many: "Delegated tasks" },
]);

let disclosureId = 0;

function normalizeStatus(status) {
  if (status === "busy") return "run";
  return ["run", "ok", "err"].includes(status) ? status : "run";
}

export function activitySummary(toolIds = [], thinkingCount = 0) {
  const source = Array.isArray(toolIds) ? toolIds.filter(Boolean) : [];
  if (!source.length) return thinkingCount > 0 ? "Thought" : "Worked";

  const matched = new Set();
  const phrases = [];
  for (const group of SUMMARY_GROUPS) {
    const count = source.filter((toolId) => group.ids.includes(toolId)).length;
    if (!count) continue;
    source.filter((toolId) => group.ids.includes(toolId)).forEach((toolId) => matched.add(toolId));
    phrases.push(count === 1 ? group.one : group.many);
  }
  const unmatched = source.filter((toolId) => !matched.has(toolId)).length;
  if (unmatched) phrases.push(unmatched === 1 ? "Used a tool" : "Used tools");
  if (phrases.length > 2) return `Used ${source.length} tools`;
  return phrases.map((phrase, index) => index === 0
    ? phrase
    : phrase.charAt(0).toLowerCase() + phrase.slice(1)).join(", ");
}

function createArrow(documentRef) {
  const arrow = documentRef.createElement("span");
  arrow.className = "activity-arrow";
  arrow.textContent = "›";
  arrow.setAttribute("aria-hidden", "true");
  return arrow;
}

function createDisclosure({
  documentRef,
  className,
  label,
  target = "",
  status = "run",
  icon = "__activity",
  open = false,
  onToggle,
}) {
  const id = `activity-detail-${++disclosureId}`;
  const root = documentRef.createElement("div");
  root.className = className;
  root.dataset.status = normalizeStatus(status);

  const trigger = documentRef.createElement("button");
  trigger.className = `${className}-trigger`;
  trigger.type = "button";
  trigger.setAttribute("aria-expanded", String(open));
  trigger.setAttribute("aria-controls", id);

  let statusIcon = null;
  if (icon) {
    statusIcon = documentRef.createElement("span");
    statusIcon.className = "activity-status";
    const iconDefinition = toolIcon(icon);
    statusIcon.dataset.icon = iconDefinition.name;
    statusIcon.innerHTML = iconDefinition.svg;
    statusIcon.setAttribute("aria-hidden", "true");
  }

  const statusText = documentRef.createElement("span");
  statusText.className = "sr-only activity-status-text";

  const copy = documentRef.createElement("span");
  copy.className = "activity-copy";
  const labelEl = documentRef.createElement("span");
  labelEl.className = "activity-label";
  labelEl.textContent = label;
  const targetEl = documentRef.createElement("span");
  targetEl.className = "activity-target";
  targetEl.textContent = target;
  targetEl.hidden = !target;
  copy.append(labelEl, targetEl);

  const time = documentRef.createElement("span");
  time.className = "activity-time";

  const arrow = createArrow(documentRef);
  if (statusIcon) trigger.appendChild(statusIcon);
  trigger.append(statusText, copy, time, arrow);

  const panel = documentRef.createElement("div");
  panel.className = `${className}-panel`;
  panel.id = id;
  panel.setAttribute("role", "region");
  panel.setAttribute("aria-label", `${label} details`);
  panel.setAttribute("aria-hidden", String(!open));
  panel.inert = !open;

  const panelInner = documentRef.createElement("div");
  panelInner.className = `${className}-panel-inner`;
  panel.appendChild(panelInner);
  root.append(trigger, panel);

  function setOpen(nextOpen) {
    const expanded = Boolean(nextOpen);
    root.classList.toggle("open", expanded);
    trigger.setAttribute("aria-expanded", String(expanded));
    panel.setAttribute("aria-hidden", String(!expanded));
    panel.inert = !expanded;
    onToggle?.(expanded, root);
  }

  trigger.addEventListener("click", () => setOpen(!root.classList.contains("open")));
  if (open) root.classList.add("open");

  return {
    root,
    trigger,
    panel,
    panelInner,
    label: labelEl,
    target: targetEl,
    time,
    statusIcon,
    statusText,
    setOpen,
    setTarget(value) {
      const next = String(value || "");
      targetEl.textContent = next;
      targetEl.hidden = !next;
    },
  };
}

function setDisclosureStatus(disclosure, status, toolId = null) {
  const state = normalizeStatus(status);
  disclosure.root.dataset.status = state;
  disclosure.statusText.textContent = state === "run"
    ? "Running"
    : state === "ok" ? "Completed" : "Failed";
  if (toolId) {
    disclosure.label.textContent = toolLabel(toolId, state);
    disclosure.panel.setAttribute("aria-label", `${disclosure.label.textContent} details`);
  }
}

function appendMetaRows(documentRef, root, rows) {
  root.replaceChildren();
  for (const row of rows) {
    const entry = documentRef.createElement("div");
    entry.className = "activity-meta-row";
    const key = documentRef.createElement("span");
    key.className = "activity-meta-key";
    key.textContent = row.label;
    const value = documentRef.createElement("code");
    value.className = "activity-meta-value";
    value.textContent = String(row.value ?? "");
    entry.append(key, value);
    root.appendChild(entry);
  }
}

export function createActivityGroup({
  documentRef = globalThis.document,
  mount,
  animate,
  onChange,
  startedAt = globalThis.performance?.now?.() ?? Date.now(),
} = {}) {
  const group = createDisclosure({
    documentRef,
    className: "activity-group",
    label: "Thinking",
    status: "run",
    icon: null,
    onToggle: (expanded, root) => {
      animate?.(root, "toggle", { expanded, scope: "group" });
      onChange?.();
    },
  });
  group.root.setAttribute("aria-live", "polite");
  group.root.setAttribute("aria-busy", "true");
  group.panelInner.classList.add("activity-list");
  group.statusText.textContent = "Working";
  mount?.(group.root);
  animate?.(group.root, "group");

  const entries = [];
  const toolIds = [];
  let thinkingCount = 0;

  function addThinking(text = "") {
    thinkingCount += 1;
    const entry = createDisclosure({
      documentRef,
      className: "activity-entry",
      label: "Thinking",
      status: "run",
      icon: null,
      onToggle: (expanded, root) => {
        animate?.(root, "toggle", { expanded, scope: "entry" });
        onChange?.();
      },
    });
    entry.root.classList.add("activity-thinking");
    entry.panelInner.classList.add("activity-thinking-content", "rich-message");
    entry.statusText.textContent = "Thinking";
    entry.panel.setAttribute("aria-label", "Thinking details");
    group.panelInner.appendChild(entry.root);
    entries.push(entry.root);
    animate?.(entry.root, "entry");
    if (text) entry.panelInner.textContent = text;
    onChange?.();
    return {
      ...entry,
      body: entry.panelInner,
      setText(value) { entry.panelInner.textContent = String(value || ""); },
      setComplete() {
        entry.root.dataset.status = "ok";
        entry.statusText.textContent = "Thinking completed";
        animate?.(entry.root, "status", { status: "ok" });
      },
    };
  }

  function addTool({ toolId, params = {}, target = "", status = "run", shorten, detailShorten } = {}) {
    toolIds.push(String(toolId || "tool"));
    const state = normalizeStatus(status);
    const entry = createDisclosure({
      documentRef,
      className: "activity-entry",
      label: toolLabel(toolId, state),
      target: target || toolTarget(toolId, params, shorten),
      status: state,
      icon: toolId,
      onToggle: (expanded, root) => {
        animate?.(root, "toggle", { expanded, scope: "entry" });
        onChange?.();
      },
    });
    entry.root.classList.add("activity-tool");
    entry.root.dataset.tool = String(toolId || "tool");

    const detail = documentRef.createElement("div");
    detail.className = "activity-detail";
    const meta = documentRef.createElement("div");
    meta.className = "activity-meta";
    appendMetaRows(documentRef, meta, toolDetailRows(toolId, params, detailShorten));
    const output = documentRef.createElement("div");
    output.className = "activity-output";
    output.hidden = true;
    detail.append(meta, output);
    entry.panelInner.appendChild(detail);
    setDisclosureStatus(entry, state, toolId);
    group.panelInner.appendChild(entry.root);
    entries.push(entry.root);
    animate?.(entry.root, "entry");
    onChange?.();

    return {
      ...entry,
      body: output,
      lbl: entry.label,
      setTime(value) {
        const next = String(value || "");
        entry.time.textContent = next;
        const rows = toolDetailRows(toolId, params, detailShorten);
        if (next) rows.push({ label: "Duration", value: next });
        appendMetaRows(documentRef, meta, rows);
      },
      setStatus(nextStatus) {
        setDisclosureStatus(entry, nextStatus, toolId);
        animate?.(entry.root, "status", { status: normalizeStatus(nextStatus) });
      },
      revealOutput() { output.hidden = false; },
    };
  }

  function finish(state = "ok", elapsedMs = null) {
    const showDuration = elapsedMs !== false;
    const elapsed = Number.isFinite(elapsedMs)
      ? elapsedMs
      : (globalThis.performance?.now?.() ?? Date.now()) - startedAt;
    const duration = Math.max(0, elapsed) / 1000;
    const durationText = `${duration < 10 ? duration.toFixed(1) : Math.round(duration)}s`;
    group.root.dataset.status = state === "err" ? "err" : "ok";
    group.root.setAttribute("aria-busy", "false");
    group.statusText.textContent = state === "err" ? "Work stopped" : "Work completed";
    group.label.textContent = state === "err" ? "Stopped" : activitySummary(toolIds, thinkingCount);
    group.time.textContent = showDuration ? durationText : "";
    group.trigger.setAttribute("aria-label", showDuration
      ? `${group.label.textContent} for ${durationText}. Show activity details`
      : `${group.label.textContent}. Show activity details`);
    animate?.(group.root, "status", { status: state });
    onChange?.();
  }

  return {
    element: group.root,
    list: group.panelInner,
    entries,
    addThinking,
    addTool,
    finish,
    setOpen: group.setOpen,
  };
}
