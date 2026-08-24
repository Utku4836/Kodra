# Kodra themes

Kodra themes are small JSON manifests. They change the semantic visual tokens used by the window, transcript, composer, menus, activity rows, Markdown, code, diffs, status and diagnostics surfaces. Theme files cannot add scripts, remote assets or arbitrary CSS.

## Use a built-in theme

Run `/themes`, choose **Kodra**, **Mist** or **Ember**, then press Enter. The choice is saved locally and restored before the interface is painted.

- **Kodra** is the original deep-black terminal theme.
- **Mist** is a translucent sage glass theme. On Windows 10 and 11 it uses the native acrylic window effect.
- **Ember** is a charcoal theme with restrained crimson accents.

## Add a custom theme

1. Run `/themes folder` to open Kodra's local theme directory.
2. Copy [quiet-blue.json](../examples/themes/quiet-blue.json) into that directory.
3. Edit its `id`, `label` and `tokens`.
4. Run `KodraThemes.reload()` from the development console, or reopen `/themes`. Valid files appear beneath the built-in themes.

Kodra reads at most 32 `.json` files. Each file must be no larger than 128 KiB. Invalid files are skipped without preventing the application from opening.

## Manifest format

```json
{
  "id": "quiet-blue",
  "label": "Quiet Blue",
  "version": 1,
  "colorScheme": "dark",
  "transparency": "opaque",
  "tokens": {
    "canvas.background": "#070b10",
    "text.primary": "#edf5ff",
    "accent.primary": "#9bc8ec"
  }
}
```

Rules:

- `id` starts with a lowercase ASCII letter and contains only lowercase letters, numbers and hyphens. The maximum length is 48 characters.
- `label` contains 1–64 characters.
- `version` is currently `1`.
- `colorScheme` is `dark` or `light`.
- `transparency` is `opaque` or `frosted`.
- `tokens` may be partial. Missing values inherit Kodra's safe defaults.
- Unknown tokens and unsafe values are rejected. Theme values cannot contain remote URLs, imports, JavaScript, CSS declarations or HTML.
- Built-in IDs (`kodra`, `mist`, `ember`) cannot be replaced by a user file.

## Token reference

### Window and surfaces

| Token | Purpose |
| --- | --- |
| `native.background` | Native WebView background beneath the document |
| `canvas.background` | Main application canvas |
| `canvas.ambient` | Optional gradient or flat ambient layer |
| `surface.panel` | Composer and persistent panels |
| `surface.raised` | Menus and elevated surfaces |
| `surface.inset` | Recessed content such as diff bodies |
| `surface.soft` | Very subtle secondary surface |
| `surface.hover` | Keyboard or pointer hover state |
| `surface.selected` | Selected menu row |

### Text, borders and accent

| Token | Purpose |
| --- | --- |
| `text.primary` | Main interface text |
| `text.response` | Assistant response prose |
| `text.secondary` | Supporting labels |
| `text.muted` | Low-emphasis metadata |
| `text.dim` | Quiet but readable text |
| `text.user` | User prompt text |
| `text.link` | Links and path actions |
| `border.subtle` | Hairline separators |
| `border.normal` | Panel and control boundaries |
| `border.focus` | Keyboard focus indication |
| `accent.primary` | Primary accent and active indicators |
| `accent.soft` | Low-opacity accent surface |

### State and glass

| Token | Purpose |
| --- | --- |
| `state.success` | Successful operations |
| `state.warning` | Warnings and approaching limits |
| `state.danger` | Errors and destructive actions |
| `state.offline` | Offline indicator |
| `overlay.scrim` | Modal backdrop |
| `glass.blur` | Backdrop blur radius, for example `24px` |
| `glass.saturation` | Backdrop saturation, for example `118%` |
| `glass.highlight` | Soft glass edge highlight |
| `shadow.window` | Main window shadow or inset highlight |
| `shadow.panel` | Raised panel shadow |
| `shadow.focus` | Focus halo |

### Code and diff

| Token | Purpose |
| --- | --- |
| `code.background` | Code block background |
| `code.inlineBackground` | Inline code background |
| `code.text` | Default code text |
| `code.muted` | Line numbers and quiet code metadata |
| `code.keyword` | Keywords |
| `code.string` | Strings |
| `code.number` | Numeric values |
| `code.function` | Function names |
| `diff.addBackground` | Added-line background |
| `diff.addText` | Added-line marker/text |
| `diff.deleteBackground` | Removed-line background |
| `diff.deleteText` | Removed-line marker/text |
| `diff.hunk` | Diff hunk metadata |

### Interaction and typography

| Token | Purpose |
| --- | --- |
| `selection.background` | Text selection |
| `scrollbar.thumb` | Scrollbar thumb |
| `font.responseSize` | Assistant prose size |
| `font.responseLineHeight` | Assistant prose line height |
| `radius.panel` | Panel corner radius |
| `radius.control` | Control corner radius |

## Development API

The development console exposes a deliberately small API:

```js
KodraThemes.list()          // Safe theme metadata
KodraThemes.apply("mist") // Apply and persist
KodraThemes.current()       // Current safe metadata
KodraThemes.reload()        // Re-read user JSON files
KodraThemes.openFolder()    // Open the local theme directory
```

The API does not expose provider keys, session content or unrestricted filesystem access.
