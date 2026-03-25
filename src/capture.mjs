/**
 * capture.mjs — Page context capture
 *
 * Called automatically when `ss connect` runs. Uses Playwright to visit the
 * live site and save context files to ss-context/ in the current project:
 *
 *   ss-context/desktop.png     — full-page screenshot at 1440px
 *   ss-context/tablet.png      — full-page screenshot at 768px
 *   ss-context/mobile.png      — full-page screenshot at 375px
 *   ss-context/page.md         — HTML structure + CSS tokens in markdown,
 *                                readable by any AI assistant (Copilot, Cursor,
 *                                Claude, etc.)
 *
 * The user can then ask their IDE's AI: "Based on ss-context/page.md, add a
 * sticky bar that matches the site's colors" and paste the output into variation.js.
 */

import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const TOOL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Capture the live page and save context files to ss-context/.
 *
 * @param {string} targetUrl - The live site URL to capture
 * @param {string} testName  - Active test name (included in page.md for AI context)
 * @param {object} [options]
 * @param {Array}  [options.cookies] - Cookies to inject (e.g. CF clearance from PwFetcher)
 */
export async function capturePageContext(targetUrl, testName, { cookies } = {}) {
  const contextDir = join(process.cwd(), 'ss-context');
  mkdirSync(contextDir, { recursive: true });

  console.log(`\n🔍 Capturing page context from ${targetUrl}...`);

  let browser;
  try {
    browser = await chromium.launch();
  } catch (err) {
    // Chromium not downloaded yet — install it automatically on first use
    if (err.message.includes('Executable') || err.message.includes('browserType.launch')) {
      console.log('  Installing Chromium (one-time setup, ~100MB)...');
      try {
        const playwrightBin = join(TOOL_DIR, 'node_modules', '.bin', 'playwright');
        execSync(`"${playwrightBin}" install chromium`, { stdio: 'inherit' });
        browser = await chromium.launch();
      } catch (installErr) {
        console.warn(`  ⚠ Could not install Chromium: ${installErr.message}\n`);
        return;
      }
    } else {
      console.warn(`  ⚠ Could not launch browser: ${err.message}\n`);
      return;
    }
  }

  const viewports = [
    { name: 'desktop', width: 1440, height: 900 },
    { name: 'tablet',  width: 768,  height: 1024 },
    { name: 'mobile',  width: 375,  height: 812 },
  ];

  const context = await browser.newContext({
    viewport: { width: viewports[0].width, height: viewports[0].height },
  });

  // Inject CF clearance cookies if provided (for Cloudflare-protected sites)
  if (cookies && cookies.length) {
    await context.addCookies(cookies);
  }

  const page = await context.newPage();

  try {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (err) {
    console.warn(`  ⚠ Page capture timed out or failed: ${err.message}`);
    console.warn(`    The proxy will still work — context files just weren't saved.\n`);
    await browser.close();
    return;
  }

  // Full-page screenshots at each viewport size
  for (const vp of viewports) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.waitForTimeout(300); // let layout settle after resize
    await page.screenshot({
      path: join(contextDir, `${vp.name}.png`),
      fullPage: true,
    });
    console.log(`  ✔ ${vp.name}.png (${vp.width}px)`);
  }

  // Extract the visible body HTML — strips scripts, styles, SVGs, and other
  // invisible elements so the AI gets a clean view of the page structure
  const bodyHtml = await page.evaluate(() => {
    const clone = document.body.cloneNode(true);
    // Remove elements that add noise without structural value
    clone.querySelectorAll('script, style, noscript, svg, link[rel="stylesheet"], iframe')
      .forEach((el) => el.remove());
    // Collapse whitespace runs into single spaces for a compact output
    return clone.innerHTML
      .replace(/\s{2,}/g, ' ')
      .replace(/> </g, '>\n<')
      .trim();
  });

  // CSS design tokens — extracted from the live browser environment
  const tokens = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const result = {};

    for (const prop of root) {
      if (prop.startsWith('--')) {
        const val = root.getPropertyValue(prop).trim();
        if (val) result[prop] = val;
      }
    }

    const body = getComputedStyle(document.body);
    result['_font-family']       = body.fontFamily;
    result['_background-color']  = body.backgroundColor;
    result['_color']             = body.color;

    const el = document.querySelector('a, button');
    if (el) {
      const s = getComputedStyle(el);
      result['_link-color']      = s.color;
      result['_link-background'] = s.backgroundColor;
    }

    return result;
  });

  const pageTitle = await page.title();
  await browser.close();

  // Build page.md — the main context file for the AI assistant
  const cssTokenLines = Object.entries(tokens)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join('\n');

  const md = [
    `# Page Context: ${pageTitle}`,
    ``,
    `**URL:** ${targetUrl}`,
    `**Active test:** tests/${testName}/`,
    ``,
    `## Screenshots`,
    `- **Desktop (1440px):** ss-context/desktop.png`,
    `- **Tablet (768px):** ss-context/tablet.png`,
    `- **Mobile (375px):** ss-context/mobile.png`,
    ``,
    `## How to use this file`,
    `Ask your AI assistant (Copilot, Cursor, Claude, etc.):`,
    `> "Based on the context in ss-context/page.md, [what you want to build]"`,
    ``,
    `Then paste the generated JS into \`tests/${testName}/v1/variation.js\``,
    `and the CSS into \`tests/${testName}/v1/index.css\`.`,
    `The proxy will rebuild and show the change on the live site automatically.`,
    ``,
    `## CSS Design Tokens`,
    `\`\`\``,
    cssTokenLines || '(none found)',
    `\`\`\``,
    ``,
    `## Page Body`,
    `\`\`\`html`,
    bodyHtml,
    `\`\`\``,
  ].join('\n');

  writeFileSync(join(contextDir, 'page.md'), md);

  console.log(`✔ Context saved to ss-context/`);
  console.log(`  desktop.png, tablet.png, mobile.png — full-page screenshots`);
  console.log(`  page.md — reference this file when prompting your AI\n`);
}
