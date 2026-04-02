/**
 * proxy.mjs — MITM proxy server for ss-proxy-service
 *
 * Intercepts all HTTP and HTTPS traffic routed through the OS system proxy.
 * For each HTML response, checks whether the URL matches any registered
 * project's targeting rules and injects the ss payload if so.
 *
 * HTTP:  Standard forward proxy — reads the full URL from the request line,
 *        forwards to origin, intercepts the response.
 *
 * HTTPS: CONNECT tunnel — terminates TLS using a per-hostname fake certificate
 *        signed by the local CA, then handles the decrypted request as HTTP.
 *        Uses cert.mjs to generate/cache certificates on demand.
 *
 * /__ss__/* routes on any hostname are intercepted before forwarding and
 * handled locally (bundle serving, WebSocket, variations API, etc.).
 *
 * Usage:
 *   import { startProxy, stopProxy } from './proxy.mjs';
 *   const { port, broadcast } = await startProxy({ port: 8080, projects });
 */

import { createServer as createHttpServer, request as httpRequest } from 'http';
import { request as httpsRequest, createServer as createHttpsServer } from 'https';
import { connect as netConnect } from 'net';
import { WebSocketServer } from 'ws';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { URL } from 'url';

import { getCert, ensureCA }              from './cert.mjs';
import { listActive, list as listAll }   from './db.mjs';
import { match, loadAll, testPages }     from './matcher.mjs';
import { inject, stripSecurityHeaders }  from './injector.mjs';
import { startIpcServer, stopIpcServer } from './ipc.mjs';
import { startWatching, onConfigChange } from './watcher.mjs';
import { log }                           from './logger.mjs';

// ─── Constants ────────────────────────────────────────────────────────────────

const SS_PATH_PREFIX = '/__ss__/';
const HTML_TYPES     = new Set(['text/html', 'application/xhtml+xml']);

// ─── State ────────────────────────────────────────────────────────────────────

let _httpServer  = null;   // the main forward-proxy TCP server
let _wss         = null;   // WebSocket server (attached to _httpServer)
let _projects    = [];     // current list from db.listActive()
let _wsChannels  = new Map(); // projectId (string) → Set<WebSocket>

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isHtml(contentType) {
  if (!contentType) return false;
  const base = contentType.split(';')[0].trim().toLowerCase();
  return HTML_TYPES.has(base);
}

function findProject(id) {
  return _projects.find(p => String(p.id) === String(id)) ?? null;
}

/**
 * Buffer a full HTTP response into memory.
 * Returns { statusCode, headers, body: Buffer }.
 */
function bufferResponse(res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end',  () => resolve({
      statusCode: res.statusCode,
      headers:    res.headers,
      body:       Buffer.concat(chunks),
    }));
    res.on('error', reject);
  });
}

/**
 * Pipe a readable stream to a writable, with error handling.
 */
function pipe(readable, writable) {
  readable.on('error', () => writable.destroy());
  writable.on('error', () => readable.destroy());
  readable.pipe(writable);
}

// ─── /__ss__/* request handler ────────────────────────────────────────────────

/**
 * Handle requests to /__ss__/* that are intercepted before forwarding.
 * Returns true if the request was handled, false to fall through to proxy.
 */
