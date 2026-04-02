/**
 * matcher.mjs — URL rule evaluation against registered project configs
 *
 * Loads config.json from every active project, then tests a request URL
 * against each experience's pages.include / pages.exclude rules to find
 * which (if any) experience + variation should be injected.
 *
 * Rule types:  URL_MATCHES | URL_CONTAINS | URL_STARTSWITH | URL_ENDSWITH | URL_REGEX
 * Options:     ignore_query_string | ignore_fragment | ignore_protocol | case_sensitive
 *
 * Cache:
 *   Configs are loaded lazily and cached in memory. The watcher module
 *   calls invalidate(projectPath) whenever a config.json changes so the
 *   next match() call re-reads the file.
 *
 * Usage:
 *   import { match, invalidate, loadAll } from './matcher.mjs';
 *
 *   loadAll(listActive());           // prime cache at startup
 *   const result = match(url);       // → MatchResult | null
 *   invalidate('/path/to/project');  // call from watcher on file change
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} MatchResult
 * @property {number} projectId     DB project id
 * @property {string} projectPath   Absolute path to the project directory
 * @property {object} config        Full parsed config.json
 * @property {object} exp           The matching experience object
 * @property {object} variation     The active variation object (or null for Control)
 */

// ─── Config cache ─────────────────────────────────────────────────────────────

/** Map<projectPath, config | null> — null means failed to load */
const _cache = new Map();

/**
 * Load (or reload) the config for a project into the cache.
 * Returns the parsed config or null if unreadable.
 *
 * @param {string} projectPath
 * @returns {object|null}
 */
function _load(projectPath) {
  const configPath = join(projectPath, 'config.json');
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    _cache.set(projectPath, config);
    return config;
  } catch {
    _cache.set(projectPath, null);
    return null;
  }
}

/**
 * Return the cached config for a project, loading it first if necessary.
 *
 * @param {string} projectPath
 * @returns {object|null}
 */
function _getConfig(projectPath) {
  if (!_cache.has(projectPath)) return _load(projectPath);
  return _cache.get(projectPath);
}

// ─── Public cache API ─────────────────────────────────────────────────────────

/**
 * Prime the cache with an array of project records (from db.listActive()).
 * Called once at service startup.
 *
 * @param {Array<{ path: string }>} projects
 */
export function loadAll(projects) {
  for (const p of projects) _load(p.path);
}

/**
 * Invalidate the cached config for a project.
 * The next call to match() will re-read config.json from disk.
 *
 * @param {string} projectPath
 */
export function invalidate(projectPath) {
  _cache.delete(projectPath);
}

/**
 * Add a newly-registered project to the cache.
 *
 * @param {string} projectPath
 */
export function add(projectPath) {
  _load(projectPath);
}

/**
 * Remove a project from the cache entirely (called on unregister).
 *
 * @param {string} projectPath
 */
export function remove(projectPath) {
  _cache.delete(projectPath);
}

// ─── URL rule evaluation ──────────────────────────────────────────────────────

/**
 * Test a single URL against a single page rule object.
 *
 * Rule shape: { rule: 'URL_CONTAINS', value: '...', options: { ... } }
 * Legacy plain-string rules are treated as URL_CONTAINS.
 *
 * @param {string} url   Full request URL (e.g. 'https://example.com/page?q=1')
 * @param {object|string} rule
 * @returns {boolean}
 */
export function testRule(url, rule) {
  const r = (typeof rule === 'object' && rule !== null)
    ? rule
    : { rule: 'URL_CONTAINS', value: rule, options: {} };

  const opts = r.options || {};
  let u = url;

  if (opts.ignore_protocol)     u = u.replace(/^https?:\/\//, '');
  if (opts.ignore_query_string) u = u.split('?')[0];
  if (opts.ignore_fragment)     u = u.split('#')[0];

  const val = opts.case_sensitive ? r.value : (r.value ?? '').toLowerCase();
  const tgt = opts.case_sensitive ? u       : u.toLowerCase();

  switch (r.rule) {
    case 'URL_MATCHES':    return tgt === val;
    case 'URL_CONTAINS':   return tgt.includes(val);
    case 'URL_STARTSWITH': return tgt.startsWith(val);
    case 'URL_ENDSWITH':   return tgt.endsWith(val);
    case 'URL_REGEX': {
      try {
        return new RegExp(r.value, opts.case_sensitive ? '' : 'i').test(u);
      } catch {
        return false;
      }
    }
    default: return false;
  }
}

/**
 * Test whether a URL passes the include/exclude rules of a pages config.
 *
 * - No rules at all → always matches (no targeting configured)
 * - Include rules present → URL must match at least one
 * - Exclude rules present → URL must not match any
 *
 * @param {string} url
 * @param {{ include?: Array, exclude?: Array }} pages
 * @returns {boolean}
 */
export function testPages(url, pages) {
  const include = pages?.include || [];
  const exclude = pages?.exclude || [];

  if (!include.length && !exclude.length) return true;

  const incMatch = !include.length || include.some(r => testRule(url, r));
  const excMatch =  exclude.length  && exclude.some(r => testRule(url, r));

  return incMatch && !excMatch;
}

// ─── Main match function ──────────────────────────────────────────────────────

/**
 * Find the first registered project + experience that targets the given URL.
 *
 * Projects are evaluated in registration order (added_at ASC). The first
 * experience whose pages rules match wins.
 *
 * @param {string}                          url          Full request URL
 * @param {Array<{ path: string, enabled: number }>} projects  From db.listActive()
 * @returns {MatchResult|null}
 */
export function match(url, projects) {
  for (const project of projects) {
    if (!project.enabled) continue;

    const config = _getConfig(project.path);
    if (!config) continue;

    const active = config.active;
    if (!active?.experience) continue;

    for (const exp of config.experiences || []) {
      if (!testPages(url, exp.pages)) continue;

      // Find the active variation for this experience
      const varSlug   = active.experience === exp.slug ? active.variation : null;
      const variation = varSlug
        ? (exp.variations || []).find(v => v.slug === varSlug) ?? null
        : null;

      return {
        projectId:   project.id,
        projectPath: project.path,
        config,
        exp,
        variation,
      };
    }
  }

  return null;
}
