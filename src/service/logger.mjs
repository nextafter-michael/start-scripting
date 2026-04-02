/**
 * logger.mjs — Structured event log for ss-proxy-service
 *
 * Appends newline-delimited, human-readable entries to
 * ~/.ss-proxy/ss-proxy-service.log.
 *
 * Format (one line per event):
 *   2026-04-01T10:23:45.123Z  INFO   [enabled]  project=1  http://example.com/page
 *                                               exp=test-exp  var=control  mods=[hero-copy]
 *
 * Levels: INFO | WARN | ERROR
 *
 * Usage:
 *   import { log } from './logger.mjs';
 *   log.match(url, matchResult, 'enabled');
 *   log.inject(url, matchResult);
 *   log.disabledMatch(url, projectId, projectPath, expSlug);
 *   log.error(url, err, context);
 *   log.warn(msg, context);
 */

import { appendFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// ─── Path ─────────────────────────────────────────────────────────────────────

const DATA_DIR = join(homedir(), '.ss-proxy');
const LOG_PATH = join(DATA_DIR, 'ss-proxy-service.log');

// ─── Internal writer ──────────────────────────────────────────────────────────

function _write(level, tag, url, fields) {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

    const ts      = new Date().toISOString();
    const lvlPad  = level.padEnd(5);
    const tagPad  = `[${tag}]`.padEnd(10);
    const fieldStr = fields.length ? '  ' + fields.join('  ') : '';

    const line = `${ts}  ${lvlPad}  ${tagPad}  ${url}${fieldStr}\n`;
    appendFileSync(LOG_PATH, line, 'utf8');
  } catch {
    // Never let logging crash the proxy
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export const log = {

  /**
   * A URL matched an enabled project's page rules.
   * Called when match() returns a result (before we know if it's HTML).
   *
   * @param {string} url
   * @param {import('./matcher.mjs').MatchResult} matchResult
   */
  match(url, matchResult) {
    const { projectId, exp, variation } = matchResult;
    const varLabel = variation ? variation.slug : 'control';
    _write('INFO', 'enabled', url, [
      `project=${projectId}`,
      `exp=${exp.slug}`,
      `var=${varLabel}`,
    ]);
  },

  /**
   * HTML injection was applied to a response.
   * Called after inject() succeeds.
   *
   * @param {string} url
   * @param {import('./matcher.mjs').MatchResult} matchResult
   */
  inject(url, matchResult) {
    const { projectId, exp, variation } = matchResult;
    const varLabel = variation ? variation.slug : 'control';
    const mods = (variation?.modifications || []).map(m => m.slug);
    const modsStr = mods.length ? `mods=[${mods.join(',')}]` : 'mods=[]';
    _write('INFO', 'injected', url, [
      `project=${projectId}`,
      `exp=${exp.slug}`,
      `var=${varLabel}`,
      modsStr,
    ]);
  },

  /**
   * A URL matched a disabled project's page rules.
   * The project is registered but not active — no injection will happen.
   *
   * @param {string} url
   * @param {number} projectId
   * @param {string} projectPath
   * @param {string} expSlug
   */
  disabledMatch(url, projectId, projectPath, expSlug) {
    _write('INFO', 'disabled', url, [
      `project=${projectId}`,
      `exp=${expSlug}`,
      `path=${projectPath}`,
    ]);
  },

  /**
   * An error occurred while handling a proxied request.
   *
   * @param {string} url
   * @param {Error}  err
   * @param {string} [context]  short label e.g. 'injection', 'forward'
   */
  error(url, err, context = 'proxy') {
    _write('ERROR', context, url, [
      `error=${JSON.stringify(err.message)}`,
    ]);
  },

  /**
   * A non-fatal warning.
   *
   * @param {string} msg
   * @param {object} [fields]  flat key→value pairs
   */
  warn(msg, fields = {}) {
    const fieldStr = Object.entries(fields).map(([k, v]) => `${k}=${v}`);
    _write('WARN', 'warn', msg, fieldStr);
  },
};