async function handleSsRoute(req, res, projectId, isHttps) {
  const u      = new URL(req.url, `http://${req.headers.host}`);
  const ssPath = u.pathname; // e.g. /__ss__/bundle.js

  // CORS headers for all /__ss__/ responses
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return true; }

  const pid = projectId || u.searchParams.get('project');

  // ── Bundle ──────────────────────────────────────────────────────────────────
  if (ssPath === '/__ss__/bundle.js') {
    const project = findProject(pid);
    if (!project) { res.writeHead(404); res.end('// project not found'); return true; }
    const bundlePath = join(project.path, 'dist', 'bundle.js');
    if (!existsSync(bundlePath)) { res.writeHead(404); res.end('// bundle not built'); return true; }
    res.setHeader('Content-Type', 'application/javascript');
    res.setHeader('Cache-Control', 'no-cache');
    res.writeHead(200);
    res.end(readFileSync(bundlePath));
    return true;
  }

  // ── Variations list ─────────────────────────────────────────────────────────
  if (ssPath === '/__ss__/variations') {
    const project = findProject(pid);
    if (!project) { res.writeHead(404); res.end('{}'); return true; }
    try {
      const config = JSON.parse(readFileSync(join(project.path, 'config.json'), 'utf8'));
      const expSlug = config.active?.experience;
      const exp     = config.experiences?.find(e => e.slug === expSlug);
      const all     = (exp?.variations || [])
        .filter(v => v.enabled !== false)
        .map(v => ({ name: v.name, slug: v.slug }));
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      res.end(JSON.stringify({ active: config.active?.variation, all }));
    } catch { res.writeHead(500); res.end('{}'); }
    return true;
  }

  // ── Variation switch ────────────────────────────────────────────────────────
  if (ssPath === '/__ss__/switch') {
    const project = findProject(pid);
    if (!project) { res.writeHead(404); res.end(); return true; }
    const varSlug = u.searchParams.get('v');
    try {
      const configPath = join(project.path, 'config.json');
      const config     = JSON.parse(readFileSync(configPath, 'utf8'));
      if (config.active) config.active.variation = varSlug;
      const { writeFileSync } = await import('fs');
      writeFileSync(configPath, JSON.stringify(config, null, 2));
      broadcast(pid, { type: 'reload' });
    } catch { /* ignore */ }
    res.writeHead(204);
    res.end();
    return true;
  }

  // ── Config ──────────────────────────────────────────────────────────────────
  if (ssPath === '/__ss__/config') {
    const project = findProject(pid);
    if (!project) { res.writeHead(404); res.end('{}'); return true; }
    try {
      const config    = JSON.parse(readFileSync(join(project.path, 'config.json'), 'utf8'));
      const expSlug   = config.active?.experience;
      const varSlug   = config.active?.variation;
      const exp       = config.experiences?.find(e => e.slug === expSlug);
      const variation = exp?.variations?.find(v => v.slug === varSlug);
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      res.end(JSON.stringify({
        experience:    exp      ? { name: exp.name,       slug: exp.slug       } : null,
        variation:     variation ? { name: variation.name, slug: variation.slug } : null,
        modifications: (variation?.modifications || []).filter(m => m?.slug),
      }));
    } catch { res.writeHead(500); res.end('{}'); }
    return true;
  }

  return false; // not an /__ss__/ route we handle
}

// ─── Broadcast helpers ────────────────────────────────────────────────────────

/**
 * Broadcast a message to all WebSocket clients connected for a given project.
 *
 * @param {string|number} projectId
 * @param {object}        message
 */
export function broadcast(projectId, message) {
  const clients = _wsChannels.get(String(projectId));
  if (!clients) return;
  const payload = JSON.stringify(message);
  for (const ws of clients) {
    if (ws.readyState === 1 /* OPEN */) {
      try { ws.send(payload); } catch { /* ignore */ }
    }
  }
}

// ─── HTTP forward-proxy handler ───────────────────────────────────────────────

