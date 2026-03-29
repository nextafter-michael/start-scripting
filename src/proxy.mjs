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
import { WebSocketServer } from "ws";
import {
  createProxyMiddleware,
  responseInterceptor,
} from "http-proxy-middleware";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from "fs";
import { join, dirname, extname } from "path";

const CONFIG_FILE = join(process.cwd(), "config.json");

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
 * Concatenate HTML from all modification blocks for the active variation,
 * in config.json order. Re-reads config each call so switching variations
 * takes effect on the next page load.
 */
function loadVariationHtml() {
  const config = loadConfig();
  const expSlug = config.active?.experience;
  const varSlug = config.active?.variation;
  if (!expSlug || !varSlug) return "";

  const exp = config.experiences?.find((e) => e.slug === expSlug);
  const variation = exp?.variations?.find((v) => v.slug === varSlug);
  if (!variation?.modifications?.length) return "";

  const parts = [];
  for (const mod of variation.modifications) {
    if (!mod?.slug) continue; // guard against malformed config entries
    const htmlPath = join(
      process.cwd(),
      "experiences",
      expSlug,
      varSlug,
      mod.slug,
      "modification.html",
    );
    if (!existsSync(htmlPath)) continue;
    const raw = readFileSync(htmlPath, "utf8");
    const stripped = raw.replace(/<!--[\s\S]*?-->/g, "").trim();
    if (stripped) parts.push(raw.trim());
  }
  return parts.join("\n");
}

/**
 * List all variations for the active experience, read from config.json.
 * Returns { active: slug, all: [{ name, slug }, ...] }
 */
function listVariations() {
  const config = loadConfig();
  const expSlug = config.active?.experience;
  if (!expSlug) return { active: null, all: [] };

  const exp = config.experiences?.find((e) => e.slug === expSlug);
  if (!exp) return { active: config.active?.variation, all: [] };

  const all = (exp.variations || []).map((v) => ({ name: v.name, slug: v.slug }));
  return { active: config.active?.variation, all };
}

// DIST_DIR lives in the user's current project, not the tool install
const DIST_DIR = join(process.cwd(), "dist");

/**
 * Build a <script> block that sets window.__ss with the current session state.
 * Called per-request so it always reflects the active experience/variation.
 */
function buildWindowSsBlock() {
  const config = loadConfig();
  const expSlug = config.active?.experience;
  const varSlug = config.active?.variation;
  const exp = config.experiences?.find((e) => e.slug === expSlug);
  const variation = exp?.variations?.find((v) => v.slug === varSlug);

  const data = {
    experience: exp ? { name: exp.name, slug: exp.slug } : null,
    variation:  variation ? { name: variation.name, slug: variation.slug } : null,
    modifications: (variation?.modifications || [])
      .filter((m) => m?.slug)
      .map((m) => ({ name: m.name, slug: m.slug, trigger: m.trigger })),
  };

  // JSON carries the data; the non-serialisable parts (_applyHtml etc.) are
  // appended as plain JS so they're available before the HTML-init script runs.
  return `<script type="text/javascript" data-ss-added="config">
window.__ss = ${JSON.stringify(data)};
window.__ss._nodes = [];
window.__ss._ts    = null;

// Apply (or re-apply) variation HTML nodes directly onto document.body.
// Removes any nodes from a previous call, parses the new HTML string into a
// DocumentFragment, stamps each top-level element with data-ss-added="<ts>",
// appends them to body, and stores live references in window.__ss._nodes.
window.__ss._applyHtml = function(html) {
  (window.__ss._nodes || []).forEach(function(n) { if (n.parentNode) n.parentNode.removeChild(n); });
  window.__ss._nodes = [];
  if (!html) return;
  var tpl = document.createElement('template');
  tpl.innerHTML = html;
  var ts = String(Date.now());
  window.__ss._nodes = Array.from(tpl.content.children).map(function(el) {
    el.setAttribute('data-ss-added', ts);
    document.body.appendChild(el);
    return el;
  });
  window.__ss._ts = ts;
};
</script>`;
}

// ─── Local resource cache ─────────────────────────────────────────────────────

const CACHE_DIR = join(process.cwd(), ".cache");

// Extension → Content-Type for serving cached files without a live response
const CACHE_CONTENT_TYPES = {
  ".css":  "text/css",
  ".js":   "application/javascript",
  ".mjs":  "application/javascript",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif":  "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
  ".woff": "font/woff",
  ".woff2":"font/woff2",
  ".ttf":  "font/ttf",
  ".otf":  "font/otf",
  ".eot":  "application/vnd.ms-fontobject",
};

