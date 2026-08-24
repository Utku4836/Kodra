function escapeHtml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function splitLines(value) {
  const text = String(value ?? "").replace(/\r\n?/g, "\n");
  return text === "" ? [] : text.split("\n");
}

function wordDiff(oldText, newText) {
  const oldValue = String(oldText ?? "");
  const newValue = String(newText ?? "");
  let prefix = 0;
  while (prefix < oldValue.length && prefix < newValue.length && oldValue[prefix] === newValue[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < oldValue.length - prefix && suffix < newValue.length - prefix
    && oldValue[oldValue.length - 1 - suffix] === newValue[newValue.length - 1 - suffix]) suffix += 1;
  const oldMiddle = oldValue.slice(prefix, oldValue.length - suffix);
  const newMiddle = newValue.slice(prefix, newValue.length - suffix);
  return {
    oldHtml: `${escapeHtml(oldValue.slice(0, prefix))}<mark class="tool-diff-word is-delete">${escapeHtml(oldMiddle)}</mark>${escapeHtml(oldValue.slice(oldValue.length - suffix))}`,
    newHtml: `${escapeHtml(newValue.slice(0, prefix))}<mark class="tool-diff-word is-add">${escapeHtml(newMiddle)}</mark>${escapeHtml(newValue.slice(newValue.length - suffix))}`,
  };
}

export function parseUnifiedDiff(diffContent) {
  const output = [];
  let oldLine = 0;
  let newLine = 0;
  let additions = 0;
  let deletions = 0;
  let inferredPath = "";
  for (const raw of splitLines(diffContent)) {
    if (raw.startsWith("+++ ")) {
      const value = raw.slice(4).trim().replace(/^b\//, "");
      if (value !== "/dev/null") inferredPath = value;
      output.push({ type: "meta", text: raw });
    } else if (raw.startsWith("--- ")) output.push({ type: "meta", text: raw });
    else if (raw.startsWith("@@")) {
      const match = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (match) { oldLine = Number(match[1]); newLine = Number(match[2]); }
      output.push({ type: "hunk", text: raw });
    } else if (raw.startsWith("-") && !raw.startsWith("---")) {
      output.push({ type: "delete", old: oldLine++, text: raw.slice(1) }); deletions += 1;
    } else if (raw.startsWith("+") && !raw.startsWith("+++")) {
      output.push({ type: "add", new: newLine++, text: raw.slice(1) }); additions += 1;
    } else {
      output.push({ type: "context", old: oldLine++, new: newLine++, text: raw.startsWith(" ") ? raw.slice(1) : raw });
    }
  }
  return { lines: output, additions, deletions, inferredPath };
}

function unifiedRow(row) {
  if (row.type === "hunk" || row.type === "meta") {
    return `<div class="tool-diff-row is-${row.type}" role="row"><span class="tool-diff-meta" role="cell">${escapeHtml(row.text)}</span></div>`;
  }
  const sign = row.type === "add" ? "+" : row.type === "delete" ? "−" : "";
  return `<div class="tool-diff-row is-${row.type}" role="row">`
    + `<span class="tool-diff-number" role="cell">${row.old ?? ""}</span><span class="tool-diff-number" role="cell">${row.new ?? ""}</span>`
    + `<span class="tool-diff-sign" role="cell">${sign}</span><code class="tool-diff-code" role="cell">${row.html ?? escapeHtml(row.text)}</code></div>`;
}

function splitCell(row, side) {
  if (!row) return '<span class="tool-diff-side is-empty" aria-hidden="true"></span>';
  const number = side === "old" ? row.old : row.new;
  const sign = row.type === "delete" ? "−" : row.type === "add" ? "+" : "";
  return `<span class="tool-diff-side is-${row.type}"><span class="tool-diff-number">${number ?? ""}</span>`
    + `<span class="tool-diff-sign">${sign}</span><code class="tool-diff-code">${row.html ?? escapeHtml(row.text)}</code></span>`;
}

export function pairSplitRows(rows = []) {
  const paired = [];
  for (let index = 0; index < rows.length;) {
    const row = rows[index];
    if (row.type === "meta" || row.type === "hunk") { paired.push({ full: row }); index += 1; continue; }
    if (row.type === "context") { paired.push({ old: row, new: row }); index += 1; continue; }
    if (row.type === "delete") {
      const deletes = [];
      const adds = [];
      while (rows[index]?.type === "delete") deletes.push(rows[index++]);
      while (rows[index]?.type === "add") adds.push(rows[index++]);
      const count = Math.max(deletes.length, adds.length);
      for (let pair = 0; pair < count; pair++) paired.push({ old: deletes[pair] || null, new: adds[pair] || null });
      continue;
    }
    paired.push({ old: null, new: row });
    index += 1;
  }
  return paired;
}

function splitRow(pair) {
  if (pair.full) return `<div class="tool-diff-split-meta is-${pair.full.type}">${escapeHtml(pair.full.text)}</div>`;
  return `<div class="tool-diff-split-row">${splitCell(pair.old, "old")}${splitCell(pair.new, "new")}</div>`;
}

function pathParts(value) {
  const normalized = String(value || "untitled").replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return { name: parts.pop() || normalized || "untitled", directory: parts.join("/") };
}

function viewerHtml({ path, additions, deletions, rows, label, hiddenRows = 0, mode = "unified" }) {
  const parts = pathParts(path);
  const stats = `${additions > 0 ? `<span class="tool-diff-stat is-add">+${additions}</span>` : ""}`
    + `${deletions > 0 ? `<span class="tool-diff-stat is-delete">−${deletions}</span>` : ""}`;
  const fold = hiddenRows > 0 ? `<div class="tool-diff-fold" role="row"><span role="cell">${hiddenRows} more lines</span></div>` : "";
  const normalizedMode = mode === "split" ? "split" : "unified";
  return `<section class="tool-diff" data-view="${normalizedMode}" aria-label="${escapeHtml(label)}">`
    + `<header class="tool-diff-header"><span class="tool-diff-file-icon" aria-hidden="true"></span>`
    + `<span class="tool-diff-identity"><strong>${escapeHtml(parts.name)}</strong>${parts.directory ? `<span>${escapeHtml(parts.directory)}</span>` : ""}</span>`
    + `<span class="tool-diff-stats" aria-label="${additions} additions and ${deletions} deletions">${stats}</span>`
    + `<span class="tool-diff-modes" role="group" aria-label="Diff layout">`
    + `<button type="button" data-diff-mode="unified" aria-pressed="${normalizedMode === "unified"}">Unified</button>`
    + `<button type="button" data-diff-mode="split" aria-pressed="${normalizedMode === "split"}">Split</button></span></header>`
    + `<div class="tool-diff-pane" data-mode="unified"><div class="tool-diff-table" role="table" aria-label="Unified changes in ${escapeHtml(parts.name)}"><div role="rowgroup">${rows.map(unifiedRow).join("")}${fold}</div></div></div>`
    + `<div class="tool-diff-pane" data-mode="split"><div class="tool-diff-split" role="table" aria-label="Split changes in ${escapeHtml(parts.name)}">${pairSplitRows(rows).map(splitRow).join("")}${fold}</div></div>`
    + `</section>`;
}

export function setDiffViewMode(viewer, mode) {
  if (!viewer) return "unified";
  const next = mode === "split" ? "split" : "unified";
  viewer.dataset.view = next;
  viewer.querySelectorAll("[data-diff-mode]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.diffMode === next)));
  return next;
}

export function diffStats(toolId, params = {}) {
  if (toolId === "apply_diff") {
    const parsed = parseUnifiedDiff(params.diff_content);
    return { additions: parsed.additions, deletions: parsed.deletions };
  }
  if (toolId === "edit_file") return { additions: splitLines(params.new_string ?? params.new).length, deletions: splitLines(params.old_string ?? params.old).length };
  if (toolId === "write_file") return { additions: splitLines(params.content).length, deletions: 0 };
  return { additions: 0, deletions: 0 };
}

export function renderDiffViewer(toolId, params = {}, options = {}) {
  const shortenPath = options.shortenPath || ((value) => String(value || ""));
  const maxLines = Math.max(20, Math.min(500, Number(options.maxLines || 180)));
  let path = shortenPath(params.path || "");
  let rows = [];
  let additions = 0;
  let deletions = 0;
  if (toolId === "apply_diff") {
    const parsed = parseUnifiedDiff(params.diff_content);
    path ||= shortenPath(parsed.inferredPath); rows = parsed.lines; additions = parsed.additions; deletions = parsed.deletions;
  } else if (toolId === "edit_file") {
    const oldLines = splitLines(params.old_string ?? params.old);
    const newLines = splitLines(params.new_string ?? params.new);
    additions = newLines.length; deletions = oldLines.length;
    if (oldLines.length === 1 && newLines.length === 1) {
      const words = wordDiff(oldLines[0], newLines[0]);
      rows = [{ type: "delete", old: 1, text: oldLines[0], html: words.oldHtml }, { type: "add", new: 1, text: newLines[0], html: words.newHtml }];
    } else rows = [...oldLines.map((text, index) => ({ type: "delete", old: index + 1, text })), ...newLines.map((text, index) => ({ type: "add", new: index + 1, text }))];
  } else if (toolId === "write_file") {
    const lines = splitLines(params.content); additions = lines.length; rows = lines.map((text, index) => ({ type: "add", new: index + 1, text }));
  } else return "";
  const visibleRows = rows.slice(0, maxLines);
  return viewerHtml({
    path: path || "untitled", additions, deletions, rows: visibleRows,
    hiddenRows: Math.max(0, rows.length - visibleRows.length), mode: options.mode,
    label: toolId === "write_file" ? "New file preview" : toolId === "edit_file" ? "File edit preview" : "Applied diff preview",
  });
}
