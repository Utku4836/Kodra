# Kodra 0.2.1 release-candidate checklist

This checklist tracks the release build. The published GitHub release is updated to `v0.2.1` with explicit owner approval.

## Product and metadata

- [x] npm, Cargo, and Tauri versions are `0.2.1`.
- [x] Product, author, repository, description, and MIT license metadata agree.
- [x] README, changelog, release notes, security policy, architecture, themes, and release guides exist.
- [x] Application icons use the approved transparent source.
- [x] NSIS sidebar and header artwork is generated deterministically.
- [x] The visible client language and maintained release documentation are English.

## Security

- [x] Provider secrets remain in Windows Credential Manager.
- [x] Production WebView developer tools are disabled.
- [x] A restrictive Tauri Content Security Policy and one declared capability are enabled.
- [x] Native permission policy is authoritative even when risk labels are hidden in the UI.
- [x] Strict mode asks before every tool; destructive operations remain blocked; critical paths require per-action approval.
- [x] User themes are size/count bounded and reject unknown or executable CSS values.
- [ ] Windows binaries are signed with a trusted code-signing certificate.
- [ ] Signed artifacts are verified with `Get-AuthenticodeSignature`.

## Automated validation

- [x] `npm test`: 102/102 passed on 2026-08-24.
- [x] `cargo test --lib`: 51/51 passed on 2026-08-23.
- [x] `cargo fmt --check` passed on 2026-08-23.
- [x] `cargo check` passed on 2026-08-23.
- [x] `npm audit --audit-level=high` reports zero vulnerabilities.
- [x] `npm run benchmark:runtime` completed and its jsdom structural measurements were recorded; real WebView motion was checked separately.
- [x] `npm run verify:release`: 47/47 checks passed.
- [x] `npm run build:release` produced the final staged artifact set.

## UI and functional smoke

- [x] Kodra, Mist, and Ember render in a real Tauri WebView.
- [x] Mist acrylic/translucency remains visible over a real desktop and text is not blurred.
- [x] `/themes` and `/mode` share centered menu geometry, keyboard navigation, and visible row motion.
- [x] Activity groups use the compact Thinking/Worked hierarchy and aligned tool rows.
- [x] Approval and plan review attach to the composer instead of appearing as disconnected dialogs.
- [ ] Provider setup, one read, one approved write, session resume, and session deletion pass on the final production binary.
- [x] Setup install, launch, and uninstall passed on the current Windows profile; version `0.2.0` was reported and user data remained byte-for-byte unchanged.
- [ ] Setup install, upgrade, and uninstall pass on a clean Windows account or VM.
- [x] Portable `0.2.0` launched and remained responsive from an isolated directory outside the repository.

## Artifact contract

- [x] Tauri bundle target is NSIS only.
- [x] Release staging rejects MSI files and duplicate setup executables.
- [x] Exactly `Kodra_0.2.1_x64-setup.exe` and `Kodra_0.2.1_x64-portable.exe` are staged.
- [x] `SHA256SUMS.txt` matches both binaries.
- [x] `release-manifest.json` lists only setup and portable binaries.
- [x] GitHub supplies Source code ZIP and TAR archives; no duplicate source archive is uploaded.

## Repository and publication

- [x] Final diff and generated-file scope are reviewed.
- [x] Secret and stale-product-string scans are clean.
- [x] Intended changes are committed and pushed to `develop`.
- [x] The pushed commit is confirmed on `origin/develop`.
- [x] The workflow creates only a manual draft prerelease.
- [x] No `0.2.1` release is published without explicit owner approval.

## Candidate artifact record

Fill this table from the final staging manifest rather than copying historical values.

| Artifact | Size | SHA-256 | Signature | Smoke test |
| --- | ---: | --- | --- | --- |
| NSIS setup | 3,734,449 bytes | `763F6D54ECD4206EF5C59D2E68E3DD4C2395BCA7C3172F2CF6757649D9ACB3B2` | Not signed | Install, launch, uninstall passed on current profile |
| Portable EXE | 14,862,336 bytes | `F375B523A1B5B80B94C50F6C78B6A5036854251E6F6008A436F200F81A119FC1` | Not signed | Responsive launch outside repository passed |

## Known blockers to a public-ready claim

- Trusted Windows code signing is not configured.
- A clean-machine install/upgrade/uninstall pass has not yet been recorded.

Checksums prove file integrity; they do not replace code signing.
