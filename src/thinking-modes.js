const FALLBACK_MODE = Object.freeze({ id: "off", label: "Standard", budget: 0 });

function cleanModeId(value) {
  return String(value ?? "").trim().slice(0, 64);
}

function modeLabel(id, suppliedLabel = "") {
  const label = String(suppliedLabel || "").trim();
  if (label) return label.slice(0, 80);
  const normalized = id.toLowerCase();
  if (["off", "none", "disabled", "standard"].includes(normalized)) return "Standard";
  return id
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .slice(0, 80);
}

function normalizeMode(option) {
  if (typeof option === "string" || typeof option === "number") {
    const id = cleanModeId(option);
    return id ? { id, label: modeLabel(id) } : null;
  }
  if (!option || typeof option !== "object") return null;
  const id = cleanModeId(option.id ?? option.name ?? option.value);
  if (!id) return null;
  const budgetValue = option.budget ?? option.budgetTokens ?? option.budget_tokens;
  const budget = Number(budgetValue);
  return {
    id,
    label: modeLabel(id, option.label ?? option.name),
    ...(Number.isFinite(budget) && budget >= 0 ? { budget: Math.round(budget) } : {}),
  };
}

export function thinkingModesForModel(model) {
  if (model?.supportsReasoning === false || model?.supports_reasoning === false) {
    return [{ ...FALLBACK_MODE }];
  }
  const options = model?.reasoningOptions
    ?? model?.reasoning_options
    ?? model?.variants;
  if (!Array.isArray(options) || options.length === 0) return [{ ...FALLBACK_MODE }];

  const seen = new Set();
  const modes = [];
  for (const option of options) {
    const mode = normalizeMode(option);
    const key = mode?.id.toLowerCase();
    if (!mode || seen.has(key)) continue;
    seen.add(key);
    modes.push(mode);
  }
  return modes.length ? modes : [{ ...FALLBACK_MODE }];
}

export function resolveThinkingMode(modes, configuredMode) {
  const available = Array.isArray(modes) && modes.length ? modes : [{ ...FALLBACK_MODE }];
  const configured = cleanModeId(configuredMode).toLowerCase();
  return available.find((mode) => mode.id.toLowerCase() === configured) || available[0];
}

export function publicReasoningOptions(model, maxItems = 12) {
  const options = model?.reasoningOptions ?? model?.reasoning_options ?? model?.variants;
  if (!Array.isArray(options)) return null;
  const normalized = options
    .slice(0, Math.max(1, maxItems))
    .map(normalizeMode)
    .filter(Boolean);
  return normalized.length ? normalized : null;
}
