const COMMAND_ID = /^[a-z][a-z0-9-]*$/;

function normalizeName(value) {
  return String(value || "").trim().replace(/^\/+/, "").toLowerCase();
}

export function createCommandRegistry(definitions = []) {
  const commands = new Map();
  const aliases = new Map();
  const handlers = new Map();

  function register(definition) {
    const id = normalizeName(definition?.id);
    if (!COMMAND_ID.test(id)) throw new TypeError(`Invalid command id: ${id || "(empty)"}`);
    if (commands.has(id) || aliases.has(id)) throw new Error(`Command already registered: ${id}`);

    const command = Object.freeze({
      id,
      path: `/${id}`,
      title: String(definition.title || id),
      keywords: Object.freeze((definition.keywords || []).map(String)),
      aliases: Object.freeze((definition.aliases || []).map(normalizeName).filter(Boolean)),
    });
    const uniqueAliases = new Set();
    for (const alias of command.aliases) {
      if (!COMMAND_ID.test(alias)) throw new TypeError(`Invalid command alias: ${alias}`);
      if (commands.has(alias) || aliases.has(alias)) throw new Error(`Command alias already registered: ${alias}`);
      if (alias === id || uniqueAliases.has(alias)) throw new Error(`Duplicate command alias: ${alias}`);
      uniqueAliases.add(alias);
    }
    commands.set(id, command);
    for (const alias of command.aliases) {
      aliases.set(alias, id);
    }
    if (typeof definition.execute === "function") handlers.set(id, definition.execute);
    return command;
  }

  for (const definition of definitions) register(definition);

  function resolve(value) {
    const name = normalizeName(value);
    const id = commands.has(name) ? name : aliases.get(name);
    return id ? commands.get(id) : null;
  }

  function setHandler(idOrAlias, handler) {
    const command = resolve(idOrAlias);
    if (!command) throw new Error(`Unknown command: ${idOrAlias}`);
    if (typeof handler !== "function") throw new TypeError(`Command handler must be a function: ${command.id}`);
    handlers.set(command.id, handler);
    return () => {
      if (handlers.get(command.id) === handler) handlers.delete(command.id);
    };
  }

  function unregister(idOrAlias) {
    const command = resolve(idOrAlias);
    if (!command) return false;
    commands.delete(command.id);
    handlers.delete(command.id);
    for (const alias of command.aliases) aliases.delete(alias);
    return true;
  }

  function install(definition) {
    const command = register(definition);
    return Object.freeze({
      command,
      dispose: () => unregister(command.id),
    });
  }

  async function execute(value, args = [], context = {}) {
    const command = resolve(value);
    if (!command) return { matched: false, command: null, result: undefined };
    const handler = handlers.get(command.id);
    if (!handler) throw new Error(`Command has no handler: /${command.id}`);
    const result = await handler(Object.freeze({ command, args: [...args], context }));
    return { matched: true, command, result };
  }

  return Object.freeze({
    register,
    install,
    unregister,
    resolve,
    has: (value) => Boolean(resolve(value)),
    list: () => [...commands.values()],
    paths: () => [...commands.values()].map((command) => command.path),
    setHandler,
    execute,
  });
}

export const CORE_COMMAND_DEFINITIONS = Object.freeze([
  { id: "model", aliases: ["models"], title: "Models", keywords: ["provider", "catalog"] },
  { id: "thinking", aliases: ["reasoning"], title: "Thinking", keywords: ["reasoning", "effort"] },
  { id: "mode", title: "Mode", keywords: ["auto", "build", "plan"] },
  { id: "themes", aliases: ["theme"], title: "Themes", keywords: ["appearance", "color"] },
  { id: "provider", title: "Providers", keywords: ["api", "connection"] },
  { id: "diagnostics", aliases: ["doctor"], title: "Diagnostics", keywords: ["health", "connection"] },
  { id: "permissions", title: "Permissions", keywords: ["strict", "smart", "autonomous"] },
  { id: "status", title: "Status", keywords: ["usage", "context", "rate limit"] },
  { id: "compact", title: "Compact", keywords: ["context", "summary"] },
  { id: "sessions", title: "Sessions", keywords: ["history", "conversation"] },
  { id: "resume", title: "Resume", keywords: ["session", "conversation"] },
  { id: "delete-session", title: "Delete session", keywords: ["conversation", "remove"] },
  { id: "new", title: "New session", keywords: ["conversation", "reset"] },
  { id: "undo", title: "Undo", keywords: ["checkpoint", "restore"] },
  { id: "clear", title: "Clear", keywords: ["transcript", "screen"] },
]);
