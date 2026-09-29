# Kodra 0.2.1

Kodra 0.2.1 refines visual coherence and interaction precision across the entire workspace. All auxiliary windows and dialogs now participate fully in the active theme, modal search headers seamlessly integrate into their parent surfaces, and the command dock introduces softened curvature and subtle ambient depth.

## Highlights

- **Universal Window Theming**: Extended full theme compatibility across all auxiliary modal surfaces, including Session Status (`/status`), Provider Diagnostics, Delete Session Confirmation, and API configuration.
- **Native Frosted Glass on Windows**: Modal dialogs in the Mist theme now render with authentic acrylic frosted-glass translucency (`blur(24px)`) and subtle highlights.
- **Seamless Modal Search**: Removed the contrasting background from modal search headers, allowing the search area to naturally share the window's unified background and border styling.
- **Refined Selection Alignment**: Adjusted the menu selection indicator (`›`) and list item padding across command suggestion and provider menus, ensuring the indicator sits snugly and balanced next to item titles.
- **Softened Command Dock**: Upgraded the bottom input dock with rounded geometry, subtle translucent borders, and a centered SVG vector attachment icon.
- **Responsive Status Metrics**: Updated context usage tracks, session metrics, and status dialog typography to dynamically respond to semantic theme accents across Mist, Ember, and Kodra.

## Windows downloads

The release contains one installer and one portable application:

- `Kodra_0.2.1_x64-setup.exe` — recommended current-user NSIS setup.
- `Kodra_0.2.1_x64-portable.exe` — standalone executable using the same Kodra data and credential locations.
- `SHA256SUMS.txt` and `release-manifest.json` — integrity metadata.
- Source code ZIP and TAR archives — supplied automatically by GitHub.

The portable build requires Microsoft Edge WebView2 Runtime. Binaries are built directly from this repository. As code signing is not yet configured, Windows SmartScreen may present a prompt on first launch.

## Safety and local data

Provider credentials remain protected in Windows Credential Manager. Sessions, checkpoints, configuration, and user themes remain strictly local.
