# Changelog

All notable changes to Kodra are recorded here. The project follows [Semantic Versioning](https://semver.org/) from its first release onward.

## [0.2.1] - 2026-09-29

### Added

- Full visual theme coverage across all auxiliary modal windows, including Session Status (`/status`), Provider Diagnostics, Delete Session Confirmation, and API configuration.
- Native frosted-glass acrylic transparency for all modal surfaces under the Mist theme.

### Changed

- Seamless modal search header styling: removed the dark contrasting background in favor of a transparent surface that matches the active theme window.
- Softened command dock geometry with rounded corners, subtle translucent borders, and focused ambient depth.
- Replaced the text plus sign on the attachment button with a crisp, centered vector icon.

### Fixed

- Selection chevron alignment in command suggestion and modal lists, positioning the indicator directly alongside item titles without awkward whitespace gaps.
- Dynamic theming for session status metrics, progress tracks, and header typography across Mist, Ember, and Kodra themes.

## [0.2.0] - 2026-08-24

### Added

- Selecting a linked provider now opens its API key screen so the credential can be replaced; entering a new key overwrites the old one.
- Added Groq as a first-class provider with live model discovery.
- Added a compact, animated `/thinking` menu that exposes only the modes reported for the active model.
- Added `/mode` with Auto, Build, and Plan workflows.
- Added `/themes` with Kodra, Mist, and Ember plus bounded local JSON themes.
- Added model-aware attachments and compact pasted-content handling inside the composer.
- Added command, modal, theme, and user-theme extension contracts with failure isolation.
- Added deterministic Kodra artwork for the supported NSIS installer surfaces.
- Added release staging for exactly one setup executable, one portable executable, and SHA-256 metadata.

### Changed

- Released the project under the MIT License and made the repository public.
- Removed Turkish code comments; all comments and documentation are English.
- Replaced the experimental inline thinking ruler with the shared keyboard-first menu design.
- Simplified activity groups to one Thinking/Worked hierarchy and aligned tool rows without extra cards.
- Attached approval and plan review panels directly to the composer.
- Changed the Windows release layout from NSIS plus MSI to NSIS plus a portable executable.
- Extracted native permission and user-theme services from the application root.

### Fixed

- Persist thinking selections with the camelCase configuration schema expected by Tauri and carry them across provider switches.
- Preserve public reasoning-mode metadata in the offline model cache without storing provider secrets.
- Forward API-provided OpenAI-compatible reasoning efforts instead of collapsing unknown supported modes to `low`.
- Require approval for every tool in Strict mode and prevent saved allows from bypassing critical-path checks.
- Keep menu selection motion stable during rapid keyboard navigation and isolate invalid custom themes.

## [0.1.0] - 2026-08-15

### Added

- Keyboard-first terminal interface with a frameless glass window and high-refresh-rate motion system.
- DOM-based conversation renderer with streaming Markdown, code blocks, diffs, tables, task lists, callouts, and safe local file links.
- Native provider adapters for NVIDIA NIM, OpenAI, Anthropic, Google Gemini, Groq, DeepSeek, Together AI, Fireworks AI, OpenRouter, Ollama, and custom OpenAI-compatible servers.
- Live model catalogs with curated fallbacks and a stale-while-revalidate offline cache.
- Native tool calling for files, code search, shell commands, background processes, web retrieval, browser automation, GitHub tasks, codebase analysis, memory, and delegated subtasks.
- Smart, strict, and autonomous permission modes with risk classification, destructive-command rejection, critical-path approval, and persistent allow rules.
- Local sessions with automatic titles, checkpoints, resume, deletion, interruption recovery, and file undo.
- Manual and automatic context compaction with an 80% default threshold.
- Session status and provider diagnostics for context, token usage, estimated cost, API calls, latency, account details, and rate limits when available.
- Secure provider credential storage through Windows Credential Manager.
- Custom transparent application icon and generated Windows installer assets.
- Windows CI and private draft-release workflows.

### Changed

- Replaced the original terminal renderer with structured DOM output.
- Refined menu navigation so keyboard and pointer input do not compete.
- Improved AI response pacing and menu transitions for smoother visual feedback.
- Updated the interface and user-facing diagnostics to English.

### Security

- Added a restrictive Tauri Content Security Policy and explicit capability selection.
- Disabled production WebView developer tools.
- Kept provider secrets out of frontend caches, configuration payloads, sessions, and diagnostic exports.

### Fixed

- Prevented the animated menu selection marker from leaving duplicate visual frames during rapid navigation.
- Made Cargo rebuild the Windows executable resource whenever the application icon changes.
