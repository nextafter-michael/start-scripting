#!/usr/bin/env node
/**
 * bin/ss.mjs — CLI entry point
 *
 * Commander works like a menu: you define commands and options, then call
 * program.parse() at the end to read the actual arguments from the terminal
 * and run the matching command.
 */

import { program } from 'commander';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, cpSync } from 'fs';
import { join } from 'path';
import { exec } from 'child_process';

// Config and tests live in the current working directory (the user's project)
const CONFIG_FILE = join(process.cwd(), '.ss-config.json');

// ─── Config helpers ───────────────────────────────────────────────────────────
// .ss-config.json remembers your active test and target URL between sessions
// so you don't have to type them every time.

function loadConfig() {
  if (!existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveConfig(data) {
  writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2));
}

// ─── CLI setup ────────────────────────────────────────────────────────────────

program
  .name('ss')
  .description('A/B test local dev tool — develop on live sites from your IDE')
  .version('1.0.0');

// ─── ss new <test-name> ───────────────────────────────────────────────────────

program
  .command('new <test-name>')
  .description('Scaffold a new A/B test folder from the template')
  .action(async (testName) => {
    const { scaffoldTest } = await import('../src/scaffold.mjs');
    scaffoldTest(testName);

    const config = loadConfig();
    saveConfig({ ...config, activeTest: testName, activeVariation: 'v1' });
  });

// ─── ss connect <url> ─────────────────────────────────────────────────────────

