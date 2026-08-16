# Security policy

CLI Terminal UI can read files, run commands, and send selected conversation context to third-party AI providers. Security reports are taken seriously, especially when they involve credential storage, permission bypasses, command execution, path validation, or secret exposure.

## Supported versions

The project is still in private pre-release. Security fixes are applied to the latest `0.1.x` development version only.

## Reporting a vulnerability

Please report vulnerabilities privately.

1. Use GitHub's **Security** tab and **Report a vulnerability** when private vulnerability reporting is available.
2. If that option is unavailable, contact the repository owner through a private channel.

Do not open a public issue containing API keys, authorization headers, session files, diagnostic exports with private account data, proof-of-concept secrets, or a working exploit.

Include the affected version or commit, a minimal reproduction, the expected security boundary, and the actual result. Remove real credentials before attaching logs or screenshots.

## Security boundaries

- API keys are stored through Windows Credential Manager.
- Session files reject known secret-key fields.
- Destructive shell patterns are denied before execution.
- Critical system paths require explicit approval regardless of the selected permission mode.
- Provider responses and diagnostic errors are reduced to safe, actionable messages before reaching the UI.

These controls reduce risk but do not make autonomous tool execution harmless. Run the app with the least-permissive mode that fits the task and keep important work under version control.
