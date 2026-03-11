/**
 * capture.mjs — Page context capture
 *
 * Called automatically when `ss connect` runs. Uses Playwright to visit the
 * live site and save context files to ss-context/ in the current project:
 *
 *   ss-context/screenshot.png  — visual snapshot of the page
 *   ss-context/page.md         — HTML structure + CSS tokens in markdown,
 *                                readable by any AI assistant (Copilot, Cursor,
 *                                Claude, etc.)
 *
 * The user can then ask their IDE's AI: "Based on ss-context/page.md, add a
 * sticky bar that matches the site's colors" and paste the output into variation.js.
 */

import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

/**
 * Capture the live page and save context files to ss-context/.
 *
 * @param {string} targetUrl - The live site URL to capture
 * @param {string} testName  - Active test name (included in page.md for AI context)
 */
export async function capturePageContext(targetUrl, testName) {
  const contextDir = join(process.cwd(), 'ss-context');
  mkdirSync(contextDir, { recursive: true });

  console.log(`\n🔍 Capturing page context from ${targetUrl}...`);

  let browser;
  try {
    browser = await chromium.launch();
  } catch (err) {
    console.warn(`  ⚠ Could not launch browser for page capture: ${err.message}`);
    console.warn(`    Run "npx playwright install chromium" to fix this.\n`);
    return;
  }

  const page = await browser.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });

  try {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (err) {
    console.warn(`  ⚠ Page capture timed out or failed: ${err.message}`);
    console.warn(`    The proxy will still work — context files just weren't saved.\n`);
    await browser.close();
    return;
  }

  // Screenshot saved as a real PNG file — AI assistants that support images
  // (Cursor, Claude Code) can view it directly in the IDE
  const screenshotPath = join(contextDir, 'screenshot.png');
  await page.screenshot({ path: screenshotPath, fullPage: false });

  // Rendered HTML after JS has run (better than raw source)
  const html = await page.content();

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
    `**Active test:** tests/${testName}/variation.js`,
    `**Screenshot:** ss-context/screenshot.png`,
    ``,
    `## How to use this file`,
    `Ask your AI assistant (Copilot, Cursor, Claude, etc.):`,
    `> "Based on the context in ss-context/page.md, [what you want to build]"`,
    ``,
    `Then paste the generated JS into \`tests/${testName}/variation.js\``,
    `and the CSS into \`tests/${testName}/index.css\`.`,
    `The proxy will rebuild and show the change on the live site automatically.`,
    ``,
    `## CSS Design Tokens`,
    `\`\`\``,
    cssTokenLines || '(none found)',
    `\`\`\``,
    ``,
    `## Page HTML (first 8000 chars)`,
    `\`\`\`html`,
    html.slice(0, 8000),
    `\`\`\``,
  ].join('\n');

  writeFileSync(join(contextDir, 'page.md'), md);

  console.log(`✔ Context saved to ss-context/`);
  console.log(`  screenshot.png — open in your IDE to see the page visually`);
  console.log(`  page.md        — reference this file when prompting your AI\n`);
}