/**
 * Map a URL path to a cache file path.
 * Strips query strings and sanitises against path traversal.
 * Returns null if the path is unsafe or has no cacheable extension.
 */
function getCachePath(urlPath) {
  const clean = urlPath.split("?")[0].split("#")[0];
  if (!CACHE_CONTENT_TYPES[extname(clean).toLowerCase()]) return null;
  // Strip leading slashes and collapse any .. segments to prevent traversal
  const rel = clean.replace(/^[/\\]+/, "").replace(/\.\./g, "_");
  if (!rel) return null;
  return join(CACHE_DIR, rel);
}

/**
 * Returns true for content types worth caching (non-HTML static assets).
 */
function isCacheable(contentType) {
  return (
    contentType.startsWith("text/css") ||
    contentType.includes("javascript") ||
    contentType.startsWith("image/") ||
    contentType.startsWith("font/") ||
    contentType.startsWith("application/font")
  );
}

/**
 * Write a response buffer to the cache, silently skipping on any error.
 * Only writes on a cache miss so we never overwrite a previously cached file.
 */
function writeToCache(urlPath, buffer) {
  const cachePath = getCachePath(urlPath);
  if (!cachePath || existsSync(cachePath)) return;
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, buffer);
  } catch (_) {}
}

/**
 * Build the HTML snippet injected into every proxied page.
 *
 * Uses absolute URLs for /__ss__/* endpoints so that <base href> (used in
 * Cloudflare bypass mode) doesn't redirect them to the live domain.
 *
 * @param {string} ssOrigin - The proxy origin, e.g. "http://localhost:3000"
 */
function buildInjectSnippet(ssOrigin) {
  const wsUrl = ssOrigin.replace(/^http/, 'ws') + '/__ss__/ws';
  return `
<script type="text/javascript" src="${ssOrigin}/__ss__/bundle.js" data-ss-added="bundle"></script>
<script type="text/javascript" data-ss-added="runtime">
  // ── WebSocket live-reload ──────────────────────────────────────────────────
  (function connectSs() {
    const ws = new WebSocket('${wsUrl}');
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'reload') {
        location.reload();
      } else if (msg.type === 'css-update') {
        const el = document.getElementById('__ss_styles');
        if (el) el.textContent = msg.css;
        else location.reload();
      } else if (msg.type === 'html-update') {
        window.__ss._applyHtml(msg.html);
      }
    };
    ws.onclose = () => setTimeout(connectSs, 1000);
  })();

  // ── <ss-floating-menu> web component ──────────────────────────────────────
  // Closed shadow root keeps all internal styles isolated from the host page.
  class SsFloatingMenu extends HTMLElement {
    constructor() {
      super();
      this._root = this.attachShadow({ mode: 'closed' });
    }
    async connectedCallback() {
      const data = await fetch('${ssOrigin}/__ss__/variations').then(r => r.json());
      if (!data.all || data.all.length < 2) return; // nothing to switch between

      this._root.innerHTML = \`
        <style>
          :host {
            display: flex;
            align-items: center;
            gap: 8px;
            position: fixed;
            top: 50%;
            left: 4px;
            z-index: 2147483647;
            transform: translateY(-50%);
            font: 13px/1.4 -apple-system, system-ui, sans-serif;
            background: #1a1a2e;
            color: #eee;
            border-radius: 8px;
            padding: 6px 10px;
            box-shadow: 0 2px 12px rgba(0,0,0,.4);
            user-select: none;
          }
          .label {
            opacity: 0.5;
            font-size: 11px;
            font-weight: 600;
            letter-spacing: .04em;
            text-transform: uppercase;
          }
          select {
            background: #2d2d44;
            color: #fff;
            border: 1px solid #444;
            border-radius: 4px;
            padding: 2px 6px;
            font: inherit;
            cursor: pointer;
          }
          select:focus { outline: none; border-color: #7c7cff; }
        </style>
        <span class="label">ss</span>
        <select>\${
          data.all.map(v =>
            '<option value="' + v.slug + '"' +
            (v.slug === data.active ? ' selected' : '') +
            '>' + v.name + '</option>'
          ).join('')
        }</select>
      \`;

      this._root.querySelector('select').addEventListener('change', async (e) => {
        const slug = e.target.value;
        await fetch('${ssOrigin}/__ss__/switch?v=' + slug);
        // The server broadcasts a reload after switching; the WS handler above
        // will call location.reload() — no need to reload here too.
      });
    }
  }

  if (!customElements.get('ss-floating-menu')) {
    customElements.define('ss-floating-menu', SsFloatingMenu);
  }
  document.body.appendChild(document.createElement('ss-floating-menu'));
</script>`;
}

