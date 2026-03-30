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
  rmSync,
  statSync,
} from "fs";
import { join, dirname, extname } from "path";

const HTML_EXTS = new Set(['.html']);

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
    if (mod.enabled === false) continue; // skip disabled blocks
    const blockDir = join(process.cwd(), "experiences", expSlug, varSlug, mod.slug);
    for (const file of (mod.resources || [])) {
      if (!HTML_EXTS.has(extname(file).toLowerCase())) continue;
      const htmlPath = join(blockDir, file);
      if (!existsSync(htmlPath)) continue;
      const raw = readFileSync(htmlPath, "utf8");
      const stripped = raw.replace(/<!--[\s\S]*?-->/g, "").trim();
      if (stripped) parts.push(raw.trim());
    }
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

  const all = (exp.variations || [])
    .filter((v) => v.enabled !== false)
    .map((v) => ({ name: v.name, slug: v.slug }));
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

  const settings = config.settings || {};
  // targetOrigin is embedded so the client-side UI can show the real site URL
  // rather than the localhost proxy URL (location.href on the proxied page is
  // http://localhost:PORT/... but the code will eventually run on targetOrigin).
  const targetOriginForClient = (() => {
    try {
      const exp2 = config.experiences?.find((e) => e.slug === expSlug);
      const editor = exp2?.pages?.editor;
      if (editor) return new URL(editor).origin;
    } catch {}
    return null;
  })();

  const data = {
    experience: exp ? { name: exp.name, slug: exp.slug } : null,
    variation:  variation ? { name: variation.name, slug: variation.slug } : null,
    modifications: (variation?.modifications || [])
      .filter((m) => m?.slug && m.enabled !== false)
      .map((m) => ({
        name: m.name, slug: m.slug, trigger: m.trigger,
        hide_elements_until_code_runs: m.hide_elements_until_code_runs || [],
      })),
    settings: {
      spa:          !!settings.spa,
      inject_jquery: !!settings.inject_jquery,
      inject_fontawesome: !!settings.inject_fontawesome,
    },
    _targetOrigin: targetOriginForClient,
  };

  // JSON carries the data; the non-serialisable parts (_applyHtml etc.) are
  // appended as plain JS so they're available before the HTML-init script runs.
  const spaEnabled     = !!settings.spa;
  const jqueryEnabled  = !!settings.inject_jquery;
  const faEnabled      = !!settings.inject_fontawesome;

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

// Remove all ss-injected nodes and style tags added by _trigger (for SPA re-apply).
window.__ss._removeAll = function() {
  (window.__ss._nodes || []).forEach(function(n) { if (n.parentNode) n.parentNode.removeChild(n); });
  window.__ss._nodes = [];
  document.querySelectorAll('[data-ss-hide]').forEach(function(el) { el.parentNode && el.parentNode.removeChild(el); });
};

// Trigger runtime — called by the compiled bundle with a list of block descriptors.
// Each descriptor: { slug, trigger, run, [selector], [once], [dependency], [hide_elements_until_code_runs] }
//   IMMEDIATE       — run() called right away
//   DOM_READY       — run() after DOMContentLoaded (or immediately if DOM is ready)
//   ELEMENT_LOADED  — run() each time a node matching selector appears in the DOM;
//                     if once:true (default) the observer is disconnected after first fire
//   AFTER_CODE_BLOCK — run() after the named dependency block's run() promise resolves
//
// hide_elements_until_code_runs: array of CSS selectors. A <style data-ss-hide="slug">
// that sets visibility:hidden on those selectors is injected immediately, then removed
// once the block's run() promise settles.
window.__ss._done    = {};  // slug → true once run() promise resolves
window.__ss._waiting = {};  // dependency slug → [callbacks]

window.__ss._trigger = function(blocks) {
  // Inject flash-hide style for a block, returns a cleanup function
  function injectHide(block) {
    var sels = block.hide_elements_until_code_runs;
    if (!sels || !sels.length) return function() {};
    var style = document.createElement('style');
    style.setAttribute('data-ss-hide', block.slug);
    style.setAttribute('data-ss-added', 'hide-' + block.slug);
    style.textContent = sels.join(',') + '{visibility:hidden!important}';
    (document.head || document.documentElement).appendChild(style);
    return function() { if (style.parentNode) style.parentNode.removeChild(style); };
  }

  function finish(slug, removeHide) {
    if (removeHide) removeHide();
    window.__ss._done[slug] = true;
    var cbs = window.__ss._waiting[slug] || [];
    delete window.__ss._waiting[slug];
    cbs.forEach(function(fn) { fn(); });
  }

  // el is the matched DOM element for ELEMENT_LOADED blocks; undefined otherwise.
  function exec(block, el) {
    var removeHide = injectHide(block);
    block.run(el)
      .then(function()  { finish(block.slug, removeHide); })
      .catch(function() { finish(block.slug, removeHide); });
  }

  blocks.forEach(function(block) {
    var t = block.trigger;
    if (t === 'IMMEDIATE') {
      exec(block);
    } else if (t === 'DOM_READY') {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() { exec(block); }, { once: true });
      } else {
        exec(block);
      }
    } else if (t === 'ELEMENT_LOADED') {
      var sel   = block.selector;
      var once  = block.once !== false;
      var fired = false;
      function tryMatch(root) {
        if (!sel) return;
        var el = (root && root.matches && root.matches(sel)) ? root
               : (root && root.querySelector) ? root.querySelector(sel) : null;
        if (!el) return;
        if (once && fired) return;
        fired = true;
        exec(block, el);
      }
      tryMatch(document.body || document.documentElement);
      if (once && fired) return;
      var obs = new MutationObserver(function(mutations) {
        for (var i = 0; i < mutations.length; i++) {
          var nodes = mutations[i].addedNodes;
          for (var j = 0; j < nodes.length; j++) {
            if (nodes[j].nodeType !== 1) continue;
            tryMatch(nodes[j]);
            if (once && fired) { obs.disconnect(); return; }
          }
        }
      });
      obs.observe(document.documentElement, { childList: true, subtree: true });
    } else if (t === 'AFTER_CODE_BLOCK') {
      var dep = block.dependency;
      if (window.__ss._done[dep]) {
        exec(block);
      } else {
        if (!window.__ss._waiting[dep]) window.__ss._waiting[dep] = [];
        window.__ss._waiting[dep].push(function() { exec(block); });
      }
    }
  });
};
${spaEnabled ? `
// SPA mode — re-apply modifications on client-side route changes.
// Watches history.pushState / replaceState and the popstate event.
// On navigation: removes ss-injected nodes, waits for DOM_READY, then
// re-fetches the HTML snippet from the server and re-applies everything.
(function() {
  function ssReapply() {
    window.__ss._removeAll();
    window.__ss._done    = {};
    window.__ss._waiting = {};
    var req = new XMLHttpRequest();
    req.open('GET', '/__ss__/html-snippet', true);
    req.onload = function() {
      if (req.status === 200) {
        try {
          var data = JSON.parse(req.responseText);
          if (data.html) window.__ss._applyHtml(data.html);
        } catch(_) {}
      }
    };
    req.send();
    // Re-trigger the bundle by dispatching a synthetic DOMContentLoaded-like event
    // that the ss runtime can react to. We reload the bundle script tag instead.
    var old = document.querySelector('script[data-ss-added="bundle"]');
    if (old) {
      var s = document.createElement('script');
      s.src = old.src + (old.src.includes('?') ? '&' : '?') + '_t=' + Date.now();
      s.setAttribute('data-ss-added', 'bundle');
      old.parentNode.replaceChild(s, old);
    }
  }
  var _push = history.pushState.bind(history);
  var _replace = history.replaceState.bind(history);
  history.pushState = function() { _push.apply(history, arguments); ssReapply(); };
  history.replaceState = function() { _replace.apply(history, arguments); ssReapply(); };
  window.addEventListener('popstate', ssReapply);
})();` : ''}
${jqueryEnabled ? `
// jQuery injection — load only if not already present on the page.
if (!window.jQuery) {
  var jqs = document.createElement('script');
  jqs.src = 'https://cdn.jsdelivr.net/npm/jquery@3/dist/jquery.min.js';
  jqs.setAttribute('data-ss-added', 'jquery');
  document.head.appendChild(jqs);
}` : ''}
${faEnabled ? `
// Font Awesome injection — load only if not already present on the page.
if (!document.querySelector('link[href*="font-awesome"],link[href*="fontawesome"]')) {
  var fal = document.createElement('link');
  fal.rel  = 'stylesheet';
  fal.href = 'https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6/css/all.min.css';
  fal.setAttribute('data-ss-added', 'fontawesome');
  document.head.appendChild(fal);
}` : ''}
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
 * Map a URL path + domain to a cache file path.
 * Strips query strings and sanitises against path traversal.
 * Returns null if the path is unsafe or has no cacheable extension.
 *
 * Cache layout: .cache/<domain>/<url-path>
 * e.g. .cache/example.com/styles/main.css
 */
function getCachePath(urlPath, domain) {
  const clean = urlPath.split("?")[0].split("#")[0];
  if (!CACHE_CONTENT_TYPES[extname(clean).toLowerCase()]) return null;
  // Strip leading slashes and collapse any .. segments to prevent traversal
  const rel = clean.replace(/^[/\\]+/, "").replace(/\.\./g, "_");
  if (!rel) return null;
  const domainDir = (domain || "unknown").replace(/[^a-zA-Z0-9.-]/g, "_");
  return join(CACHE_DIR, domainDir, rel);
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
function writeToCache(urlPath, buffer, domain) {
  const cachePath = getCachePath(urlPath, domain);
  if (!cachePath || existsSync(cachePath)) return;
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, buffer);
  } catch (_) {}
}

// ─── Log buffer ───────────────────────────────────────────────────────────────
// Intercepts console output at module-load time so all proxy + builder messages
// are recorded and can be displayed in the Developer tab of <ss-modal>.
const _logs = [];
const _MAX_LOGS = 500;

