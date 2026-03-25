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
 * Start the proxy server.
 *
 * @param {string} targetUrl - The live site to mirror (e.g. "https://client.com")
 * @param {number} port      - Local port to run on (default 3000)
 * @param {object} [bypassHeaders] - Optional headers to forward (from Cloudflare bypass)
 * @param {string} [bypassHeaders.cookie] - Cookie string (e.g. "cf_clearance=...")
 * @param {string} [bypassHeaders.userAgent] - User-Agent that passed the challenge
 * @returns {Promise<void>}  - Resolves once the server is up and listening
 */
export function startProxy(targetUrl, port = 3000, bypassHeaders = null) {
  // Create the Express app — think of this as an empty rulebook
  const app = express();

  /**
   * ROUTE 1: Serve the compiled bundle
   *
   * app.get('/path', handler) means: when someone requests GET /path, run handler.
   * This route is for /__ss__/bundle.js — the compiled A/B test code.
   *
   * Why /__ss__/ prefix? It's an unlikely path to conflict with the live site's
   * own routes, so the proxy can intercept it before forwarding to the live site.
   */
  app.get("/__ss__/bundle.js", (req, res) => {
    const bundlePath = join(DIST_DIR, "bundle.js");
    if (existsSync(bundlePath)) {
      res.setHeader("Content-Type", "application/javascript");
      res.setHeader("Cache-Control", "no-store"); // always fetch fresh — no caching
      res.send(readFileSync(bundlePath));
    } else {
      // Return a comment so DevTools shows something useful instead of a 404
      res.setHeader("Content-Type", "application/javascript");
      res
        .status(200)
        .send("// [ss] bundle not built yet — save a file to trigger a build");
    }
  });

  /**
   * ROUTE 2: Serve the livereload signal file
   *
   * The builder writes a timestamp here after every successful rebuild.
   * The injected browser script polls this endpoint and refreshes when it changes.
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
   *
   * Updates the config and rewrites the esbuild cache entry so the next
   * rebuild (triggered by the file change) loads the new variation.
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
   * MIDDLEWARE: The proxy
   *
   * app.use(middleware) runs the middleware for every request that reaches this
   * point (requests to /__ss__/* were already handled above, so they never get here).
   *
   * createProxyMiddleware forwards requests to the live site and returns their responses.
   *
   * Key options:
   *   target          — where to forward requests
   *   changeOrigin    — rewrites the Host header to match the target domain
   *                     (required — otherwise the live site may reject the request)
   *   selfHandleResponse — we control sending the response ourselves
   *                        (needed so we can modify HTML before sending it)
   */
  app.use(
    createProxyMiddleware({
      target: targetUrl,
      changeOrigin: true,
      selfHandleResponse: true,
      on: {
        /**
         * proxyReq fires before the request is sent to the live site.
         * If we have bypass headers (from solving a Cloudflare challenge),
         * inject the cookies and user-agent so the live site accepts us.
         */
        proxyReq: (proxyReq, req, res) => {
          if (bypassHeaders) {
            if (bypassHeaders.cookie) {
              proxyReq.setHeader("Cookie", bypassHeaders.cookie);
            }
            if (bypassHeaders.userAgent) {
              proxyReq.setHeader("User-Agent", bypassHeaders.userAgent);
            }
          }
        },
        /**
         * proxyRes fires when the live site sends a response back.
         * responseInterceptor() buffers the full response body, then calls our
         * function so we can inspect and modify it before sending to the browser.
         */
        proxyRes: responseInterceptor(
          async (responseBuffer, proxyRes, req, res) => {
            const status = proxyRes.statusCode;
            const loc = proxyRes.headers["location"];
            if (loc) {
              console.log(`  [${status}] ${req.url} → ${loc}`);
            } else {
              console.log(`  [${status}] ${req.url}`);
            }
            /**
             * Rewrite redirect Location headers to stay on the proxy.
             *
             * When a site returns a 301/302 redirect, the Location header points
             * to the real domain (e.g. https://client.com/page). The browser would
             * follow that and leave localhost.
             *
             * We mutate proxyRes.headers directly because responseInterceptor calls
             * res.writeHead(statusCode, proxyRes.headers) AFTER our callback, which
             * would overwrite any res.setHeader() calls we make.
             */
            const location = proxyRes.headers["location"];
            if (location) {
              if (location.startsWith("/")) {
                // Relative redirect — prepend localhost origin
                proxyRes.headers["location"] =
                  `http://localhost:${port}${location}`;
              } else {
                try {
                  // Absolute redirect — swap whatever host/protocol is there with
                  // localhost so the browser stays on the proxy. This handles
                  // redirects to subdomains, www variants, or http↔https flips.
                  const u = new URL(location);
                  u.protocol = "http:";
                  u.host = `localhost:${port}`;
                  proxyRes.headers["location"] = u.toString();
                } catch (_) {
                  // Malformed URL — leave it alone
                }
              }
            }

            /**
             * Strip security headers that would block our injected scripts or
             * force the browser off the proxy.
             *
             * - Content-Security-Policy: whitelists which scripts can run
             * - Strict-Transport-Security (HSTS): tells the browser to always use
             *   HTTPS for this domain — if set, the browser will bypass our HTTP
             *   proxy and connect directly to the live site
             * - X-Frame-Options: blocks iframe embedding
             */
            delete proxyRes.headers["content-security-policy"];
            delete proxyRes.headers["content-security-policy-report-only"];
            delete proxyRes.headers["strict-transport-security"];
            delete proxyRes.headers["x-frame-options"];

            // Fix duplicate CORS headers (e.g. "*, *") which Chrome rejects
            if (proxyRes.headers["access-control-allow-origin"]) {
              proxyRes.headers["access-control-allow-origin"] = "*";
            }

            const contentType = proxyRes.headers["content-type"] || "";
            const targetOrigin = new URL(targetUrl).origin;
            const localOrigin = `http://localhost:${port}`;

            // Rewrite CSS responses — safe to do a full replacement since CSS
            // has no regex literals that could break from the substitution
            if (contentType.includes("text/css")) {
              const css = responseBuffer.toString("utf8");
              return css.split(targetOrigin).join(localOrigin);
            }

            if (contentType.includes("text/html")) {
              let html = responseBuffer.toString("utf8");

              // Process HTML in segments, skipping <script>...</script> blocks.
              //
              // Two operations must only touch real HTML markup, never inline JS:
              //   1. URL rewriting — the origin may appear as a string literal
              //      inside a polyfill script, and rewriting it there can break
              //      the JS and cause the rest of the script to render as text.
              //   2. </body> injection — polyfills often write a full HTML doc
              //      into an iframe (r.write('...<body></body>...')), so the
              //      first </body> in the raw text may be inside a script string,
              //      not the real closing tag.
              const escapedOrigin = targetOrigin.replace(
                /[.*+?^${}()|[\]\\]/g,
                "\\$&",
              );
              const originRe = new RegExp(`(=["'])${escapedOrigin}`, "gi");
              const scriptRe = /(<script[\s\S]*?<\/script>)/gi;

              // Load optional HTML snippet from the active variation's index.html
              const variationHtml = loadVariationHtml();
              const fullSnippet =
                (variationHtml ? variationHtml + "\n" : "") + INJECT_SNIPPET;

              let injected = false;
              html = html
                .split(scriptRe)
                .map((part, i) => {
                  if (i % 2 !== 0) return part; // inside a script block — leave untouched
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

            // For non-HTML responses, return the buffer unchanged
            return responseBuffer;
          },
        ),
      },
    }),
  );

  /**
   * app.listen(port, callback) starts the server.
   * We wrap it in a Promise so the caller can await it finishing startup.
   */
  return new Promise((resolve) => {
    app.listen(port, () => {
      console.log(`\n✔ Proxy running → http://localhost:${port}`);
      console.log(`  Mirroring: ${targetUrl}\n`);
      resolve();
    });
  });
}
