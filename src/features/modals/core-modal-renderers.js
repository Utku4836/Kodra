function element(documentRef, tag, className, text = "") {
  const node = documentRef.createElement(tag);
  node.className = className;
  if (text) node.textContent = text;
  return node;
}

function category(documentRef, list, text) {
  list.appendChild(element(documentRef, "div", "modal-category", text));
}

function pushRow(list, rows, el, item) {
  list.appendChild(el);
  rows.push({ el, item });
}

export function renderCoreModalRows({
  mode,
  items,
  documentRef = globalThis.document,
  list,
  context = {},
} = {}) {
  if (!list || !documentRef) throw new TypeError("Modal list and document are required");
  const rows = [];
  let selectedIndex = 0;
  const source = Array.isArray(items) ? items : [];

  if (mode === "models") {
    const groups = new Map();
    for (const item of source) {
      const key = item.providerName || "Models";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    for (const name of [...groups.keys()].sort((a, b) => a.localeCompare(b))) {
      category(documentRef, list, name);
      for (const item of groups.get(name).slice(0, 80)) {
        const row = element(documentRef, "div", "modal-item model-item");
        const label = element(
          documentRef,
          "span",
          "model-name",
          item.displayName || context.shortModelName?.(item.id) || item.id,
        );
        row.appendChild(label);
        row.title = item.id;
        row.setAttribute("aria-label", `${label.textContent}, ${item.providerName || "model"}`);
        pushRow(list, rows, row, item);
      }
    }
  } else if (mode === "thinking") {
    category(documentRef, list, "Thinking");
    const current = context.resolveThinkingMode?.(source, context.configuredThinkingMode?.()) || source[0];
    source.forEach((item, index) => {
      const row = element(documentRef, "div", "modal-item thinking-mode-item");
      if (item.id === current?.id) {
        row.classList.add("is-current");
        selectedIndex = index;
      }
      row.appendChild(element(documentRef, "span", "thinking-mode-name", item.label || item.id));
      pushRow(list, rows, row, item);
    });
  } else if (mode === "composer-mode") {
    source.forEach((item, index) => {
      const row = element(documentRef, "div", "modal-item composer-mode-item", item.name || item.id);
      if (item.id === context.composerMode) selectedIndex = index;
      pushRow(list, rows, row, item);
    });
  } else if (mode === "themes") {
    source.forEach((item, index) => {
      const row = element(documentRef, "div", "modal-item theme-item", item.label || item.id);
      if (item.id === context.currentThemeId) {
        row.classList.add("is-current");
        selectedIndex = index;
      }
      pushRow(list, rows, row, item);
    });
  } else if (mode === "diagnostics-providers") {
    category(documentRef, list, "Provider to diagnose");
    for (const item of source) {
      const row = element(documentRef, "div", "modal-item provider-item");
      const title = element(documentRef, "span", "provider-item-name", item.name);
      const meta = element(documentRef, "span", "provider-item-state");
      const report = context.providerDiagnosticCache?.get(item.id);
      meta.dataset.state = report?.overall || "unknown";
      meta.textContent = report ? context.diagnosticStateLabel(report.overall) : "Not checked yet";
      row.append(title, meta);
      pushRow(list, rows, row, item);
    }
  } else if (mode === "sessions" || mode === "delete-sessions") {
    category(documentRef, list, mode === "delete-sessions" ? "Choose a conversation" : "Conversations");
    for (const item of source) {
      const row = element(documentRef, "div", "modal-item session-item");
      row.append(
        element(documentRef, "span", "session-title", item.title),
        element(
          documentRef,
          "span",
          "session-meta",
          `${context.shortModelName?.(item.model) || item.model} · ${item.messageCount}${item.hasDraft ? " · draft" : ""}`,
        ),
      );
      pushRow(list, rows, row, item);
    }
  } else if (mode === "mode") {
    category(documentRef, list, "Access mode");
    source.forEach((item, index) => {
      const row = element(documentRef, "div", "modal-item", item.name || item.id);
      if (context.activeAccessMode === item.id) selectedIndex = index;
      pushRow(list, rows, row, item);
    });
  } else {
    const linked = new Set(context.linkedProviderIds || []);
    source.forEach((item, index) => {
      const row = element(documentRef, "div", "modal-item provider-item");
      const isConnected = linked.has(item.id);
      const isActive = context.activeProviderId === item.id;
      const label = element(documentRef, "span", "provider-item-name", item.name);
      const indicator = element(documentRef, "span", "provider-health-indicator");
      const report = context.providerDiagnosticCache?.get(item.id);
      indicator.dataset.state = report?.overall || (isConnected ? "connected" : "unlinked");
      indicator.setAttribute(
        "aria-label",
        report ? context.diagnosticStateLabel(report.overall) : isConnected ? "Connected" : "Not connected",
      );
      if (isActive) {
        indicator.classList.add("is-active");
        selectedIndex = index;
      }
      row.append(label, indicator);
      pushRow(list, rows, row, item);
    });
  }

  return { rows, selectedIndex };
}
