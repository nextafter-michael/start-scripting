# Changelog

## 1.1.0

Complete redesign of the project model and developer experience, building on the original `ss connect` proof-of-concept.

### Project model

- **Renamed `tests/` → `experiences/`** — better matches A/B testing terminology
- **Three-level hierarchy**: `experiences/<exp>/<variation>/<block>/` replaces the flat `tests/<name>/v1/` structure
- **Modification blocks**: each block (`<block>/`) holds `modification.js`, `modification.css`, and `modification.html` as independent files — multiple blocks per variation, applied in config order
- **Control variation**: always present in config as a JSON entry; no directory created; switching to it removes all injected code
- **`config.json`** replaces the old `.ss-config.json`: full rich schema with `active`, `experiences` (pages, variations, modifications, audiences), and `settings` (cache_ttl, timeout_ms, spa, ssr)
- **`config.template.json`** added to the repo as a reference schema

### Commands

| Old | New |
|-----|-----|
| `ss connect <url> --test <name>` | `ss start [url]` |
| `ss new <test-name>` | `ss new experience <name>` |
| `ss variation` | `ss new variation <name>` |
| *(none)* | `ss new block <name>` |
| *(none)* | `ss init [dirname]` |
| *(none)* | `ss stop` |
| *(none)* | `ss cache clear` |

- **`ss init [dirname]`** — initializes a project, prompts for site URL → experience name → variation name in sequence; creates `config.json`, `AGENTS.md`, `.gitignore`, and directory structure
- **`ss start [url]`** — replaces `ss connect`; URL is optional when `pages.editor` is set in config; prompts interactively if neither is provided
- **`ss start --background` / `-b`** — spawns a detached server process, writes PID to `.ss-pid`, logs to `.ss.log`
- **`ss stop`** — sends SIGTERM to the background server by reading `.ss-pid`
- **`ss new experience/variation/block`** — subcommand hierarchy replaces the old flat commands; each validates against both the filesystem and config to prevent duplicates
- **`ss list`** — now reads from `config.json` and displays the full experience/variation tree with modification block counts
- **`ss capture`** — falls back to `experience.pages.editor` from config when no URL argument is given

### Live reload

- **Replaced polling with WebSocket** — a persistent WebSocket connection (`/__ss__/ws`) replaces the 1-second polling loop; the server pushes targeted update messages instead of clients polling
- **CSS hot-swap** — CSS-only saves send a `css-update` WebSocket message; the `<style id="__ss_styles">` tag is updated in-place, no page reload
- **HTML hot-swap** — HTML-only saves send an `html-update` WebSocket message; `window.__ss._applyHtml()` removes old nodes and inserts new parsed nodes, no page reload
- **JS changes** still trigger a full `location.reload()` — JS has side effects that can't be safely hot-swapped

### HTML injection

- **Removed the `<div id="__ss_html">` wrapper** — variation HTML is now parsed via `<template>` into a `DocumentFragment` and appended as bare elements directly to `document.body`
- **`window.__ss._applyHtml(html)`** — client-side helper that removes previously injected nodes, parses new HTML, stamps each top-level element with `data-ss-added="<timestamp>"`, and appends them to body; live references stored in `window.__ss._nodes`
- **`data-ss-added` attributes** on all ss-injected elements:
  - `data-ss-added="config"` — `window.__ss` script block
  - `data-ss-added="html-init"` — per-request HTML init script
  - `data-ss-added="bundle"` — the `<script src="bundle.js">` tag
  - `data-ss-added="runtime"` — WebSocket + floating menu script
  - `data-ss-added="styles"` — the injected `<style>` tag
  - `data-ss-added="<timestamp>"` — each HTML element appended by `_applyHtml`

### `window.__ss`

Every proxied page now exposes a `window.__ss` object:

```js
window.__ss = {
  experience:    { name, slug },
  variation:     { name, slug },
  modifications: [{ name, slug, trigger }],
  _nodes: [],       // live references to HTML elements injected by _applyHtml
  _ts:    null,     // timestamp of last _applyHtml call
  _applyHtml(html), // removes old nodes, parses and inserts new HTML fragment
};
```

A `/__ss__/config` endpoint returns the same data as JSON for fetching post-switch.

### Variation switcher

- **`<ss-floating-menu>` web component** replaces the old inline `<div id="__ss_switcher">` — uses a **closed shadow root** so host-page styles cannot bleed in; shows variation display names (not slugs) in the dropdown
- **Control variation fix** — switching to Control now always broadcasts a `reload` message from the server; previously the file watcher never fired for Control (no source files), so the page would not reload

### Resource caching

- **`.cache/` directory** stores CSS, JS, images, and fonts fetched from the live site; assets are served from disk on subsequent requests and proxy restarts
- **`ss start --fresh`** clears `.cache/` before connecting
- **`ss cache clear`** command for manual cache invalidation
- CSS is rewritten on serve (origin URL → localhost) so port changes don't invalidate cached CSS

### File watching enhancements

- **`syncExperiencesDir()`** — the 500ms poll loop now detects manually created directories and files and syncs them to `config.json`:
  - New folder under `<exp>/` → registered as a variation
  - New folder under `<var>/` → registered as a modification block with trigger `DOM_READY`
  - New `.js`/`.css`/`.html` file under a block → added to the block's `resources` list in config order (CSS → JS → HTML)

### esbuild entry files

- **`dist/entry/`** replaces `.ss-cache/`  — synthetic esbuild entry files live inside `dist/` (already gitignored) instead of a separate hidden directory; the name makes the build pipeline relationship obvious
- Import paths corrected to `../../experiences/...` (two levels deep from `dist/entry/`)
- Malformed config entries (missing `slug`) are silently skipped rather than generating broken import paths

### Project context

- **`.context/`** replaces `ss-context/` — screenshots and page HTML are stored under `.context/screenshots/` and `.context/content/body.html`
- **`AGENTS.md`** is generated by `ss init` and updated by `ss start` and `ss capture`; documents the project structure, `window.__ss` API, and file paths for AI assistants
- **`setup.bat` / `setup.sh`** added — run `npm install && npm link` from the repo directory for quick install or update

### Bug fixes

- Duplicate experience/variation entries in `config.json` when running commands in a directory with a pre-existing config
- Quotes typed at readline prompts (e.g. `"v1"`) were stored literally; now stripped
- `loadVariationHtml()` fatal path error when a config modification entry had no `slug` field
- `dist/entry/` import paths used `../` (one level) instead of `../../` (two levels)
- `scaffoldBlock` wrote resources in wrong order (`js` before `css`)
