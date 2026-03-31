# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project does

CLI tool (`ss`) for A/B test development at a marketing agency. It starts a local proxy that mirrors any live client website at `localhost:3000`, automatically injecting the developer's local JS/CSS/HTML into every page with CSS and HTML hot-swap and JS live-reload. An `AGENTS.md` file is generated in each project directory to give AI assistants context about the project.

## Commands

```bash
ss init [dirname]              # initialize a project (prompts for URL, experience, variation)
  --template, -t <name>        # use a platform template: vwo, gtm, at
ss new experience <name>       # create a new experience
ss new variation <name>        # create a variation for the active experience
ss new block <name>            # create a modification block for the active variation
ss start [url]                 # start proxy + watcher (--background to detach)
ss stop                        # stop background server
ss list                        # list experiences/variations from config.json
ss capture [url]               # re-capture page context to .context/
ss cache clear                 # wipe .cache/
ss build                       # bundle all experiences to dist/ (minified)
ss upgrade                     # upgrade ss in the background
ss uninstall                   # remove ss binary and installation directory
ss man                         # full command reference
```

After `npm link` or global install, use `ss` instead of `node bin/ss.mjs`.

## Architecture

```
bin/ss.mjs          CLI entry point (Commander subcommands)
src/proxy.mjs       Express proxy server — mirrors live site, strips CSP, injects bundle
src/builder.mjs     esbuild watcher/bundler — outputs to dist/bundle.js
src/scaffold.mjs    Creates experiences/variations/blocks, writes dist/entry/ cache files
src/capture.mjs     Playwright page scan → screenshots + body.html in .context/
src/templates.mjs   Trigger catalogue + platform-template init wizards (vwo, gtm, at)
src/uninstaller.mjs Detached child script run by ss uninstall
config.template.json  Reference schema for config.json
dist/               Build output (gitignored)
  entry/            Synthetic esbuild entry files (one per experience, gitignored via dist/)
config.json         Active state + full project schema (gitignored, lives in user's project)
```

## Project model

Three-level hierarchy mirroring A/B test concepts:

```
experiences/<exp-slug>/
  <variation-slug>/          ← one directory per non-control variation
    <block-slug>/            ← one directory per modification block
      modification.js
      modification.css
      modification.html
```

**Control** variation is JSON-only (entry in `config.json`, no directory). Switching to it removes all injected code.

`config.json` schema:

```json
{
  "active": { "experience": "slug", "variation": "slug" },
  "experiences": [{
    "name": "Display Name", "slug": "display-name",
    "pages": {
      "editor": "https://...",
      "include": [{ "rule": "URL_MATCHES", "value": "https://example.com", "options": { "ignore_query_string": true } }],
      "exclude": []
    },
    "variations": [{
      "name": "Control", "slug": "control"
    }, {
      "name": "Variation 1", "slug": "variation-1",
      "modifications": [{
        "name": "Hero Copy", "slug": "hero-copy",
        "trigger": "DOM_READY",
        "resources": ["modification.css", "modification.js", "modification.html"]
      }, {
        "name": "Sticky Bar", "slug": "sticky-bar",
        "trigger": "ELEMENT_LOADED", "selector": "#header", "once": true,
        "resources": ["modification.css", "modification.js"]
      }]
    }],
    "audiences": [],
    "variables": { "handlebars": { "headline": { "type": "string", "value": "Hello" } } }
  }],
  "settings": {
    "cache_ttl": 3600, "timeout_ms": 30000, "spa": false, "ssr": false,
    "template": "vwo",
    "template_notes": ["Export note 1"]
  }
}
```

Page rule types: `URL_MATCHES`, `URL_CONTAINS`, `URL_STARTSWITH`, `URL_ENDSWITH`, `URL_REGEX`. Options: `ignore_query_string`, `ignore_fragment`, `ignore_protocol`, `case_sensitive`.

## How injection works

The proxy intercepts HTML responses, strips CSP/HSTS headers, and injects before `</body>`:

1. `<script data-ss-added="config">` — sets `window.__ss` (experience/variation data + `_applyHtml` helper)
2. `<script data-ss-added="html-init">` — calls `window.__ss._applyHtml(html)` with the server-rendered variation HTML (only present when there is HTML to inject)
3. `<script src="/__ss__/bundle.js" data-ss-added="bundle">` — compiled JS+CSS from esbuild
4. `<script data-ss-added="runtime">` — WebSocket live-reload + `<ss-floating-menu>` web component

All ss-injected nodes carry a `data-ss-added` attribute for DevTools identification.

### HTML injection detail

Variation HTML is NOT wrapped in a container element. `_applyHtml()`:
1. Removes previously tracked nodes (`window.__ss._nodes`)
2. Parses the HTML string via `<template>` into a `DocumentFragment`
3. Stamps each top-level element with `data-ss-added="<timestamp>"`
4. Appends directly to `document.body`; stores live references in `window.__ss._nodes`

