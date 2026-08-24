import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stageReleaseArtifacts } from "../scripts/package-release.mjs";

test("release staging emits exactly one setup and one portable binary plus hashes", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "kodra-release-"));
  try {
    const target = path.join(root, "target", "release");
    mkdirSync(path.join(target, "bundle", "nsis"), { recursive: true });
    writeFileSync(path.join(target, "kodra.exe"), "portable");
    writeFileSync(path.join(target, "bundle", "nsis", "Kodra_0.2.0_x64-setup.exe"), "setup");
    const result = stageReleaseArtifacts({
      root,
      version: "0.2.0",
      targetDirectory: target,
      outputDirectory: path.join(root, "artifacts"),
    });
    assert.deepEqual(result.manifest.artifacts.map((artifact) => artifact.kind), ["setup", "portable"]);
    const sums = readFileSync(path.join(result.stage, "SHA256SUMS.txt"), "utf8");
    assert.match(sums, /Kodra_0\.2\.0_x64-setup\.exe/);
    assert.match(sums, /Kodra_0\.2\.0_x64-portable\.exe/);
    assert.equal(sums.trim().split("\n").length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release staging rejects stale MSI or duplicate setup artifacts", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "kodra-release-"));
  try {
    const target = path.join(root, "target", "release");
    mkdirSync(path.join(target, "bundle", "nsis"), { recursive: true });
    mkdirSync(path.join(target, "bundle", "msi"), { recursive: true });
    writeFileSync(path.join(target, "kodra.exe"), "portable");
    writeFileSync(path.join(target, "bundle", "nsis", "Kodra-setup.exe"), "setup");
    writeFileSync(path.join(target, "bundle", "msi", "Kodra.msi"), "stale");
    assert.throws(() => stageReleaseArtifacts({
      root,
      version: "0.2.0",
      targetDirectory: target,
      outputDirectory: path.join(root, "artifacts"),
    }), /MSI artifacts are not allowed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
