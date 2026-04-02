/**
 * db.mjs — Project registry (JSON file store)
 *
 * Stores a list of registered project paths in ~/.ss-proxy/projects.json.
 * The source of truth for all experience/variation/page-rule data remains
 * each project's own config.json; this file is just a roster of paths.
 *
 * Schema (per entry):
 *   { id: number, path: string, enabled: boolean, added_at: number }
 *
 * Usage:
 *   import { register, unregister, list, listActive, setEnabled, get, closeDB } from './db.mjs';
 *
 *   register('/home/user/my-project');
 *   list();        // → [{ id, path, enabled, added_at }, ...]
 *   setEnabled('/home/user/my-project', false);
 *   unregister('/home/user/my-project');
 *
 * Note: closeDB() is a no-op kept for API compatibility with a SQLite implementation.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';

// ─── Paths ────────────────────────────────────────────────────────────────────

const DATA_DIR = join(homedir(), '.ss-proxy');
const DB_PATH  = join(DATA_DIR, 'projects.json');

// ─── In-memory store ──────────────────────────────────────────────────────────

/** @type {Array<{ id: number, path: string, enabled: number, added_at: number }>} */
let _projects = null;

// ─── Persistence ─────────────────────────────────────────────────────────────

function ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function load() {
  if (_projects !== null) return;
  ensureDir();
  if (!existsSync(DB_PATH)) { _projects = []; return; }
  try {
    _projects = JSON.parse(readFileSync(DB_PATH, 'utf8'));
    if (!Array.isArray(_projects)) _projects = [];
  } catch {
    _projects = [];
  }
}

function save() {
  ensureDir();
  writeFileSync(DB_PATH, JSON.stringify(_projects, null, 2), 'utf8');
}

function nextId() {
  return _projects.length === 0
    ? 1
    : Math.max(..._projects.map(p => p.id)) + 1;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normPath(p) {
  return resolve(p);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Register a project directory. Idempotent — re-registering an existing path
 * is a no-op and does not reset the enabled state.
 *
 * @param {string} projectPath  Absolute or relative path to the project directory.
 * @returns {{ created: boolean, project: object }}
 */
export function register(projectPath) {
  load();
  const path = normPath(projectPath);

  if (!existsSync(join(path, 'config.json'))) {
    throw new Error(`No config.json found in ${path}. Run \`ss init\` first.`);
  }

  const existing = _projects.find(p => p.path === path);
  if (existing) return { created: false, project: existing };

  const project = { id: nextId(), path, enabled: 1, added_at: Date.now() };
  _projects.push(project);
  save();
  return { created: true, project };
}

/**
 * Remove a project from the registry. Does not touch the project directory.
 *
 * @param {string} projectPath
 * @returns {{ removed: boolean }}
 */
export function unregister(projectPath) {
  load();
  const path    = normPath(projectPath);
  const before = _projects.length;
  _projects    = _projects.filter(p => p.path !== path);
  const removed = _projects.length < before;
  if (removed) save();
  return { removed };
}

/**
 * Return all registered projects.
 *
 * @returns {Array<{ id: number, path: string, enabled: number, added_at: number }>}
 */
export function list() {
  load();
  return [..._projects].sort((a, b) => a.added_at - b.added_at);
}

/**
 * Return all enabled projects whose config.json still exists on disk.
 *
 * @returns {Array<{ id: number, path: string, enabled: number, added_at: number }>}
 */
export function listActive() {
  return list().filter(p => p.enabled && existsSync(join(p.path, 'config.json')));
}

/**
 * Enable or disable a project without removing it.
 *
 * @param {string}  projectPath
 * @param {boolean} enabled
 * @returns {{ updated: boolean }}
 */
export function setEnabled(projectPath, enabled) {
  load();
  const path    = normPath(projectPath);
  const project = _projects.find(p => p.path === path);
  if (!project) return { updated: false };
  project.enabled = enabled ? 1 : 0;
  save();
  return { updated: true };
}

/**
 * Look up a single project by path.
 *
 * @param {string} projectPath
 * @returns {object|null}
 */
export function get(projectPath) {
  load();
  return _projects.find(p => p.path === normPath(projectPath)) ?? null;
}

/**
 * No-op — kept for API compatibility. JSON store has no connection to close.
 */
export function closeDB() {}

/**
 * Expose the data file path so the uninstaller can locate it.
 */
export { DB_PATH };
