# Changelog

All notable changes to Kodra are recorded here. The project follows [Semantic Versioning](https://semver.org/) from its first release onward.

## [Unreleased]

### Planned

- Code-sign the Windows installers before the first public download.
- Complete a clean-machine installation smoke test.

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