async function handleHttpRequest(req, res, isHttps = false) {
  try {
    const scheme    = isHttps ? 'https' : 'http';
    const targetUrl = new URL(req.url.startsWith('http') ? req.url : `${scheme}://${req.headers.host}${req.url}`);
    const hostname  = targetUrl.hostname;

    // Check if this is a /__ss__/ management route
    if (targetUrl.pathname.startsWith(SS_PATH_PREFIX)) {
      const pid = targetUrl.searchParams.get('project')
        || _findProjectForHost(hostname)?.id;
      const handled = await handleSsRoute(req, res, pid, isHttps);
      if (handled) return;
    }

    // Find matching project for injection
    const activeProjects = listActive();
    const matchResult    = match(targetUrl.href, activeProjects);

    if (matchResult) {
      log.match(targetUrl.href, matchResult);
    } else {
      // Check if any disabled project would have matched (for visibility)
      _logDisabledMatches(targetUrl.href);
    }

    // Forward the request to the origin
    const requestFn = isHttps ? httpsRequest : httpRequest;
    const options   = {
      hostname: targetUrl.hostname,
      port:     targetUrl.port || (isHttps ? 443 : 80),
      path:     targetUrl.pathname + targetUrl.search,
      method:   req.method,
      headers:  { ...req.headers, host: targetUrl.host },
    };
    // Remove proxy-specific headers
    delete options.headers['proxy-connection'];

    const originReq = requestFn(options, async (originRes) => {
      const contentType = originRes.headers['content-type'] || '';
      const shouldInject = matchResult && isHtml(contentType);

      let headers = { ...originRes.headers };
      if (shouldInject) headers = stripSecurityHeaders(headers);

      if (shouldInject) {
        // Buffer the full response to inject into it
        const { statusCode, body } = await bufferResponse(originRes);
        let html = body.toString('utf8');
        try {
          html = inject(html, matchResult, matchResult.projectId, hostname, isHttps);
          log.inject(targetUrl.href, matchResult);
        } catch (injErr) {
          log.error(targetUrl.href, injErr, 'injection');
          // Serve the unmodified response rather than a 500
        }

        const encoded = Buffer.from(html, 'utf8');
        headers['content-length'] = String(encoded.length);
        delete headers['transfer-encoding']; // we're sending full content-length

        res.writeHead(statusCode, headers);
        res.end(encoded);
      } else {
        // Pass through unchanged
        res.writeHead(originRes.statusCode, headers);
        pipe(originRes, res);
      }
    });

    originReq.on('error', (err) => {
      log.error(targetUrl.href, err, 'forward');
      if (!res.headersSent) {
        res.writeHead(502);
        res.end(`Proxy error: ${err.message}`);
      }
    });

    // Pipe request body (for POST etc.)
    pipe(req, originReq);

  } catch (err) {
    log.error(req.url || '(unknown)', err, 'proxy');
    if (!res.headersSent) {
      res.writeHead(500);
      res.end(`Internal proxy error: ${err.message}`);
    }
  }
}

// ─── HTTPS CONNECT tunnel handler ────────────────────────────────────────────

async function handleConnect(req, clientSocket, head) {
  const [hostname, portStr] = req.url.split(':');
  const port = parseInt(portStr, 10) || 443;

  try {
    // Get (or generate) a fake TLS cert for this hostname
    const { cert, key } = await getCert(hostname);

    // Create an in-process TLS server for this connection
    const tlsServer = createHttpsServer({ cert, key }, (req, res) => handleHttpRequest(req, res, true));

    tlsServer.on('error', () => clientSocket.destroy());

    // Listen on a random local port
    tlsServer.listen(0, '127.0.0.1', () => {
      const tlsPort = tlsServer.address().port;

      // Tell the client the tunnel is established
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) clientSocket.unshift(head);

      // Connect client → our TLS server
      const localSocket = netConnect(tlsPort, '127.0.0.1', () => {
        pipe(clientSocket, localSocket);
        pipe(localSocket, clientSocket);
      });

      localSocket.on('error', () => clientSocket.destroy());
      clientSocket.on('close', () => { localSocket.destroy(); tlsServer.close(); });
      clientSocket.on('error', () => { localSocket.destroy(); tlsServer.close(); });
    });

  } catch (err) {
    // Fall back to transparent tunnel (no injection) on cert errors
    console.warn(`[ss-proxy] cert error for ${hostname}:`, err.message);
    log.warn(`CONNECT cert error for ${hostname}`, { error: err.message });
    const originSocket = netConnect(port, hostname, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) originSocket.write(head);
      pipe(clientSocket, originSocket);
      pipe(originSocket, clientSocket);
    });
    originSocket.on('error', () => clientSocket.destroy());
  }
}

// ─── WebSocket server ─────────────────────────────────────────────────────────