program
  .command('connect <url>')
  .description('Start proxy + watcher, capture page context, and open the site in your browser')
  .option('-t, --test <name>', 'Test name to use (defaults to last used test)')
  .option('-p, --port <number>', 'Port to run on', '3000')
  .action(async (url, options) => {
    const config = loadConfig();
    const testName = options.test || config.activeTest;

    if (!testName) {
      console.error('✖ No test specified.');
      console.error('  Run "ss new <test-name>" first, or use: ss connect <url> --test <name>');
      process.exit(1);
    }

    const port = parseInt(options.port, 10);

    // Auto-prepend https:// if no protocol provided (e.g. "opb.org" → "https://opb.org")
    if (!/^https?:\/\//i.test(url)) {
      url = `https://${url}`;
    }

    // Detect bot protection (Cloudflare, etc.) with a quick headless probe.
    let useCDP = false;
    try {
      const { chromium } = await import('playwright');
      console.log('\n  Checking for bot protection...');
      const probe = await chromium.launch({ headless: true });
      const ctx = await probe.newContext();
      const pg = await ctx.newPage();
      await pg.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await new Promise(r => setTimeout(r, 3000));
      const bodyText = await pg.evaluate(() => document.body.innerText);
      useCDP = /security verification|checking your browser|just a moment/i.test(bodyText);

      if (!useCDP) {
        // No challenge — check for redirects (e.g. opb.org → www.opb.org)
        const finalUrl = new URL(pg.url());
        const canonical = `${finalUrl.protocol}//${finalUrl.host}`;
        if (canonical !== new URL(url).origin) {
          console.log(`  ↳ ${url} redirects to ${canonical} — using that instead`);
          url = canonical;
        }
        console.log('  ✔ No bot protection detected');
      } else {
        console.log('  ⚠ Bot protection detected — will use CDP mode');
      }
      await probe.close();
    } catch (err) {
      console.warn(`  ⚠ Probe failed: ${err.message} — proceeding with standard proxy`);
    }

    // Follow redirects for non-CF sites (CF sites handle this in Chrome)
    if (!useCDP) {
      try {
        const res = await fetch(url, { method: 'GET', redirect: 'follow' });
        const resolved = new URL(res.url);
        const canonical = `${resolved.protocol}//${resolved.host}`;
        if (canonical !== new URL(url).origin) {
          console.log(`  ↳ ${url} redirects to ${canonical} — using that instead`);
          url = canonical;
        }
      } catch {}
    }

    // Auto-create the test folder if it doesn't exist yet
    const testDir = join(process.cwd(), 'tests', testName);
    if (!existsSync(testDir)) {
      const { scaffoldTest } = await import('../src/scaffold.mjs');
      scaffoldTest(testName);
    }

    // Split URL into origin (for proxy target) and path (for browser + capture)
    const parsedUrl = new URL(url);
    const targetOrigin = parsedUrl.origin;
    const targetPath = parsedUrl.pathname + parsedUrl.search;

    const activeVariation = config.activeVariation || 'v1';
    saveConfig({ ...config, activeTest: testName, activeVariation, targetUrl: url });

    console.log(`\n  Active test      : tests/${testName}/`);
    console.log(`  Active variation : ${activeVariation}`);
    console.log(`  Target URL       : ${url}`);

    const { startBuilder } = await import('../src/builder.mjs');
    const { startProxy } = await import('../src/proxy.mjs');
    const { capturePageContext } = await import('../src/capture.mjs');

    if (useCDP) {
      // ── CDP mode ─────────────────────────────────────────────────────────
      // Cloudflare blocks Playwright and Node.js HTTP. Instead, launch the
      // user's real Chrome with a debugging port and inject scripts via CDP.
      // Chrome handles Cloudflare natively — no proxy needed for site content.
      const { spawn: spawnProcess } = await import('child_process');
      const { tmpdir } = await import('os');

      const chromePaths = {
        darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        linux: '/usr/bin/google-chrome',
        win32: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      };
      const chromePath = chromePaths[process.platform];
      if (!chromePath) {
        console.error('✖ Could not find Chrome. CDP mode requires Google Chrome.');
        process.exit(1);
      }

      const debugPort = 9222;
      const userDataDir = join(tmpdir(), `ss-chrome-${Date.now()}`);

      console.log('  Launching Chrome with DevTools protocol...');
      const chromeProc = spawnProcess(chromePath, [
        `--remote-debugging-port=${debugPort}`,
        `--user-data-dir=${userDataDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        url,
      ], { stdio: 'ignore', detached: false });

      // Clean up Chrome when the CLI exits
      const cleanup = () => { try { chromeProc.kill(); } catch {} };
      process.on('exit', cleanup);
      process.on('SIGINT', () => { cleanup(); process.exit(0); });

      // Wait for Chrome's debug port to be ready
      for (let i = 0; i < 30; i++) {
        try {
          const r = await fetch(`http://localhost:${debugPort}/json/version`);
          if (r.ok) break;
        } catch {}
        await new Promise(r => setTimeout(r, 500));
      }

      // Connect Playwright to Chrome via CDP
      const { chromium } = await import('playwright');
      const cdpBrowser = await chromium.connectOverCDP(`http://localhost:${debugPort}`);
      const cdpContext = cdpBrowser.contexts()[0];

      // Inject bundle loader + livereload on every page navigation.
      // This runs at document-start via CDP's Page.addScriptToEvaluateOnNewDocument.
      // Since Chrome was launched normally (not by Playwright), navigator.webdriver
      // is NOT set and Cloudflare treats it as a real browser.
      await cdpContext.addInitScript(`
        document.addEventListener('DOMContentLoaded', () => {
          // Load the A/B test bundle
          var s = document.createElement('script');
          s.src = 'http://localhost:${port}/__ss__/bundle.js';
          document.head.appendChild(s);

          // Livereload: poll for rebuilds
          var _ssLast = null;
          setInterval(function() {
            fetch('http://localhost:${port}/__ss__/.reload?t=' + Date.now())
              .then(function(r) { return r.text(); })
              .then(function(ts) {
                if (_ssLast !== null && ts !== _ssLast) location.reload();
                _ssLast = ts;
              })
              .catch(function() {});
          }, 1000);
        });
      `);

      console.log('  ✔ Scripts will be injected after Cloudflare clears');
      console.log('  ℹ Solve the security check in Chrome — your test loads automatically after.\n');

      // Start local server for /__ss__/* + builder + capture in parallel
      await Promise.all([
        startBuilder(testName),
        startProxy(targetOrigin, port, { localOnly: true }),
        capturePageContext(url, testName),
      ]);

      // Chrome is already open — don't open localhost
      console.log(`  Edit tests/${testName}/${activeVariation}/variation.js to write your test.`);
      console.log('  Ask your AI: "Based on ss-context/page.md, [what you want]"');
      console.log('  Press Ctrl+C to stop.\n');

    } else {
      // ── Standard proxy mode ──────────────────────────────────────────────
      await Promise.all([
        startBuilder(testName),
        startProxy(targetOrigin, port),
        capturePageContext(url, testName),
      ]);

      // Open the proxied site at the original path
      const openCmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
      exec(`${openCmd} http://localhost:${port}${targetPath}`);

      console.log(`  Edit tests/${testName}/${activeVariation}/variation.js to write your test.`);
      console.log('  Ask your AI: "Based on ss-context/page.md, [what you want]"');
      console.log('  Press Ctrl+C to stop.\n');
    }

    process.stdin.resume();
  });

// ─── ss list ──────────────────────────────────────────────────────────────────

program
  .command('list')
  .description('List all tests in the current project')
  .action(() => {
    const testsDir = join(process.cwd(), 'tests');
    const config = loadConfig();

    if (!existsSync(testsDir)) {
      console.log('No tests/ folder found. Run "ss connect <url> --test <name>" to create one.');
      return;
    }

    const tests = readdirSync(testsDir).filter((name) => {
      if (name === '_template') return false;
      return statSync(join(testsDir, name)).isDirectory();
    });

    if (tests.length === 0) {
      console.log('No tests yet. Run "ss connect <url> --test <name>" to create one.');
      return;
    }

    console.log('\n  Tests:\n');
    tests.forEach((name) => {
      const active = name === config.activeTest;
      console.log(`  ${active ? '▶' : ' '} ${name}${active ? '  ← active' : ''}`);
    });
    if (config.targetUrl) {
      console.log(`\n  Target URL: ${config.targetUrl}`);
    }
    console.log('');
  });

