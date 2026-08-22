# Kodra 0.1.0

Kodra 0.1.0 is the first public Windows release. It brings the full provider, tool, session, Markdown, diagnostics, and permission systems into one keyboard-first desktop interface.

## Highlights

- Connect OpenAI, Anthropic, Gemini, NVIDIA NIM, Groq, DeepSeek, Together AI, Fireworks AI, OpenRouter, Ollama, or a custom compatible server.
- Work with native file, code-search, shell, web, browser, repository, and background-process tools.
- Review risky actions before they run, with strict and autonomous modes available when needed.
- Resume local conversations with their provider, model, context state, checkpoints, and usage intact.
- Read responses as polished Markdown instead of raw terminal output.
- Inspect provider health and session usage without adding diagnostic noise to the conversation.

## Installation

The release produces two Windows installer formats, available on the [Releases page](https://github.com/Utku4836/Kodra/releases):

- NSIS setup executable (`*-setup.exe`)
- Windows Installer package (`*.msi`)

The installers are not code-signed yet. Windows may display a SmartScreen warning until a signing certificate is configured.

## First launch

Choose a provider and enter its API key. Credentials are stored in Windows Credential Manager. Ollama can be used without an API key when its local server is running.

Type `/` to see the available commands. The default `smart` permission mode automatically allows reads and asks before writes or risky operations.

## Known limitations

- Windows 10 and Windows 11 are the only tested targets for 0.1.0.
- Browser automation expects Microsoft Edge to be installed.
- Provider catalog quality, quotas, rate-limit headers, and tool support vary by provider and account tier.
- Custom servers must expose an OpenAI-compatible chat and model API.
- The app does not yet include an automatic updater.
- The installers are not code-signed; SmartScreen may warn until a signing certificate is configured.

## Upgrade notes

This is the first packaged release, so there is no migration step. Existing development sessions use the same local session schema and are loaded automatically.