### Supported resource file extensions

Scripts: `.js` `.ts` `.tsx` `.jsx` `.mjs` `.cjs` — esbuild handles TS/TSX/JSX natively. `.tsx`/`.jsx` files are treated as React components (auto-mounted, see below).

Styles: `.css` `.scss` `.sass` — SCSS/SASS require `sass` as an optional peer dep (`npm install sass` in the project).

Markup: `.html` — injected as DOM fragments before `</body>`.

Default scaffold filenames (`modification.js`, `modification.css`, `modification.html`) are just defaults. Any supported filename works as long as it is listed in the block's `resources` array.

### CSS / style handling

Style files (`.css`/`.scss`/`.sass`) are imported bare in the entry file and transformed by `cssInjectorPlugin` (in `src/builder.mjs`) into JS that injects a `<style type="text/css" id="__ss_styles" data-ss-added="styles">` tag. SCSS/SASS are compiled via `sass.compile()` before injection. Final output is a single self-contained `.js` bundle.

### esbuild entry files

`dist/entry/<exp-slug>.js` is a synthetic file written by `writeCacheEntry()` (in `src/scaffold.mjs`). It contains:
1. Bare CSS/style imports (one per style resource, in `resources` order)
2. A `window.__ss._trigger([...])` call with one descriptor per JS block

Each descriptor: `{ slug, trigger, run, [selector, once, dependency] }`. The `run` field is either `() => import(...)` for plain JS/TS, or an inline function that resolves React and mounts the default export for `.tsx`/`.jsx` files.

### Trigger runtime

`window.__ss._trigger(blocks)` is defined in the `config` script block and called by the compiled bundle:
- `IMMEDIATE` — `run()` called immediately
- `DOM_READY` — waits for `DOMContentLoaded` or fires immediately if DOM is already ready
- `ELEMENT_LOADED` — MutationObserver watches for `block.selector`; fires once (default) or on every match. The matched element is passed to `run(el)`.
- `AFTER_CODE_BLOCK` — queued until the named `dependency` block's `run()` promise resolves

### React component mounting (`.tsx` / `.jsx`)

Entry files for React blocks include static `import` statements for `react` and `react-dom/client` so esbuild bundles them. At runtime `window.React || bundledReact` is used — if the host page already exposes React globally, the bundled copy is unused. Mount target: for `ELEMENT_LOADED` the matched element is used as root; for all other triggers a new `<div>` is appended to `document.body`.

### Live reload

The WebSocket server at `/__ss__/ws` is bidirectional:

**Server → client broadcasts:**
- `{ type: "reload" }` — triggers `location.reload()` (JS changes, variation switches)
- `{ type: "css-update", css }` — updates `#__ss_styles` textContent in place
- `{ type: "html-update", html }` — calls `window.__ss._applyHtml(html)`

**Client → server commands** (from `<ss-modal>`):
- Each message: `{ action, id, ...payload }`. Server replies `{ type: "cmd-result", id, ok, [error] }`.
- Actions: `switch-variation`, `rename-variation`, `reorder-variations`, `create-variation`, `delete-variation`, `rename-modification`, `reorder-modifications`, `delete-modification`, `set-page-rules`
- Handled by `handleCommand()` in `proxy.mjs` — mutates `config.json` and broadcasts `reload` where needed.

### Floating menu and project manager modal

`<ss-floating-menu>` (z-index 2147483645) — closed shadow root, shows two SVG logo icons + variation `<select>` (when ≥2 variations exist) + gear button. Gear button dispatches `ss-open-modal` custom event that bubbles through the real DOM.

`<ss-modal>` (z-index 2147483647, always above the menu) — separate custom element, closed shadow root. Listens for `ss-open-modal` on `document`. Four tabs:
- **General** — read-only: active experience/variation name, slug, modification count
- **Pages** — editable preview URL; include/exclude page rules (rule type dropdown + value + option checkboxes); drag-to-reorder
- **Content** — variation cards with radio to switch active, drag-to-reorder (except Control), inline rename, delete; modification rows with drag-to-reorder, inline rename, delete; "+ New variation" button
- **Developer** — raw `config.json` viewer (`GET /__ss__/raw-config`); scrollable log list (`GET /__ss__/logs`)

### Log buffer

Module-level console interception in `proxy.mjs` captures all `log`/`warn`/`error` output into a 500-entry circular buffer (`_logs`). Exposed via `GET /__ss__/logs`.

### API endpoints

