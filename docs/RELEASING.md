# Releasing Kodra for Windows

Kodra intentionally publishes one installer class and one portable binary:

1. `Kodra_<version>_x64-setup.exe` — NSIS current-user installer.
2. `Kodra_<version>_x64-portable.exe` — standalone application executable.
3. `SHA256SUMS.txt` and `release-manifest.json` — verification metadata.
4. GitHub's automatic **Source code (zip)** and **Source code (tar.gz)** archives.

MSI is not a release target. The staging script fails if a stale MSI is present in the bundle tree, preventing accidental upload of two installer formats.

## Local release candidate

From a clean checkout on Windows:

```powershell
npm ci
npm run assets:installer
npm run release:check
npm run build:release
```

The final staged files are written to `release-artifacts/v<version>/`. This directory is generated and ignored by Git.

`npm run build:release` performs a production Tauri build and then:

- finds exactly one NSIS `-setup.exe`;
- copies the no-bundle application executable as the portable artifact;
- rejects MSI output;
- uses stable human-readable file names;
- computes SHA-256 for both binaries;
- writes a machine-readable manifest.

## Installer appearance

The NSIS flow remains a recognizable Windows installer. Kodra customizes only stable Tauri-supported surfaces:

- approved application and uninstaller icon;
- 164×314 black sidebar with Kodra's traffic-light motif;
- 150×57 matching header image;
- current-user install scope, avoiding an unnecessary administrator prompt;
- one English installer language and LZMA compression.

Regenerate the deterministic bitmap assets with:

```powershell
npm run assets:installer
```

The source generator is [generate-installer-assets.ps1](../scripts/generate-installer-assets.ps1). Do not hand-edit the generated BMP files.

## GitHub draft workflow

The **Draft Windows Release** workflow runs only after a maintainer manually types `draft`. It accepts `master` or `develop`, runs the full release gate, builds the NSIS setup, creates a private prerelease draft, and uploads the portable binary and verification metadata. GitHub adds the two source archives automatically.

The workflow does not publish the release. Publishing, repository visibility changes, signing and tagging policy remain explicit owner decisions.

## Required verification

- `npm run release:check`
- `npm run benchmark:runtime`
- launch the production portable executable
- verify `/themes`, `/mode`, `/model`, `/provider`, `/sessions`, `/status`
- run one read tool and one approved write in Smart mode
- confirm Strict asks for every tool
- confirm critical-path and destructive-command guards
- install, launch and uninstall on a clean Windows account or VM
- compare Kodra, Mist and Ember on the transcript, selection modal, approval panel and diff viewer
- verify hashes with `Get-FileHash -Algorithm SHA256`
- verify signature state with `Get-AuthenticodeSignature`

Unsigned builds will trigger Windows reputation warnings. A public release should not be described as fully production-ready until code signing and clean-machine install/uninstall are complete.