function setupWebSocketServer(httpServer) {
  _wss = new WebSocketServer({ server: httpServer, path: '/__ss__/ws' });

  _wss.on('connection', (ws, req) => {
    const u   = new URL(req.url, 'http://localhost');
    const pid = u.searchParams.get('project') || '';

    if (!_wsChannels.has(pid)) _wsChannels.set(pid, new Set());
    _wsChannels.get(pid).add(ws);

    ws.on('close', () => {
      const ch = _wsChannels.get(pid);
      if (ch) { ch.delete(ws); if (!ch.size) _wsChannels.delete(pid); }
    });

    ws.on('error', () => { /* ignore */ });
  });
}

// ─── Utility ──────────────────────────────────────────────────────────────────

/**
 * Check if any *disabled* project would have matched the given URL.
 * Logs a [disabled] entry for each matching experience found.
 * Only called when no enabled project matched, so it doesn't run on every request.
 *
 * @param {string} url
 */
function _logDisabledMatches(url) {
  try {
    for (const p of listAll()) {
      if (p.enabled) continue;
      try {
        const config = JSON.parse(readFileSync(join(p.path, 'config.json'), 'utf8'));
        for (const exp of config.experiences || []) {
          if (testPages(url, exp.pages)) {
            log.disabledMatch(url, p.id, p.path, exp.slug);
          }
        }
      } catch { /* config unreadable — skip */ }
    }
  } catch { /* db unreadable — skip */ }
}

function _findProjectForHost(hostname) {
  return _projects.find(p => {
    try {
      const config = JSON.parse(readFileSync(join(p.path, 'config.json'), 'utf8'));
      const editor = config.experiences?.[0]?.pages?.editor;
      if (!editor) return false;
      return new URL(editor).hostname === hostname;
    } catch { return false; }
  }) ?? null;
}

// ─── Start / Stop ─────────────────────────────────────────────────────────────

/**
 * Start the MITM proxy.
 *
 * @param {object}  options
 * @param {number}  options.port         Port to listen on (default 8080)
 * @returns {Promise<{ port: number, broadcast: Function, stop: Function }>}
 */
export async function startProxy({ port = 8080 } = {}) {
  await ensureCA();

  // Load active projects into the matcher cache
  _projects = listActive();
  loadAll(_projects);

  // Re-load project list whenever a config.json changes
  onConfigChange(() => {
    _projects = listActive();
    loadAll(_projects);
  });

  // Watch all registered project configs
  startWatching(_projects);

  // Create the main HTTP server (acts as forward proxy)
  _httpServer = createHttpServer(handleHttpRequest);
  _httpServer.on('connect', handleConnect);
  _httpServer.on('error', (err) => {
    console.error('[ss-proxy] server error:', err.message);
  });

  // Attach WebSocket server for live-reload
  setupWebSocketServer(_httpServer);

  // Start IPC server for stop/restart/status commands
  startIpcServer({
    onStop:    () => stopProxy().then(() => process.exit(0)),
    onRestart: () => stopProxy().then(() => startProxy({ port })),
    onReload:  () => {
      _projects = listActive();
      loadAll(_projects);
      startWatching(_projects);
    },
    onStatus:  async () => ({
      port,
      projects: _projects.map(p => ({
        id:      p.id,
        path:    p.path,
        enabled: p.enabled,
      })),
      connections: [..._wsChannels.entries()].map(([pid, set]) => ({
        projectId: pid,
        clients:   set.size,
      })),
    }),
  });

  return new Promise((resolve, reject) => {
    _httpServer.listen(port, '127.0.0.1', () => {
      const actualPort = _httpServer.address().port;
      console.log(`[ss-proxy] Listening on 127.0.0.1:${actualPort}`);
      resolve({
        port:      actualPort,
        broadcast,
        stop:      stopProxy,
      });
    });
    _httpServer.on('error', reject);
  });
}

/**
 * Gracefully shut down the proxy server.
 */
export async function stopProxy() {
  stopIpcServer();

  if (_wss) {
    for (const ws of _wss.clients) try { ws.close(); } catch { /* ignore */ }
    await new Promise(r => _wss.close(r));
    _wss = null;
  }

  if (_httpServer) {
    await new Promise(r => _httpServer.close(r));
    _httpServer = null;
  }

  _wsChannels.clear();
  _projects = [];
}
