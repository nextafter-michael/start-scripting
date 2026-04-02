# Changelog

## 1.3.0 (WIP — `experimental/ss-proxy-server`)

### `ss-proxy-service` — always-on system proxy daemon

A new companion binary that replaces the per-project `ss start` workflow. Instead of mirroring a site at `localhost:3000`, it intercepts all browser traffic at the OS level so the address bar always shows the real URL. Multiple projects across multiple domains are active simultaneously.

#### Architecture (`src/service/`)

| Module | Purpose |
|---|---|
| `cert.mjs` | Local CA generation (4096-bit RSA, 10yr) + per-domain leaf cert cache (2048-bit, 1yr, regenerated after 11 months) using `node-forge` |
| `db.mjs` | JSON-file project registry at `~/.ss-proxy/projects.json` — `register`, `unregister`, `list`, `listActive`, `setEnabled` |
| `matcher.mjs` | URL rule evaluation against registered project configs — `testRule`, `testPages`, `match`; in-memory config cache with `invalidate`/`add`/`remove` |
| `watcher.mjs` | `fs.watch` on each project's `config.json`; 150ms debounce + re-attach on rename events; calls `invalidate()` on change |
| `injector.mjs` | HTML injection adapted from `src/proxy.mjs` — strips CSP/HSTS/X-Frame-Options, inserts `config`/`bundle`/`runtime` script blocks before `</body>` |
| `proxy.mjs` | MITM proxy: HTTP forward proxy + HTTPS CONNECT tunnel (in-process TLS server per connection); WebSocket server for live reload |
| `ipc.mjs` | Unix socket / Windows named pipe — `stop`, `restart`, `status`, `reload` actions; `sendIpcCommand` client helper |
| `os-proxy.mjs` | Read/set/unset OS system proxy on macOS (`networksetup`), Windows (registry + `InternetSetOption`), Linux (gsettings → kwriteconfig5 → `~/.profile`) |
| `autostart.mjs` | Login autostart via macOS LaunchAgent plist, Windows `HKCU\Run` registry, Linux systemd user service |
| `os-trust.mjs` | Install/remove CA cert in OS trust store and Firefox NSS databases; `findFirefoxProfiles()` detects profiles on all platforms |
| `setup.mjs` | Interactive 7-step TUI setup wizard: port → CA → OS trust → Firefox → system proxy → autostart → write config |
| `logger.mjs` | Structured append-only event log at `~/.ss-proxy/ss-proxy-service.log`; records URL matches (enabled/disabled), injections with variation + mod list, and errors |

#### `bin/ss-proxy-service.mjs`

New CLI binary registered alongside `ss` in `package.json`. Commands: `setup`, `start [--silent]`, `stop`, `restart`, `status`, `register [path]`, `unregister [path]`, `upgrade`, `uninstall`.

#### Integration with `ss init`

`ss init` checks for `~/.ss-proxy/config.json` and auto-registers the new project with the running daemon. The IPC `reload` action (new in this version) lets `register` hot-reload the daemon's project list without a restart.

#### Logger (`src/service/logger.mjs`)

- Appends to `~/.ss-proxy/ss-proxy-service.log`
- `[enabled]` — URL matched an active project; logs experience, variation, modifications
- `[injected]` — HTML injection applied; logs same fields post-inject
- `[disabled]` — URL would have matched a disabled project
- `[error]` / `[forward]` / `[injection]` — error context with message
- `[warn]` — non-fatal warnings (e.g. CONNECT cert errors)

#### Tests (`tests/`)

- `tests/matcher.test.mjs` — 29 unit tests covering all rule types, options, `testPages` include/exclude combos, and `match()` with a real temp config
- `tests/injector.test.mjs` — 16 unit tests for `stripSecurityHeaders` and `inject` (script blocks, WS scheme, html-init, no-`</body>` graceful handling)
- `tests/proxy.test.mjs` — 10 integration tests: HTTP passthrough, injection (config/bundle/runtime/`window.__ss`), HTTPS CONNECT tunnel, and IPC live reload

Run: `npm test` (all), `npm run test:unit` (no network), `npm run test:integration`

#### New dependency

- `node-forge` — pure-JS X.509 certificate generation; no native compilation required

#### Bug fixes (found during review)

- `match()` was missing `projectId` in the returned `MatchResult` — injector received `0` for every project
- `handleHttpRequest` derived `isHttps` from the URL protocol, which is always `http:` inside a CONNECT tunnel (requests arrive as relative paths) — fixed with an explicit `isHttps` parameter
- `createHttpsServer` in the CONNECT handler was not passing `isHttps=true` to the request handler — HTTPS tunnelled requests were forwarded as plain HTTP
- `register` IPC ping was a no-op status call; replaced with a `reload` action that refreshes `_projects` in the running daemon without downtime

---

## 1.2.0

### Stale-while-revalidate caching

- **Serve cached assets immediately** — on a cache hit the response is served from disk right away; a background `fetch()` then overwrites the cached file so the next request gets the freshest version
- **`cache_ttl = 0` bypasses cache entirely** — existing behaviour for `cache_ttl = 0` is preserved; all other values trigger the SWR strategy
- A `_revalidating` Set prevents duplicate in-flight background fetches for the same URL
- `writeToCache()` gains a `force` parameter (default `false`); background revalidation passes `force: true` to overwrite

### Handlebars variable substitution

