import assert from "node:assert/strict";
import test from "node:test";
import { CORE_MODAL_DEFINITIONS, createModalRegistry } from "../src/modal-registry.js";

test("core modal registry centralizes labels, search, and compact behavior", () => {
  const registry = createModalRegistry(CORE_MODAL_DEFINITIONS);
  assert.equal(registry.get("composer-mode").compact, true);
  assert.equal(registry.get("themes").ariaLabel, "Theme");
  assert.equal(registry.get("models").searchable, true);
  assert.equal(registry.get("thinking").searchable, false);
});

test("modal extensions are disposable and duplicate ids fail loudly", () => {
  const registry = createModalRegistry([]);
  const extension = registry.install({ id: "custom-menu", ariaLabel: "Custom menu", compact: true });
  assert.equal(registry.has("custom-menu"), true);
  assert.equal(extension.definition.ariaLabel, "Custom menu");
  assert.throws(() => registry.register({ id: "custom-menu" }), /already registered/);
  extension.dispose();
  assert.equal(registry.has("custom-menu"), false);
  assert.throws(() => registry.register({ id: "../unsafe" }), /Invalid modal id/);
});
