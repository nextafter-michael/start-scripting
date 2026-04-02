/**
 * injector.mjs — HTML injection for the system proxy service
 *
 * Given a MatchResult (from matcher.mjs) and a raw HTML response body, this
 * module builds and inserts the ss injection payload before </body>.
 *
 * Injected blocks (in order):
 *   1. <script data-ss-added="config">   — window.__ss + _applyHtml + _trigger runtime
 *   2. <script data-ss-added="html-init"> — calls _applyHtml() with variation HTML (if any)
 *   3. <script src="/__ss__/bundle.js?project=<id>"> — compiled esbuild bundle
 *   4. <script data-ss-added="runtime">  — WebSocket live-reload + <ss-floating-menu>
 *
 * Unlike the per-project dev server, the /__ss__/* routes are served on the
 * real hostname (intercepted by the proxy before forwarding). The WebSocket
 * URL uses wss:// so it works on HTTPS sites.
 *
 * Usage:
 *   import { inject, stripSecurityHeaders } from './injector.mjs';
 *
 *   const clean = stripSecurityHeaders(responseHeaders);
 *   const html  = inject(rawHtml, matchResult, projectId);
 */

import { readFileSync, existsSync } from 'fs';
import { join, extname } from 'path';

// ─── Security header stripping ────────────────────────────────────────────────

const STRIP_HEADERS = new Set([
  'content-security-policy',
  'content-security-policy-report-only',
  'strict-transport-security',
  'x-frame-options',
]);

/**
 * Return a shallow copy of the headers object with CSP, HSTS, and
 * X-Frame-Options removed so our injected scripts are not blocked.
 *
 * @param {Record<string,string>} headers  Response headers (lowercased keys)
 * @returns {Record<string,string>}
 */
export function stripSecurityHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!STRIP_HEADERS.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

// ─── Variation HTML loader ────────────────────────────────────────────────────

/**
 * Concatenate HTML from all enabled modification blocks for the active variation.
 *
 * @param {object} exp        Experience object from config.json
 * @param {object} variation  Variation object (may be null for Control)
 * @param {string} projectPath
 * @returns {string}
 */
function loadVariationHtml(exp, variation, projectPath) {
  if (!variation?.modifications?.length) return '';

  const parts = [];
  for (const mod of variation.modifications) {
    if (!mod?.slug) continue;
    if (mod.enabled === false) continue;
    const blockDir = join(projectPath, 'experiences', exp.slug, variation.slug, mod.slug);
    for (const file of (mod.resources || [])) {
      if (extname(file).toLowerCase() !== '.html') continue;
      const htmlPath = join(blockDir, file);
      if (!existsSync(htmlPath)) continue;
      try {
        const raw = readFileSync(htmlPath, 'utf8');
        const stripped = raw.replace(/<!--[\s\S]*?-->/g, '').trim();
        if (stripped) parts.push(raw.trim());
      } catch { /* skip unreadable file */ }
    }
  }
  return parts.join('\n');
}

// ─── window.__ss config block ─────────────────────────────────────────────────

/**
 * Build the <script data-ss-added="config"> block that sets window.__ss.
 *
 * @param {object} exp
 * @param {object} variation
 * @param {object} settings   config.settings
 * @returns {string}
 */
