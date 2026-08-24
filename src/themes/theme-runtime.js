import {
  DEFAULT_THEME_ID,
  THEME_STORAGE_KEY,
  resolvedThemeTokens,
  tokenVariableName,
} from "./theme-contract.js";
import { themeRegistry as defaultRegistry } from "./theme-registry.js";

function safeStorage(storage) {
  return storage && typeof storage.getItem === "function" ? storage : null;
}

export function createThemeRuntime({
  documentRef = globalThis.document,
  storage = globalThis.localStorage,
  registry = defaultRegistry,
} = {}) {
  const root = documentRef?.documentElement;
  const targetStorage = safeStorage(storage);
  const listeners = new Set();
  let currentTheme = null;
  let appliedVariables = [];

  function storedThemeId() {
    try { return targetStorage?.getItem(THEME_STORAGE_KEY) || ""; }
    catch (_) { return ""; }
  }

  function persist(id) {
    try { targetStorage?.setItem(THEME_STORAGE_KEY, id); }
    catch (_) {}
  }

  function notify(theme) {
    const detail = Object.freeze({
      id: theme.id,
      label: theme.label,
      transparency: theme.transparency,
      colorScheme: theme.colorScheme,
    });
    for (const listener of listeners) listener(detail);
    if (root && typeof documentRef.defaultView?.CustomEvent === "function") {
      root.dispatchEvent(new documentRef.defaultView.CustomEvent("kodra:themechange", { detail }));
    }
  }

  function apply(requestedId, { save = true } = {}) {
    const theme = registry.get(requestedId) || registry.get(DEFAULT_THEME_ID);
    if (!theme) throw new Error("The default Kodra theme is not registered");
    if (!root) {
      currentTheme = theme;
      return theme;
    }

    for (const variable of appliedVariables) root.style.removeProperty(variable);
    appliedVariables = [];
    for (const [token, value] of Object.entries(resolvedThemeTokens(theme))) {
      const variable = tokenVariableName(token);
      root.style.setProperty(variable, value);
      appliedVariables.push(variable);
    }
    root.dataset.theme = theme.id;
    root.dataset.themeTransparency = theme.transparency;
    root.style.colorScheme = theme.colorScheme;
    currentTheme = theme;
    if (save) persist(theme.id);
    notify(theme);
    return theme;
  }

  function restore() {
    return apply(storedThemeId() || root?.dataset.theme || DEFAULT_THEME_ID, { save: false });
  }

  function subscribe(listener) {
    if (typeof listener !== "function") return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return Object.freeze({
    apply,
    restore,
    subscribe,
    list: () => registry.list(),
    register: (...args) => registry.register(...args),
    get current() { return currentTheme; },
  });
}

export const themeRuntime = createThemeRuntime();
