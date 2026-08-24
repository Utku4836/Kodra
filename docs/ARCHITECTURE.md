# Kodra architecture

Kodra is a Tauri 2 desktop application with a plain JavaScript frontend and a Rust native core. The architecture keeps presentation extensible while credentials, permission decisions, filesystem access and provider requests remain native and authoritative.

## Runtime map

```text
index.html
  main.js                    application assembly and feature wiring
    kodra.config.js          versioned public UI defaults and feature switches
    command-registry.js      slash command discovery and dispatch
    modal-registry.js        selection surface metadata and extension lifecycle
    features/modals/         model, provider, session, mode and theme rows
    features/themes/         local user-theme loading
    themes/                  token contract, registry, runtime and built-ins
    composer-workflow.js     Auto/Build/Plan and attached approvals
    attachment-support.js    model-aware validation and pasted-content adapter
    session-metrics.js       context, compaction, token, and cost calculations
    system-prompt.js         explicit model/mode/environment prompt contract
    activity-ui.js           Thinking/Worked disclosure projection
    tool-renderers.js        safe tool summaries, output and diff renderers
    markdown-ui.js           safe streaming Markdown projection
    transcript-virtualizer.js long-session DOM windowing
    ui-motion.js             shared visibility and selection motion

Tauri IPC
  lib.rs                     application builder, command façade and request assembly
    config_store.rs          public config schema, migrations, and secret references
    providers.rs             provider catalog and endpoint contracts
    streaming.rs             normalized streaming event decoding
    diagnostics.rs           provider health projections
    sessions.rs              structured session storage and migrations
    secrets.rs               Windows Credential Manager boundary
    permissions.rs           authoritative tool policy
    themes.rs                bounded local JSON theme loader
```

The current migration is deliberately incremental. A module is extracted only after its behavior is covered by a contract test; large unreviewable file moves are avoided.

## Extension contracts

### Commands

`createCommandRegistry()` owns IDs, aliases, palette paths and handlers. Registration validates the entire alias set before mutating the registry, so a failed extension cannot leave a partially installed command.

```js
const extension = KodraExtensions.commands.install({
  id: "hello",
  title: "Hello",
  keywords: ["demo"],
  execute: async () => console.log("hello"),
});

extension.dispose();
```

The slash palette reads registry paths at render time, so installed commands appear without editing a hard-coded list.

`KodraExtensions.config` exposes a detached, read-only snapshot of the versioned defaults in `src/kodra.config.js`. It contains no credentials or session data. Product-wide preference keys, composer defaults, motion defaults, and safe UI budgets should be changed there instead of being duplicated across features.

### Selection modals

The shared modal shell owns geometry, focus restoration, keyboard navigation, pointer/keyboard ownership, scrolling and motion. A modal definition supplies metadata and optional renderer/filter/select callbacks.

```js
const extension = KodraExtensions.modals.install({
  id: "example",
  ariaLabel: "Example choices",
  searchable: true,
  render: ({ documentRef, list, items }) => {
    // Return { rows: [{ el, item }], selectedIndex }.
  },
  filter: (items, query) => items.filter((item) => item.name.includes(query)),
  select: async ({ item }) => console.log(item),
});

KodraExtensions.modals.open("example", [{ name: "One" }]);
extension.dispose();
```

Renderer exceptions are isolated inside the modal surface instead of breaking the application bootstrap.

### Themes

Themes use schema-versioned semantic tokens. The runtime applies tokens to the document root, emits `kodra:themechange`, and stores only the selected theme ID. Local manifests are loaded by the bounded native service and validated again in the frontend. See [THEMES.md](THEMES.md).

### Tools

Native tool IDs are projected through the frontend renderer layer. A renderer may change summary, icon, target and details, but it never grants execution permission. Unknown tools fall back to a bounded generic renderer and unknown native tools fail closed.

## State ownership

- Rust owns secrets, provider requests, permissions, tool execution and persisted sessions.
- The transcript schema owns persisted presentation events independently from provider message history.
- Composer state owns draft text, attachments, pasted content, mode and one attached transient panel.
- Registries own discoverability and extension lifecycle, not DOM nodes outside their host.
- Themes own values, not structural markup.

## Security boundaries

- Provider credentials are referenced by deterministic keyring IDs and never serialized to the frontend cache.
- `permissions.rs` evaluates both the preflight decision and the final execution authorization. Frontend approval styling cannot bypass it.
- Strict mode requires approval for every tool. Known destructive commands remain denied even after approval. Critical paths require an explicit per-action approval and cannot be bypassed by a saved allow rule.
- Theme JSON cannot contain scripts, HTML, remote URLs, imports or arbitrary CSS declarations.
- Markdown HTML is not trusted; external URLs and local paths pass separate allowlists and require a user action.

## Performance boundaries

- Provider deltas are paced into readable streaming updates rather than remounting the complete response.
- Markdown commits stable blocks and updates only the live tail.
- Long transcripts unmount distant DOM nodes while retaining measured height.
- Scroll and selection work is coalesced to animation frames.
- UI motion uses transform and opacity and honors the explicit full/reduced preference.

Run `npm run benchmark:runtime` for structural hot-path measurements. It is not a substitute for WebView/GPU validation.
