/**
 * ipc.mjs — Inter-process communication between the daemon and CLI commands
 *
 * Uses a Unix domain socket on macOS/Linux and a named pipe on Windows.
 * This lets `ss-proxy-service stop`, `restart`, and `status` communicate
 * with a running daemon without relying on signals (which don't carry
 * structured data and aren't available on Windows).
 *
 * Protocol:
 *   Each message is a newline-delimited JSON string.
 *   Client sends:  { action: 'stop' | 'restart' | 'status' }
 *   Server replies: { ok: true, [data] } or { ok: false, error: '...' }
 *
 * Usage (server — call inside the running daemon):
 *   import { startIpcServer, stopIpcServer } from './ipc.mjs';
 *   startIpcServer({ onStop, onRestart, onStatus, onReload });
 *
 * Usage (client — call from CLI commands):
 *   import { sendIpcCommand } from './ipc.mjs';
 *   const reply = await sendIpcCommand({ action: 'status' });
 */

import { createServer, createConnection } from 'net';
import { existsSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir, platform } from 'os';

// ─── Socket path ──────────────────────────────────────────────────────────────

const DATA_DIR   = join(homedir(), '.ss-proxy');
const SOCK_PATH  = platform() === 'win32'
  ? '\\\\.\\pipe\\ss-proxy-service'
  : join(DATA_DIR, 'proxy.sock');

export { SOCK_PATH };

// ─── Server ───────────────────────────────────────────────────────────────────

let _server = null;

/**
 * Start the IPC server inside the running daemon.
 *
 * @param {object} handlers
 * @param {() => void}              handlers.onStop
 * @param {() => void}              handlers.onRestart
 * @param {() => Promise<object>}   handlers.onStatus  Returns data to include in reply
 * @param {() => void}              handlers.onReload   Re-read projects from disk (no downtime)
 */
export function startIpcServer({ onStop, onRestart, onStatus, onReload }) {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

  // Remove stale socket file from a previous (crashed) run
  if (platform() !== 'win32' && existsSync(SOCK_PATH)) {
    try { unlinkSync(SOCK_PATH); } catch { /* ignore */ }
  }

  _server = createServer((socket) => {
    let buf = '';

    socket.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop(); // keep partial line in buffer

      for (const line of lines) {
        if (!line.trim()) continue;
        _handleMessage(line.trim(), socket, { onStop, onRestart, onStatus, onReload });
      }
    });

    socket.on('error', () => { /* client disconnected abruptly */ });
  });

  _server.on('error', (err) => {
    console.error('[ss-proxy] IPC server error:', err.message);
  });

  _server.listen(SOCK_PATH, () => {
    // Socket is ready
  });
}

/**
 * Stop the IPC server and remove the socket file.
 */
export function stopIpcServer() {
  if (_server) {
    _server.close();
    _server = null;
    if (platform() !== 'win32' && existsSync(SOCK_PATH)) {
      try { unlinkSync(SOCK_PATH); } catch { /* ignore */ }
    }
  }
}

// ─── Client ───────────────────────────────────────────────────────────────────

/**
 * Send a command to a running daemon and return the response.
 * Rejects if the daemon is not running (socket not found or connection refused).
 *
 * @param {object}  command       e.g. { action: 'status' }
 * @param {number}  [timeout=5000] ms before giving up
 * @returns {Promise<object>}     The daemon's reply object
 */
export function sendIpcCommand(command, timeout = 5000) {
  return new Promise((resolve, reject) => {
    if (platform() !== 'win32' && !existsSync(SOCK_PATH)) {
      return reject(new Error('Proxy service is not running (socket not found).'));
    }

    const socket = createConnection(SOCK_PATH);
    let buf = '';
    let timer = null;

    const cleanup = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      socket.destroy();
    };

    timer = setTimeout(() => {
      cleanup();
      reject(new Error('IPC command timed out.'));
    }, timeout);

    socket.on('connect', () => {
      socket.write(JSON.stringify(command) + '\n');
    });

    socket.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        cleanup();
        try { resolve(JSON.parse(line)); }
        catch { resolve({ ok: false, error: 'Invalid response from daemon' }); }
        return;
      }
    });

    socket.on('error', (err) => {
      cleanup();
      if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
        reject(new Error('Proxy service is not running.'));
      } else {
        reject(err);
      }
    });

    socket.on('close', () => {
      cleanup();
      reject(new Error('Connection closed before response.'));
    });
  });
}

/**
 * Return true if a daemon appears to be running (socket exists and responds).
 * Does not throw — returns false on any error.
 *
 * @returns {Promise<boolean>}
 */
export async function isDaemonRunning() {
  try {
    await sendIpcCommand({ action: 'status' }, 2000);
    return true;
  } catch {
    return false;
  }
}

// ─── Internal ─────────────────────────────────────────────────────────────────

async function _handleMessage(raw, socket, { onStop, onRestart, onStatus }) {
  const reply = (data) => {
    try { socket.write(JSON.stringify(data) + '\n'); } catch { /* client gone */ }
  };

  let msg;
  try { msg = JSON.parse(raw); }
  catch { return reply({ ok: false, error: 'Invalid JSON' }); }

  switch (msg.action) {
    case 'stop': {
      reply({ ok: true });
      // Give the reply time to flush before shutting down
      setTimeout(() => { try { onStop(); } catch { process.exit(0); } }, 100);
      break;
    }
    case 'restart': {
      reply({ ok: true });
      setTimeout(() => { try { onRestart(); } catch { process.exit(0); } }, 100);
      break;
    }
    case 'status': {
      try {
        const data = await onStatus();
        reply({ ok: true, ...data });
      } catch (err) {
        reply({ ok: false, error: err.message });
      }
      break;
    }
    case 'reload': {
      try {
        if (onReload) onReload();
        reply({ ok: true });
      } catch (err) {
        reply({ ok: false, error: err.message });
      }
      break;
    }
    default:
      reply({ ok: false, error: `Unknown action: ${msg.action}` });
  }
}
