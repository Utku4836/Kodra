function safeCurrentTheme(theme) {
  if (!theme) return null;
  return Object.freeze({
    id: theme.id,
    label: theme.label,
    colorScheme: theme.colorScheme,
    transparency: theme.transparency,
    source: theme.source,
  });
}

export function createUserThemeService({
  invoke,
  runtime,
  storage = globalThis.localStorage,
  storageKey = "kodra-theme",
  defaultThemeId = "kodra",
  announce = () => {},
} = {}) {
  if (!runtime || typeof runtime.register !== "function" || typeof runtime.list !== "function") {
    throw new TypeError("A theme runtime is required");
  }

  let disposers = [];
  let directory = "";

  function preferredThemeId() {
    try { return storage?.getItem?.(storageKey) || ""; }
    catch (_) { return ""; }
  }

  function disposeRegisteredThemes() {
    for (const dispose of disposers) {
      try { dispose(); } catch (_) {}
    }
    disposers = [];
  }

  async function hydrate({ notify = false } = {}) {
    if (typeof invoke !== "function") return { loaded: 0, errors: 0, directory };

    let report;
    try {
      report = await invoke("list_user_themes");
    } catch (_) {
      if (notify) announce("Custom themes could not be loaded.");
      return { loaded: disposers.length, errors: 1, directory };
    }

    disposeRegisteredThemes();
    directory = String(report?.directory || "");
    let validationErrors = 0;
    for (const manifest of Array.isArray(report?.themes) ? report.themes : []) {
      try {
        const dispose = runtime.register({ ...manifest, source: "user" });
        if (typeof dispose === "function") disposers.push(dispose);
      } catch (_) {
        validationErrors += 1;
      }
    }

    const errors = (Array.isArray(report?.errors) ? report.errors.length : 0) + validationErrors;
    const availableIds = new Set(runtime.list().map((theme) => theme.id));
    const preferred = preferredThemeId();
    if (preferred && availableIds.has(preferred) && runtime.current?.id !== preferred) {
      runtime.apply(preferred, { save: false });
    } else if (runtime.current && !availableIds.has(runtime.current.id)) {
      runtime.apply(defaultThemeId);
    }

    if (notify) {
      announce(errors
        ? `${disposers.length} custom themes loaded · ${errors} skipped`
        : `${disposers.length} custom themes loaded`);
    }
    return { loaded: disposers.length, errors, directory };
  }

  async function openDirectory() {
    if (typeof invoke !== "function") throw new Error("The native theme service is unavailable.");
    directory = String(await invoke("open_theme_directory") || directory);
    return directory;
  }

  return Object.freeze({
    hydrate,
    openDirectory,
    current: () => safeCurrentTheme(runtime.current),
    get directory() { return directory; },
    dispose: disposeRegisteredThemes,
  });
}
