/**
 * watcher.mjs — File watcher for registered project config.json files
 *
 * Watches each registered project's config.json using Node's fs.watch().
 * When a file changes, it:
 *   1. Invalidates the matcher's config cache for that project
 *   2. Notifies registered change listeners (e.g. the proxy can re-read rules)
 *
 * Handles the common edge cases with fs.watch:
 *   - Debounces rapid successive events (editors often write multiple events)
 *   - Re-attaches the watcher if the file is replaced (rename event)
 *   - Cleans up watchers when a project is unregistered
 *
 * Usage:
 *   import { startWatching, stopWatching, onConfigChange } from './watcher.mjs';
 *
 *   onConfigChange((projectPath) => { ... });   // register a listener
 *   startWatching(listActive());                // call after db.openDB()
 *   startWatchingOne('/path/to/project');       // call after register()
 *   stopWatchingOne('/path/to/project');        // call after unregister()
 *   stopWatching();                             // call on shutdown
 */

import { watch, existsSync } from 'fs';
import { join } from 'path';
import { invalidate } from './matcher.mjs';

// ─── State ────────────────────────────────────────────────────────────────────

/** Map<projectPath, fs.FSWatcher> */
const _watchers  = new Map();

/** Debounce timers: Map<projectPath, NodeJS.Timeout> */
const _debounce  = new Map();

/** Registered change listeners */
const _listeners = new Set();

const DEBOUNCE_MS = 150;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Register a callback to be invoked whenever a config.json changes.
 * The callback receives the absolute project path as its only argument.
 *
 * @param {(projectPath: string) => void} fn
 * @returns {() => void}  Call the returned function to remove the listener.
 */
export function onConfigChange(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

/**
 * Start watching all projects in the provided list.
 * Idempotent — already-watched projects are skipped.
 *
 * @param {Array<{ path: string }>} projects
 */
export function startWatching(projects) {
  for (const p of projects) startWatchingOne(p.path);
}

/**
 * Start watching a single project directory.
 * Idempotent — no-op if already watching.
 *
 * @param {string} projectPath
 */
export function startWatchingOne(projectPath) {
  if (_watchers.has(projectPath)) return;

  const configPath = join(projectPath, 'config.json');
  if (!existsSync(configPath)) return;

  _attach(projectPath, configPath);
}

/**
 * Stop watching a single project. Cleans up the fs.FSWatcher.
 *
 * @param {string} projectPath
 */
export function stopWatchingOne(projectPath) {
  const watcher = _watchers.get(projectPath);
  if (watcher) {
    try { watcher.close(); } catch { /* already closed */ }
    _watchers.delete(projectPath);
  }
  const timer = _debounce.get(projectPath);
  if (timer) {
    clearTimeout(timer);
    _debounce.delete(projectPath);
  }
}

/**
 * Stop all watchers. Call during graceful shutdown.
 */
export function stopWatching() {
  for (const projectPath of _watchers.keys()) stopWatchingOne(projectPath);
}

/**
 * Return the set of currently-watched project paths.
 *
 * @returns {string[]}
 */
export function watchedPaths() {
  return [..._watchers.keys()];
}

// ─── Internal ─────────────────────────────────────────────────────────────────

function _attach(projectPath, configPath) {
  try {
    const watcher = watch(configPath, (eventType) => {
      // 'rename' fires when the file is deleted or replaced by an atomic write
      // (many editors write to a temp file then rename it into place).
      if (eventType === 'rename') {
        // Give the OS a moment to finish the rename, then re-attach.
        stopWatchingOne(projectPath);
        setTimeout(() => {
          if (existsSync(configPath)) _attach(projectPath, configPath);
        }, 200);
      }
      _scheduleChange(projectPath);
    });

    watcher.on('error', (err) => {
      console.warn(`[ss-proxy] watcher error for ${configPath}:`, err.message);
      stopWatchingOne(projectPath);
    });

    _watchers.set(projectPath, watcher);
  } catch (err) {
    console.warn(`[ss-proxy] could not watch ${configPath}:`, err.message);
  }
}

function _scheduleChange(projectPath) {
  // Debounce: cancel any pending fire and restart the timer
  const existing = _debounce.get(projectPath);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    _debounce.delete(projectPath);
    _handleChange(projectPath);
  }, DEBOUNCE_MS);

  _debounce.set(projectPath, timer);
}

function _handleChange(projectPath) {
  // Invalidate the matcher's in-memory config cache
  invalidate(projectPath);

  // Notify all registered listeners
  for (const fn of _listeners) {
    try { fn(projectPath); } catch (err) {
      console.error('[ss-proxy] watcher listener error:', err);
    }
  }
}
