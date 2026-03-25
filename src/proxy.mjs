/**
 * proxy.mjs — The Express proxy server
 *
 * EXPRESS CRASH COURSE:
 * Express is a Node.js library for building HTTP servers.
 * The core idea: you create an "app", attach rules to it ("when a request comes
 * in matching this pattern, run this function"), then start listening on a port.
 *
 * Key concepts used here:
 *   app.use(fn)        — "middleware": run fn for EVERY request
 *   app.get('/path', fn) — run fn only for GET requests to /path
 *   app.listen(port)   — start the server on this port
 *   req                — the incoming request (url, headers, body, etc.)
 *   res                — the outgoing response (what we send back)
 */

import express from "express";
import {
  createProxyMiddleware,
  responseInterceptor,
} from "http-proxy-middleware";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  statSync,
} from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const CONFIG_FILE = join(process.cwd(), ".ss-config.json");

function loadConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveConfig(data) {
  writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2));
}

/**
 * Read the active variation's index.html and return its content if it has
 * real HTML (not just the placeholder comment). Re-reads config each call
 * so switching variations takes effect on the next page load.
 */
function loadVariationHtml() {
  const config = loadConfig();
  const { activeTest, activeVariation = "v1" } = config;
  if (!activeTest) return "";
  const htmlPath = join(
    process.cwd(),
    "tests",
    activeTest,
    activeVariation,
    "index.html",
  );
  if (!existsSync(htmlPath)) return "";
  const raw = readFileSync(htmlPath, "utf8");
  // Only inject if there's real content beyond HTML comments
  const stripped = raw.replace(/<!--[\s\S]*?-->/g, "").trim();
  return stripped ? raw.trim() : "";
}

/**
 * List all v# folders for the active test.
 */
function listVariations() {
  const config = loadConfig();
  if (!config.activeTest) return { active: "v1", all: [] };
  const testDir = join(process.cwd(), "tests", config.activeTest);
  if (!existsSync(testDir))
    return { active: config.activeVariation || "v1", all: [] };
  const all = readdirSync(testDir)
    .filter((n) => /^v\d+$/.test(n) && statSync(join(testDir, n)).isDirectory())
    .sort((a, b) => parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10));
  return { active: config.activeVariation || "v1", all };
}

// DIST_DIR lives in the user's current project, not the tool install
const DIST_DIR = join(process.cwd(), "dist");

/**
 * This HTML snippet is injected into every page on the proxied site.
 *
 * It does two things:
 * 1. Loads bundle.js — your compiled A/B test code
 * 2. Polls /__ss__/.reload every second — when the file changes (after a
 *    rebuild), it refreshes the page automatically (livereload)
 */
const INJECT_SNIPPET = `
<script src="/__ss__/bundle.js"></script>
<script>
  // Livereload: poll for changes and refresh when a new build is ready
  let _ssLastBuild = null;
  setInterval(async () => {
    try {
      const r = await fetch('/__ss__/.reload?t=' + Date.now());
      const ts = await r.text();
      if (_ssLastBuild !== null && ts !== _ssLastBuild) location.reload();
      _ssLastBuild = ts;
    } catch (_) {}
  }, 1000);

  // Variation switcher widget
  (async () => {
    const data = await fetch('/__ss__/variations').then(r => r.json());
    if (data.all.length < 2) return; // no switcher needed for a single variation

    const bar = document.createElement('div');
    bar.id = '__ss_switcher';
    bar.innerHTML = \`
      <style>
        #__ss_switcher {
          position: fixed; top: 50%; left: 4px; z-index: 2147483647;
          font: 13px/1.4 -apple-system, system-ui, sans-serif;
          background: #1a1a2e; color: #eee; border-radius: 8px;
          padding: 6px 10px; display: flex; align-items: center; gap: 8px;
          box-shadow: 0 2px 12px rgba(0,0,0,.35); user-select: none;
        }
        #__ss_switcher select {
          background: #2d2d44; color: #fff; border: 1px solid #444;
          border-radius: 4px; padding: 2px 6px; font: inherit; cursor: pointer;
        }
        #__ss_switcher .label { opacity: 0.6; font-size: 11px; }
      </style>
      <span class="label">ss</span>
      <select>\${data.all.map(v =>
        '<option value="' + v + '"' + (v === data.active ? ' selected' : '') + '>' + v + '</option>'
      ).join('')}</select>
    \`;
    document.body.appendChild(bar);

    bar.querySelector('select').addEventListener('change', async (e) => {
      const v = e.target.value;
      await fetch('/__ss__/switch?v=' + v);
      // livereload will handle the refresh after esbuild rebuilds
    });
  })();
</script>`;

