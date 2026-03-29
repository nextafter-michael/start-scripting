# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project does

CLI tool (`ss`) for A/B test development at a marketing agency. It starts a local proxy that mirrors any live client website at `localhost:3000`, automatically injecting the developer's local JS/CSS/HTML into every page with CSS and HTML hot-swap and JS live-reload. An `AGENTS.md` file is generated in each project directory to give AI assistants context about the project.

## Commands

```bash
ss init [dirname]              # initialize a project (prompts for URL, experience, variation)
ss new experience <name>       # create a new experience
ss new variation <name>        # create a variation for the active experience
ss new block <name>            # create a modification block for the active variation
ss start [url]                 # start proxy + watcher (--background to detach)
ss stop                        # stop background server
ss list                        # list experiences/variations from config.json
ss capture [url]               # re-capture page context to .context/
ss cache clear                 # wipe .cache/
ss build                       # bundle all experiences to dist/ (minified)
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
    "pages": { "editor": "https://...", "include": [], "exclude": [] },
    "variations": [{
      "name": "Control", "slug": "control"
    }, {
      "name": "Variation 1", "slug": "variation-1",
      "modifications": [{
        "name": "Hero Copy", "slug": "hero-copy",
        "trigger": "DOM_READY",
        "resources": ["modification.css", "modification.js", "modification.html"]
      }]
    }],
    "audiences": []
  }],
  "settings": { "cache_ttl": 3600, "timeout_ms": 30000, "spa": false, "ssr": false }
}
```

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

### CSS handling

Modification blocks import CSS (`import '../../experiences/.../modification.css'`) which is transformed by `cssInjectorPlugin` (in `src/builder.mjs`) into JS that injects a `<style type="text/css" id="__ss_styles" data-ss-added="styles">` tag — final output is a single self-contained `.js` file.

### esbuild entry files

`dist/entry/<exp-slug>.js` is a synthetic file written by `writeCacheEntry()` (in `src/scaffold.mjs`) that imports CSS then JS from all modification blocks in the order defined in `config.json`. Paths use `../../` relative to `dist/entry/`. esbuild reads this file and bundles everything into `dist/bundle.js`.

### Live reload

The WebSocket server at `/__ss__/ws` broadcasts three message types:
- `{ type: "reload" }` — triggers `location.reload()` (JS changes, variation switches)
- `{ type: "css-update", css }` — updates `#__ss_styles` textContent in place
- `{ type: "html-update", html }` — calls `window.__ss._applyHtml(html)`

### Variation switcher

`<ss-floating-menu>` is a custom element with a **closed** shadow root, so host-page styles cannot affect it. It fetches `/__ss__/variations` for the variation list and posts to `/__ss__/switch?v=<slug>`. The server broadcasts `reload` after a switch (even for Control where no source files change).

### Resource caching

`.cache/` stores proxied static assets (CSS, JS, images, fonts). The cache middleware runs before the proxy middleware — on a hit it serves from disk. CSS is URL-rewritten on serve so cached files remain valid after port changes. `writeToCache()` is miss-only (never overwrites).

### Filesystem sync

`syncExperiencesDir()` (called every 500ms poll cycle) detects manually created directories and files:
- New folder under `<exp>/` → new variation registered in config
- New folder under `<var>/` → new modification block in config (trigger: DOM_READY)
- New file in a block → added to `resources` list (sorted: CSS → JS → HTML)

### Bot protection

`ss start` probes the target URL with a headless Playwright browser before starting the proxy. If Cloudflare (or similar) challenge text is detected, it switches to `PwFetcher` mode: a stealth browser (playwright-extra + puppeteer-extra-plugin-stealth) handles all HTML fetches; non-HTML assets are 302-redirected to the real domain.

## Key dependencies

- `express` + `http-proxy-middleware` — proxy server
- `esbuild` — bundler with watch mode
- `playwright` + `playwright-extra` + `puppeteer-extra-plugin-stealth` — headless browser, Cloudflare bypass
- `ws` — WebSocket server
- `commander` — CLI subcommand parsing
- `dotenv` — `.env` support (ANTHROPIC_API_KEY for future AI features)
