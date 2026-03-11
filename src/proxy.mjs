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

import express from 'express';
import { createProxyMiddleware, responseInterceptor } from 'http-proxy-middleware';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// DIST_DIR lives in the user's current project, not the tool install
const DIST_DIR = join(process.cwd(), 'dist');

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
</script>`;

/**
 * Start the proxy server.
 *
 * @param {string} targetUrl - The live site to mirror (e.g. "https://client.com")
 * @param {number} port      - Local port to run on (default 3000)
 * @returns {Promise<void>}  - Resolves once the server is up and listening
 */
export function startProxy(targetUrl, port = 3000) {
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
  app.get('/__ss__/bundle.js', (req, res) => {
    const bundlePath = join(DIST_DIR, 'bundle.js');
    if (existsSync(bundlePath)) {
      res.setHeader('Content-Type', 'application/javascript');
      res.setHeader('Cache-Control', 'no-store'); // always fetch fresh — no caching
      res.send(readFileSync(bundlePath));
    } else {
      // Return a comment so DevTools shows something useful instead of a 404
      res.setHeader('Content-Type', 'application/javascript');
      res.status(200).send('// [ss] bundle not built yet — save a file to trigger a build');
    }
  });

  /**
   * ROUTE 2: Serve the livereload signal file
   *
   * The builder writes a timestamp here after every successful rebuild.
   * The injected browser script polls this endpoint and refreshes when it changes.
   */
  app.get('/__ss__/.reload', (req, res) => {
    const reloadPath = join(DIST_DIR, '.reload');
    res.setHeader('Content-Type', 'text/plain');
    res.send(existsSync(reloadPath) ? readFileSync(reloadPath, 'utf8') : '0');
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
         * proxyRes fires when the live site sends a response back.
         * responseInterceptor() buffers the full response body, then calls our
         * function so we can inspect and modify it before sending to the browser.
         */
        proxyRes: responseInterceptor(async (responseBuffer, proxyRes, req, res) => {
          /**
           * Strip security headers that would block our injected scripts.
           *
           * Content-Security-Policy (CSP) is a header sites use to whitelist
           * which scripts are allowed to run. Since our injected script and
           * bundle are served from /__ss__/ on the same proxy, they'd normally
           * pass CSP — but some sites use very strict policies, so we strip it
           * to be safe during development.
           */
          res.removeHeader('content-security-policy');
          res.removeHeader('content-security-policy-report-only');
          // X-Frame-Options blocks the page from being embedded in iframes
          res.removeHeader('x-frame-options');

          // Only modify HTML responses — leave JS, CSS, images, fonts, etc. alone
          const contentType = proxyRes.headers['content-type'] || '';
          if (contentType.includes('text/html')) {
            let html = responseBuffer.toString('utf8');

            // Inject our snippet just before the closing </body> tag
            // The /i flag makes the regex case-insensitive (handles </BODY> too)
            if (html.includes('</body>') || html.match(/<\/body>/i)) {
              html = html.replace(/<\/body>/i, INJECT_SNIPPET + '\n</body>');
            } else {
              // Some pages don't have </body> — append to end as a fallback
              html += INJECT_SNIPPET;
            }
            return html;
          }

          // For non-HTML responses, return the buffer unchanged
          return responseBuffer;
        }),
      },
    })
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
