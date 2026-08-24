import { validateThemeDefinition } from "./theme-contract.js";
import { kodraTheme } from "./kodra.js";
import { mistTheme } from "./mist.js";
import { emberTheme } from "./ember.js";

export const BUILTIN_THEMES = Object.freeze([kodraTheme, mistTheme, emberTheme]);

export function createThemeRegistry(initialThemes = BUILTIN_THEMES) {
  const themes = new Map();

  function register(definition, { replace = false } = {}) {
    const validation = validateThemeDefinition(definition);
    if (!validation.ok) throw new TypeError(validation.errors.join("; "));
    const theme = validation.theme;
    if (themes.has(theme.id) && !replace) throw new Error(`Theme already registered: ${theme.id}`);
    themes.set(theme.id, theme);
    return () => {
      if (themes.get(theme.id) === theme && theme.source !== "builtin") themes.delete(theme.id);
    };
  }

  for (const theme of initialThemes) register(theme);

  return Object.freeze({
    register,
    get(id) { return themes.get(String(id || "").toLowerCase()) || null; },
    has(id) { return themes.has(String(id || "").toLowerCase()); },
    list() {
      return [...themes.values()].map((theme) => Object.freeze({
        id: theme.id,
        label: theme.label,
        version: theme.version,
        colorScheme: theme.colorScheme,
        transparency: theme.transparency,
        source: theme.source,
      }));
    },
  });
}

export const themeRegistry = createThemeRegistry();
