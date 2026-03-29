# start-scripting

Local dev tool for building A/B tests on live websites. Write test code in your IDE against a live proxied site — CSS and HTML changes hot-swap instantly, JS changes reload in under a second.

## How it works

1. `ss init` sets up a project, prompts for your first experience and variation
2. `ss start` mirrors any live site at `localhost:3000` and injects your local code into every page
3. Save a file → CSS/HTML hot-swaps; JS triggers an instant reload
4. Page context (screenshots + cleaned HTML + CSS tokens) is saved to `.context/` for prompting your AI assistant

## Install

Requires [Node.js](https://nodejs.org) v18+.

```bash
git clone https://github.com/garrett-a/start-scripting.git ~/.ss
cd ~/.ss
npm install
npm link
```

Or use the included helper scripts:

```bash
# Windows
setup.bat

# macOS / Linux
./setup.sh
```

This installs the `ss` command globally. The first time you run `ss start`, Chromium will be downloaded automatically (~100MB, one time).

## Quickstart

```bash
# Initialize a new project (prompts for URL, experience, and variation names)
mkdir client-project && cd client-project
ss init

# Start the proxy (URL comes from config — no argument needed after init)
ss start

# localhost:3000 opens in your browser, mirroring the live site
# Edit experiences/<exp>/<variation>/<block>/modification.js — hot-reloads on save
```

## Commands

```
ss init [dirname]              Initialize a new project directory

ss new experience <name>       Create a new experience
ss new variation <name>        Create a new variation for the active experience
ss new block <name>            Create a modification block for the active variation

ss start [url]                 Start proxy + watcher
  --port, -p <number>          Port to run on (default: 3000)
  --fresh                      Clear the resource cache before starting
  --background, -b             Run as a background process (logs → .ss.log)

ss stop                        Stop a background server

ss list                        Show all experiences and variations
ss capture [url]               Re-capture page context (screenshots + HTML)
ss build                       Bundle all experiences to dist/ (minified)
ss cache clear                 Delete all cached resources (.cache/)
ss man                         Show the full command reference
```

## Project structure

```
experiences/
  my-test/
    variation-1/
      hero-copy/               ← modification block
        modification.js        ← your code (plain JS, no wrapper needed)
        modification.css       ← your styles
        modification.html      ← optional HTML appended to <body>
config.json                    ← active experience/variation + full schema (gitignored)
.context/
  screenshots/
    desktop.png                ← 1440px full-page screenshot
    tablet.png                 ← 768px
    mobile.png                 ← 375px
  content/
    body.html                  ← cleaned HTML + CSS tokens for AI prompting
```

`modification.js` is plain JavaScript — no function wrapper needed. The DOM is ready when it runs.

```js
// modification.js example
const hero = document.querySelector('.hero h1');
if (hero) hero.textContent = 'New Headline';
```

## AI-assisted development

When `ss start` runs, it saves context files to `.context/`. Open `.context/content/body.html` in your IDE and ask your AI assistant (Copilot, Cursor, Claude, etc.):

> "Based on `.context/content/body.html`, add a sticky announcement bar at the top that matches the site's colors"

Paste the generated code into `modification.js` and `modification.css` — the proxy rebuilds and the change appears on the proxied site.

Run `ss capture` at any time to refresh context files without restarting the proxy.

## Live reload

- **CSS changes** — the `<style>` tag is updated in-place; the page does not reload
- **HTML changes** — injected nodes are replaced via DOM fragment; the page does not reload
- **JS changes** — full page reload (JS side effects require a clean slate)

All injected elements have a `data-ss-added` attribute so you can identify them in DevTools.

## window.__ss

Every proxied page exposes the current session state as a browser global:

```js
window.__ss = {
  experience:    { name, slug },
  variation:     { name, slug },
  modifications: [{ name, slug, trigger }],
  _nodes:        [],    // live references to HTML elements injected by ss
  _ts:           null,  // timestamp of the last HTML injection
  _applyHtml(html),     // re-inject variation HTML programmatically
  _trigger(blocks),     // called by the bundle to execute modification blocks per their trigger type
};
```

## Floating menu and project manager

A `<ss-floating-menu>` widget is injected into every proxied page. It shows a variation switcher dropdown (when more than one variation exists) and a gear icon that opens the **project manager modal** (`<ss-modal>`).

The modal has four tabs:

- **General** — active experience and variation, read-only overview
- **Pages** — preview URL, include/exclude targeting rules (with rule type, value, and option checkboxes)
- **Content** — variation list with drag-to-reorder, inline rename, delete, radio to switch the active variation, and modification block details
- **Developer** — raw `config.json` viewer and live log output

Both elements use closed shadow roots so host-page styles cannot affect them.

## Optional HTML injection

Add HTML to a block's `modification.html` and it will be appended to `<body>` on every proxied page as bare elements (no wrapper div). Useful for modals, overlays, or any markup your test needs:

```html
<!-- modification.html -->
<div id="my-modal" style="display:none">
  <h2>Special Offer</h2>
</div>
```

Leave the file empty if your test doesn't need extra HTML.

## Deploying a test

```bash
ss build
# → dist/my-test.js (minified, self-contained)
```

Paste the contents of `dist/<exp>.js` into your A/B testing platform (Optimizely, VWO, Convert, etc.) or load it via a `<script>` tag.

## Resource caching

The proxy caches CSS, JS, images, and fonts from the live site to `.cache/<domain>/` (namespaced by hostname so multi-site projects don't collide). Subsequent page loads and proxy restarts serve these from disk — making navigation faster during development.

```bash
ss start --fresh        # clear cache before starting
ss cache clear          # clear cache without restarting
```

## Background mode

Run the proxy in the background so your terminal stays free:

```bash
ss start --background   # starts server, prints PID
ss stop                 # stops it
tail -f .ss.log         # follow logs
```

## Testing locally (contributing)

```bash
# 1. Clone and link
git clone https://github.com/garrett-a/start-scripting.git ~/.ss
cd ~/.ss && npm install && npm link

# 2. Make a throwaway project to test against
mkdir /tmp/ss-test && cd /tmp/ss-test
ss init

# Changes to src/ or bin/ take effect immediately — no reinstall needed
```

To unlink when done:

```bash
npm unlink -g start-scripting
```

## Updating

```bash
cd ~/.ss && git pull && npm install
# or
cd ~/.ss && ./setup.sh
```