| Route | Description |
|---|---|
| `GET /__ss__/bundle.js` | Compiled bundle |
| `GET /__ss__/variations` | `{ active, all }` for the variation switcher |
| `GET /__ss__/config` | Mirrors `window.__ss` session state |
| `GET /__ss__/project` | Full config tree + `editorUrl` for the modal |
| `POST /__ss__/settings` | Update `pages.editor` URL |
| `GET /__ss__/switch?v=<slug>` | Switch active variation |
| `GET /__ss__/raw-config` | Raw `config.json` for the Developer tab |
| `GET /__ss__/logs` | In-memory log buffer |
| `WS /__ss__/ws` | Live-reload broadcasts + command channel |

### Resource caching

`.cache/<domain>/` stores proxied static assets (CSS, JS, images, fonts) namespaced by the target hostname (e.g. `.cache/example.com/styles/main.css`). This supports multi-site projects without cross-domain cache collisions. The cache middleware runs before the proxy middleware — on a hit it serves from disk. CSS is URL-rewritten on serve so cached files remain valid after port changes.

**Stale-while-revalidate**: on a cache hit the asset is served immediately. If the file is older than `cache_ttl` seconds, a background `fetch()` overwrites the cache entry — the next request then gets the fresh copy. A `_revalidating` Set prevents duplicate in-flight fetches. `cache_ttl = 0` disables caching entirely (all requests pass through to origin).

### Handlebars variable substitution

`{{variable_name}}` tokens in resource files (JS/TS/JSX/TSX/MJS/CJS/CSS/SCSS/SASS/HTML) are replaced at build time with typed values from `config.json`.

Variables are stored per-experience under `exp.variables.handlebars` as `{ type, value }` objects:
- **Types**: `string`, `number`, `boolean`, `null`, `object`, `array`
- **JS context**: bare literals — `true`, `42`, `"text"`, `null`, `{…}`
- **CSS/HTML context**: raw strings; `object`/`array` cast to JSON string with a console warning

`handlebarsPlugin()` in `src/builder.mjs` is an esbuild `onLoad` plugin that intercepts files in `experiences/`. `cssInjectorPlugin` and `readVariationHtml` apply the same substitution to CSS and HTML outside of esbuild.

WS commands from the modal: `create-variable`, `update-variable-value`, `rename-variable` (renames the token across all source files), `delete-variable` (blocked when reference count > 0). Server route `GET /__ss__/variable-refs?exp=<slug>` returns per-variable counts.

### Auto-shutdown

The proxy self-terminates 8 seconds after all browser page-client WebSocket connections close (once at least one page session has been seen). Modal command sockets — identified by sending an `action` message — are excluded from the count. A pending shutdown is cancelled the moment any new connection arrives.

### Platform templates

`ss init --template <name>` (`vwo`, `gtm`, `at`) runs an interactive wizard that creates the experience/variation/block structure, writes the correct trigger defaults, and stores `settings.template` + `settings.template_notes` in `config.json`.

`src/templates.mjs` exports:
- `TRIGGER_GROUPS` — all 22 trigger strings grouped by platform
- `ALL_TRIGGERS` — flat array for validation
- `SELECTOR_TRIGGERS` — Set of triggers that require a `selector` field
- `EVENT_TRIGGERS` — Set of GTM event triggers that require an `event` field
- `triggerExtras(trigger)` — returns `{ needsSelector, needsDependency, needsEvent }` for UI
- `runtimeTrigger(trigger)` — resolves namespaced triggers to generic runtime equivalents
- `TEMPLATES` — `{ vwo, gtm, at }` each with `{ name, run }` used by `bin/ss.mjs`

### Filesystem sync

`syncExperiencesDir()` (called every 500ms poll cycle) detects manually created directories and files:
- New folder under `<exp>/` → new variation registered in config
- New folder under `<var>/` → new modification block in config (trigger: DOM_READY)
- New file in a block → added to `resources` list (sorted: CSS → JS → HTML)

### Bot protection

`ss start` probes the target URL with a headless Playwright browser before starting the proxy. If Cloudflare (or similar) challenge text is detected, it switches to `PwFetcher` mode: a stealth browser (playwright-extra + puppeteer-extra-plugin-stealth) handles all HTML fetches; non-HTML assets are 302-redirected to the real domain.

### `ss uninstall`

`bin/ss.mjs` spawns `src/uninstaller.mjs` as a detached child process (same pattern as `ss upgrade`). The parent exits immediately; the child: waits 1.5 s for the parent to release file locks, runs `npm unlink` (fallback `npm rm -g start-scripting`), then `rmSync(toolDir, { recursive: true, force: true })`. Project directories are never touched.

## Key dependencies

- `express` + `http-proxy-middleware` — proxy server
- `esbuild` — bundler with watch mode
- `playwright` + `playwright-extra` + `puppeteer-extra-plugin-stealth` — headless browser, Cloudflare bypass
- `ws` — WebSocket server
- `commander` — CLI subcommand parsing
- `dotenv` — `.env` support (ANTHROPIC_API_KEY for future AI features)
