const MODAL_ID = /^[a-z][a-z0-9-]{0,47}$/;

export const CORE_MODAL_DEFINITIONS = Object.freeze([
  { id: "models", ariaLabel: "Model", searchable: true, filter: "models" },
  { id: "thinking", ariaLabel: "Thinking mode", compact: true },
  { id: "composer-mode", ariaLabel: "Composer mode", compact: true },
  { id: "themes", ariaLabel: "Theme", compact: true },
  { id: "providers", ariaLabel: "Provider", searchable: true, filter: "providers" },
  { id: "diagnostics-providers", ariaLabel: "Provider diagnostics", searchable: true, filter: "diagnostics" },
  { id: "sessions", ariaLabel: "Conversations", searchable: true, filter: "sessions" },
  { id: "delete-sessions", ariaLabel: "Delete conversation", searchable: true, filter: "sessions" },
  { id: "mode", ariaLabel: "Access mode", searchable: true, filter: "simple" },
]);

function normalizeDefinition(definition) {
  if (!definition || typeof definition !== "object") throw new TypeError("Modal definition must be an object");
  const id = String(definition.id || "").trim().toLowerCase();
  if (!MODAL_ID.test(id)) throw new TypeError(`Invalid modal id: ${id || "<empty>"}`);
  const ariaLabel = String(definition.ariaLabel || "Selection menu").trim().slice(0, 80);
  return Object.freeze({
    id,
    ariaLabel: ariaLabel || "Selection menu",
    compact: Boolean(definition.compact),
    searchable: Boolean(definition.searchable),
    filter: typeof definition.filter === "function" ? definition.filter : String(definition.filter || "none"),
    render: typeof definition.render === "function" ? definition.render : null,
    select: typeof definition.select === "function" ? definition.select : null,
  });
}

export function createModalRegistry(initial = CORE_MODAL_DEFINITIONS) {
  const definitions = new Map();

  function register(definition, { replace = false } = {}) {
    const normalized = normalizeDefinition(definition);
    if (definitions.has(normalized.id) && !replace) throw new Error(`Modal already registered: ${normalized.id}`);
    definitions.set(normalized.id, normalized);
    return () => {
      if (definitions.get(normalized.id) === normalized) definitions.delete(normalized.id);
    };
  }

  function install(definition, options) {
    const normalized = normalizeDefinition(definition);
    const dispose = register(normalized, options);
    return Object.freeze({ definition: normalized, dispose });
  }

  for (const definition of initial) register(definition);

  return Object.freeze({
    register,
    install,
    get(id) { return definitions.get(String(id || "").toLowerCase()) || null; },
    has(id) { return definitions.has(String(id || "").toLowerCase()); },
    list() { return [...definitions.values()]; },
  });
}