- **`{{variable_name}}` tokens in resource files are replaced at build time** — works in `.js`, `.ts`, `.tsx`, `.jsx`, `.mjs`, `.cjs`, `.css`, `.scss`, `.sass`, and `.html` files
- Variables are stored per-experience in `config.json` under `exp.variables.handlebars`
- Each variable has a **type**: `string`, `number`, `boolean`, `null`, `object`, or `array`
  - JS context: values are emitted as bare literals (`true`, `42`, `"text"`, `null`, `{…}`)
  - CSS/HTML context: values are emitted as raw strings; `object`/`array` are JSON-stringified with a console warning
  - Legacy plain-string values in config are accepted for backwards compatibility
- **esbuild plugin** (`handlebarsPlugin`) intercepts all JS/TS/JSX/TSX/MJS/CJS files in `experiences/` and applies substitution before bundling
- `cssInjectorPlugin` and `readCssFiles` apply substitution in CSS/SCSS context; `readVariationHtml` applies it in HTML context

### Variables UI (General tab)

- Variables section added to the **General tab** of `<ss-modal>` with a 5-column table: Name | Type | Value | Refs | Actions
- **Inline editing** — click any row to edit name, type, or value in-place; ✓ Save / ✗ Cancel buttons appear only when a field is dirty
- **Type-specific value widgets**: text input (string), number input (number), `<select>` (boolean, null), `<textarea>` (object, array)
- **Reference count** — shows how many `{{token}}` occurrences exist in source files; variables with references cannot be deleted
- **Inline "+ Add variable"** row — no browser `prompt()` calls; everything happens within the modal
- WS commands: `create-variable`, `update-variable-value`, `rename-variable` (renames token across all source files), `delete-variable` (blocked when refs > 0)
- Server route `GET /__ss__/variable-refs?exp=<slug>` returns per-variable reference counts

### Auto-shutdown

- The proxy server **self-terminates 8 seconds after all browser page-client WebSocket connections close**, provided at least one page has loaded during the session
- Modal command sockets (which send `action` messages) are excluded from the page-client count so closing the project manager does not trigger shutdown
- A pending shutdown is cancelled immediately when a new connection arrives (covers page refreshes)

### Platform templates (`ss init --template`)

- **`ss init --template vwo`** — VWO wizard: asks for URL, experience name, number of variations + names; creates one "Custom Code" block per variation with `VWO:DOM_READY`; writes `settings.template = "vwo"` and export notes to config
- **`ss init --template gtm`** — GTM wizard: asks for URL, tag name, workspace name; single variation; CSS + JS block with `GTM:DOM_READY`; export notes include `<script type="text/gtmscript">` wrapping
- **`ss init --template at`** — Adobe Target wizard: asks for URL, activity name, variation name; CSS + JS + HTML block with `AT:DOM_READY`; export notes warn about template-literal syntax
- `src/templates.mjs` — new file; centralises trigger catalogue, `runtimeTrigger()` mapping, `SELECTOR_TRIGGERS`, `EVENT_TRIGGERS`, `triggerExtras()`, and wizard runners

### Trigger namespaces

- **22 trigger strings** now recognised across all templates: 4 generic, 4 VWO-namespaced, 10 GTM-specific, 3 AT-namespaced
- `writeCacheEntry` in `scaffold.mjs` resolves stored trigger strings to generic runtime equivalents via `runtimeTrigger()` so the client-side `_trigger()` runtime always receives a known trigger type
- `SELECTOR_TRIGGERS` set covers `ELEMENT_LOADED`, `VWO:ELEMENT_LOADED`, `AT:ELEMENT_LOADED`, and `GTM:ELEMENT_VISIBILITY`
- `EVENT_TRIGGERS` set covers `GTM:CUSTOM_EVENT`, `GTM:FORM_SUBMIT`, `GTM:CLICK`, `GTM:SCROLL`
- Code-viewer trigger `<select>` in `<ss-modal>` is populated per-template with `<optgroup>` sections

### `ss uninstall`

- **New command** — prompts for `"yes"` confirmation, then detaches a worker process (`src/uninstaller.mjs`) that: removes the global `ss` symlink (`npm unlink`, fallback `npm rm -g start-scripting`) and recursively deletes the installation directory
- Project directories and their `config.json` files are never touched
- Logs written to `.ss-uninstall.log` in the installation directory

### `config.template.json` schema updates

- `trigger` enum expanded from 4 to 22 values
- `event` field added to modification block (GTM event name for GTM event triggers)
- `settings.template` added (`"vwo" | "gtm" | "at" | null`)
- `settings.template_notes` added (array of strings — export notes written by wizard)

### `ss man` updates

- TEMPLATES section documents `--template vwo/gtm/at` options with export notes
- TRIGGERS section lists all 22 trigger strings with descriptions
- COMMANDS table now includes `ss upgrade` and `ss uninstall`
- UNINSTALL section added

### Bug fixes

- Syntax error in injected `<script>` (missing closing quote in template literal ternary) that caused the floating menu and modal to fail silently — fixed; `_showTab()` now wrapped in try/catch so render errors show an inline message instead of breaking the whole UI
- Custom element registrations each independently try/catch'd so a broken tab cannot kill the floating menu
- `create-variable` was silently dropped because `prompt()` is blocked inside a closed shadow DOM — removed all `prompt()`/`alert()` calls from the modal
- Variable creation showed stale data after success — `refreshGeneral()` now re-fetches both `/config` and `/project` before re-rendering
- `SEL_TRIGS` alias imported but never referenced — removed

---

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
