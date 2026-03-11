# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project does

CLI tool (`ss`) for A/B test development at a marketing agency. It starts a local proxy that mirrors any live client website at `localhost:3000`, automatically injecting the developer's local JS/CSS into every page. An AI feature uses Playwright + Claude to scan a live page and generate test components from a plain-English prompt.

## Commands

```bash
node bin/ss.mjs new <test-name>       # scaffold a new test folder
node bin/ss.mjs connect <url>         # start proxy + watcher, opens browser
node bin/ss.mjs generate "<prompt>"   # AI: scan page, generate JS+CSS
node bin/ss.mjs build                 # bundle all tests to dist/ (minified)
npm run build                         # alias for ss build
```

After `npm link` or global install, use `ss` instead of `node bin/ss.mjs`.

## Architecture

```
bin/ss.mjs          CLI entry point (Commander subcommands)
src/proxy.mjs       Express proxy server — mirrors live site, strips CSP, injects bundle
src/builder.mjs     esbuild watcher/bundler — outputs to dist/bundle.js
src/generate.mjs    Playwright page scan + Claude API → writes test JS+CSS
src/scaffold.mjs    Copies tests/_template/ to a new test folder
tests/_template/    Boilerplate for new tests (IIFE pattern, CSS import)
dist/               Build output (gitignored)
.ss-config.json     Stores active test name + target URL between sessions (gitignored)
```

### How script injection works

The proxy intercepts HTML responses, strips `Content-Security-Policy` headers, and injects two things before `</body>`:
1. `<script src="/__ss__/bundle.js">` — the compiled test code (served from the same proxy, no CORS issue)
2. A livereload polling script that fetches `/__ss__/.reload` every second and refreshes the page when the timestamp changes (written by esbuild's `onEnd` plugin after each rebuild)

### CSS handling

Tests import CSS (`import './index.css'`) which is transformed by a custom esbuild plugin (`cssInjectorPlugin` in `src/builder.mjs`) into JS that injects a `<style>` tag — so the final output is always a single self-contained `.js` file.

### AI generation flow

`ss generate` → Playwright navigates to the target URL → captures screenshot (PNG→base64) + rendered HTML + CSS custom properties → sends multimodal message to `claude-sonnet-4-6` → parses JS and CSS code blocks from response → writes to `tests/<name>/index.js` and `index.css` → esbuild picks up the change and rebuilds.

## Environment

Requires `ANTHROPIC_API_KEY` in `.env` for the `generate` command. Copy `.env.example` to `.env`.

## Key dependencies

- `express` + `http-proxy-middleware` — proxy server
- `esbuild` — bundler with watch mode
- `playwright` — headless Chromium for page scanning
- `@anthropic-ai/sdk` — Claude API client
- `commander` — CLI subcommand parsing