// ─── ss variation ─────────────────────────────────────────────────────────────

program
  .command('variation')
  .description('Create a new variation for the active test and switch to it')
  .action(async () => {
    const config = loadConfig();
    if (!config.activeTest) {
      console.error('✖ No active test. Run "ss new <name>" first.');
      process.exit(1);
    }

    const testDir = join(process.cwd(), 'tests', config.activeTest);
    if (!existsSync(testDir)) {
      console.error(`✖ Test folder not found: tests/${config.activeTest}/`);
      process.exit(1);
    }

    // Find the highest existing v# folder and increment
    const existing = readdirSync(testDir).filter(
      (n) => /^v\d+$/.test(n) && statSync(join(testDir, n)).isDirectory()
    );
    const nums = existing.map((n) => parseInt(n.slice(1), 10));
    const nextNum = nums.length > 0 ? Math.max(...nums) + 1 : 2;
    const nextVariation = `v${nextNum}`;
    const currentVariation = config.activeVariation || 'v1';

    // Copy current variation folder to new variation
    cpSync(join(testDir, currentVariation), join(testDir, nextVariation), { recursive: true });

    // Rewrite the hidden cache entry to point to the new variation
    const { writeCacheEntry } = await import('../src/scaffold.mjs');
    writeCacheEntry(config.activeTest, nextVariation);

    saveConfig({ ...config, activeVariation: nextVariation });

    console.log(`✔ Created tests/${config.activeTest}/${nextVariation}/ (copied from ${currentVariation})`);
    console.log(`  Now active: ${nextVariation}`);
    console.log(`  Edit tests/${config.activeTest}/${nextVariation}/variation.js`);
  });

// ─── ss capture ───────────────────────────────────────────────────────────────

program
  .command('capture [url]')
  .description('Re-capture page context (screenshots + HTML) for the target site')
  .action(async (url) => {
    const config = loadConfig();
    const targetUrl = url || config.targetUrl;

    if (!targetUrl) {
      console.error('✖ No URL specified and no previous target found.');
      console.error('  Usage: ss capture <url>  or  run ss connect first.');
      process.exit(1);
    }

    const testName = config.activeTest || 'unknown';
    const { capturePageContext } = await import('../src/capture.mjs');
    await capturePageContext(targetUrl, testName);
  });

// ─── ss build ─────────────────────────────────────────────────────────────────

program
  .command('build')
  .description('Bundle all tests to dist/ for deployment (minified)')
  .action(async () => {
    const { buildAll } = await import('../src/builder.mjs');
    await buildAll();
  });

// ─── ss man ───────────────────────────────────────────────────────────────────

program
  .command('man')
  .description('Show the full command reference')
  .action(() => {
    console.log(`
  ┌─────────────────────────────────────────────────────┐
  │                  ss — start-scripting                │
  │        A/B test dev tool for live websites           │
  └─────────────────────────────────────────────────────┘

  WORKFLOW
  ────────
  1. ss connect <url> --test <name>
       Proxy starts at localhost:3000 mirroring the live site.
       Page context saved to ss-context/ for your AI assistant.

  2. Edit tests/<name>/v1/variation.js
       Write plain JS — no wrapper needed. Save to rebuild.

  3. Ask your AI (Copilot, Cursor, Claude, etc.):
       "Based on ss-context/page.md, add a sticky bar..."
       Paste the output into variation.js.

  4. ss build  →  dist/<name>.js
       Paste into Optimizely / VWO / Convert to go live.

  COMMANDS
  ────────
  ss connect <url>               Start proxy + watcher
    --test, -t <name>            Test to use (auto-created if missing)
    --port, -p <number>          Port to run on (default: 3000)

  ss new <test-name>             Scaffold a new test folder
  ss variation                   Create a new variation for the active test
  ss capture [url]               Re-capture page context (screenshots + HTML)
  ss list                        Show all tests, mark active one
  ss build                       Bundle all tests to dist/ (minified)
  ss man                         Show this reference

  TEST FOLDER
  ───────────
  tests/<name>/
    v1/
      variation.js  ← your code (edit this)
      index.css     ← your styles (edit this)
      index.html    ← optional HTML injected before </body>

  CONTEXT FILES (auto-generated on connect, refreshed with ss capture)
  ────────────────────────────────────────────────────────────────────
  ss-context/
    desktop.png  ← full-page screenshot at 1440px
    tablet.png   ← full-page screenshot at 768px
    mobile.png   ← full-page screenshot at 375px
    page.md      ← reference when prompting your AI assistant

  INSTALL
  ───────
  git clone https://github.com/garrett-a/start-scripting.git ~/.ss
  cd ~/.ss && npm install && npm link

  UPDATE
  ──────
  cd ~/.ss && git pull && npm install
`);
  });

// ─── Parse and run ────────────────────────────────────────────────────────────

program.parse();
