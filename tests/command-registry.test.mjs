import assert from "node:assert/strict";
import test from "node:test";
import { CORE_COMMAND_DEFINITIONS, createCommandRegistry } from "../src/command-registry.js";

test("core slash paths, aliases, and theme command come from one registry", () => {
  const registry = createCommandRegistry(CORE_COMMAND_DEFINITIONS);
  assert.ok(registry.paths().includes("/themes"));
  assert.equal(registry.resolve("/theme").id, "themes");
  assert.equal(registry.resolve("models").id, "model");
  assert.equal(registry.resolve("/doctor").id, "diagnostics");
});

test("registered handlers receive normalized command metadata and immutable argument copies", async () => {
  const registry = createCommandRegistry([{ id: "demo", aliases: ["d"], title: "Demo" }]);
  let received = null;
  registry.setHandler("demo", async (payload) => {
    received = payload;
    payload.args.push("local");
    return "done";
  });
  const original = ["one"];
  const result = await registry.execute("/d", original, { source: "test" });
  assert.equal(result.matched, true);
  assert.equal(result.command.id, "demo");
  assert.equal(result.result, "done");
  assert.deepEqual(original, ["one"]);
  assert.deepEqual(received.args, ["one", "local"]);
});

test("registry rejects duplicate aliases and reports unknown commands without throwing", async () => {
  assert.throws(() => createCommandRegistry([
    { id: "first", aliases: ["same"] },
    { id: "second", aliases: ["same"] },
  ]), /already registered/);

  const registry = createCommandRegistry([{ id: "known" }]);
  assert.deepEqual(await registry.execute("missing"), { matched: false, command: null, result: undefined });
});

test("extensions can be installed and disposed without leaving aliases or handlers", async () => {
  const registry = createCommandRegistry([]);
  const extension = registry.install({
    id: "hello",
    aliases: ["hi"],
    execute: async () => "world",
  });
  assert.equal((await registry.execute("/hi")).result, "world");
  assert.equal(extension.dispose(), true);
  assert.equal(registry.has("hello"), false);
  assert.equal(registry.has("hi"), false);
});

test("invalid alias sets never leave a partially registered command", () => {
  const registry = createCommandRegistry([{ id: "taken" }]);
  assert.throws(() => registry.register({ id: "partial", aliases: ["taken"] }), /already registered/);
  assert.equal(registry.has("partial"), false);
});
