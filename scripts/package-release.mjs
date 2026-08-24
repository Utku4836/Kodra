import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function filesBelow(directory) {
  if (!existsSync(directory)) return [];
  const result = [];
  for (const name of readdirSync(directory)) {
    const candidate = path.join(directory, name);
    if (statSync(candidate).isDirectory()) result.push(...filesBelow(candidate));
    else result.push(candidate);
  }
  return result;
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex").toUpperCase();
}

function safeVersion(value) {
  const version = String(value || "").trim();
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Unsafe release version: ${version || "<empty>"}`);
  }
  return version;
}

export function stageReleaseArtifacts({
  root,
  version,
  targetDirectory,
  outputDirectory,
} = {}) {
  const projectRoot = path.resolve(root || path.dirname(path.dirname(fileURLToPath(import.meta.url))));
  const releaseVersion = safeVersion(version || JSON.parse(readFileSync(path.join(projectRoot, "package.json"), "utf8")).version);
  const target = path.resolve(targetDirectory || path.join(projectRoot, "src-tauri", "target", "release"));
  const outputRoot = path.resolve(outputDirectory || path.join(projectRoot, "release-artifacts"));
  const stage = path.join(outputRoot, `v${releaseVersion}`);
  const expectedStagePrefix = `${outputRoot}${path.sep}`.toLowerCase();
  if (!stage.toLowerCase().startsWith(expectedStagePrefix)) throw new Error("Release stage escaped its output directory");

  const portableSource = path.join(target, "kodra.exe");
  if (!existsSync(portableSource)) throw new Error(`Portable executable not found: ${portableSource}`);
  const setupCandidates = filesBelow(path.join(target, "bundle", "nsis"))
    .filter((file) => /-setup\.exe$/i.test(file));
  if (setupCandidates.length !== 1) {
    throw new Error(`Expected exactly one NSIS setup executable, found ${setupCandidates.length}`);
  }
  const forbiddenInstallers = filesBelow(path.join(target, "bundle"))
    .filter((file) => /\.msi$/i.test(file));
  if (forbiddenInstallers.length) throw new Error("MSI artifacts are not allowed in the Kodra release set");

  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  const setupName = `Kodra_${releaseVersion}_x64-setup.exe`;
  const portableName = `Kodra_${releaseVersion}_x64-portable.exe`;
  const setup = path.join(stage, setupName);
  const portable = path.join(stage, portableName);
  copyFileSync(setupCandidates[0], setup);
  copyFileSync(portableSource, portable);

  const binaryFiles = [setup, portable];
  const checksums = binaryFiles
    .map((file) => `${sha256(file)}  ${path.basename(file)}`)
    .join("\n") + "\n";
  writeFileSync(path.join(stage, "SHA256SUMS.txt"), checksums, "utf8");
  const manifest = {
    schemaVersion: 1,
    product: "Kodra",
    version: releaseVersion,
    architecture: "x64",
    artifacts: [
      { kind: "setup", file: setupName, sha256: sha256(setup) },
      { kind: "portable", file: portableName, sha256: sha256(portable) },
    ],
    sourceArchives: "GitHub automatically provides Source code (zip) and Source code (tar.gz).",
  };
  writeFileSync(path.join(stage, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { stage, manifest };
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entry && entry.toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  const result = stageReleaseArtifacts();
  console.log(`Staged ${result.manifest.artifacts.length} Kodra binaries in ${result.stage}`);
}