/**
 * Inject our script snippet into an HTML string.
 * Processes HTML in segments, skipping <script> blocks to avoid breaking
 * inline JS that contains URL strings or </body> literals.
 */
function injectIntoHtml(html, targetOrigin, localOrigin) {
  const escapedOrigin = targetOrigin.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );
  const originRe = new RegExp(`(=["'])${escapedOrigin}`, "gi");
  const scriptRe = /(<script[\s\S]*?<\/script>)/gi;

  const variationHtml = loadVariationHtml();
  const fullSnippet =
    (variationHtml ? variationHtml + "\n" : "") + INJECT_SNIPPET;

  let injected = false;
  html = html
    .split(scriptRe)
    .map((part, i) => {
      if (i % 2 !== 0) return part;
      let out = part.replace(originRe, `$1${localOrigin}`);
      if (!injected && /<\/body>/i.test(out)) {
        out = out.replace(/<\/body>/i, fullSnippet + "\n</body>");
        injected = true;
      }
      return out;
    })
    .join("");

  if (!injected) html += fullSnippet;
  return html;
}

/**
 * Start the proxy server.
 *
 * @param {string} targetUrl    - The live site to mirror (e.g. "https://client.com")
 * @param {number} port         - Local port to run on (default 3000)
 * @param {object|null} browser - A Playwright browser context for Cloudflare-protected sites.
 *                                When provided, HTML pages are fetched through the browser's
 *                                network stack (real TLS fingerprint) instead of Node's http.
 * @returns {Promise<void>}     - Resolves once the server is up and listening
 */
