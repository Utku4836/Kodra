# Release checklist

This checklist is for the first private Windows release candidate, `0.1.0`. Completing it does not publish a release; publication requires an explicit owner decision.

## Product and metadata

- [x] Product name and version agree across npm, Cargo, and Tauri.
- [x] Package descriptions, author, repository, and private license state are set.
- [x] README, changelog, draft release notes, and security policy are present.
- [x] Application icons are generated from the approved transparent source.
- [x] The executable rebuilds when the Windows icon changes.
- [x] GitHub repository visibility is private.

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
- [x] All 35 JavaScript tests pass.
- [x] All 37 Rust tests pass.
- [x] Runtime benchmark completes without regression.
- [x] All 36 release metadata checks pass.
- [x] Release application build succeeds with production CSP enabled.
- [x] NSIS and MSI installers build successfully.
- [x] The release executable launches, responds, and contains the approved transparent icon.
- [ ] Provider setup, one tool approval, session resume, and session deletion pass a smoke test.
- [ ] Installation and uninstall are tested on a clean Windows account or VM.

## Publication gate

- [ ] Review the final diff and release notes.
- [ ] Commit and push the release-preparation changes.
- [ ] Create the `v0.1.0` tag.
- [ ] Run the manual **Draft Windows Release** workflow.
- [ ] Download and verify both draft artifacts.
- [ ] Publish the GitHub Release only after owner approval.
- [ ] Decide whether and when the repository itself should become public.

## Artifact record

Record filenames, sizes, SHA-256 hashes, signature state, and smoke-test results here before publication.

| Artifact | Size | SHA-256 | Signature | Smoke test |
| --- | ---: | --- | --- | --- |
| NSIS setup | 3.44 MiB | `DA60A3F97A59DFCA17C0EEA76AB82C19898147CA767DB6AF08D643E8DB726B98` | Not signed | Installer smoke test pending |
| MSI installer | 5.20 MiB | `213CF11555CFD7BE097B939646EC94AF0D37F4FF09EE99E32729C1A12048FF47` | Not signed | Installer smoke test pending |