/**
 * Inject our script snippet into an HTML string.
 * Processes HTML in segments, skipping <script> blocks to avoid breaking
 * inline JS that contains URL strings or </body> literals.
 */
function injectIntoHtml(html, targetOrigin, localOrigin, INJECT_SNIPPET) {
  const escapedOrigin = targetOrigin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const originRe = new RegExp(`(=["'])${escapedOrigin}`, "gi");
  const scriptRe = /(<script[\s\S]*?<\/script>)/gi;

  const variationHtml = loadVariationHtml();
  // Build a per-request init script that calls _applyHtml (defined in the
  // window.__ss block above) with the server-rendered variation HTML string.
  // This runs immediately since we're just before </body> and the DOM is live.
  const htmlInitScript = variationHtml
    ? `<script type="text/javascript" data-ss-added="html-init">window.__ss._applyHtml(${JSON.stringify(variationHtml)});</script>`
    : '';

  const fullSnippet = buildWindowSsBlock() + "\n"
    + (htmlInitScript ? htmlInitScript + "\n" : "")
    + INJECT_SNIPPET;

  let injected = false;
  html = html
    .split(scriptRe)
    .map((part, i) => {
      if (i % 2 !== 0) return part; // skip script blocks
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
 * @param {string} targetUrl - The live site to mirror (e.g. "https://client.com")
 * @param {number} port      - Local port to run on (default 3000)
 * @param {object} [options]
 * @param {object} [options.pwFetcher] - PwFetcher instance for Cloudflare bypass
 * @returns {Promise<Function>} - Resolves with the broadcast() function
 */
export async function startProxy(targetUrl, port = 3000, { pwFetcher = null } = {}) {
  const app = express();

  const targetOrigin = new URL(targetUrl).origin;
  const localOrigin  = `http://localhost:${port}`;
  const INJECT_SNIPPET = buildInjectSnippet(localOrigin);

  // Placeholder replaced once the WebSocket server is ready (after app.listen).
  // Defined here so all route handlers below can close over it.
  let broadcast = (_msg) => {};

  // Allow cross-origin requests to /__ss__/* endpoints
  app.use("/__ss__", (req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Private-Network", "true");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  // ── ROUTE 1: Compiled bundle ─────────────────────────────────────────────
  app.get("/__ss__/bundle.js", (_req, res) => {
    const bundlePath = join(DIST_DIR, "bundle.js");
    res.setHeader("Content-Type", "application/javascript");
    res.setHeader("Cache-Control", "no-store");
    if (existsSync(bundlePath)) {
      res.send(readFileSync(bundlePath));
    } else {
      res.status(200).send("// [ss] bundle not built yet — save a file to trigger a build");
    }
  });

  // ── ROUTE 2: Variation list ──────────────────────────────────────────────
  app.get("/__ss__/variations", (_req, res) => {
    res.json(listVariations());
  });

  // ── ROUTE 3: Session state (mirrors window.__ss) ─────────────────────────
  app.get("/__ss__/config", (_req, res) => {
    const config = loadConfig();
    const expSlug = config.active?.experience;
    const varSlug = config.active?.variation;
    const exp = config.experiences?.find((e) => e.slug === expSlug);
    const variation = exp?.variations?.find((v) => v.slug === varSlug);
    res.json({
      experience:    exp       ? { name: exp.name,       slug: exp.slug       } : null,
      variation:     variation ? { name: variation.name, slug: variation.slug } : null,
      modifications: (variation?.modifications || [])
        .filter((m) => m?.slug)
        .map((m) => ({ name: m.name, slug: m.slug, trigger: m.trigger })),
    });
  });

  // ── ROUTE 4: Switch active variation ─────────────────────────────────────
  app.get("/__ss__/switch", async (req, res) => {
    const varSlug = req.query.v;
    if (!varSlug) return res.status(400).json({ error: "Missing ?v= parameter" });

    const config = loadConfig();
    const expSlug = config.active?.experience;
    if (!expSlug) return res.status(400).json({ error: "No active experience" });

    const exp = config.experiences?.find((e) => e.slug === expSlug);
    const variation = exp?.variations?.find((v) => v.slug === varSlug);
    if (!variation) return res.status(404).json({ error: `${varSlug} not found in config` });

    // Control is JSON-only (no directory); all other variations must have a dir
    if (varSlug !== "control") {
      const varDir = join(process.cwd(), "experiences", expSlug, varSlug);
      if (!existsSync(varDir))
        return res.status(404).json({ error: `${varSlug} directory not found` });
    }

    const { writeCacheEntry } = await import("./scaffold.mjs");
    writeCacheEntry(expSlug, varSlug);

    if (!config.active) config.active = {};
    config.active.variation = varSlug;
    saveConfig(config);

    // Always broadcast a reload — the builder's file watcher only fires when a
    // source file changes, so switching (especially to/from Control) requires an
    // explicit push here.
    broadcast({ type: "reload" });

    console.log(`  ↻ Switched to ${varSlug}`);
    res.json({ ok: true, active: varSlug });
  });

  // ── MIDDLEWARE: Local resource cache ─────────────────────────────────────
  app.use((req, res, next) => {
    if (req.method !== "GET") return next();
    const cachePath = getCachePath(req.path);
    if (!cachePath || !existsSync(cachePath)) return next();

    const ext = extname(req.path).toLowerCase();
    const contentType = CACHE_CONTENT_TYPES[ext];
    res.setHeader("Cache-Control", "public, max-age=3600");

    if (ext === ".css") {
      const css = readFileSync(cachePath, "utf8").split(targetOrigin).join(localOrigin);
      res.setHeader("Content-Type", "text/css");
      return res.send(css);
    }

    res.setHeader("Content-Type", contentType);
    res.send(readFileSync(cachePath));
  });

  if (pwFetcher) {
    // ── MIDDLEWARE: Playwright-backed proxy (Cloudflare bypass) ─────────────
    app.use(async (req, res) => {
      const accept  = req.headers["accept"] || "";
      const fullUrl = targetOrigin + req.originalUrl;

      if (accept.includes("text/html")) {
        try {
          console.log(`  [PW] ${req.method} ${req.url}`);
          let html = await pwFetcher.fetchPage(fullUrl);
          const baseTag = `<base href="${targetOrigin}/">`;
          html = /<head[^>]*>/i.test(html)
            ? html.replace(/(<head[^>]*>)/i, `$1\n${baseTag}`)
            : baseTag + "\n" + html;
          html = injectIntoHtml(html, targetOrigin, localOrigin, INJECT_SNIPPET);
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.setHeader("Cache-Control", "no-store");
          res.send(html);
        } catch (err) {
          console.error(`  [PW] Error fetching ${req.url}:`, err.message);
          res.status(502).send("Proxy error: " + err.message);
        }
      } else {
        res.redirect(302, fullUrl);
      }
    });
  } else {
    // ── MIDDLEWARE: Standard http-proxy-middleware ─────────────────────────
    app.use(
      createProxyMiddleware({
        target: targetUrl,
        changeOrigin: true,
        selfHandleResponse: true,
        on: {
          proxyRes: responseInterceptor(
            async (responseBuffer, proxyRes, req) => {
              const status = proxyRes.statusCode;
              const loc    = proxyRes.headers["location"];
              console.log(loc ? `  [${status}] ${req.url} → ${loc}` : `  [${status}] ${req.url}`);

              if (loc) {
                if (loc.startsWith("/")) {
                  proxyRes.headers["location"] = `http://localhost:${port}${loc}`;
                } else {
                  try {
                    const u = new URL(loc);
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
                writeToCache(req.path, responseBuffer);
                return responseBuffer.toString("utf8").split(targetOrigin).join(localOrigin);
              }

              if (contentType.includes("text/html")) {
                return injectIntoHtml(
                  responseBuffer.toString("utf8"),
                  targetOrigin,
                  localOrigin,
                  INJECT_SNIPPET,
                );
              }

              if (isCacheable(contentType)) writeToCache(req.path, responseBuffer);
              return responseBuffer;
            },
          ),
        },
      }),
    );
  }

  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      console.log(`\n✔ Proxy running → http://localhost:${port}`);
      console.log(`  Mirroring: ${targetUrl}\n`);
      resolve(broadcast);
    });

    // WebSocket server — shares the same HTTP server, handles /__ss__/ws upgrades.
    // Upgrade the broadcast placeholder once the WSS is ready.
    const wss = new WebSocketServer({ server, path: "/__ss__/ws" });

    broadcast = (msg) => {
      const data = JSON.stringify(msg);
      for (const client of wss.clients) {
        if (client.readyState === 1 /* OPEN */) {
          try { client.send(data); } catch (_) {}
        }
      }
    };
  });
}
