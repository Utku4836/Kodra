export const THEME_SCHEMA_VERSION = 1;
export const THEME_STORAGE_KEY = "kodra-theme";
export const DEFAULT_THEME_ID = "kodra";

export const THEME_TOKEN_DEFAULTS = Object.freeze({
  "native.background": "#000000",
  "canvas.background": "#000000",
  "canvas.ambient": "transparent",
  "surface.panel": "#050607",
  "surface.raised": "rgba(3, 4, 5, 0.97)",
  "surface.inset": "rgba(0, 0, 0, 0.34)",
  "surface.soft": "rgba(255, 255, 255, 0.018)",
  "surface.hover": "rgba(255, 255, 255, 0.024)",
  "surface.selected": "rgba(255, 255, 255, 0.038)",
  "text.primary": "#ededed",
  "text.response": "#e6e8eb",
  "text.secondary": "#abb0b7",
  "text.muted": "#666666",
  "text.dim": "#858c95",
  "text.user": "#9aa0a8",
  "text.link": "#9ec8e5",
  "border.subtle": "rgba(255, 255, 255, 0.055)",
  "border.normal": "rgba(255, 255, 255, 0.105)",
  "border.focus": "rgba(255, 255, 255, 0.34)",
  "accent.primary": "#dce8f0",
  "accent.soft": "rgba(174, 211, 235, 0.11)",
  "state.success": "#79bd94",
  "state.warning": "#d2ac6d",
  "state.danger": "#cf7f85",
  "state.offline": "#e06d75",
  "overlay.scrim": "rgba(0, 0, 0, 0.76)",
  "glass.blur": "0px",
  "glass.saturation": "100%",
  "glass.highlight": "rgba(255, 255, 255, 0.022)",
  "shadow.window": "none",
  "shadow.panel": "0 28px 80px rgba(0, 0, 0, 0.68)",
  "shadow.focus": "0 0 0 1px rgba(255, 255, 255, 0.17)",
  "code.background": "rgba(255, 255, 255, 0.025)",
  "code.inlineBackground": "rgba(255, 255, 255, 0.055)",
  "code.text": "#d9dde1",
  "code.muted": "#747c86",
  "code.keyword": "#a9c8df",
  "code.string": "#a8c7ae",
  "code.number": "#d0b58b",
  "code.function": "#c2b8d9",
  "diff.addBackground": "rgba(65, 128, 85, 0.12)",
  "diff.addText": "#91c5a0",
  "diff.deleteBackground": "rgba(144, 61, 70, 0.12)",
  "diff.deleteText": "#d0959a",
  "diff.hunk": "#8294a7",
  "selection.background": "rgba(137, 180, 208, 0.2)",
  "scrollbar.thumb": "rgba(255, 255, 255, 0.12)",
  "font.responseSize": "15px",
  "font.responseLineHeight": "1.62",
  "radius.panel": "16px",
  "radius.control": "9px",
});

const SAFE_THEME_ID = /^[a-z][a-z0-9-]{0,47}$/;
const UNSAFE_VALUE = /(?:url\s*\(|@import|expression\s*\(|javascript:|!important|[;{}<>])/i;

export function tokenVariableName(token) {
  return `--theme-${String(token).replace(/[^a-zA-Z0-9]+/g, "-")}`;
}

function safeTokenValue(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 160
    && !UNSAFE_VALUE.test(value);
}

export function validateThemeDefinition(input, { allowPartial = true } = {}) {
  const errors = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, errors: ["Theme must be an object"], theme: null };
  }

  const id = String(input.id || "").trim().toLowerCase();
  const label = String(input.label || "").trim();
  const version = Number(input.version ?? THEME_SCHEMA_VERSION);
  const colorScheme = input.colorScheme === "light" ? "light" : "dark";
  if (!SAFE_THEME_ID.test(id)) errors.push("Theme id must use lowercase letters, numbers, and hyphens");
  if (!label || label.length > 64) errors.push("Theme label must contain 1–64 characters");
  if (version !== THEME_SCHEMA_VERSION) errors.push(`Unsupported theme schema version: ${version}`);

  const sourceTokens = input.tokens && typeof input.tokens === "object" && !Array.isArray(input.tokens)
    ? input.tokens
    : {};
  const tokens = {};
  for (const [token, value] of Object.entries(sourceTokens)) {
    if (!Object.hasOwn(THEME_TOKEN_DEFAULTS, token)) {
      errors.push(`Unknown theme token: ${token}`);
      continue;
    }
    if (!safeTokenValue(value)) {
      errors.push(`Unsafe or invalid value for theme token: ${token}`);
      continue;
    }
    tokens[token] = value.trim();
  }

  if (!allowPartial) {
    for (const token of Object.keys(THEME_TOKEN_DEFAULTS)) {
      if (!Object.hasOwn(tokens, token)) errors.push(`Missing theme token: ${token}`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    theme: errors.length ? null : Object.freeze({
      id,
      label,
      version,
      colorScheme,
      transparency: input.transparency === "frosted" ? "frosted" : "opaque",
      source: String(input.source || "user").slice(0, 32),
      tokens: Object.freeze({ ...tokens }),
    }),
  };
}

export function resolvedThemeTokens(theme) {
  return Object.freeze({ ...THEME_TOKEN_DEFAULTS, ...(theme?.tokens || {}) });
}
