/**
 * pw-fetcher.mjs — Playwright-backed page fetcher with Cloudflare bypass
 *
 * Launches a stealth Playwright browser that can pass Cloudflare's bot
 * detection. Used by the proxy when http-proxy-middleware is blocked.
 *
 * Anti-detection measures (via playwright-extra + stealth plugin):
 *   - Uses real Chrome binary (channel: 'chrome') instead of bundled Chromium
 *   - Patches ~15 detection vectors: navigator.webdriver, chrome.runtime,
 *     navigator.plugins, WebGL, iframe contentWindow, etc.
 *   - Disables AutomationControlled blink feature
 *
 * If headless Chrome can't clear a CF challenge (e.g. Turnstile CAPTCHA),
 * a small headed window opens for the user to solve it once. The cookies
 * are then transferred to the headless browser for all future requests.
 */

import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

chromium.use(StealthPlugin());

const CF_PATTERN =
  /checking your browser|just a moment|security verification|please wait|one moment|verify you are human|challenge-platform/i;

const LAUNCH_ARGS = [
  "--disable-blink-features=AutomationControlled",
  "--disable-features=AutomationControlled",
];

const REALISTIC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export class PwFetcher {
  constructor() {
    this._browser = null;
    this._context = null;
    this._page = null;
    this._cookies = [];
  }

  /**
   * Initialize the fetcher. Launches Chrome with anti-detection and
   * navigates to the target URL to prime cookies / clear any CF challenge.
   *
   * @param {string} url - The target site URL
   */
  async init(url) {
    // Try headless first with real Chrome
    let useChrome = true;
    try {
      this._browser = await chromium.launch({
        channel: "chrome",
        headless: true,
        args: LAUNCH_ARGS,
      });
    } catch {
      // Chrome not installed — fall back to bundled Chromium
      useChrome = false;
      this._browser = await chromium.launch({
        headless: true,
        args: LAUNCH_ARGS,
      });
      console.log(
        "  ⚠ Chrome not found — using Chromium (CF may require manual verification)",
      );
    }

    this._context = await this._browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent: REALISTIC_UA,
    });
    this._page = await this._context.newPage();

    // Navigate and wait for CF challenge to clear
    await this._page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    const cleared = await this._waitForChallengeToClear(8000);

    if (!cleared) {
      // Headless couldn't clear CF — open a headed window for user to solve
      console.log(
        "  CF requires human verification — opening a browser window...",
      );
      await this._browser.close();

      const headedBrowser = await chromium.launch({
        channel: useChrome ? "chrome" : undefined,
        headless: false,
        args: LAUNCH_ARGS,
      });
      const headedContext = await headedBrowser.newContext({
        viewport: { width: 800, height: 600 },
        userAgent: REALISTIC_UA,
      });
      const headedPage = await headedContext.newPage();
      await headedPage.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });

      console.log("  Solve the check in the popup, then it will close automatically.");

      // Wait up to 120s for the user to solve the challenge
      for (let i = 0; i < 240; i++) {
        await new Promise((r) => setTimeout(r, 500));
        try {
          const text = await headedPage.evaluate(() => document.body.innerText);
          if (!CF_PATTERN.test(text)) break;
        } catch {
          break; // page closed or navigated
        }
      }

      // Grab cookies from the headed session
      this._cookies = await headedContext.cookies();
      await headedBrowser.close();

      // Relaunch headless with the clearance cookies
      try {
        this._browser = await chromium.launch({
          channel: useChrome ? "chrome" : undefined,
          headless: true,
          args: LAUNCH_ARGS,
        });
      } catch {
        this._browser = await chromium.launch({
          headless: true,
          args: LAUNCH_ARGS,
        });
      }
      this._context = await this._browser.newContext({
        viewport: { width: 1440, height: 900 },
        userAgent: REALISTIC_UA,
      });
      await this._context.addCookies(this._cookies);
      this._page = await this._context.newPage();

      // Verify the cookies work
      await this._page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      const ok = await this._waitForChallengeToClear(5000);
      if (ok) {
        console.log("  ✔ Verification passed — proxy is ready");
      } else {
        console.warn(
          "  ⚠ CF challenge may not have cleared — proxy may not work",
        );
      }
    } else {
      console.log("  ✔ Cloudflare bypassed automatically");
    }
  }

  /**
   * Fetch a page by navigating the Playwright browser.
   * Returns the full rendered HTML. If CF challenges the page,
   * waits for it to clear before returning.
   *
   * @param {string} url - Full URL to fetch
   * @returns {Promise<string>} The page HTML content
   */
  async fetchPage(url) {
    await this._page.goto(url, { waitUntil: "load", timeout: 30000 });

    // Check if this specific page triggered a CF challenge
    try {
      const text = await this._page.evaluate(() => document.body.innerText);
      if (CF_PATTERN.test(text)) {
        console.warn(`  ⚠ CF challenge on ${url} — waiting for it to clear...`);
        await this._waitForChallengeToClear(10000);
      }
    } catch {
      // page navigated — that's fine
    }

    return await this._page.content();
  }

  /**
   * Get cookies from the current browser context.
   * Useful for sharing CF clearance with other Playwright instances (e.g. capture).
   */
  async getCookies() {
    if (this._cookies.length) return this._cookies;
    try {
      return await this._context.cookies();
    } catch {
      return [];
    }
  }

  /**
   * Close the browser.
   */
  async close() {
    try {
      await this._browser?.close();
    } catch {}
  }

  /**
   * Poll the current page for CF challenge text to disappear.
   * @param {number} maxMs - Maximum wait time in milliseconds
   * @returns {Promise<boolean>} true if the challenge cleared
   */
  async _waitForChallengeToClear(maxMs) {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      try {
        const text = await this._page.evaluate(() => document.body.innerText);
        if (!CF_PATTERN.test(text)) return true;
      } catch {
        return true; // page navigated away from challenge
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }
}
