# Release checklist

This checklist records the published `0.1.0` release and the current development build. Publishing a newer release still requires an explicit owner decision.

## Product and metadata

- [x] Product name and version agree across npm, Cargo, and Tauri.
- [x] Package descriptions, author, repository, and MIT license metadata are set.
- [x] README, changelog, draft release notes, and security policy are present.
- [x] Application icons are generated from the approved transparent source.
- [x] The executable rebuilds when the Windows icon changes.
- [x] GitHub repository visibility is public.

## Security

- [x] Provider secrets use Windows Credential Manager.
- [x] Production devtools are disabled.
- [x] A restrictive Tauri Content Security Policy is enabled.
- [x] Only the declared main-window capability is enabled.
- [ ] Windows installers are signed with a trusted code-signing certificate.
- [ ] Signed artifacts have been checked with `Get-AuthenticodeSignature`.

## Validation

- [x] `npm ci` succeeds from the locked dependency set.
- [x] `npm audit --audit-level=high` reports no advisories.
- [x] `cargo audit` reports zero vulnerabilities. Of 17 informational warnings, 12 transitive GTK/proc-macro warnings are absent from the Windows tree; the remaining five are unmaintained UNIC crates inherited through Tauri's `urlpattern` dependency.
- [x] All 42 JavaScript tests pass.
- [x] All 39 Rust tests pass.
- [x] Runtime benchmark completes without regression.
- [x] All 36 release metadata checks pass.
- [x] Release application build succeeds with production CSP enabled.
- [x] NSIS and MSI installers build successfully.
- [x] The release executable launches, responds, and contains the approved transparent icon.
- [ ] Provider setup, one tool approval, session resume, and session deletion pass a smoke test.
- [ ] Installation and uninstall are tested on a clean Windows account or VM.

## `0.1.0` publication record

- [x] Review the final diff and release notes.
- [x] Commit and push the release-preparation changes.
- [x] Create the `v0.1.0` tag.
- [x] Run the manual **Draft Windows Release** workflow.
- [x] Publish the GitHub Release after owner approval.
- [x] Make the repository public after owner approval.

## Next release gate

- [ ] Choose and apply the next version number.
- [ ] Complete the provider and clean-machine smoke tests below.
- [ ] Review the changelog and generated artifact hashes.
- [ ] Create and verify a draft release before publication.

## Artifact record

Record filenames, sizes, SHA-256 hashes, signature state, and smoke-test results here before publication.

| Artifact | Size | SHA-256 | Signature | Smoke test |
| --- | ---: | --- | --- | --- |
| NSIS setup | 3.48 MiB | `A6AF0882349DC7232F89EE80EAF554C5BE9F3E287E9B1FE241139315CE01E139` | Not signed | Current develop build; installer smoke test pending |
| MSI installer | 5.22 MiB | `FB2E438DB7203DEB72325AE788FD2EC84ED34AF9DF52397F827D64AE86C9DE2A` | Not signed | Current develop build; installer smoke test pending |
