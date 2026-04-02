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
  --template, -t <name>        Use a platform template (vwo | gtm | at)

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
ss upgrade                     Upgrade ss to the latest version
ss uninstall                   Remove the ss binary and installation directory
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

## Platform templates

`ss init --template <name>` runs a guided wizard tailored to your A/B platform:

| Template | Platform | Default trigger |
|----------|----------|-----------------|
| `vwo` | Visual Website Optimizer | `VWO:DOM_READY` |
| `gtm` | Google Tag Manager | `GTM:DOM_READY` |
| `at` | Adobe Target | `AT:DOM_READY` |

Each template asks only the questions relevant to that platform, sets the correct trigger on each block, and writes export notes to `config.json`.

## Handlebars variables

Define reusable values in the **General** tab of the project manager and reference them in any resource file with `{{variable_name}}`. Values are replaced at build time — before esbuild bundles the code.

```js
// modification.js
document.querySelector('.hero h1').textContent = {{headline}};
```

```css
/* modification.css */
.hero { background: {{brand_color}}; }
```

Variables support typed values (`string`, `number`, `boolean`, `null`, `object`, `array`). Renaming a variable in the UI updates all token references in source files automatically.

## ss-proxy-service (always-on system proxy)

`ss-proxy-service` is an optional companion daemon that replaces `ss start` for teams who want to work against real URLs instead of `localhost:3000`.

Instead of running a per-project proxy, it intercepts all browser HTTPS/HTTP traffic at the OS level and injects the active experience's code into matching pages transparently — the address bar always shows the real URL.

### How it works

1. `ss-proxy-service setup` generates a local CA certificate, installs it in your OS and Firefox trust stores, sets the system proxy, and optionally configures autostart
2. `ss-proxy-service start` (or `--silent` to background it) runs the MITM proxy on `127.0.0.1:8080`
3. `ss-proxy-service register` (or `ss init` auto-registers) adds a project to the daemon's registry
4. Open any registered site in any browser — injection happens automatically based on the project's page targeting rules

Multiple projects across multiple domains can be registered and active simultaneously.

### Setup (run once after install)

```bash
ss-proxy-service setup
```

The wizard handles everything: CA generation, OS trust store installation, Firefox profile detection, system proxy configuration, and autostart.

> **Note:** Installing the CA certificate into the OS trust store requires a one-time confirmation (macOS shows a password dialog; Windows adds to the CurrentUser store without elevation).

### Commands

```
ss-proxy-service setup              Interactive setup wizard (run once)

ss-proxy-service start              Start the proxy in the foreground
ss-proxy-service start --silent     Start as a background daemon (logs → ~/.ss-proxy/proxy.log)
ss-proxy-service stop               Stop the running daemon
ss-proxy-service restart            Restart the running daemon
ss-proxy-service status             Show running state and registered projects

ss-proxy-service register [path]    Add a project to the registry (defaults to cwd)
ss-proxy-service unregister [path]  Remove a project from the registry

ss-proxy-service upgrade            Upgrade to the latest version
ss-proxy-service uninstall          Unset proxy, remove CA cert, delete ~/.ss-proxy/
```

### Integration with ss init

If `ss-proxy-service` is installed (`~/.ss-proxy/config.json` exists), `ss init` automatically registers the new project with the daemon — no manual `register` step needed.

### Service data directory

All service state lives in `~/.ss-proxy/` and is never inside any project directory:

```
~/.ss-proxy/
  config.json              Port, log level, autostart flag
  ca.crt                   Root CA certificate (installed in OS trust store)
  ca.key                   Root CA private key (never leaves this directory)
  certs/                   Per-domain certificate cache
  projects.json            Project registry
  proxy.pid                PID of the running daemon
  proxy.log                Daemon stdout/stderr (silent mode)
  ss-proxy-service.log     Structured event log (matches, injections, errors)
```

`tail -f ~/.ss-proxy/ss-proxy-service.log` while the proxy is running to watch requests in real time. Each line records whether a URL matched an enabled project (with experience, variation, and modification list), a disabled project, or encountered an error.

### Uninstalling ss-proxy-service

```bash
ss-proxy-service uninstall
```

Stops the daemon, unsets the system proxy, removes the CA certificate from all trust stores, and deletes `~/.ss-proxy/`. Project directories and `config.json` files are never touched.

---

## Updating

```bash
ss upgrade
```

Or manually:

```bash
cd ~/.ss && git pull && npm install
```

## Uninstalling

```bash
ss uninstall
```

Removes the global `ss` symlink and deletes the installation directory. Your project directories and `config.json` files are never touched.
