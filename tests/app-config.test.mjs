import test from "node:test";
import assert from "node:assert/strict";

import { KODRA_CONFIG, publicConfigSnapshot } from "../src/kodra.config.js";

test("the public Kodra configuration is versioned, immutable, and serializable", () => {
  assert.equal(KODRA_CONFIG.schemaVersion, 1);
  assert.equal(KODRA_CONFIG.defaults.composerMode, "auto");
  assert.equal(Object.isFrozen(KODRA_CONFIG.ui), true);
  assert.deepEqual(publicConfigSnapshot().features, KODRA_CONFIG.features);
  assert.notEqual(publicConfigSnapshot(), KODRA_CONFIG);
});
