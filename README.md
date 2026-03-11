# start-scripting

Local dev tool for building A/B tests on live websites. Write test code in your IDE, see it run on the live site instantly.

## How it works

1. `ss connect <url>` starts a proxy at `localhost:3000` that mirrors any live site
2. Your local JS/CSS is automatically injected into every page
3. Save a file → page rebuilds and refreshes instantly
4. Page context (screenshot + HTML + CSS) is saved to `ss-context/` so you can prompt your AI assistant (Copilot, Cursor, Claude, etc.) to generate test code

## Install

Requires [Node.js](https://nodejs.org) v18+.

```bash
git clone https://github.com/garrett-a/start-scripting.git ~/.ss
cd ~/.ss
npm install
npm link
```

This installs the `ss` command globally. The first time you run `ss connect`, Chromium will be downloaded automatically (~100MB, one time).

## Quickstart

```bash
# Navigate to any project
cd ~/projects/client-site/

# Connect to a live site (auto-creates the test folder)
ss connect https://client-site.com --test homepage-hero

# localhost:3000 opens in your browser, mirroring the live site
# Edit tests/homepage-hero/variation.js — the page refreshes on every save
```

## AI-assisted development

When `ss connect` runs, it saves two files to `ss-context/`:

- `screenshot.png` — visual snapshot of the page
- `page.md` — HTML structure + CSS design tokens

Open `ss-context/page.md` in your IDE and ask your AI assistant:

> "Based on ss-context/page.md, add a sticky announcement bar at the top that matches the site's colors"

Paste the generated code into `variation.js` → the proxy rebuilds → the change appears on the live site.

## Commands

```
ss connect <url>               Start proxy + watcher for a live site
ss connect <url> --test <name> Connect with a specific test name
ss connect <url> --port <n>    Run on a custom port (default: 3000)

ss new <test-name>             Create a new test folder manually
ss list                        Show all tests and which is active
ss build                       Bundle all tests to dist/ for deployment

ss man                         Show the full command reference
```

## Test structure

Each test lives in `tests/<name>/`:

```
tests/
  my-test/
    variation.js   ← write your code here (no wrapper needed)
    index.css      ← styles (auto-injected as a <style> tag)
    index.js       ← boilerplate, do not edit
```

`variation.js` is plain JavaScript — no function wrapper needed. The DOM is ready when it runs.

```js
// variation.js example
const hero = document.querySelector('.hero h1');
if (hero) hero.textContent = 'New Headline';
```

## Deploying a test

```bash
ss build
# → dist/my-test.js (minified, self-contained)
```

Paste the contents of `dist/my-test.js` into your A/B testing platform (Optimizely, VWO, Convert, etc.) or load it via a `<script>` tag.

## Updating

```bash
cd ~/.ss && git pull && npm install
```
