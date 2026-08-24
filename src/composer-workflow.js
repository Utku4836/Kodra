import { KODRA_CONFIG } from "./kodra.config.js";

function button(label, action, tone = "neutral") {
  const el = document.createElement("button");
  el.type = "button";
  el.className = `composer-action composer-action-${tone}`;
  el.dataset.action = action;
  const text = document.createElement("span");
  text.textContent = label;
  el.appendChild(text);
  return el;
}

const nextFrame = globalThis.requestAnimationFrame
  ? (callback) => globalThis.requestAnimationFrame(callback)
  : (callback) => setTimeout(callback, 0);

export function createComposerWorkflow(elements, options = {}) {
  const {
    shell, panel, title, body, feedback, actions, input,
  } = elements;
  let pending = null;
  const storedMode = localStorage.getItem(KODRA_CONFIG.preferences.composerMode);
  let mode = ["auto", "build", "plan"].includes(storedMode) ? storedMode : KODRA_CONFIG.defaults.composerMode;

  const notifyHeight = () => options.onHeightChange?.();

  function renderMode() {
    shell.dataset.mode = mode;
    localStorage.setItem(KODRA_CONFIG.preferences.composerMode, mode);
    options.onModeChange?.(mode);
  }

  function setMode(next, config = {}) {
    mode = ["auto", "build", "plan"].includes(next) ? next : KODRA_CONFIG.defaults.composerMode;
    renderMode(config);
    return mode;
  }

  function open(kind) {
    panel.hidden = false;
    panel.dataset.kind = kind;
    panel.classList.remove("is-closing");
    nextFrame(() => {
      panel.classList.add("is-open");
      options.animatePanel?.(panel, "open");
      notifyHeight();
    });
  }

  function close() {
    panel.classList.remove("is-open");
    panel.classList.add("is-closing");
    feedback.hidden = true;
    feedback.value = "";
    const finish = () => {
      panel.hidden = true;
      panel.classList.remove("is-closing");
      panel.removeAttribute("data-kind");
      body.replaceChildren();
      actions.replaceChildren();
      notifyHeight();
      input?.focus();
    };
    if (options.reducedMotion?.()) finish();
    else {
      const motion = options.animatePanel?.(panel, "close");
      if (motion?.finally) motion.finally(finish);
      else setTimeout(finish, 170);
    }
  }

  function settle(value) {
    const current = pending;
    if (!current) return;
    pending = null;
    close();
    current.resolve(value);
  }

  function cancelPrevious() {
    if (!pending) return;
    const current = pending;
    pending = null;
    current.resolve(current.kind === "plan" ? { decision: "reject" } : "deny");
  }

  function requestApproval({ toolId, title: approvalTitle, detailHtml, editable = false }) {
    cancelPrevious();
    return new Promise((resolve) => {
      pending = { kind: "approval", resolve, toolId };
      title.textContent = approvalTitle || toolId.replace(/[_-]+/g, " ");
      body.innerHTML = detailHtml;
      feedback.hidden = true;
      actions.replaceChildren(
        button("Deny", "deny", "quiet"),
        ...(editable ? [button("Edit", "edit", "quiet")] : []),
        button("Allow", "once", "neutral"),
        button("Always allow", "always", "primary"),
      );
      open("approval");
    });
  }

  function requestPlan({ title: planTitle, steps = [], rationale = "" }) {
    cancelPrevious();
    return new Promise((resolve) => {
      pending = { kind: "plan", resolve };
      title.textContent = planTitle || "Ready to implement";
      const fragment = document.createDocumentFragment();
      if (rationale) {
        const intro = document.createElement("p");
        intro.className = "plan-rationale";
        intro.textContent = rationale;
        fragment.appendChild(intro);
      }
      const list = document.createElement("ol");
      list.className = "plan-review-list";
      steps.slice(0, 12).forEach((step) => {
        const item = document.createElement("li");
        item.textContent = String(typeof step === "string" ? step : step?.title || step?.step || "");
        if (item.textContent) list.appendChild(item);
      });
      fragment.appendChild(list);
      body.replaceChildren(fragment);
      feedback.hidden = true;
      actions.replaceChildren(
        button("Cancel", "reject", "quiet"),
        button("Change", "change", "neutral"),
        button("Apply", "apply", "primary"),
      );
      open("plan");
    });
  }

  function handleAction(action) {
    if (!pending) return;
    if (pending.kind === "approval") {
      if (action === "deny") settle("deny");
      else if (action === "once") settle("once");
      else if (action === "always") settle("always");
      else if (action === "edit") {
        feedback.placeholder = "Edit the command or content, then press Ctrl+Enter...";
        feedback.hidden = false;
        feedback.value = options.editValue?.() || "";
        feedback.focus();
      }
      return;
    }
    if (action === "reject") settle({ decision: "reject" });
    else if (action === "apply") settle({ decision: "apply", automatic: false });
    else if (action === "change") {
      if (feedback.hidden) {
        feedback.placeholder = "Describe what the plan should change...";
        feedback.hidden = false;
        feedback.focus();
        notifyHeight();
      } else if (feedback.value.trim()) {
        settle({ decision: "change", feedback: feedback.value.trim() });
      }
    }
  }

  actions.addEventListener("click", (event) => {
    const target = event.target.closest?.("button[data-action]");
    if (target) handleAction(target.dataset.action);
  });
  feedback.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      if (pending?.kind === "approval") {
        options.onEdit?.(feedback.value);
        feedback.hidden = true;
        notifyHeight();
      } else if (feedback.value.trim()) settle({ decision: "change", feedback: feedback.value.trim() });
    }
  });
  document.addEventListener("keydown", (event) => {
    if (!pending) return;
    const key = event.key.toLowerCase();
    if (feedback === document.activeElement && key !== "escape") return;
    if (pending.kind === "approval" && ["y", "p", "n", "e"].includes(key)) {
      event.preventDefault();
      handleAction(key === "y" ? "once" : key === "p" ? "always" : key === "n" ? "deny" : "edit");
    } else if (pending.kind === "plan") {
      if (event.key === "Escape") { event.preventDefault(); handleAction("reject"); }
      else if (key === "c") { event.preventDefault(); handleAction("change"); }
      else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); handleAction("apply"); }
    }
  }, true);

  renderMode();
  return {
    requestApproval,
    requestPlan,
    setMode,
    get mode() { return mode; },
    get active() { return Boolean(pending); },
    close,
  };
}