(function _captureConsole() {
  for (const level of ['log', 'warn', 'error']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      const msg = args.map(x => (x !== null && typeof x === 'object') ? JSON.stringify(x) : String(x)).join(' ');
      _logs.push({ ts: Date.now(), level, msg });
      if (_logs.length > _MAX_LOGS) _logs.shift();
      orig(...args);
    };
  }
})();

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
  // Draggable bar: drag handle + "ss" logo + variation switcher + gear icon.
  // Visibility: fades out when the page loses focus or the mouse leaves the
  // document body; fades back in on mouse re-entry or focus.
  // Position is persisted to sessionStorage so it survives soft reloads.
  class SsFloatingMenu extends HTMLElement {
    constructor() {
      super();
      this._root = this.attachShadow({ mode: 'closed' });
      this._dragging = false;
      this._dragOffX  = 0;
      this._dragOffY  = 0;
    }
    async connectedCallback() {
      const data = await fetch('${ssOrigin}/__ss__/variations').then(r => r.json());

      this._root.innerHTML = \`
        <style>
          :host {
            display: flex;
            align-items: center;
            gap: 8px;
            position: fixed;
            z-index: 2147483645;
            font: 13px/1.4 -apple-system, system-ui, sans-serif;
            background: #1a1a2e;
            color: #eee;
            border-radius: 8px; /* default; overridden by applyPos() when docked */
            padding: 6px 10px;
            box-shadow: 0 2px 12px rgba(0,0,0,.4);
            user-select: none;
            opacity: 0;
            transition: opacity .25s ease, border-radius .15s ease;
          }
          :host(.ss-visible)   { opacity: 0.70; }
          :host(.ss-hovered)   { opacity: 1; }
          .drag-handle {
            display: flex;
            align-items: center;
            color: #444;
            cursor: grab;
            font-size: 14px;
            padding: 0 2px 0 0;
            line-height: 1;
            flex-shrink: 0;
          }
          .drag-handle:active { cursor: grabbing; }
          .logo {
            display: flex;
            align-items: center;
            opacity: 0.7;
            transform: skewX(-20deg) scale(1.15);
            gap: 0;
            color: coral;
          }
          .logo svg {
            width: 8px;
            height: 18px;
          }
          .logo svg path, .logo svg use {
            stroke: currentColor;
            stroke-width: 0.7;
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
          .settings-btn {
            display: flex;
            align-items: center;
            justify-content: center;
            background: none;
            border: none;
            color: #aaa;
            cursor: pointer;
            padding: 0;
            line-height: 1;
            border-radius: 3px;
            transition: color .15s;
          }
          .settings-btn:hover { color: #fff; }
        </style>
        <span class="drag-handle" title="Drag to move">⠿</span>
        <span class="logo" aria-label="ss">
          <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox=".5 .5 5 11"><path id="ss-logo-a" fill="none" stroke="#fff" stroke-width=".4" d="M3 9V7L1 5V3L3 1 5 3V5L4 6"/><use xlink:href="#ss-logo-a" transform="rotate(180 3 6)"/></svg>
          <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox=".5 .5 5 11"><path id="ss-logo-b" fill="none" stroke="#fff" stroke-width=".4" d="M3 9V7L1 5V3L3 1 5 3V5L4 6"/><use xlink:href="#ss-logo-b" transform="rotate(180 3 6)"/></svg>
        </span>
        \${data.all && data.all.length >= 2 ? \`<select>\${
          data.all.map(v =>
            '<option value="' + v.slug + '"' +
            (v.slug === data.active ? ' selected' : '') +
            '>' + v.name + '</option>'
          ).join('')
        }</select>\` : ''}
        <button class="settings-btn" title="ss settings" aria-label="Open ss settings">
          <svg width="15" height="15" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path fill-rule="evenodd" clip-rule="evenodd"
              d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z"/>
          </svg>
        </button>
      \`;

      // ── Snap + styling helpers ────────────────────────────────────────────
      // Returns { sbX, sbY } — the pixel width of vertical and horizontal
      // scrollbars respectively (0 when no scrollbar is visible).
      const scrollbarSizes = () => ({
        sbX: window.innerWidth  - document.documentElement.clientWidth,
        sbY: window.innerHeight - document.documentElement.clientHeight,
      });

      // Apply position + border-radius that reflects which edges are docked.
      // border-radius order: top-left  top-right  bottom-right  bottom-left
      const applyPos = (x, y) => {
        const { sbX, sbY } = scrollbarSizes();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const w  = this.offsetWidth;
        const h  = this.offsetHeight;
        const R  = 8; // default corner radius
        const onL = x === 0;
        const onR = x === vw - w - sbX;
        const onT = y === 0;
        const onB = y === vh - h - sbY;
        // corner order: top-left top-right bottom-right bottom-left
        const tl = (onT || onL) ? 0 : R;
        const tr = (onT || onR) ? 0 : R;
        const br = (onB || onR) ? 0 : R;
        const bl = (onB || onL) ? 0 : R;
        this.style.left         = x + 'px';
        this.style.top          = y + 'px';
        this.style.borderRadius = \`\${tl}px \${tr}px \${br}px \${bl}px\`;
      };

      // ── Restore saved position ──────────────────────────────────────────────
      const saved = sessionStorage.getItem('__ss_menu_pos');
      if (saved) {
        try {
          const { x, y } = JSON.parse(saved);
          applyPos(x, y);
        } catch (_) {
          this.style.left = '4px';
          this.style.top  = '50%';
          this.style.transform = 'translateY(-50%)';
        }
      } else {
        this.style.left = '4px';
        this.style.top  = '50%';
        this.style.transform = 'translateY(-50%)';
      }

      // ── Drag-to-move ──────────────────────────────────────────────────────
      const handle = this._root.querySelector('.drag-handle');
      handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const rect = this.getBoundingClientRect();
        // Clear percentage-based transform before dragging
        this.style.transform = '';
        this.style.top  = rect.top  + 'px';
        this.style.left = rect.left + 'px';
        this._dragOffX = e.clientX - rect.left;
        this._dragOffY = e.clientY - rect.top;
        this._dragging = true;
      });
      document.addEventListener('mousemove', (e) => {
        if (!this._dragging) return;
        const SNAP   = 8;
        const { sbX, sbY } = scrollbarSizes();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const w  = this.offsetWidth;
        const h  = this.offsetHeight;
        let x = Math.max(0, Math.min(e.clientX - this._dragOffX, vw - w - sbX));
        let y = Math.max(0, Math.min(e.clientY - this._dragOffY, vh - h - sbY));
        if (x <= SNAP)              x = 0;
        if (x >= vw - w - sbX - SNAP) x = vw - w - sbX;
        if (y <= SNAP)              y = 0;
        if (y >= vh - h - sbY - SNAP) y = vh - h - sbY;
        applyPos(x, y);
      });
      document.addEventListener('mouseup', () => {
        if (!this._dragging) return;
        this._dragging = false;
        sessionStorage.setItem('__ss_menu_pos', JSON.stringify({
          x: parseFloat(this.style.left),
          y: parseFloat(this.style.top),
        }));
      });

      // ── Visibility: mouse presence + page focus ───────────────────────────
      const show = () => this.classList.add('ss-visible');
      const hide = () => { if (!this._dragging) this.classList.remove('ss-visible'); };

      // Show on mouse enter document body, hide on leave
      document.addEventListener('mouseenter', show);
      document.addEventListener('mouseleave', hide);

      // Show when page is focused, hide when blurred
      window.addEventListener('focus', show);
      window.addEventListener('blur',  hide);

      // Start visible if the page is already focused
      if (document.hasFocus()) show();

      // ── Hover to full opacity ─────────────────────────────────────────────
      this.addEventListener('mouseenter', () => this.classList.add('ss-hovered'));
      this.addEventListener('mouseleave', () => this.classList.remove('ss-hovered'));

      // ── Variation switcher ────────────────────────────────────────────────
      const sel = this._root.querySelector('select');
      if (sel) {
        sel.addEventListener('change', async (e) => {
          await fetch('${ssOrigin}/__ss__/switch?v=' + e.target.value);
        });
      }

      // ── Settings button → open modal ──────────────────────────────────────
      this._root.querySelector('.settings-btn').addEventListener('click', () => {
        this.dispatchEvent(new CustomEvent('ss-open-modal', { bubbles: true, composed: true }));
      });
    }
  }

  // ── <ss-modal> web component ───────────────────────────────────────────────
  // Full-screen overlay + tabbed modal card. Opens on "ss-open-modal" event
  // dispatched by <ss-floating-menu>. Four tabs: General, Pages, Content, Developer.
  class SsModal extends HTMLElement {
    constructor() {
      super();
      this._root = this.attachShadow({ mode: 'closed' });
      this._data = null;
      this._activeTab = 'general';
    }

    connectedCallback() {
      this._root.innerHTML = \`
        <style>
          :host { display: contents; }
          * { box-sizing: border-box; }
          .overlay {
            display: none; position: fixed; inset: 0;
            background: rgba(0,0,0,.55); z-index: 2147483647;
            align-items: center; justify-content: center;
          }
          .overlay.open { display: flex; }
          .modal {
            background: #1a1a2e; color: #eee;
            border-radius: 10px; box-shadow: 0 8px 40px rgba(0,0,0,.7);
            width: min(780px, 96vw); height: min(580px, 88vh);
            display: flex; flex-direction: column;
            font: 13px/1.5 -apple-system, system-ui, sans-serif;
            overflow: hidden;
          }
          .modal-header {
            display: flex; align-items: center; justify-content: space-between;
            padding: 13px 18px; border-bottom: 1px solid #2d2d44;
            font-weight: 600; font-size: 14px; flex-shrink: 0;
          }
          .modal-close {
            background: none; border: none; color: #666; cursor: pointer;
            font-size: 22px; line-height: 1; padding: 0 4px; border-radius: 4px;
          }
          .modal-close:hover { color: #fff; }
          .modal-body { display: flex; flex: 1; overflow: hidden; }
          /* ── Sidebar ── */
          .sidebar {
            width: 130px; flex-shrink: 0;
            border-right: 1px solid #2d2d44; background: #13132a;
            display: flex; flex-direction: column; padding: 8px 0;
          }
          .tab-btn {
            background: none; border: none; border-left: 2px solid transparent;
            color: #888; text-align: left; padding: 9px 14px;
            font: inherit; font-size: 13px; cursor: pointer;
            transition: color .12s, background .12s;
            white-space: nowrap;
          }
          .tab-btn:hover { color: #ddd; background: rgba(255,255,255,.04); }
          .tab-btn.active { color: #fff; border-left-color: #7c7cff; background: rgba(124,124,255,.1); }
          /* ── Tab pane ── */
          .tab-pane { flex: 1; overflow-y: auto; padding: 18px 22px 22px; }
          /* ── Shared content ── */
          .section { margin-bottom: 20px; }
          .section:last-child { margin-bottom: 0; }
          .section-title {
            font-size: 10px; font-weight: 700; letter-spacing: .08em;
            text-transform: uppercase; color: #555; margin: 0 0 10px;
          }
          .field { margin-bottom: 8px; }
          .field-label { font-size: 11px; color: #666; margin-bottom: 2px; }
          .field-value { color: #ddd; }
          .field-value.mono { font-family: ui-monospace, monospace; font-size: 12px; color: #aaa; }
          .input-row { display: flex; align-items: center; gap: 8px; }
          .input {
            flex: 1; background: #2d2d44; color: #fff;
            border: 1px solid #3a3a55; border-radius: 4px;
            padding: 5px 9px; font: inherit; font-size: 12px;
          }
          .input:focus { outline: none; border-color: #7c7cff; }
          .btn {
            background: #7c7cff; color: #fff; border: none; border-radius: 4px;
            padding: 5px 13px; font: inherit; font-size: 12px;
            cursor: pointer; flex-shrink: 0;
          }
          .btn:hover { background: #6a6aee; }
          .btn-sm { padding: 3px 10px; font-size: 11px; }
          .btn-icon {
            background: none; border: none; color: #555; cursor: pointer;
            font-size: 13px; padding: 0 3px; line-height: 1; border-radius: 3px; flex-shrink: 0;
          }
          .btn-icon:hover { color: #ff6b6b; }
          .toggle-btn {
            background: none; border: none; cursor: pointer; padding: 0 2px;
            border-radius: 3px; flex-shrink: 0; line-height: 1; color: #444;
            font-size: 13px; transition: color .15s;
          }
          .toggle-btn:hover { color: #aaa; }
          .toggle-btn.is-enabled { color: #7c7cff; }
          .toggle-btn.is-enabled:hover { color: #a0a0ff; }
          .var-card.var-disabled { opacity: .45; }
          .mod-row.mod-disabled { opacity: .4; }
          .eye-btn {
            background: none; border: none; color: #555; cursor: pointer;
            padding: 0 3px; line-height: 1; border-radius: 3px; flex-shrink: 0;
            display: flex; align-items: center;
          }
          .eye-btn:hover { color: #ddd; }
          .save-flash { font-size: 11px; color: #7c7cff; opacity: 0; transition: opacity .3s; flex-shrink: 0; }
          .save-flash.show { opacity: 1; }
          .empty-note { color: #555; font-size: 12px; font-style: italic; }
          /* ── Pages tab ── */
          .rule-row {
            display: flex; align-items: flex-start; gap: 6px;
            margin-bottom: 8px;
          }
          .rule-drag {
            color: #444; cursor: grab; font-size: 14px; flex-shrink: 0;
            padding: 6px 2px 0; user-select: none;
          }
          .rule-drag:active { cursor: grabbing; }
          .rule-fields { display: flex; flex-direction: column; gap: 5px; flex: 1; }
          .rule-top { display: flex; align-items: center; gap: 6px; }
          .rule-type { flex: 0 0 160px; }
          .rule-value { flex: 1; }
          .rule-opts {
            display: flex; flex-wrap: wrap; gap: 4px 14px;
            padding: 3px 0 0 2px;
          }
          .rule-opt-label {
            display: flex; align-items: center; gap: 5px;
            font-size: 11px; color: #777; cursor: pointer; user-select: none;
          }
          .rule-opt-label:hover { color: #bbb; }
          .rule-opt-label input { accent-color: #7c7cff; cursor: pointer; }
          .section-title-row {
            display: flex; align-items: center; justify-content: space-between;
            margin-bottom: 10px;
          }
          /* ── Content tab ── */
          .exp-card {
            background: #1f1f38; border: 1px solid #2d2d44; border-radius: 7px;
            padding: 10px 12px; margin-bottom: 8px;
          }
          .exp-card:last-child { margin-bottom: 0; }
          .exp-name { font-weight: 600; margin-bottom: 6px; }
          .exp-slug-txt { font-weight: 400; font-size: 11px; opacity: .5; }
          .var-list { display: flex; flex-direction: column; gap: 5px; margin-left: 6px; }
          .var-row { display: flex; align-items: center; gap: 8px; }
          .var-dot { width: 6px; height: 6px; border-radius: 50%; background: #444; flex-shrink: 0; }
          .var-dot.active { background: #7c7cff; }
          .badge { font-size: 10px; border-radius: 3px; padding: 1px 5px; flex-shrink: 0; }
          .badge-active  { background: #7c7cff; color: #fff; }
          .badge-trigger { background: #2d2d44; color: #bbb; }
          .var-card {
            background: #1f1f38; border: 1px solid #2d2d44; border-radius: 7px;
            padding: 8px 10px; margin-bottom: 6px;
          }
          .var-card.var-control { opacity: .7; }
          .var-card-header { display: flex; align-items: center; gap: 8px; }
          .drag-handle {
            color: #444; cursor: grab; font-size: 14px; flex-shrink: 0;
            user-select: none; padding: 0 2px;
          }
          .drag-handle:active { cursor: grabbing; }
          .drag-placeholder { width: 20px; flex-shrink: 0; }
          .var-radio-label { display: flex; align-items: center; flex-shrink: 0; cursor: pointer; }
          .var-name { flex: 1; font-weight: 600; }
          .var-name[contenteditable]:focus {
            outline: 1px solid #7c7cff; border-radius: 3px; padding: 0 3px;
          }
          .var-file-count { font-size: 11px; color: #555; flex-shrink: 0; }
          .mod-list { margin: 8px 0 2px 20px; display: flex; flex-direction: column; gap: 4px; }
          .mod-row { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #888; }
          .mod-name { flex: 1; }
          .mod-name[contenteditable]:focus {
            outline: 1px solid #7c7cff; border-radius: 3px; padding: 0 3px;
          }
          .mod-files { font-size: 11px; color: #555; flex-shrink: 0; }
          /* ── Developer tab ── */
          .code-block {
            background: #0e0e1e; border: 1px solid #2a2a40; border-radius: 6px;
            padding: 10px 12px; margin: 0;
            font: 11px/1.7 ui-monospace, monospace; color: #aaa;
            overflow: auto; max-height: 200px; white-space: pre;
          }
          .log-list { display: flex; flex-direction: column; }
          .log-entry {
            display: grid; grid-template-columns: 72px 40px 1fr;
            gap: 6px; padding: 3px 0; border-bottom: 1px solid #1a1a30;
            font: 11px/1.5 ui-monospace, monospace;
          }
          .log-ts    { color: #444; }
          .log-lvl   { }
          .log-lvl.log   { color: #7c7cff; }
          .log-lvl.warn  { color: #f5a623; }
          .log-lvl.error { color: #ff5f5f; }
          .log-msg { color: #bbb; word-break: break-all; }
          /* ── Developer settings ── */
          .settings-grid {
            display: grid; grid-template-columns: 1fr 1fr; gap: 6px 16px;
            margin-bottom: 4px;
          }
          .check-label {
            display: flex; align-items: center; gap: 7px;
            font-size: 12px; color: #bbb; cursor: pointer; user-select: none;
          }
          .check-label:hover { color: #eee; }
          .check-label input[type=checkbox] { accent-color: #7c7cff; cursor: pointer; width: 13px; height: 13px; }
          .check-note { font-size: 10px; color: #555; margin-top: 2px; }
          .num-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
          .num-label { font-size: 12px; color: #bbb; width: 160px; flex-shrink: 0; }
          .num-input {
            width: 90px; background: #2d2d44; color: #fff; border: 1px solid #3a3a55;
            border-radius: 4px; padding: 4px 8px; font: 12px/1.4 inherit;
          }
          .num-input:focus { outline: none; border-color: #7c7cff; }
          .num-unit { font-size: 11px; color: #555; }
        </style>
        <div class="overlay">
          <div class="modal" role="dialog" aria-modal="true" aria-label="ss Project Manager">
            <div class="modal-header">
              <span>ss — Project Manager</span>
              <button class="modal-close" aria-label="Close">&times;</button>
            </div>
            <div class="modal-body">
              <nav class="sidebar">
                <button class="tab-btn active" data-tab="general">General</button>
                <button class="tab-btn" data-tab="pages">Pages</button>
                <button class="tab-btn" data-tab="content">Content</button>
                <button class="tab-btn" data-tab="developer">Developer</button>
              </nav>
              <div class="tab-pane"></div>
            </div>
          </div>
        </div>
      \`;

      const overlay  = this._root.querySelector('.overlay');
      const closeBtn = this._root.querySelector('.modal-close');

      const open = async () => {
        const [config, project] = await Promise.all([
          fetch('${ssOrigin}/__ss__/config').then(r => r.json()),
          fetch('${ssOrigin}/__ss__/project').then(r => r.json()),
        ]);
        this._data = { config, project };
        this._showTab(this._activeTab);
        overlay.classList.add('open');
      };
      const close = () => overlay.classList.remove('open');

      document.addEventListener('ss-open-modal', open);
      closeBtn.addEventListener('click', close);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

      this._root.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => this._showTab(btn.dataset.tab));
      });
    }

    // Send a command over the WebSocket and return a promise that resolves with
    // the reply. Opens a dedicated WS connection per-modal instance so commands
    // don't interfere with the live-reload listener in the runtime script.
    _cmd(payload) {
      return new Promise((resolve) => {
        if (!this._ws || this._ws.readyState !== 1) {
          this._ws = new WebSocket('${wsUrl}');
        }
        const id = Math.random().toString(36).slice(2);
        const msg = JSON.stringify({ ...payload, id });
        const handler = (e) => {
          let data;
          try { data = JSON.parse(e.data); } catch { return; }
          if (data.type === 'cmd-result' && data.id === id) {
            this._ws.removeEventListener('message', handler);
            resolve(data);
          }
        };
        if (this._ws.readyState === 1) {
          this._ws.addEventListener('message', handler);
          this._ws.send(msg);
        } else {
          this._ws.addEventListener('open', () => {
            this._ws.addEventListener('message', handler);
            this._ws.send(msg);
          });
        }
      });
    }

    _showTab(name) {
      this._activeTab = name;
      this._root.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
      const pane = this._root.querySelector('.tab-pane');
      if (name === 'general')   { pane.innerHTML = this._tabGeneral();   this._wireGeneral(); }
      if (name === 'pages')     { pane.innerHTML = this._tabPages();     this._wirePages(); }
      if (name === 'content')   { pane.innerHTML = this._tabContent();   this._wireContent(); }
      if (name === 'developer') { pane.innerHTML = this._tabDeveloper(); this._wireDeveloper(); }
    }

    // ── Tab: General ────────────────────────────────────────────────────────
    _tabGeneral() {
      const { config, project } = this._data;
      const exp = (project.experiences || []).find(e => e.slug === config.experience?.slug);
      const varName = config.variation?.name || config.variation?.slug || '—';
      const varSlug = config.variation?.slug || '—';
      const modCount = (config.modifications || []).length;

      // ── Page targeting match ──────────────────────────────────────────────
      // Reconstruct the real target-site URL from the proxied path so we show
      // (and evaluate targeting rules against) the URL the code will run on.
      const _to = window.__ss?._targetOrigin;
      const currentUrl = _to
        ? _to + location.pathname + location.search + location.hash
        : location.href;
      const include = exp?.pages?.include || [];
      const exclude = exp?.pages?.exclude || [];
      let targeting = 'none'; // 'none' | 'match' | 'no-match'
      if (include.length || exclude.length) {
        const testUrl = (url, rule) => {
          const r = typeof rule === 'object' ? rule : { rule: 'URL_CONTAINS', value: rule, options: {} };
          const opts = r.options || {};
          let u = url;
          if (opts.ignore_protocol)     u = u.replace(/^https?:\\/\\//, '');
          if (opts.ignore_query_string) u = u.split('?')[0];
          if (opts.ignore_fragment)     u = u.split('#')[0];
          const val = (opts.case_sensitive) ? r.value : r.value?.toLowerCase();
          const tgt = (opts.case_sensitive) ? u       : u.toLowerCase();
          switch (r.rule) {
            case 'URL_MATCHES':    return tgt === val;
            case 'URL_CONTAINS':   return tgt.includes(val);
            case 'URL_STARTSWITH': return tgt.startsWith(val);
            case 'URL_ENDSWITH':   return tgt.endsWith(val);
            case 'URL_REGEX': try { return new RegExp(r.value, opts.case_sensitive ? '' : 'i').test(u); } catch { return false; }
            default: return false;
          }
        };
        const incMatch = !include.length || include.some(r => testUrl(currentUrl, r));
        const excMatch =  exclude.length  && exclude.some(r => testUrl(currentUrl, r));
        targeting = (incMatch && !excMatch) ? 'match' : 'no-match';
      }
      const targetIcon = targeting === 'match'    ? '<span style="color:#4caf50;font-size:15px" title="Page matches targeting rules">✓</span>'
                       : targeting === 'no-match' ? '<span style="color:#f44336;font-size:15px" title="Page does not match targeting rules">✗</span>'
                       : '';
      const targetNote = targeting === 'none'     ? '<span style="color:#555;font-size:11px;font-style:italic">No targeting rules set</span>'
                       : targeting === 'match'    ? '<span style="color:#4caf50;font-size:11px">Matches include rules</span>'
                       : '<span style="color:#f44336;font-size:11px">Does not match include rules</span>';

      return \`
        <div class="section">
          <div class="section-title">Active Experience</div>
          <div class="field">
            <div class="field-label">Name</div>
            <div class="field-value var-name" id="ss-exp-name" contenteditable="true" spellcheck="false" title="Click to rename">\${exp?.name || '—'}</div>
          </div>
          <div class="field">
            <div class="field-label">Slug</div>
            <div class="field-value mono">\${exp?.slug || '—'}</div>
          </div>
        </div>
        <div class="section">
          <div class="section-title">Active Variation</div>
          <div class="field">
            <div class="field-label">Name</div>
            <div class="field-value">\${varName}</div>
          </div>
          <div class="field">
            <div class="field-label">Slug</div>
            <div class="field-value mono">\${varSlug}</div>
          </div>
          <div class="field">
            <div class="field-label">Modification blocks</div>
            <div class="field-value">\${modCount}</div>
          </div>
        </div>
        <div class="section">
          <div class="section-title">Current Page</div>
          <div class="field">
            <div class="field-label">URL</div>
            <div class="field-value mono" style="word-break:break-all;font-size:11px">\${currentUrl}</div>
          </div>
          <div class="field">
            <div class="field-label" style="display:flex;align-items:center;gap:5px">Targeting \${targetIcon}</div>
            <div class="field-value">\${targetNote}</div>
          </div>
        </div>
      \`;
    }

    _wireGeneral() {
      const pane = this._root.querySelector('.tab-pane');
      const { config } = this._data;
      const expSlug = config.experience?.slug;
      const nameEl = pane.querySelector('#ss-exp-name');
      if (!nameEl || !expSlug) return;
      nameEl.addEventListener('focus', () => { nameEl.dataset.orig = nameEl.textContent; });
      nameEl.addEventListener('blur', async () => {
        const name = nameEl.textContent.trim();
        if (!name || name === nameEl.dataset.orig) return;
        await this._cmd({ action: 'rename-experience', expSlug, name });
      });
      nameEl.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); nameEl.blur(); }
        if (e.key === 'Escape') { nameEl.textContent = nameEl.dataset.orig; nameEl.blur(); }
      });
    }

    // ── Tab: Pages ──────────────────────────────────────────────────────────
    _tabPages() {
      const { config, project } = this._data;
      const exp       = (project.experiences || []).find(e => e.slug === config.experience?.slug);
      const editorUrl = exp?.pages?.editor  || '';
      const include   = exp?.pages?.include || [];
      const exclude   = exp?.pages?.exclude || [];

      const ruleList = (type, arr) => \`
        <div class="rule-list" id="rules-\${type}">
          \${arr.map(r => {
            // Normalise legacy plain-string rules to object form
            const obj = (typeof r === 'object' && r !== null) ? r : { rule: 'URL_CONTAINS', value: r, options: {} };
            return this._ruleRowHtml(type, obj);
          }).join('')}
        </div>
        <button class="btn btn-sm rule-add" data-type="\${type}">+ Add rule</button>
      \`;

      return \`
        <div class="section">
          <div class="section-title">Preview URL</div>
          <div class="input-row">
            <input class="input" id="ss-editor-url" type="url" value="\${editorUrl}" placeholder="https://..."/>
            <button class="btn" id="ss-save-url">Save</button>
            <span class="save-flash" id="ss-save-msg">Saved</span>
          </div>
        </div>
        <div class="section">
          <div class="section-title">Include rules</div>
          \${ruleList('include', include)}
        </div>
        <div class="section">
          <div class="section-title">Exclude rules</div>
          \${ruleList('exclude', exclude)}
        </div>
        <div class="section" style="padding-top:4px">
          <button class="btn" id="ss-save-rules">Save rules</button>
          <span class="save-flash" id="ss-rules-msg">Saved</span>
        </div>
      \`;
    }
    _wirePages() {
      const pane = this._root.querySelector('.tab-pane');

      // ── Preview URL save ───────────────────────────────────────────────
      pane.querySelector('#ss-save-url').addEventListener('click', async () => {
        const val = pane.querySelector('#ss-editor-url').value.trim();
        if (!val) return;
        await fetch('${ssOrigin}/__ss__/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ editorUrl: val }),
        });
        const msg = pane.querySelector('#ss-save-msg');
        msg.classList.add('show');
        setTimeout(() => msg.classList.remove('show'), 2000);
      });

      // ── Add rule ──────────────────────────────────────────────────────
      pane.querySelectorAll('.rule-add').forEach(btn => {
        btn.addEventListener('click', () => {
          const type = btn.dataset.type;
          const list = pane.querySelector(\`#rules-\${type}\`);
          // Build a blank rule row by rendering via the same helper used above
          const tmp = document.createElement('div');
          tmp.innerHTML = this._ruleRowHtml(type, { rule: 'URL_CONTAINS', value: '', options: {} });
          const row = tmp.firstElementChild;
          list.appendChild(row);
          row.querySelector('.rule-value').focus();
          this._wireRuleRow(row);
        });
      });

      // ── Wire existing rows ────────────────────────────────────────────
      pane.querySelectorAll('.rule-row').forEach(row => this._wireRuleRow(row));

      // ── Save rules ────────────────────────────────────────────────────
      pane.querySelector('#ss-save-rules').addEventListener('click', async () => {
        const collect = (type) => Array.from(
          pane.querySelectorAll(\`.rule-row[data-type="\${type}"]\`)
        ).map(row => {
          const ruleType = row.querySelector('.rule-type').value;
          const value    = row.querySelector('.rule-value').value.trim();
          if (!value) return null;
          const options = {};
          row.querySelectorAll('.rule-opt').forEach(cb => {
            if (cb.checked) options[cb.dataset.opt] = true;
          });
          const rule = { rule: ruleType, value };
          if (Object.keys(options).length) rule.options = options;
          return rule;
        }).filter(Boolean);

        const include = collect('include');
        const exclude = collect('exclude');

        await this._cmd({ action: 'set-page-rules', include, exclude });

        // Reflect into in-memory data so re-opening the tab is current
        const { config, project } = this._data;
        const exp = (project.experiences || []).find(e => e.slug === config.experience?.slug);
        if (exp?.pages) { exp.pages.include = include; exp.pages.exclude = exclude; }

        const msg = pane.querySelector('#ss-rules-msg');
        msg.classList.add('show');
        setTimeout(() => msg.classList.remove('show'), 2000);
      });

      // ── Drag-to-reorder ───────────────────────────────────────────────
      ['include','exclude'].forEach(type => {
        const list = pane.querySelector(\`#rules-\${type}\`);
        let dragging = null;
        list.addEventListener('dragstart', e => {
          dragging = e.target.closest('.rule-row');
          if (dragging) dragging.style.opacity = '.4';
        });
        list.addEventListener('dragend', () => {
          if (dragging) dragging.style.opacity = '';
          dragging = null;
        });
        list.addEventListener('dragover', e => {
          e.preventDefault();
          const target = e.target.closest('.rule-row');
          if (target && target !== dragging) {
            const after = e.clientY > target.getBoundingClientRect().top + target.offsetHeight / 2;
            list.insertBefore(dragging, after ? target.nextSibling : target);
          }
        });
        list.querySelectorAll('.rule-drag').forEach(handle => {
          handle.addEventListener('mousedown', () => {
            handle.closest('.rule-row').setAttribute('draggable', true);
          });
        });
      });
    }
    // Shared helper — builds the innerHTML of a single rule row
    _ruleRowHtml(type, r) {
      const RULE_TYPES = [
        { value: 'URL_MATCHES',    label: 'URL matches' },
        { value: 'URL_CONTAINS',   label: 'URL contains' },
        { value: 'URL_STARTSWITH', label: 'URL starts with' },
        { value: 'URL_ENDSWITH',   label: 'URL ends with' },
        { value: 'URL_REGEX',      label: 'URL regex' },
      ];
      const RULE_OPTIONS = [
        { key: 'ignore_query_string', label: 'Ignore query string' },
        { key: 'ignore_fragment',     label: 'Ignore fragment (#)' },
        { key: 'ignore_protocol',     label: 'Ignore protocol' },
        { key: 'case_sensitive',      label: 'Case sensitive' },
      ];
      const ruleType = r.rule  || 'URL_CONTAINS';
      const ruleVal  = r.value || '';
      const opts     = r.options || {};
      const selOpts  = RULE_TYPES.map(t =>
        \`<option value="\${t.value}"\${t.value === ruleType ? ' selected' : ''}>\${t.label}</option>\`
      ).join('');
      const optChecks = RULE_OPTIONS.map(o =>
        \`<label class="rule-opt-label">
          <input type="checkbox" class="rule-opt" data-opt="\${o.key}"\${opts[o.key] ? ' checked' : ''}/>
          \${o.label}
        </label>\`
      ).join('');
      return \`<div class="rule-row" data-type="\${type}">
        <span class="rule-drag" title="Drag to reorder">⠿</span>
        <div class="rule-fields">
          <div class="rule-top">
            <select class="input rule-type">\${selOpts}</select>
            <input  class="input rule-value" value="\${ruleVal.replace(/"/g,'&quot;')}" placeholder="e.g. https://example.com/*"/>
            <button class="btn-icon rule-del" title="Remove rule">✕</button>
          </div>
          <div class="rule-opts">\${optChecks}</div>
        </div>
      </div>\`;
    }
    _wireRuleRow(row) {
      row.querySelector('.rule-del').addEventListener('click', () => row.remove());
    }

    // ── Tab: Content ────────────────────────────────────────────────────────
    _tabContent() {
      const { config, project } = this._data;
      const exp = (project.experiences || []).find(e => e.slug === config.experience?.slug);
      if (!exp) return '<span class="empty-note">No active experience.</span>';

      const varCards = (exp.variations || []).map(v => {
        const isControl  = v.slug === 'control';
        const isActive   = config.variation?.slug === v.slug;
        const isDisabled = v.enabled === false;
        const fileCount  = (v.modifications || []).reduce((n, m) => n + (m.resources?.length || 0), 0);

        const modRows = (v.modifications || []).map(m => {
          const modDisabled = m.enabled === false;
          return \`<div class="mod-row\${modDisabled ? ' mod-disabled' : ''}" data-mod="\${m.slug}">
            \${isControl ? '' : \`<span class="drag-handle" title="Drag to reorder">⠿</span>\`}
            <span class="mod-name" \${isControl ? '' : 'contenteditable="true" spellcheck="false"'}>\${m.name}</span>
            <span class="badge badge-trigger">\${m.trigger || 'DOM_READY'}</span>
            <span class="mod-files">\${(m.resources||[]).length} file\${(m.resources||[]).length!==1?'s':''}</span>
            \${isControl ? '' : \`
              <button class="eye-btn" data-mod="\${m.slug}" title="View code">
                <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor"><path d="M10 12a2 2 0 100-4 2 2 0 000 4z"/><path fill-rule="evenodd" d="M.458 10C1.732 5.943 5.522 3 10 3s8.268 2.943 9.542 7c-1.274 4.057-5.064 7-9.542 7S1.732 14.057.458 10zM14 10a4 4 0 11-8 0 4 4 0 018 0z" clip-rule="evenodd"/></svg>
              </button>
              <button class="toggle-btn\${modDisabled ? '' : ' is-enabled'}" data-mod="\${m.slug}" title="\${modDisabled ? 'Enable block' : 'Disable block'}">⏻</button>
              <button class="btn-icon mod-del" data-mod="\${m.slug}" title="Delete modification">✕</button>
            \`}
          </div>\`;
        }).join('');

        return \`<div class="var-card\${isControl ? ' var-control' : ''}\${isDisabled ? ' var-disabled' : ''}" data-var="\${v.slug}">
          <div class="var-card-header">
            \${isControl ? '<span class="drag-placeholder"></span>' : '<span class="drag-handle var-drag" title="Drag to reorder">⠿</span>'}
            <label class="var-radio-label">
              <input type="radio" name="ss-active-var" value="\${v.slug}" \${isActive ? 'checked' : ''}/>
            </label>
            <span class="var-name" \${isControl ? '' : 'contenteditable="true" spellcheck="false"'}>\${v.name}</span>
            \${isActive ? '<span class="badge badge-active">active</span>' : ''}
            <span class="var-file-count">\${fileCount} file\${fileCount!==1?'s':''}</span>
            \${isControl ? '' : \`
              <button class="toggle-btn\${isDisabled ? '' : ' is-enabled'}" data-var="\${v.slug}" title="\${isDisabled ? 'Enable variation' : 'Disable variation'}">⏻</button>
              <button class="btn-icon var-del" data-var="\${v.slug}" title="Delete variation">✕</button>
            \`}
          </div>
          \${(v.modifications||[]).length ? \`<div class="mod-list" data-var="\${v.slug}">\${modRows}</div>\` : ''}
        </div>\`;
      }).join('');

      return \`
        <div class="section">
          <div class="section-title-row">
            <span class="section-title" style="margin:0">Variations</span>
            <button class="btn btn-sm" id="ss-new-var">+ New variation</button>
          </div>
          <div id="ss-var-list">\${varCards}</div>
        </div>
      \`;
    }
    _wireContent() {
      const pane = this._root.querySelector('.tab-pane');
      const { config } = this._data;
      const expSlug = config.experience?.slug;

      // ── Switch variation via radio ────────────────────────────────────
      pane.querySelectorAll('input[name="ss-active-var"]').forEach(radio => {
        radio.addEventListener('change', async () => {
          await this._cmd({ action: 'switch-variation', varSlug: radio.value, expSlug });
          this._data.config.variation = { slug: radio.value };
        });
      });

      // ── Rename variation (contenteditable blur) ───────────────────────
      pane.querySelectorAll('.var-name[contenteditable]').forEach(el => {
        const varSlug = el.closest('.var-card').dataset.var;
        el.addEventListener('blur', async () => {
          const name = el.textContent.trim();
          if (!name) { el.textContent = el.dataset.orig; return; }
          await this._cmd({ action: 'rename-variation', varSlug, name, expSlug });
        });
        el.addEventListener('focus', () => { el.dataset.orig = el.textContent; });
        el.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); el.blur(); } });
      });

      // ── Toggle variation enabled/disabled ────────────────────────────
      pane.querySelectorAll('.var-card-header .toggle-btn[data-var]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const varSlug = btn.dataset.var;
          const res = await this._cmd({ action: 'toggle-variation', varSlug, expSlug });
          if (res.ok) {
            const card = btn.closest('.var-card');
            const nowDisabled = res.enabled === false;
            card.classList.toggle('var-disabled', nowDisabled);
            btn.classList.toggle('is-enabled', !nowDisabled);
            btn.title = nowDisabled ? 'Enable variation' : 'Disable variation';
          }
        });
      });

      // ── Delete variation ──────────────────────────────────────────────
      pane.querySelectorAll('.var-del').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm(\`Delete variation "\${btn.dataset.var}"? This cannot be undone.\`)) return;
          await this._cmd({ action: 'delete-variation', varSlug: btn.dataset.var, expSlug });
          this._showTab('content');
        });
      });

      // ── Variation drag-to-reorder ─────────────────────────────────────
      const varList = pane.querySelector('#ss-var-list');
      let dragVar = null;
      varList.querySelectorAll('.var-drag').forEach(handle => {
        const card = handle.closest('.var-card');
        handle.addEventListener('mousedown', () => card.setAttribute('draggable', true));
        card.addEventListener('dragstart', e => { dragVar = card; card.style.opacity = '.4'; e.stopPropagation(); });
        card.addEventListener('dragend', async () => {
          card.style.opacity = '';
          card.removeAttribute('draggable');
          const order = Array.from(varList.querySelectorAll('.var-card')).map(c => c.dataset.var);
          await this._cmd({ action: 'reorder-variations', order, expSlug });
          dragVar = null;
        });
      });
      varList.addEventListener('dragover', e => {
        e.preventDefault();
        const target = e.target.closest('.var-card');
        if (target && dragVar && target !== dragVar && !target.classList.contains('var-control')) {
          const after = e.clientY > target.getBoundingClientRect().top + target.offsetHeight / 2;
          varList.insertBefore(dragVar, after ? target.nextSibling : target);
        }
      });

      // ── Rename modification ───────────────────────────────────────────
      pane.querySelectorAll('.mod-name[contenteditable]').forEach(el => {
        const varSlug = el.closest('.mod-list').dataset.var;
        const modSlug = el.closest('.mod-row').dataset.mod;
        el.addEventListener('blur', async () => {
          const name = el.textContent.trim();
          if (!name) { el.textContent = el.dataset.orig; return; }
          await this._cmd({ action: 'rename-modification', varSlug, modSlug, name, expSlug });
        });
        el.addEventListener('focus', () => { el.dataset.orig = el.textContent; });
        el.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); el.blur(); } });
      });

      // ── Modification drag-to-reorder ──────────────────────────────────
      pane.querySelectorAll('.mod-list').forEach(list => {
        const varSlug = list.dataset.var;
        let dragMod = null;
        list.querySelectorAll('.drag-handle').forEach(handle => {
          const row = handle.closest('.mod-row');
          handle.addEventListener('mousedown', () => row.setAttribute('draggable', true));
          row.addEventListener('dragstart', e => { dragMod = row; row.style.opacity = '.4'; e.stopPropagation(); });
          row.addEventListener('dragend', async () => {
            row.style.opacity = '';
            row.removeAttribute('draggable');
            const order = Array.from(list.querySelectorAll('.mod-row')).map(r => r.dataset.mod);
            await this._cmd({ action: 'reorder-modifications', varSlug, order, expSlug });
            dragMod = null;
          });
        });
        list.addEventListener('dragover', e => {
          e.preventDefault();
          const target = e.target.closest('.mod-row');
          if (target && dragMod && target !== dragMod) {
            const after = e.clientY > target.getBoundingClientRect().top + target.offsetHeight / 2;
            list.insertBefore(dragMod, after ? target.nextSibling : target);
          }
        });
      });

      // ── Toggle modification enabled/disabled ─────────────────────────
      pane.querySelectorAll('.mod-list .toggle-btn[data-mod]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const modSlug = btn.dataset.mod;
          const varSlug = btn.closest('.mod-list').dataset.var;
          const res = await this._cmd({ action: 'toggle-modification', varSlug, modSlug, expSlug });
          if (res.ok) {
            const row = btn.closest('.mod-row');
            const nowDisabled = res.enabled === false;
            row.classList.toggle('mod-disabled', nowDisabled);
            btn.classList.toggle('is-enabled', !nowDisabled);
            btn.title = nowDisabled ? 'Enable block' : 'Disable block';
          }
        });
      });

      // ── View modification code (eye icon) ─────────────────────────────
      pane.querySelectorAll('.eye-btn[data-mod]').forEach(btn => {
        btn.addEventListener('click', () => {
          const modSlug = btn.dataset.mod;
          const varSlug = btn.closest('.mod-list').dataset.var;
          const { project, config } = this._data;
          const expSlug2 = config.experience?.slug;
          const exp2 = (project.experiences || []).find(e => e.slug === expSlug2);
          const variation = exp2?.variations?.find(v => v.slug === varSlug);
          const mod = variation?.modifications?.find(m => m.slug === modSlug);
          if (!mod) return;
          const viewer = document.querySelector('ss-code-viewer');
          if (viewer) viewer.open(mod, expSlug2, varSlug, variation?.modifications || []);
        });
      });

      // ── Delete modification ───────────────────────────────────────────
      pane.querySelectorAll('.mod-del').forEach(btn => {
        btn.addEventListener('click', async () => {
          const row     = btn.closest('.mod-row');
          const modSlug = btn.dataset.mod;
          const varSlug = btn.closest('.mod-list').dataset.var;
          if (!confirm(\`Delete modification "\${modSlug}"? This cannot be undone.\`)) return;
          await this._cmd({ action: 'delete-modification', varSlug, modSlug, expSlug });
          row.remove();
        });
      });

      // ── New variation ─────────────────────────────────────────────────
      pane.querySelector('#ss-new-var')?.addEventListener('click', async () => {
        const name = prompt('New variation name:');
        if (!name?.trim()) return;
        await this._cmd({ action: 'create-variation', name: name.trim(), expSlug });
        const [config, project] = await Promise.all([
          fetch('${ssOrigin}/__ss__/config').then(r => r.json()),
          fetch('${ssOrigin}/__ss__/project').then(r => r.json()),
        ]);
        this._data = { config, project };
        this._showTab('content');
      });
    }

    // ── Tab: Developer ──────────────────────────────────────────────────────
    _tabDeveloper() {
      const cfg = this._data?.project?._settings || {};
      const chk = (val) => val ? ' checked' : '';
      return \`
        <div class="section">
          <div class="section-title-row">
            <span class="section-title" style="margin:0">Project Settings</span>
            <span class="save-flash" id="ss-dev-save-msg">Saved</span>
          </div>
          <div class="section" style="margin-bottom:12px">
            <div class="field-label" style="margin-bottom:6px">JS Tools</div>
            <div class="settings-grid">
              <label class="check-label">
                <input type="checkbox" id="ss-inject-jquery"\${chk(cfg.inject_jquery)}/> jQuery 3
              </label>
              <label class="check-label">
                <input type="checkbox" id="ss-inject-fa"\${chk(cfg.inject_fontawesome)}/> Font Awesome 6
              </label>
            </div>
            <div class="check-note">Injected into every proxied page if not already present.</div>
          </div>
          <div class="section" style="margin-bottom:12px">
            <div class="field-label" style="margin-bottom:6px">Single-Page App (SPA)</div>
            <label class="check-label" style="margin-bottom:4px">
              <input type="checkbox" id="ss-spa"\${chk(cfg.spa)}/>
              Re-apply modifications on client-side route changes
            </label>
            <div class="check-note">Watches pushState / replaceState / popstate and re-applies all ss changes after each navigation.</div>
          </div>
          <div class="section" style="margin-bottom:12px">
            <div class="field-label" style="margin-bottom:8px">Cache &amp; Timeouts</div>
            <div class="num-row">
              <span class="num-label">Resource cache TTL</span>
              <input class="num-input" type="number" id="ss-cache-ttl" min="0" value="\${cfg.cache_ttl ?? 3600}"/>
              <span class="num-unit">seconds</span>
            </div>
            <div class="num-row">
              <span class="num-label">Page load timeout</span>
              <input class="num-input" type="number" id="ss-timeout-ms" min="0" step="1000" value="\${cfg.timeout_ms ?? 30000}"/>
              <span class="num-unit">ms</span>
            </div>
          </div>
          <button class="btn btn-sm" id="ss-dev-save">Save settings</button>
        </div>
        <div class="section">
          <div class="section-title">Timestamps</div>
          <div class="field">
            <div class="field-label">Last resource cache write</div>
            <div class="field-value mono" id="ss-ts-cache">—</div>
          </div>
          <div class="field">
            <div class="field-label">Last context capture (body.html)</div>
            <div class="field-value mono" id="ss-ts-context">—</div>
          </div>
          <div class="field">
            <div class="field-label">Last screenshot</div>
            <div class="field-value mono" id="ss-ts-screenshots">—</div>
          </div>
        </div>
        <div class="section">
          <div class="section-title">config.json</div>
          <pre class="code-block" id="ss-raw-config">Loading...</pre>
        </div>
        <div class="section">
          <div class="section-title">Logs</div>
          <div class="log-list" id="ss-log-list">
            <span class="empty-note">Loading...</span>
          </div>
        </div>
      \`;
    }
    _wireDeveloper() {
      const pane = this._root.querySelector('.tab-pane');

      // ── Settings save ─────────────────────────────────────────────────────
      pane.querySelector('#ss-dev-save').addEventListener('click', async () => {
        const payload = {
          action: 'update-project-settings',
          inject_jquery:      pane.querySelector('#ss-inject-jquery').checked,
          inject_fontawesome: pane.querySelector('#ss-inject-fa').checked,
          spa:                pane.querySelector('#ss-spa').checked,
          cache_ttl:          parseInt(pane.querySelector('#ss-cache-ttl').value,  10) || 0,
          timeout_ms:         parseInt(pane.querySelector('#ss-timeout-ms').value, 10) || 0,
        };
        const res = await this._cmd(payload);
        if (res.ok) {
          // Reflect into cached project settings so re-opening the tab is current
          if (!this._data.project._settings) this._data.project._settings = {};
          Object.assign(this._data.project._settings, payload);
          const msg = pane.querySelector('#ss-dev-save-msg');
          msg.classList.add('show');
          setTimeout(() => msg.classList.remove('show'), 2000);
        }
      });

      // ── Timestamps ────────────────────────────────────────────────────────
      fetch('${ssOrigin}/__ss__/status')
        .then(r => r.json())
        .then(status => {
          const fmt = (ms) => ms ? new Date(ms).toLocaleString() : 'Never';
          const cacheEl  = this._root.querySelector('#ss-ts-cache');
          const ctxEl    = this._root.querySelector('#ss-ts-context');
          const shotsEl  = this._root.querySelector('#ss-ts-screenshots');
          if (cacheEl)  cacheEl.textContent  = fmt(status.cache);
          if (ctxEl)    ctxEl.textContent    = fmt(status.context);
          if (shotsEl)  shotsEl.textContent  = fmt(status.screenshots);
        })
        .catch(() => {});

      // ── Raw config ────────────────────────────────────────────────────────
      fetch('${ssOrigin}/__ss__/raw-config')
        .then(r => r.json())
        .then(cfg => {
          const el = this._root.querySelector('#ss-raw-config');
          if (el) el.textContent = JSON.stringify(cfg, null, 2);
        })
        .catch(() => {
          const el = this._root.querySelector('#ss-raw-config');
          if (el) el.textContent = 'Could not load config.';
        });

      // ── Logs ──────────────────────────────────────────────────────────────
      fetch('${ssOrigin}/__ss__/logs')
        .then(r => r.json())
        .then(logs => {
          const list = this._root.querySelector('#ss-log-list');
          if (!list) return;
          if (!logs.length) {
            list.innerHTML = '<span class="empty-note">No log entries yet.</span>';
            return;
          }
          list.innerHTML = logs.slice().reverse().map(entry => {
            const time = new Date(entry.ts).toLocaleTimeString();
            const msg  = entry.msg.replace(/&/g, '&amp;').replace(/</g, '&lt;');
            return \`<div class="log-entry">
              <span class="log-ts">\${time}</span>
              <span class="log-lvl \${entry.level}">\${entry.level}</span>
              <span class="log-msg">\${msg}</span>
            </div>\`;
          }).join('');
        })
        .catch(() => {
          const list = this._root.querySelector('#ss-log-list');
          if (list) list.innerHTML = '<span class="empty-note">Could not load logs.</span>';
        });
    }
  }

  // ── <ss-code-viewer> web component ────────────────────────────────────────
  // Monaco-backed read-only code viewer with editable trigger settings.
  // Opens on top of the modal (z-index 2147483648).
  // Usage: document.querySelector('ss-code-viewer').open(modData, expSlug, varSlug)
  class SsCodeViewer extends HTMLElement {
    constructor() {
      super();
      this._root = this.attachShadow({ mode: 'closed' });
      this._editor = null;
      this._modData = null;
      this._ws = null;
    }

    connectedCallback() {
      this._root.innerHTML = \`
        <style>
          :host { display: contents; }
          * { box-sizing: border-box; }
          .cv-overlay {
            display: none; position: fixed; inset: 0;
            background: rgba(0,0,0,.72); z-index: 2147483648;
            align-items: center; justify-content: center;
          }
          .cv-overlay.open { display: flex; }
          .cv-modal {
            background: #1a1a2e; color: #eee;
            border-radius: 10px; box-shadow: 0 8px 48px rgba(0,0,0,.85);
            width: min(960px, 96vw); height: min(680px, 90vh);
            display: flex; flex-direction: column;
            font: 13px/1.5 -apple-system, system-ui, sans-serif;
            overflow: hidden;
          }
          .cv-header {
            display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
            padding: 10px 16px; border-bottom: 1px solid #2d2d44; flex-shrink: 0;
          }
          .cv-mod-name { font-weight: 600; font-size: 14px; }
          .cv-settings {
            display: flex; align-items: center; gap: 8px; flex-wrap: wrap; flex: 1;
          }
          .cv-label { font-size: 11px; color: #666; }
          .cv-select {
            background: #2d2d44; color: #fff; border: 1px solid #3a3a55;
            border-radius: 4px; padding: 3px 8px; font: 12px/1.4 inherit; cursor: pointer;
          }
          .cv-select:focus { outline: none; border-color: #7c7cff; }
          .cv-input {
            background: #2d2d44; color: #fff; border: 1px solid #3a3a55;
            border-radius: 4px; padding: 3px 8px; font: 12px/1.4 inherit; width: 180px;
          }
          .cv-input:focus { outline: none; border-color: #7c7cff; }
          .cv-dirty-row {
            display: none; align-items: center; gap: 6px;
          }
          .cv-dirty-row.visible { display: flex; }
          .cv-save-btn {
            background: #7c7cff; color: #fff; border: none; border-radius: 4px;
            padding: 3px 12px; font: 12px inherit; cursor: pointer;
          }
          .cv-save-btn:hover { background: #6a6aee; }
          .cv-cancel-btn {
            background: none; color: #aaa; border: 1px solid #444; border-radius: 4px;
            padding: 3px 10px; font: 12px inherit; cursor: pointer;
          }
          .cv-cancel-btn:hover { color: #fff; border-color: #777; }
          .cv-save-flash { font-size: 11px; color: #7c7cff; }
          .cv-close {
            margin-left: auto; background: none; border: none; color: #666;
            cursor: pointer; font-size: 22px; line-height: 1; padding: 0 4px; border-radius: 4px;
          }
          .cv-close:hover { color: #fff; }
          .cv-tabs {
            display: flex; border-bottom: 1px solid #2d2d44; background: #13132a;
            flex-shrink: 0; overflow-x: auto;
          }
          .cv-tab {
            background: none; border: none; border-bottom: 2px solid transparent;
            color: #777; padding: 8px 16px; font: inherit; font-size: 12px;
            cursor: pointer; white-space: nowrap; flex-shrink: 0;
          }
          .cv-tab:hover { color: #ddd; }
          .cv-tab.active { color: #fff; border-bottom-color: #7c7cff; }
          .cv-editor-wrap { flex: 1; overflow: hidden; position: relative; }
          .cv-loading {
            position: absolute; inset: 0; display: flex; align-items: center;
            justify-content: center; color: #555; font-size: 13px;
          }
        </style>
        <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/monaco-editor@0.52.0/min/vs/editor/editor.main.css"/>
        <div class="cv-overlay">
          <div class="cv-modal">
            <div class="cv-header">
              <span class="cv-mod-name"></span>
              <div class="cv-settings">
                <span class="cv-label">Trigger</span>
                <select class="cv-select cv-trigger-sel">
                  <option value="IMMEDIATE">IMMEDIATE</option>
                  <option value="DOM_READY">DOM_READY</option>
                  <option value="ELEMENT_LOADED">ELEMENT_LOADED</option>
                  <option value="AFTER_CODE_BLOCK">AFTER_CODE_BLOCK</option>
                </select>
                <input class="cv-input cv-selector-input" placeholder="CSS selector" style="display:none"/>
                <select class="cv-select cv-dependency-sel" style="display:none"></select>
                <div class="cv-dirty-row">
                  <button class="cv-save-btn">Save</button>
                  <button class="cv-cancel-btn">Cancel</button>
                  <span class="cv-save-flash" style="display:none">Saved</span>
                </div>
              </div>
              <button class="cv-close">&times;</button>
            </div>
            <div class="cv-tabs"></div>
            <div class="cv-editor-wrap">
              <div class="cv-loading">Loading editor…</div>
            </div>
          </div>
        </div>
      \`;

      const overlay = this._root.querySelector('.cv-overlay');
      this._root.querySelector('.cv-close').addEventListener('click', () => this._close());
      overlay.addEventListener('click', (e) => { if (e.target === overlay) this._close(); });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && overlay.classList.contains('open')) this._close();
      });

      // Track dirty state when trigger settings change
      const trigSel  = this._root.querySelector('.cv-trigger-sel');
      const selInput = this._root.querySelector('.cv-selector-input');
      const depSel   = this._root.querySelector('.cv-dependency-sel');
      const dirtyRow = this._root.querySelector('.cv-dirty-row');
      const saveBtn  = this._root.querySelector('.cv-save-btn');
      const cancelBtn= this._root.querySelector('.cv-cancel-btn');

      const updateExtras = () => {
        selInput.style.display = trigSel.value === 'ELEMENT_LOADED'   ? '' : 'none';
        depSel.style.display   = trigSel.value === 'AFTER_CODE_BLOCK' ? '' : 'none';
      };
      const markDirty = () => { dirtyRow.classList.add('visible'); };
      trigSel.addEventListener('change', () => { updateExtras(); markDirty(); });
      selInput.addEventListener('input', markDirty);
      depSel.addEventListener('change', markDirty);

      saveBtn.addEventListener('click', async () => {
        const flash = this._root.querySelector('.cv-save-flash');
        const payload = {
          action: 'update-modification-trigger',
          expSlug: this._expSlug,
          varSlug: this._varSlug,
          modSlug: this._modData.slug,
          trigger: trigSel.value,
        };
        if (trigSel.value === 'ELEMENT_LOADED')    payload.selector   = selInput.value.trim();
        if (trigSel.value === 'AFTER_CODE_BLOCK')  payload.dependency = depSel.value;
        const res = await this._cmd(payload);
        if (res.ok) {
          dirtyRow.classList.remove('visible');
          flash.style.display = '';
          setTimeout(() => { flash.style.display = 'none'; }, 1800);
          this._modData.trigger    = trigSel.value;
          this._modData.dependency = depSel.value;
        }
      });

      cancelBtn.addEventListener('click', () => {
        this._resetTriggerUi();
        dirtyRow.classList.remove('visible');
      });
    }

    _resetTriggerUi() {
      const mod      = this._modData;
      const allMods  = this._allMods || [];
      const trigSel  = this._root.querySelector('.cv-trigger-sel');
      const selInput = this._root.querySelector('.cv-selector-input');
      const depSel   = this._root.querySelector('.cv-dependency-sel');

      trigSel.value  = mod.trigger || 'DOM_READY';
      selInput.value = mod.selector || '';

      // Populate dependency dropdown with other blocks in the same variation
      const others = allMods.filter(m => m.slug !== mod.slug);
      depSel.innerHTML = others.length
        ? others.map(m =>
            \`<option value="\${m.slug}"\${m.slug === mod.dependency ? ' selected' : ''}>\${m.name} (\${m.slug})</option>\`
          ).join('')
        : '<option value="" disabled>No other blocks in this variation</option>';
      if (mod.dependency && others.some(m => m.slug === mod.dependency)) {
        depSel.value = mod.dependency;
      }

      selInput.style.display = trigSel.value === 'ELEMENT_LOADED'   ? '' : 'none';
      depSel.style.display   = trigSel.value === 'AFTER_CODE_BLOCK' ? '' : 'none';
    }

    _cmd(payload) {
      return new Promise((resolve) => {
        if (!this._ws || this._ws.readyState !== 1) {
          this._ws = new WebSocket('${wsUrl}');
        }
        const id = Math.random().toString(36).slice(2);
        const msg = JSON.stringify({ ...payload, id });
        const handler = (e) => {
          let data; try { data = JSON.parse(e.data); } catch { return; }
          if (data.type === 'cmd-result' && data.id === id) {
            this._ws.removeEventListener('message', handler);
            resolve(data);
          }
        };
        if (this._ws.readyState === 1) {
          this._ws.addEventListener('message', handler);
          this._ws.send(msg);
        } else {
          this._ws.addEventListener('open', () => {
            this._ws.addEventListener('message', handler);
            this._ws.send(msg);
          });
        }
      });
    }

    open(modData, expSlug, varSlug, allMods) {
      this._modData = modData;
      this._expSlug = expSlug;
      this._varSlug = varSlug;
      this._allMods = allMods || [];

      this._root.querySelector('.cv-mod-name').textContent = modData.name || modData.slug;
      this._resetTriggerUi();
      this._root.querySelector('.cv-dirty-row').classList.remove('visible');
      this._root.querySelector('.cv-save-flash').style.display = 'none';

      // Build tabs
      const tabsEl  = this._root.querySelector('.cv-tabs');
      const allFiles = modData.resources || [];
      tabsEl.innerHTML = allFiles.map((f, i) =>
        \`<button class="cv-tab\${i === 0 ? ' active' : ''}" data-file="\${f}">\${f}</button>\`
      ).join('');
      tabsEl.querySelectorAll('.cv-tab').forEach(tab => {
        tab.addEventListener('click', () => {
          tabsEl.querySelectorAll('.cv-tab').forEach(t => t.classList.remove('active'));
          tab.classList.add('active');
          this._loadFile(tab.dataset.file);
        });
      });

      this._root.querySelector('.cv-overlay').classList.add('open');
      this._initMonaco().then(() => {
        if (allFiles.length) this._loadFile(allFiles[0]);
      });
    }

    _close() {
      this._root.querySelector('.cv-overlay').classList.remove('open');
    }

    async _initMonaco() {
      if (window.monaco) {
        if (!this._editor) this._createEditor();
        return;
      }
      if (!window.__ss_monaco_loading) {
        window.__ss_monaco_loading = new Promise((resolve) => {
          const script = document.createElement('script');
          script.src = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.0/min/vs/loader.min.js';
          script.onload = () => {
            window.require.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.0/min/vs' } });
            window.require(['vs/editor/editor.main'], resolve);
          };
          document.head.appendChild(script);
        });
      }
      await window.__ss_monaco_loading;
      if (!this._editor) this._createEditor();
    }

    _createEditor() {
      const wrap    = this._root.querySelector('.cv-editor-wrap');
      const loading = wrap.querySelector('.cv-loading');
      const container = document.createElement('div');
      container.style.cssText = 'position:absolute;inset:0;';
      wrap.appendChild(container);
      if (loading) loading.remove();
      this._editor = window.monaco.editor.create(container, {
        value: '',
        language: 'javascript',
        readOnly: true,
        theme: 'vs-dark',
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        fontSize: 12,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        automaticLayout: true,
      });
    }

    async _loadFile(filename) {
      if (!filename) return;
      try {
        const url = '${ssOrigin}/__ss__/file-content?exp=' + encodeURIComponent(this._expSlug)
          + '&var=' + encodeURIComponent(this._varSlug)
          + '&mod=' + encodeURIComponent(this._modData.slug)
          + '&file=' + encodeURIComponent(filename);
        const { content } = await fetch(url).then(r => r.json());
        if (!this._editor) return;
        const ext = filename.split('.').pop().toLowerCase();
        const langMap = { js:'javascript', mjs:'javascript', cjs:'javascript', ts:'typescript', tsx:'typescript', jsx:'javascript', css:'css', scss:'scss', sass:'scss', html:'html' };
        const lang = langMap[ext] || 'plaintext';
        const oldModel = this._editor.getModel();
        const newModel = window.monaco.editor.createModel(content || '', lang);
        this._editor.setModel(newModel);
        if (oldModel) oldModel.dispose();
      } catch (_) {}
    }
  }

  if (!customElements.get('ss-floating-menu')) {
    customElements.define('ss-floating-menu', SsFloatingMenu);
  }
  if (!customElements.get('ss-modal')) {
    customElements.define('ss-modal', SsModal);
  }
  if (!customElements.get('ss-code-viewer')) {
    customElements.define('ss-code-viewer', SsCodeViewer);
  }
  document.body.appendChild(document.createElement('ss-floating-menu'));
  document.body.appendChild(document.createElement('ss-modal'));
  document.body.appendChild(document.createElement('ss-code-viewer'));
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
/**
 * Handle a WebSocket command message sent from <ss-modal>.
 * Each action mutates config.json and optionally broadcasts a reload.
 *
 * @param {object} msg      - Parsed message with { action, ...payload }
 * @param {Function} broadcast - Broadcast function to push reload/etc to all clients
 * @param {Function} reply  - Send a cmd-result back to the originating WS client
 */
async function handleCommand(msg, broadcast, reply) {
  const config  = loadConfig();
  const expSlug = msg.expSlug || config.active?.experience;
  const exp     = config.experiences?.find((e) => e.slug === expSlug);
  if (!exp && msg.action !== 'set-page-rules') {
    return reply({ ok: false, error: 'Experience not found' });
  }

  const { writeCacheEntry, scaffoldVariation } = await import('./scaffold.mjs');

  switch (msg.action) {

    case 'switch-variation': {
      const v = exp.variations?.find((v) => v.slug === msg.varSlug);
      if (!v) return reply({ ok: false, error: 'Variation not found' });
      if (msg.varSlug !== 'control') {
        const varDir = join(process.cwd(), 'experiences', expSlug, msg.varSlug);
        if (!existsSync(varDir)) return reply({ ok: false, error: 'Variation directory not found' });
      }
      writeCacheEntry(expSlug, msg.varSlug);
      config.active.variation = msg.varSlug;
      saveConfig(config);
      reply({ ok: true });
      broadcast({ type: 'reload' });
      break;
    }

    case 'rename-variation': {
      const v = exp.variations?.find((v) => v.slug === msg.varSlug);
      if (!v) return reply({ ok: false, error: 'Variation not found' });
      v.name = msg.name;
      saveConfig(config);
      reply({ ok: true });
      break;
    }

    case 'reorder-variations': {
      // msg.order = array of slugs in new order; control must stay first
      const bySlug = Object.fromEntries((exp.variations || []).map((v) => [v.slug, v]));
      const reordered = msg.order.map((s) => bySlug[s]).filter(Boolean);
      if (reordered[0]?.slug !== 'control' && bySlug['control']) {
        reordered.unshift(bySlug['control']);
      }
      exp.variations = reordered;
      saveConfig(config);
      reply({ ok: true });
      break;
    }

    case 'create-variation': {
      const varSlug = scaffoldVariation(expSlug, msg.name);
      reply({ ok: true, varSlug });
      broadcast({ type: 'reload' });
      break;
    }

    case 'delete-variation': {
      if (msg.varSlug === 'control') return reply({ ok: false, error: 'Cannot delete Control' });
      const idx = exp.variations?.findIndex((v) => v.slug === msg.varSlug);
      if (idx < 0) return reply({ ok: false, error: 'Variation not found' });
      exp.variations.splice(idx, 1);
      if (config.active?.variation === msg.varSlug) config.active.variation = 'control';
      saveConfig(config);
      const varDir = join(process.cwd(), 'experiences', expSlug, msg.varSlug);
      if (existsSync(varDir)) rmSync(varDir, { recursive: true, force: true });
      reply({ ok: true });
      broadcast({ type: 'reload' });
      break;
    }

    case 'rename-modification': {
      const v = exp.variations?.find((v) => v.slug === msg.varSlug);
      const m = v?.modifications?.find((m) => m.slug === msg.modSlug);
      if (!m) return reply({ ok: false, error: 'Modification not found' });
      m.name = msg.name;
      saveConfig(config);
      reply({ ok: true });
      break;
    }

    case 'reorder-modifications': {
      const v = exp.variations?.find((v) => v.slug === msg.varSlug);
      if (!v) return reply({ ok: false, error: 'Variation not found' });
      const bySlug = Object.fromEntries((v.modifications || []).map((m) => [m.slug, m]));
      v.modifications = msg.order.map((s) => bySlug[s]).filter(Boolean);
      saveConfig(config);
      writeCacheEntry(expSlug, msg.varSlug);
      reply({ ok: true });
      break;
    }

    case 'delete-modification': {
      const v = exp.variations?.find((v) => v.slug === msg.varSlug);
      const idx = v?.modifications?.findIndex((m) => m.slug === msg.modSlug);
      if (idx === undefined || idx < 0) return reply({ ok: false, error: 'Modification not found' });
      v.modifications.splice(idx, 1);
      saveConfig(config);
      writeCacheEntry(expSlug, msg.varSlug);
      const blockDir = join(process.cwd(), 'experiences', expSlug, msg.varSlug, msg.modSlug);
      if (existsSync(blockDir)) rmSync(blockDir, { recursive: true, force: true });
      reply({ ok: true });
      broadcast({ type: 'reload' });
      break;
    }

    case 'set-page-rules': {
      if (!exp) return reply({ ok: false, error: 'Experience not found' });
      if (!exp.pages) exp.pages = {};
      if (Array.isArray(msg.include)) exp.pages.include = msg.include;
      if (Array.isArray(msg.exclude)) exp.pages.exclude = msg.exclude;
      saveConfig(config);
      reply({ ok: true });
      break;
    }

    case 'rename-experience': {
      if (!msg.name?.trim()) return reply({ ok: false, error: 'Name required' });
      exp.name = msg.name.trim();
      saveConfig(config);
      reply({ ok: true });
      break;
    }

    case 'toggle-variation': {
      const v = exp.variations?.find((v) => v.slug === msg.varSlug);
      if (!v) return reply({ ok: false, error: 'Variation not found' });
      if (msg.varSlug === 'control') return reply({ ok: false, error: 'Cannot disable Control' });
      v.enabled = v.enabled === false ? true : false;
      saveConfig(config);
      reply({ ok: true, enabled: v.enabled });
      break;
    }

    case 'toggle-modification': {
      const v = exp.variations?.find((v) => v.slug === msg.varSlug);
      const m = v?.modifications?.find((m) => m.slug === msg.modSlug);
      if (!m) return reply({ ok: false, error: 'Modification not found' });
      m.enabled = m.enabled === false ? true : false;
      saveConfig(config);
      writeCacheEntry(expSlug, msg.varSlug);
      reply({ ok: true, enabled: m.enabled });
      break;
    }

    case 'update-project-settings': {
      if (!config.settings) config.settings = {};
      if (typeof msg.inject_jquery      === 'boolean') config.settings.inject_jquery      = msg.inject_jquery;
      if (typeof msg.inject_fontawesome === 'boolean') config.settings.inject_fontawesome = msg.inject_fontawesome;
      if (typeof msg.spa                === 'boolean') config.settings.spa                = msg.spa;
      if (typeof msg.cache_ttl          === 'number')  config.settings.cache_ttl          = msg.cache_ttl;
      if (typeof msg.timeout_ms         === 'number')  config.settings.timeout_ms         = msg.timeout_ms;
      saveConfig(config);
      reply({ ok: true });
      // No reload needed — tool injections and SPA mode take effect on the next page load.
      break;
    }

    case 'update-modification-trigger': {
      const v = exp.variations?.find((v) => v.slug === msg.varSlug);
      const m = v?.modifications?.find((m) => m.slug === msg.modSlug);
      if (!m) return reply({ ok: false, error: 'Modification not found' });
      const TRIGGERS = ['IMMEDIATE', 'DOM_READY', 'ELEMENT_LOADED', 'AFTER_CODE_BLOCK'];
      if (!TRIGGERS.includes(msg.trigger)) return reply({ ok: false, error: 'Invalid trigger' });
      m.trigger = msg.trigger;
      if (msg.trigger === 'ELEMENT_LOADED')   { m.selector   = msg.selector   || ''; delete m.dependency; }
      else if (msg.trigger === 'AFTER_CODE_BLOCK') { m.dependency = msg.dependency || ''; delete m.selector; }
      else { delete m.selector; delete m.dependency; }
      saveConfig(config);
      writeCacheEntry(expSlug, msg.varSlug);
      reply({ ok: true });
      break;
    }

    default:
      reply({ ok: false, error: `Unknown action: ${msg.action}` });
  }
}

export async function startProxy(targetUrl, port = 3000, { pwFetcher = null } = {}) {
  const app = express();

  const targetOrigin = new URL(targetUrl).origin;
  const targetDomain = new URL(targetUrl).hostname;
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

  // ── ROUTE 4: Full project tree for the management modal ─────────────────
  app.get("/__ss__/project", (_req, res) => {
    const config = loadConfig();
    const expSlug = config.active?.experience;
    const exp = config.experiences?.find((e) => e.slug === expSlug);
    res.json({
      experiences: config.experiences || [],
      editorUrl: exp?.pages?.editor || '',
      _settings: config.settings || {},
    });
  });

  // ── ROUTE 5: Update settings (editor URL) ────────────────────────────────
  app.use(express.json());
  app.post("/__ss__/settings", (req, res) => {
    const { editorUrl } = req.body || {};
    const config = loadConfig();
    const expSlug = config.active?.experience;
    const exp = config.experiences?.find((e) => e.slug === expSlug);
    if (exp && editorUrl) {
      if (!exp.pages) exp.pages = {};
      exp.pages.editor = editorUrl;
      saveConfig(config);
      console.log(`  ✔ Editor URL updated: ${editorUrl}`);
    }
    res.json({ ok: true });
  });

  // ── ROUTE 6: Switch active variation ─────────────────────────────────────
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

  // ── ROUTE 7: Raw config.json for the Developer tab ──────────────────────
  app.get("/__ss__/raw-config", (_req, res) => {
    res.json(loadConfig());
  });

  // ── ROUTE 8: In-memory log buffer for the Developer tab ──────────────────
  app.get("/__ss__/logs", (_req, res) => {
    res.json(_logs);
  });

  // ── ROUTE 9b: HTML snippet for SPA re-apply ──────────────────────────────
  app.get("/__ss__/html-snippet", (_req, res) => {
    res.json({ html: loadVariationHtml() });
  });

  // ── ROUTE 9: Timestamps for Developer tab (cache + context mtimes) ────────
  app.get("/__ss__/status", (_req, res) => {
    const result = { cache: null, context: null, screenshots: null };

    // Last cache write — stat the domain subdirectory
    const cacheSubdir = join(CACHE_DIR, targetDomain.replace(/[^a-zA-Z0-9.-]/g, '_'));
    try { result.cache = statSync(cacheSubdir).mtimeMs; } catch (_) {}

    // Last context capture — body.html and desktop screenshot
    try { result.context     = statSync(join(process.cwd(), '.context', 'content', 'body.html')).mtimeMs; } catch (_) {}
    try { result.screenshots = statSync(join(process.cwd(), '.context', 'screenshots', 'desktop.png')).mtimeMs; } catch (_) {}

    res.json(result);
  });

  // ── ROUTE 10: Serve a single modification file for the code viewer ─────────
  app.get("/__ss__/file-content", (req, res) => {
    const { exp: expQ, var: varQ, mod: modQ, file: fileQ } = req.query;
    const slugRe = /^[a-z0-9-]+$/;
    const fileRe = /^[\w.-]+\.(js|ts|tsx|jsx|mjs|cjs|css|scss|sass|html)$/i;
    if (!expQ || !varQ || !modQ || !fileQ
        || !slugRe.test(expQ) || !slugRe.test(varQ) || !slugRe.test(modQ)
        || !fileRe.test(fileQ)) {
      return res.status(400).json({ error: 'Invalid params' });
    }
    const filePath = join(process.cwd(), 'experiences', expQ, varQ, modQ, fileQ);
    try {
      res.json({ content: readFileSync(filePath, 'utf8') });
    } catch (_) {
      res.json({ content: '' });
    }
  });

  // ── MIDDLEWARE: Local resource cache ─────────────────────────────────────
  app.use((req, res, next) => {
    if (req.method !== "GET") return next();
    const cachePath = getCachePath(req.path, targetDomain);
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
                writeToCache(req.path, responseBuffer, targetDomain);
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

              if (isCacheable(contentType)) writeToCache(req.path, responseBuffer, targetDomain);
              return responseBuffer;
            },
          ),
        },
      }),
    );
  }

  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => {
      console.log(`\n✔ Proxy running → http://localhost:${port}`);
      console.log(`  Mirroring: ${targetUrl}\n`);
      resolve(broadcast);
    });

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`\n✖ Port ${port} is already in use.`);
        console.error(`  Another ss server may be running. Try:`);
        console.error(`    ss stop               (stop a background server)`);
        console.error(`    ss start --port 3001  (use a different port)`);
        process.exit(1);
      }
      reject(err);
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

    // Absorb WSS-level errors (e.g. if the underlying server fails to bind).
    // The server 'error' handler above already calls process.exit for EADDRINUSE.
    wss.on('error', (_err) => {});

    // Handle inbound command messages from <ss-modal>.
    // Each message must have a unique { id } so the reply can be matched.
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }
        if (!msg?.action) return;
        const reply = (result) => {
          try { ws.send(JSON.stringify({ type: 'cmd-result', id: msg.id, ...result })); } catch (_) {}
        };
        handleCommand(msg, broadcast, reply).catch((err) => reply({ ok: false, error: err.message }));
      });
    });
  });
}
