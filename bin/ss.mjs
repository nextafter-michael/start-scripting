#!/usr/bin/env node
/**
 * bin/ss.mjs — CLI entry point
 *
 * Commander works like a menu: you define commands and options, then call
 * program.parse() at the end to read the actual arguments from the terminal
 * and run the matching command.
 */

import { program } from 'commander';
import { createInterface } from 'readline';
import { readFileSync, writeFileSync, openSync, closeSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { exec, spawn } from 'child_process';

// config.json lives in the current working directory (the user's project)
const CONFIG_FILE = join(process.cwd(), 'config.json');
const PID_FILE    = join(process.cwd(), '.ss-pid');
const LOG_FILE    = join(process.cwd(), '.ss.log');

// ─── Prompt helper ────────────────────────────────────────────────────────────

function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => {
    rl.question(question, (answer) => {
      rl.close();
      // Strip surrounding quotes — readline doesn't remove them the way a shell does,
      // so typing "my name" at a prompt would otherwise store the quotes literally.
      res(answer.trim().replace(/^["']|["']$/g, '').trim());
    });
  });
}

// ─── Config helpers ───────────────────────────────────────────────────────────

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

// ─── Cache helpers ────────────────────────────────────────────────────────────

function clearCache() {
  const cacheDir = join(process.cwd(), '.cache');
  if (existsSync(cacheDir)) {
    rmSync(cacheDir, { recursive: true, force: true });
  }
  mkdirSync(cacheDir, { recursive: true });
  console.log('✔ Cache cleared');
}

// ─── AGENTS.md helpers ────────────────────────────────────────────────────────

function buildAgentsMd({ targetUrl, expSlug } = {}) {
  const urlLine = targetUrl
    ? `**Target site:** ${targetUrl}`
    : `**Target site:** _(run \`ss start <url>\` to set)_`;
  const expLine = expSlug
    ? `**Active experience:** \`experiences/${expSlug}/\``
    : `**Active experience:** _(run \`ss start <url>\` to set)_`;

  return `# Project Context

This is an A/B test project managed with the \`ss\` (start-scripting) tool.
The tool proxies a live website at \`localhost:3000\` and injects local JS/CSS
into every page so you can develop test variations against the real site.

${urlLine}
${expLine}

## How the tool works

- \`ss start [url]\` — starts the proxy and opens the site in your browser.
  The page context (screenshots + HTML) is captured to \`.context/\`.
- \`ss new experience <name>\` — creates a new experience in config.json and \`experiences/\`.
- \`ss new variation <name>\` — adds a variation to the active experience.
- \`ss new block <name>\` — adds a modification block to the active variation.
- \`ss build\` — bundles all experiences to \`dist/\` for deployment.

## Writing test code

Each modification block lives in \`experiences/<exp>/<variation>/<block>/\`:

- \`modification.js\`   — plain JS injected into every proxied page (no wrapper needed)
- \`modification.css\`  — styles, bundled and injected as a \`<style>\` tag automatically
- \`modification.html\` — optional HTML injected before \`</body>\`

Save any file and the proxy rebuilds and live-reloads automatically.
CSS and HTML changes hot-swap without a full page reload.

## Context files (for AI prompting)

After \`ss start\` runs, these files are populated:

- \`.context/screenshots/desktop.png\` — full-page screenshot at 1440px
- \`.context/screenshots/tablet.png\`  — full-page screenshot at 768px
- \`.context/screenshots/mobile.png\`  — full-page screenshot at 375px
- \`.context/content/body.html\`       — cleaned page body HTML + CSS design tokens

To generate test code with an AI assistant:
> "Based on \`.context/content/body.html\`, add a sticky donation bar that
>  matches the site's colors and appears after 3 seconds."

Paste the output into \`modification.js\` and \`modification.css\`. The proxy will rebuild.

## Variation switcher

A floating widget is injected into the proxied page when multiple variations
exist. Use it to switch between variations — the page reloads automatically.

## window.__ss

The proxy exposes the current session state as a window variable on every page:

\`\`\`js
window.__ss = {
  experience:    { name, slug },
  variation:     { name, slug },
  modifications: [{ name, slug, trigger }],
};
\`\`\`
`;
}

function updateAgentsMd(projectDir, { targetUrl, expSlug }) {
  const agentsPath = join(projectDir, 'AGENTS.md');
  if (!existsSync(agentsPath)) return;

  let content = readFileSync(agentsPath, 'utf8');

  if (targetUrl) {
    content = content.replace(
      /^\*\*Target site:\*\*.+$/m,
      `**Target site:** ${targetUrl}`,
    );
  }
  if (expSlug) {
    content = content.replace(
      /^\*\*Active experience:\*\*.+$/m,
      `**Active experience:** \`experiences/${expSlug}/\``,
    );
  }

  writeFileSync(agentsPath, content);
}

// ─── CLI setup ────────────────────────────────────────────────────────────────

program
  .name('ss')
  .description('A/B test local dev tool — develop on live sites from your IDE')
  .version('1.1.0');

// ─── ss init [<dirname>] ──────────────────────────────────────────────────────

program
  .command('init [dirname]')
  .description('Initialize a new ss project in the current directory, or in a new subdirectory')
  .action(async (dirname) => {
    const projectDir = dirname ? resolve(process.cwd(), dirname) : process.cwd();

    if (dirname) {
      if (existsSync(projectDir)) {
        console.error(`✖ Directory already exists: ${dirname}/`);
        process.exit(1);
      }
      mkdirSync(projectDir, { recursive: true });
      console.log(`✔ Created ${dirname}/`);
    }

    // Project subdirectories
    mkdirSync(join(projectDir, 'experiences'), { recursive: true });
    mkdirSync(join(projectDir, '.context', 'screenshots'), { recursive: true });
    mkdirSync(join(projectDir, '.context', 'content'), { recursive: true });
    mkdirSync(join(projectDir, '.cache'), { recursive: true });

    // .gitignore
    const gitignorePath = join(projectDir, '.gitignore');
    if (!existsSync(gitignorePath)) {
      writeFileSync(gitignorePath, [
        'node_modules/',
        'dist/',
        'config.json',
        '.context/',
        '.cache/',
        '.ss-pid',
        '.ss.log',
        '.env',
        '*.DS_Store',
        '*.log',
      ].join('\n') + '\n');
      console.log('✔ Created .gitignore');
    }

    // AGENTS.md
    const agentsPath = join(projectDir, 'AGENTS.md');
    if (!existsSync(agentsPath)) {
      writeFileSync(agentsPath, buildAgentsMd());
      console.log('✔ Created AGENTS.md');
    }

    // Prompts: URL → experience name → variation name
    console.log('');
    const siteUrl = await prompt('  Site URL (press Enter to skip):         ');
    const expName = await prompt('  Experience name (press Enter to skip):  ');
    let varName = '';
    if (expName) {
      varName = await prompt('  Variation name (press Enter to skip):   ');
    }

    const { slugify, writeCacheEntry } = await import('../src/scaffold.mjs');

    let config = {
      $schema: 'https://nextafter.com/ss/config-schema.json',
      active: { experience: null, variation: null },
      experiences: [],
      settings: { cache_ttl: 3600, timeout_ms: 30000, spa: false, ssr: false },
    };

    let expSlug = null;
    let varSlug = null;

    if (expName) {
      expSlug = slugify(expName);
      varSlug = varName ? slugify(varName) : null;

      const expDir = join(projectDir, 'experiences', expSlug);
      mkdirSync(expDir, { recursive: true });

      const experience = {
        name: expName,
        slug: expSlug,
        pages: { editor: siteUrl || '', include: [], exclude: [] },
        variations: [{ name: 'Control', slug: 'control' }],
        audiences: [],
      };

      if (varSlug) {
        const varDir = join(projectDir, 'experiences', expSlug, varSlug);
        mkdirSync(varDir, { recursive: true });
        experience.variations.push({ name: varName, slug: varSlug, modifications: [] });
      }

      config.experiences.push(experience);
      config.active.experience = expSlug;
      config.active.variation  = varSlug || 'control';
    }

    writeFileSync(join(projectDir, 'config.json'), JSON.stringify(config, null, 2));
    console.log('✔ Created config.json');

    if (varSlug) writeCacheEntry(expSlug, varSlug);

    if (expName) {
      console.log(`\n  ✔ Experience: ${expName} (${expSlug})`);
      if (varSlug) console.log(`  ✔ Variation:  ${varName} (${varSlug})`);
    }

    const label = dirname ? `${dirname}/` : 'current directory';
    console.log(`\n  Project initialized in ${label}`);
    console.log('\n  Next steps:');
    if (dirname) console.log(`    cd ${dirname}`);
    if (!expName) console.log('    ss new experience <name>   Create your first experience');
    console.log('    ss start                   Start the proxy and open the site');
    console.log('');
  });

// ─── ss new ───────────────────────────────────────────────────────────────────

const newCmd = program
  .command('new')
  .description('Scaffold new experiences, variations, or modification blocks');

newCmd
  .command('experience <name>')
  .description('Create a new experience')
  .action(async (name) => {
    const { scaffoldExperience, scaffoldVariation } = await import('../src/scaffold.mjs');
    const expSlug = scaffoldExperience(name);

    const varName = await prompt('  Variation name (press Enter to skip): ');
    if (varName) scaffoldVariation(expSlug, varName);

    console.log('\n  Run "ss new block <name>" to add a modification block.');
    console.log('  Run "ss start" to begin developing.\n');
  });

newCmd
  .command('variation <name>')
  .description('Create a new variation for the active experience')
  .action(async (name) => {
    const config = loadConfig();
    const expSlug = config.active?.experience;
    if (!expSlug) {
      console.error('✖ No active experience. Run "ss new experience <name>" first.');
      process.exit(1);
    }
    const { scaffoldVariation } = await import('../src/scaffold.mjs');
    scaffoldVariation(expSlug, name);
    console.log('\n  Run "ss new block <name>" to add a modification block.\n');
  });

newCmd
  .command('block <name>')
  .description('Create a new modification block for the active variation')
  .action(async (name) => {
    const config = loadConfig();
    const expSlug = config.active?.experience;
    const varSlug = config.active?.variation;
    if (!expSlug || !varSlug) {
      console.error('✖ No active experience/variation.');
      console.error('  Run "ss new experience <name>" and "ss new variation <name>" first.');
      process.exit(1);
    }
    if (varSlug === 'control') {
      console.error('✖ Cannot add modification blocks to the Control variation.');
      process.exit(1);
    }
    const { scaffoldBlock } = await import('../src/scaffold.mjs');
    scaffoldBlock(expSlug, varSlug, name);
    console.log('');
  });

// ─── ss start [url] ───────────────────────────────────────────────────────────

program
  .command('start [url]')
  .description('Start the proxy + watcher and open the site in your browser')
  .option('-p, --port <number>', 'Port to run on', '3000')
  .option('--fresh', 'Clear the local resource cache before connecting')
  .option('-b, --background', 'Run the server in a background process (use "ss stop" to stop)')
  .action(async (url, options) => {

    // ── Background mode ─────────────────────────────────────────────────────
    // Relaunch the same command as a detached child process and exit.
    // Logs go to .ss.log; PID is saved to .ss-pid for "ss stop".
    if (options.background) {
      const args = [process.argv[1], 'start'];
      if (url) args.push(url);
      if (options.port !== '3000') args.push('--port', options.port);
      if (options.fresh) args.push('--fresh');

      const logFd = openSync(LOG_FILE, 'a');
      const child = spawn(process.execPath, args, {
        detached: true,
        stdio: ['ignore', logFd, logFd],
        windowsHide: true,
        cwd: process.cwd(),
      });
      child.unref();
      closeSync(logFd);

      writeFileSync(PID_FILE, String(child.pid));
      console.log(`✔ Server started in background (PID ${child.pid})`);
      console.log(`  Logs: .ss.log`);
      console.log(`  Run "ss stop" to stop it.`);
      process.exit(0);
    }

    // ── Foreground mode ─────────────────────────────────────────────────────
    if (options.fresh) clearCache();

    const config = loadConfig();
    const expSlug = config.active?.experience;
    const varSlug = config.active?.variation;

    if (!expSlug) {
      console.error('✖ No active experience.');
      console.error('  Run "ss init" or "ss new experience <name>" to create one.');
      process.exit(1);
    }

    // Resolve URL: command arg → config.pages.editor → prompt
    let targetUrl = url;
    if (!targetUrl) {
      const exp = config.experiences?.find((e) => e.slug === expSlug);
      targetUrl = exp?.pages?.editor;
    }
    if (!targetUrl) {
      console.log('');
      targetUrl = await prompt('  Enter the site URL: ');
      if (!targetUrl) {
        console.error('✖ A URL is required to start the proxy.');
        process.exit(1);
      }
    }

    const port = parseInt(options.port, 10);

    // Auto-prepend https:// if no protocol provided
    if (!/^https?:\/\//i.test(targetUrl)) {
      targetUrl = `https://${targetUrl}`;
    }

    // Detect bot protection (Cloudflare, etc.) with a quick headless probe
    let usePW = false;
    try {
      const { chromium } = await import('playwright');
      console.log('\n  Checking for bot protection...');
      const probe = await chromium.launch({ headless: true });
      const ctx = await probe.newContext();
      const pg = await ctx.newPage();
      await pg.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await new Promise(r => setTimeout(r, 3000));
      const bodyText = await pg.evaluate(() => document.body.innerText);
      usePW = /security verification|checking your browser|just a moment/i.test(bodyText);

      if (!usePW) {
        const finalUrl = new URL(pg.url());
        const canonical = `${finalUrl.protocol}//${finalUrl.host}`;
        if (canonical !== new URL(targetUrl).origin) {
          console.log(`  ↳ ${targetUrl} redirects to ${canonical} — using that instead`);
          targetUrl = canonical;
        }
        console.log('  ✔ No bot protection detected');
      } else {
        console.log('  ⚠ Bot protection detected — will use Playwright bypass');
      }
      await probe.close();
    } catch (err) {
      console.warn(`  ⚠ Probe failed: ${err.message} — proceeding with standard proxy`);
    }

    // Follow redirects for non-CF sites
    if (!usePW) {
      try {
        const res = await fetch(targetUrl, { method: 'GET', redirect: 'follow' });
        const resolved = new URL(res.url);
        const canonical = `${resolved.protocol}//${resolved.host}`;
        if (canonical !== new URL(targetUrl).origin) {
          console.log(`  ↳ ${targetUrl} redirects to ${canonical} — using that instead`);
          targetUrl = canonical;
        }
      } catch {}
    }

    const parsedUrl = new URL(targetUrl);
    const targetOrigin = parsedUrl.origin;
    const targetPath   = parsedUrl.pathname + parsedUrl.search;

    // Persist the URL to experience.pages.editor
    const updatedConfig = loadConfig();
    const exp = updatedConfig.experiences?.find((e) => e.slug === expSlug);
    if (exp) {
      if (!exp.pages) exp.pages = {};
      exp.pages.editor = targetUrl;
    }
    saveConfig(updatedConfig);
    updateAgentsMd(process.cwd(), { targetUrl, expSlug });

    console.log(`\n  Active experience : experiences/${expSlug}/`);
    console.log(`  Active variation  : ${varSlug || 'control'}`);
    console.log(`  Target URL        : ${targetUrl}`);

    const { startBuilder }    = await import('../src/builder.mjs');
    const { startProxy }      = await import('../src/proxy.mjs');
    const { capturePageContext } = await import('../src/capture.mjs');

    if (usePW) {
      const { PwFetcher } = await import('../src/pw-fetcher.mjs');
      const pwFetcher = new PwFetcher();

      console.log('  Launching stealth browser to bypass Cloudflare...');
      await pwFetcher.init(targetUrl);

      process.on('SIGINT', async () => { await pwFetcher.close(); process.exit(0); });

      const cookies   = await pwFetcher.getCookies();
      const broadcast = await startProxy(targetOrigin, port, { pwFetcher });
      await Promise.all([
        startBuilder(expSlug, varSlug || 'control', broadcast),
        capturePageContext(targetUrl, expSlug, { cookies }),
      ]);
    } else {
      const broadcast = await startProxy(targetOrigin, port);
      await Promise.all([
        startBuilder(expSlug, varSlug || 'control', broadcast),
        capturePageContext(targetUrl, expSlug),
      ]);
    }

    const openCmd = process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'start' : 'xdg-open';
    exec(`${openCmd} http://localhost:${port}${targetPath}`);

    console.log(`  Edit experiences/${expSlug}/${varSlug || 'control'}/ to write your test.`);
    console.log('  Ask your AI: "Based on .context/content/body.html, [what you want]"');
    console.log('  Press Ctrl+C to stop.\n');

    process.stdin.resume();
  });

// ─── ss stop ─────────────────────────────────────────────────────────────────

program
  .command('stop')
  .description('Stop a background server started with "ss start --background"')
  .action(() => {
    if (!existsSync(PID_FILE)) {
      console.log('No background server running (.ss-pid not found).');
      return;
    }

    const pid = parseInt(readFileSync(PID_FILE, 'utf8').trim(), 10);
    if (isNaN(pid)) {
      console.error('✖ Invalid PID in .ss-pid');
      rmSync(PID_FILE);
      return;
    }

    try {
      process.kill(pid, 'SIGTERM');
      rmSync(PID_FILE);
      console.log(`✔ Server stopped (PID ${pid})`);
    } catch (err) {
      if (err.code === 'ESRCH') {
        console.log('Server was not running (stale PID file removed).');
        rmSync(PID_FILE);
      } else {
        console.error(`✖ Could not stop server: ${err.message}`);
      }
    }
  });

// ─── ss list ──────────────────────────────────────────────────────────────────

program
  .command('list')
  .description('List all experiences and variations in the current project')
  .action(() => {
    const config = loadConfig();
    const experiences = config.experiences || [];

    if (experiences.length === 0) {
      console.log('No experiences yet. Run "ss new experience <name>" to create one.');
      return;
    }

    const activeExp = config.active?.experience;
    const activeVar = config.active?.variation;

    console.log('\n  Experiences:\n');
    for (const exp of experiences) {
      const isActiveExp = exp.slug === activeExp;
      console.log(`  ${isActiveExp ? '▶' : ' '} ${exp.name} (${exp.slug})${isActiveExp ? '  ← active' : ''}`);
      if (exp.pages?.editor) console.log(`      URL: ${exp.pages.editor}`);
      for (const v of exp.variations || []) {
        const isActiveVar = isActiveExp && v.slug === activeVar;
        const modCount = v.modifications?.length || 0;
        const blockNote = modCount ? ` — ${modCount} block${modCount !== 1 ? 's' : ''}` : '';
        console.log(`      ${isActiveVar ? '▶' : '·'} ${v.name}${blockNote}${isActiveVar ? '  ← active' : ''}`);
      }
    }
    console.log('');
  });

// ─── ss capture ───────────────────────────────────────────────────────────────

program
  .command('capture [url]')
  .description('Re-capture page context (screenshots + HTML) for the target site')
  .action(async (url) => {
    const config = loadConfig();
    const expSlug = config.active?.experience;
    const exp = expSlug ? config.experiences?.find((e) => e.slug === expSlug) : null;
    const targetUrl = url || exp?.pages?.editor;

    if (!targetUrl) {
      console.error('✖ No URL specified and no editor URL found in config.');
      console.error('  Usage: ss capture <url>  or  run ss start first.');
      process.exit(1);
    }

    updateAgentsMd(process.cwd(), { targetUrl, expSlug });
    const { capturePageContext } = await import('../src/capture.mjs');
    await capturePageContext(targetUrl, expSlug || 'unknown');
  });

// ─── ss cache ─────────────────────────────────────────────────────────────────

const cacheCmd = program
  .command('cache')
  .description('Manage the local resource cache (.cache/)');

cacheCmd
  .command('clear')
  .description('Delete all cached resources so they are re-fetched on next start')
  .action(() => {
    clearCache();
  });

// ─── ss build ─────────────────────────────────────────────────────────────────

program
  .command('build')
  .description('Bundle all experiences to dist/ for deployment (minified)')
  .action(async () => {
    const { buildAll } = await import('../src/builder.mjs');
    await buildAll();
  });

// ─── ss upgrade ──────────────────────────────────────────────────────────────

program
  .command('upgrade')
  .description('Upgrade ss to the latest version from the remote repository')
  .action(() => {
    // Resolve the tool's own install directory from this file's path.
    // import.meta.url is file:///.../.../bin/ss.mjs — go up one level.
    const toolDir = join(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'), '..', '..');

    const updaterPath = join(toolDir, 'src', 'updater.mjs');
    const logPath     = join(toolDir, '.ss-upgrade.log');

    const logFd = openSync(logPath, 'w');
    const child = spawn(process.execPath, [updaterPath, toolDir], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
    });
    child.unref();
    closeSync(logFd);

    console.log('  Upgrading in the background...');
    console.log(`  Logs: ${logPath}`);
    console.log('  The upgrade will print "Upgrade completed: vX.Y.Z" when done.');
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
  1. ss init [<dirname>]
       Initialize a new project (prompts for URL, experience + variation names).

  2. ss start
       Proxy starts at localhost:3000 mirroring the live site.
       URL comes from config (set during init or passed as argument).
       Page context saved to .context/ for your AI assistant.

  3. Edit experiences/<exp>/<variation>/<block>/modification.js
       Write plain JS — no wrapper needed. Save to rebuild.
       CSS and HTML changes hot-swap without a full reload.

  4. Ask your AI (Copilot, Cursor, Claude, etc.):
       "Based on .context/content/body.html, add a sticky bar..."
       Paste the output into modification.js / modification.css.

  5. ss build  →  dist/<exp-slug>.js
       Paste into Optimizely / VWO / Convert to go live.

  COMMANDS
  ────────
  ss init [dirname]              Initialize a new project directory

  ss new experience <name>       Create a new experience
  ss new variation <name>        Create a new variation for the active experience
  ss new block <name>            Create a modification block for the active variation

  ss start [url]                 Start proxy + watcher
    --port, -p <number>          Port to run on (default: 3000)
    --fresh                      Clear the cache before starting
    --background, -b             Run in background (logs → .ss.log)

  ss stop                        Stop a background server

  ss list                        Show all experiences and variations
  ss capture [url]               Re-capture page context (screenshots + HTML)
  ss build                       Bundle all experiences to dist/ (minified)
  ss cache clear                 Delete all cached resources (.cache/)
  ss man                         Show this reference

  EXPERIENCE FOLDER
  ─────────────────
  experiences/<slug>/
    <variation-slug>/
      <block-slug>/
        modification.js    ← your code (edit this)
        modification.css   ← your styles (edit this)
        modification.html  ← optional HTML injected before </body>

  CONTEXT FILES (auto-generated on start, refreshed with ss capture)
  ──────────────────────────────────────────────────────────────────
  .context/
    screenshots/
      desktop.png  ← full-page screenshot at 1440px
      tablet.png   ← full-page screenshot at 768px
      mobile.png   ← full-page screenshot at 375px
    content/
      body.html    ← reference this file when prompting your AI assistant

  WINDOW VARIABLE (available on every proxied page)
  ─────────────────────────────────────────────────
  window.__ss = {
    experience:    { name, slug },
    variation:     { name, slug },
    modifications: [{ name, slug, trigger }],
  }

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
