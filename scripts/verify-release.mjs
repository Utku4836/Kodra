import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const failures = [];
const passes = [];

function read(relativePath) {
  return readFileSync(join(root, relativePath), "utf8");
}

function readJson(relativePath) {
  return JSON.parse(read(relativePath));
}

function check(condition, message) {
  if (condition) passes.push(message);
  else failures.push(message);
}

const packageJson = readJson("package.json");
const packageLock = readJson("package-lock.json");
const tauri = readJson("src-tauri/tauri.conf.json");
const cargo = read("src-tauri/Cargo.toml");
const cargoVersion = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
const cargoDescription = cargo.match(/^description\s*=\s*"([^"]+)"/m)?.[1];
const cargoAuthors = cargo.match(/^authors\s*=\s*\[([^\]]+)\]/m)?.[1] || "";

check(packageJson.private === true, "npm package is private");
check(packageJson.license === "MIT", "npm package license is MIT");
check(Boolean(packageJson.description), "npm package has a description");
check(packageJson.author === "Utku", "npm package has a release author");
check(packageJson.repository?.url?.includes("Utku4836/Kodra"), "npm repository metadata is set");
check(
  packageJson.engines?.node === "^20.19.0 || ^22.13.0 || >=24.0.0",
  "supported Node.js ranges are declared",
);
check(packageLock.version === packageJson.version, "package-lock version matches package.json");
check(packageLock.packages?.[""]?.version === packageJson.version, "package-lock root package version matches");

check(cargoVersion === packageJson.version, "Cargo version matches package.json");
check(tauri.version === packageJson.version, "Tauri version matches package.json");
check(Boolean(cargoDescription) && cargoDescription !== "A Tauri App", "Cargo description is release-ready");
check(!cargoAuthors.includes('"you"'), "Cargo author placeholder is removed");
check(/^publish\s*=\s*false$/m.test(cargo), "Cargo package publishing is disabled");

check(tauri.productName === "Kodra", "product name is human-readable");
check(tauri.app?.windows?.every((window) => window.devtools === false), "production WebView devtools are disabled");
check(Boolean(tauri.app?.security?.csp), "Tauri Content Security Policy is enabled");
check(tauri.app?.security?.capabilities?.length === 1 && tauri.app.security.capabilities[0] === "default", "only the declared default capability is enabled");
check(tauri.bundle?.windows?.allowDowngrades === false, "Windows installer downgrades are disabled");
check(
  Array.isArray(tauri.bundle?.targets)
    && tauri.bundle.targets.length === 1
    && tauri.bundle.targets[0] === "nsis",
  "only the NSIS installer target is enabled",
);
check(packageJson.scripts?.["release:stage"] === "node scripts/package-release.mjs", "release staging command is declared");
check(packageJson.scripts?.["build:release"]?.includes("release:stage"), "release build stages portable and setup artifacts");

const requiredDocuments = [
  "README.md",
  "CHANGELOG.md",
  "RELEASE_NOTES.md",
  "SECURITY.md",
  "docs/RELEASE_CHECKLIST.md",
  "docs/THEMES.md",
  "docs/ARCHITECTURE.md",
  "docs/RELEASING.md",
];
for (const document of requiredDocuments) {
  check(existsSync(join(root, document)), `${document} exists`);
}
check(!read("README.md").includes("# Tauri + Vanilla"), "README template content is removed");

for (const icon of tauri.bundle?.icon || []) {
  check(existsSync(join(root, "src-tauri", icon)), `bundle icon exists: ${icon}`);
}

const sourceIconPath = join(root, "src-tauri/icons/app-icon-full-transparent-source.png");
check(existsSync(sourceIconPath), "approved source icon exists");
if (existsSync(sourceIconPath)) {
  const png = readFileSync(sourceIconPath);
  const isPng = png.length > 25 && png.subarray(1, 4).toString("ascii") === "PNG";
  const width = isPng ? png.readUInt32BE(16) : 0;
  const height = isPng ? png.readUInt32BE(20) : 0;
  const colorType = isPng ? png[25] : -1;
  check(isPng, "source icon is a PNG");
  check(width === height && width >= 512, "source icon is square and at least 512 px");
  check(colorType === 4 || colorType === 6, "source icon carries an alpha channel");
}

for (const [name, expectedWidth, expectedHeight] of [
  ["src-tauri/windows/installer-sidebar.bmp", 164, 314],
  ["src-tauri/windows/installer-header.bmp", 150, 57],
]) {
  const assetPath = join(root, name);
  check(existsSync(assetPath), `${name} exists`);
  if (!existsSync(assetPath)) continue;
  const bitmap = readFileSync(assetPath);
  const isBitmap = bitmap.length > 26 && bitmap.subarray(0, 2).toString("ascii") === "BM";
  check(isBitmap, `${name} is a BMP`);
  check(isBitmap && bitmap.readInt32LE(18) === expectedWidth && Math.abs(bitmap.readInt32LE(22)) === expectedHeight, `${name} has the required NSIS dimensions`);
}

const frontend = read("src/main.js");
const native = read("src-tauri/src/lib.rs");
check(!frontend.includes("Kontrol ediliyor") && !frontend.includes('|| "Kontrol"'), "diagnostic UI fallbacks are English");
check(!native.includes("Bilinmeyen tool"), "native unknown-tool error is English");

for (const message of passes) console.log(`ok  ${message}`);
if (failures.length) {
  for (const message of failures) console.error(`fail  ${message}`);
  console.error(`\nRelease verification failed with ${failures.length} issue(s).`);
  process.exit(1);
}

console.log(`\nRelease metadata verified (${passes.length} checks).`);