export async function startProxy(targetUrl, port = 3000, browser = null) {
  const app = express();

  const targetOrigin = new URL(targetUrl).origin;
  const localOrigin = `http://localhost:${port}`;

  // If we have a Playwright browser context, create a persistent "fetcher" page.
  // All proxy requests will be routed through this page's fetch() so they use
  // the browser's TLS fingerprint and cookies — passing Cloudflare.
  let fetcherPage = null;
  if (browser) {
    fetcherPage = await browser.newPage();
    // Navigate once to set the page's origin (needed for same-origin fetch)
    await fetcherPage.goto(targetUrl, { waitUntil: "load", timeout: 30000 });
    console.log("  ✔ Browser-based proxy active (Cloudflare bypass)");
  }

  /**
   * ROUTE 1: Serve the compiled bundle
   */
  app.get("/__ss__/bundle.js", (req, res) => {
    const bundlePath = join(DIST_DIR, "bundle.js");
    if (existsSync(bundlePath)) {
      res.setHeader("Content-Type", "application/javascript");
      res.setHeader("Cache-Control", "no-store");
      res.send(readFileSync(bundlePath));
    } else {
      res.setHeader("Content-Type", "application/javascript");
      res
        .status(200)
        .send("// [ss] bundle not built yet — save a file to trigger a build");
    }
  });

  /**
   * ROUTE 2: Serve the livereload signal file
   */
  app.get("/__ss__/.reload", (req, res) => {
    const reloadPath = join(DIST_DIR, ".reload");
    res.setHeader("Content-Type", "text/plain");
    res.send(existsSync(reloadPath) ? readFileSync(reloadPath, "utf8") : "0");
  });

  /**
   * ROUTE 3: List available variations (JSON)
   */
  app.get("/__ss__/variations", (req, res) => {
    res.json(listVariations());
  });

  /**
   * ROUTE 4: Switch active variation
   */
  app.get("/__ss__/switch", async (req, res) => {
    const v = req.query.v;
    if (!v) return res.status(400).json({ error: "Missing ?v= parameter" });

    const config = loadConfig();
    if (!config.activeTest)
      return res.status(400).json({ error: "No active test" });

    const testDir = join(process.cwd(), "tests", config.activeTest);
    const variationDir = join(testDir, v);
    if (!existsSync(variationDir))
      return res.status(404).json({ error: `${v} not found` });

    const { writeCacheEntry } = await import("./scaffold.mjs");
    writeCacheEntry(config.activeTest, v);
    saveConfig({ ...config, activeVariation: v });

    console.log(`  ↻ Switched to ${v}`);
    res.json({ ok: true, active: v });
  });

  /**
   * MIDDLEWARE: Browser-based proxy (for Cloudflare-protected sites)
   *
   * When a Playwright browser context is available, we fetch pages through
   * the browser's own fetch() API inside page.evaluate(). This uses the
   * browser's real TLS fingerprint and cookies, which Cloudflare accepts.
   *
   * Falls through to http-proxy-middleware if no browser context is set.
   */
  if (fetcherPage) {
    app.use(async (req, res) => {
      const fullUrl = targetOrigin + req.url;
      console.log(`  [browser] ${req.method} ${req.url}`);
      try {
        const result = await fetcherPage.evaluate(
          async ({ url, method }) => {
            const resp = await fetch(url, {
              method,
              credentials: "same-origin",
              redirect: "follow",
            });
            const headers = {};
            resp.headers.forEach((v, k) => { headers[k] = v; });
            const buf = await resp.arrayBuffer();
            const bytes = new Uint8Array(buf);
            let binary = "";
            for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
            return { status: resp.status, headers, bodyBase64: btoa(binary) };
          },
          { url: fullUrl, method: req.method },
        );

        const body = Buffer.from(result.bodyBase64, "base64");
        const contentType = result.headers["content-type"] || "";

        // Forward response headers, skipping ones we need to control
        const skipHeaders = new Set([
          "content-encoding", "transfer-encoding", "content-length",
          "content-security-policy", "content-security-policy-report-only",
          "strict-transport-security", "x-frame-options",
        ]);
        for (const [k, v] of Object.entries(result.headers)) {
          if (!skipHeaders.has(k)) res.setHeader(k, v);
        }
        // Fix CORS
        if (result.headers["access-control-allow-origin"]) {
          res.setHeader("access-control-allow-origin", "*");
        }

        if (contentType.includes("text/html")) {
          let html = body.toString("utf8");
          html = injectIntoHtml(html, targetOrigin, localOrigin);
          res.setHeader("Content-Type", contentType);
          res.status(result.status).send(html);
        } else if (contentType.includes("text/css")) {
          const css = body.toString("utf8").split(targetOrigin).join(localOrigin);
          res.setHeader("Content-Type", contentType);
          res.status(result.status).send(css);
        } else {
          res.status(result.status).send(body);
        }
      } catch (err) {
        console.error(`  ✖ Browser fetch failed: ${err.message}`);
        res.status(502).send(`Proxy error: ${err.message}`);
      }
    });
  } else {
    /**
     * MIDDLEWARE: Standard http-proxy-middleware (for sites without bot protection)
     */
    app.use(
      createProxyMiddleware({
        target: targetUrl,
        changeOrigin: true,
        selfHandleResponse: true,
        on: {
          proxyRes: responseInterceptor(
            async (responseBuffer, proxyRes, req, res) => {
              const status = proxyRes.statusCode;
              const loc = proxyRes.headers["location"];
              if (loc) {
                console.log(`  [${status}] ${req.url} → ${loc}`);
              } else {
                console.log(`  [${status}] ${req.url}`);
              }

              const location = proxyRes.headers["location"];
              if (location) {
                if (location.startsWith("/")) {
                  proxyRes.headers["location"] =
                    `http://localhost:${port}${location}`;
                } else {
                  try {
                    const u = new URL(location);
                    u.protocol = "http:";
                    u.host = `localhost:${port}`;
                    proxyRes.headers["location"] = u.toString();
                  } catch (_) {}
                }
              }

              delete proxyRes.headers["content-security-policy"];
              delete proxyRes.headers["content-security-policy-report-only"];
              delete proxyRes.headers["strict-transport-security"];
              delete proxyRes.headers["x-frame-options"];

              if (proxyRes.headers["access-control-allow-origin"]) {
                proxyRes.headers["access-control-allow-origin"] = "*";
              }

              const contentType = proxyRes.headers["content-type"] || "";

              if (contentType.includes("text/css")) {
                const css = responseBuffer.toString("utf8");
                return css.split(targetOrigin).join(localOrigin);
              }

              if (contentType.includes("text/html")) {
                let html = responseBuffer.toString("utf8");
                return injectIntoHtml(html, targetOrigin, localOrigin);
              }

              return responseBuffer;
            },
          ),
        },
      }),
    );
  }

  return new Promise((resolve) => {
    app.listen(port, () => {
      console.log(`\n✔ Proxy running → http://localhost:${port}`);
      console.log(`  Mirroring: ${targetUrl}\n`);
      resolve();
    });
  });
}
