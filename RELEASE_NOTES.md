# Kodra 0.2.0 release candidate

Kodra 0.2.0 makes the workspace quieter on the surface and more extensible underneath. Tool activity now reads as one compact timeline, the composer owns approvals and plans without opening a disconnected dialog, and three complete visual themes can be switched from the keyboard.

## Highlights

- Choose **Kodra**, **Mist**, or **Ember** with `/themes`. Mist uses native Windows acrylic with a readable translucent tint; all three themes cover menus, Markdown, activity, diffs, status, diagnostics, approvals, and plans.
- Install validated local JSON themes without editing Kodra's source or exposing arbitrary CSS and scripts.
- Use `/mode` to switch between Auto, Build, and Plan. Approval and plan reviews grow from the composer and keep focus in the current conversation.
- Scan a simpler activity hierarchy: `Thinking` when reasoning is present and `Worked` otherwise, with aligned Read, Run, Edit, Write, Search, and other tool rows.
- Attach only formats supported by the active model. Large code or text pastes become compact inline attachments while their complete content is preserved for the provider and session.
- Extend slash commands, selection menus, themes, and tool presentation through documented registries with disposal and failure isolation.
- Run stricter native permission checks. Strict mode asks before every tool; destructive commands remain blocked; critical paths cannot be bypassed by a saved allow rule.
- Keep long transcripts responsive with bounded Markdown updates, paced response motion, frame-coalesced scrolling, and DOM virtualization.

## Windows downloads

The candidate release contains one installer and one portable application:

- `Kodra_0.2.0_x64-setup.exe` — recommended current-user NSIS setup.
- `Kodra_0.2.0_x64-portable.exe` — standalone executable using the same Kodra data and credential locations.
- `SHA256SUMS.txt` and `release-manifest.json` — integrity metadata.
- Source code ZIP and TAR archives — supplied automatically by GitHub.

MSI is no longer a release target. The portable build still requires Microsoft Edge WebView2 Runtime. Neither Windows binary is code-signed yet, so SmartScreen may warn on first launch.

## Safety and local data

Provider credentials remain in Windows Credential Manager. Sessions, checkpoints, configuration, and user themes remain local and are preserved by upgrades and normal uninstall behavior. Theme files cannot execute code or access credentials.

## Known release gates

- Code signing is not configured.
- A clean Windows account or VM install, upgrade, and uninstall pass is still required before describing this candidate as production-ready.
- Provider model catalogs, quotas, and rate-limit headers vary by provider and account tier; Kodra shows only data the provider actually returns.

This file is used by the manual draft workflow. The workflow creates a draft prerelease and never publishes it without an explicit maintainer action.