function buildConfigBlock(exp, variation, settings = {}) {
  const data = {
    experience:    exp     ? { name: exp.name,       slug: exp.slug       } : null,
    variation:     variation ? { name: variation.name, slug: variation.slug } : null,
    modifications: (variation?.modifications || [])
      .filter(m => m?.slug && m.enabled !== false)
      .map(m => ({
        name: m.name, slug: m.slug, trigger: m.trigger,
        hide_elements_until_code_runs: m.hide_elements_until_code_runs || [],
      })),
    settings: {
      spa:                !!settings.spa,
      inject_jquery:      !!settings.inject_jquery,
      inject_fontawesome: !!settings.inject_fontawesome,
    },
  };

  const spaEnabled    = !!settings.spa;
  const jqueryEnabled = !!settings.inject_jquery;
  const faEnabled     = !!settings.inject_fontawesome;

  return `<script type="text/javascript" data-ss-added="config">
window.__ss = ${JSON.stringify(data)};
window.__ss._nodes = [];
window.__ss._ts    = null;

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

window.__ss._removeAll = function() {
  (window.__ss._nodes || []).forEach(function(n) { if (n.parentNode) n.parentNode.removeChild(n); });
  window.__ss._nodes = [];
  document.querySelectorAll('[data-ss-hide]').forEach(function(el) { el.parentNode && el.parentNode.removeChild(el); });
};

window.__ss._done    = {};
window.__ss._waiting = {};

window.__ss._trigger = function(blocks) {
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
      } else { exec(block); }
    } else if (t === 'ELEMENT_LOADED') {
      var sel = block.selector, once = block.once !== false, fired = false;
      function tryMatch(root) {
        if (!sel) return;
        var el = (root && root.matches && root.matches(sel)) ? root
               : (root && root.querySelector) ? root.querySelector(sel) : null;
        if (!el || (once && fired)) return;
        fired = true; exec(block, el);
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
      if (window.__ss._done[dep]) { exec(block); }
      else {
        if (!window.__ss._waiting[dep]) window.__ss._waiting[dep] = [];
        window.__ss._waiting[dep].push(function() { exec(block); });
      }
    }
  });
};
${spaEnabled ? `
(function() {
  function ssReapply() {
    window.__ss._removeAll();
    window.__ss._done = {}; window.__ss._waiting = {};
    var req = new XMLHttpRequest();
    req.open('GET', '/__ss__/html-snippet', true);
    req.onload = function() {
      if (req.status === 200) {
        try { var d = JSON.parse(req.responseText); if (d.html) window.__ss._applyHtml(d.html); } catch(_) {}
      }
    };
    req.send();
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
  history.pushState    = function() { _push.apply(history, arguments);    ssReapply(); };
  history.replaceState = function() { _replace.apply(history, arguments); ssReapply(); };
  window.addEventListener('popstate', ssReapply);
})();` : ''}
${jqueryEnabled ? `
if (!window.jQuery) {
  var jqs = document.createElement('script');
  jqs.src = 'https://cdn.jsdelivr.net/npm/jquery@3/dist/jquery.min.js';
  jqs.setAttribute('data-ss-added', 'jquery');
  document.head.appendChild(jqs);
}` : ''}
${faEnabled ? `
if (!document.querySelector('link[href*="font-awesome"],link[href*="fontawesome"]')) {
  var fal = document.createElement('link');
  fal.rel  = 'stylesheet';
  fal.href = 'https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6/css/all.min.css';
  fal.setAttribute('data-ss-added', 'fontawesome');
  document.head.appendChild(fal);
}` : ''}
</script>`;
}

// ─── Runtime block (WebSocket + floating menu) ────────────────────────────────

/**
 * Build the <script data-ss-added="runtime"> block.
 *
 * In the system proxy, /__ss__/* is served on the real hostname (intercepted
 * before forwarding), so the WS URL is wss://<hostname>/__ss__/ws?project=<id>.
 *
 * @param {string} projectId  Numeric project id from the DB (as string)
 * @param {string} hostname   e.g. 'example.com'
 * @param {boolean} isHttps
 * @returns {string}
 */
function buildRuntimeBlock(projectId, hostname, isHttps) {
  const wsScheme = isHttps ? 'wss' : 'ws';
  const wsUrl    = `${wsScheme}://${hostname}/__ss__/ws?project=${projectId}`;
  const apiBase  = `${isHttps ? 'https' : 'http'}://${hostname}`;

  return `<script type="text/javascript" data-ss-added="runtime">
(function connectSs() {
  var ws = new WebSocket('${wsUrl}');
  ws.onmessage = function(e) {
    var msg = JSON.parse(e.data);
    if (msg.type === 'reload') { location.reload(); }
    else if (msg.type === 'css-update') {
      var el = document.getElementById('__ss_styles');
      if (el) el.textContent = msg.css; else location.reload();
    } else if (msg.type === 'html-update') { window.__ss._applyHtml(msg.html); }
  };
  ws.onclose = function() { setTimeout(connectSs, 1000); };
})();

try {
  class SsFloatingMenu extends HTMLElement {
    constructor() {
      super();
      this._root = this.attachShadow({ mode: 'closed' });
    }
    async connectedCallback() {
      var data = await fetch('${apiBase}/__ss__/variations?project=${projectId}').then(function(r) { return r.json(); });
      this._root.innerHTML = '<style>:host{display:flex;align-items:center;gap:8px;position:fixed;z-index:2147483645;font:13px/1.4 -apple-system,system-ui,sans-serif;background:#1a1a2e;color:#eee;border-radius:8px;padding:6px 10px;box-shadow:0 2px 12px rgba(0,0,0,.4);user-select:none;right:16px;bottom:16px;}</style>'
        + '<span style="opacity:.6;font-size:11px">ss</span>'
        + (data.all.length > 1
          ? '<select style="background:#2a2a4e;color:#eee;border:none;border-radius:4px;padding:2px 4px;font-size:12px">'
            + data.all.map(function(v) { return '<option value="' + v.slug + '"' + (v.slug === data.active ? ' selected' : '') + '>' + v.name + '</option>'; }).join('')
            + '</select>'
          : '')
        + '<button style="background:none;border:none;color:#eee;cursor:pointer;font-size:14px;padding:0 2px" title="Project manager">⚙</button>';
      var sel = this._root.querySelector('select');
      if (sel) sel.addEventListener('change', function(e) {
        fetch('${apiBase}/__ss__/switch?v=' + e.target.value + '&project=${projectId}');
      });
      this._root.querySelector('button').addEventListener('click', function() {
        document.dispatchEvent(new CustomEvent('ss-open-modal', { bubbles: true }));
      });
    }
  }
  if (!customElements.get('ss-floating-menu')) customElements.define('ss-floating-menu', SsFloatingMenu);
  var menu = document.createElement('ss-floating-menu');
  document.body.appendChild(menu);
} catch(e) { console.error('[ss] floating menu error:', e); }
</script>`;
}

// ─── Main inject function ─────────────────────────────────────────────────────

/**
 * Inject the ss payload into an HTML response body.
 *
 * Processes the HTML in segments, skipping <script> blocks to avoid
 * accidentally matching </body> inside inline JS strings.
 *
 * @param {string}      rawHtml      Full HTML response body
 * @param {MatchResult} matchResult  From matcher.match()
 * @param {number|string} projectId  DB project id
 * @param {string}      hostname     Request hostname (for WS URL)
 * @param {boolean}     isHttps      Whether the request was HTTPS
 * @returns {string}  Modified HTML
 */
export function inject(rawHtml, matchResult, projectId, hostname, isHttps) {
  const { exp, variation, projectPath, config } = matchResult;
  const settings     = config.settings || {};
  const variationHtml = loadVariationHtml(exp, variation, projectPath);

  const configBlock  = buildConfigBlock(exp, variation, settings);
  const htmlInit     = variationHtml
    ? `<script type="text/javascript" data-ss-added="html-init">window.__ss._applyHtml(${JSON.stringify(variationHtml)});</script>`
    : '';
  const bundleTag    = `<script type="text/javascript" src="/__ss__/bundle.js?project=${projectId}" data-ss-added="bundle"></script>`;
  const runtimeBlock = buildRuntimeBlock(String(projectId), hostname, isHttps);

  const fullSnippet  = [configBlock, htmlInit, bundleTag, runtimeBlock]
    .filter(Boolean)
    .join('\n');

  // Split on <script>...</script> blocks so we never inspect their contents
  const scriptRe = /(<script[\s\S]*?<\/script>)/gi;
  let injected   = false;

  let result = rawHtml
    .split(scriptRe)
    .map((part, i) => {
      if (i % 2 !== 0) return part; // odd indices are captured script blocks — skip
      if (!injected && /<\/body>/i.test(part)) {
        injected = true;
        return part.replace(/<\/body>/i, fullSnippet + '\n</body>');
      }
      return part;
    })
    .join('');

  // No </body> found — append at end (malformed HTML)
  if (!injected) result += fullSnippet;

  return result;
}
