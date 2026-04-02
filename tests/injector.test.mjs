/**
 * tests/injector.test.mjs — Unit tests for HTML injection
 *
 * Tests stripSecurityHeaders() and inject() from src/service/injector.mjs.
 * No network or proxy required.
 *
 * Run: node --test tests/injector.test.mjs
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { stripSecurityHeaders, inject } from '../src/service/injector.mjs';

// ─── stripSecurityHeaders ─────────────────────────────────────────────────────

describe('stripSecurityHeaders', () => {
  test('removes content-security-policy', () => {
    const result = stripSecurityHeaders({ 'content-security-policy': "default-src 'self'", 'content-type': 'text/html' });
    assert.equal(result['content-security-policy'], undefined);
    assert.equal(result['content-type'], 'text/html');
  });

  test('removes content-security-policy-report-only', () => {
    const result = stripSecurityHeaders({ 'content-security-policy-report-only': "default-src 'self'" });
    assert.equal(result['content-security-policy-report-only'], undefined);
  });

  test('removes strict-transport-security', () => {
    const result = stripSecurityHeaders({ 'strict-transport-security': 'max-age=31536000' });
    assert.equal(result['strict-transport-security'], undefined);
  });

  test('removes x-frame-options', () => {
    const result = stripSecurityHeaders({ 'x-frame-options': 'DENY' });
    assert.equal(result['x-frame-options'], undefined);
  });

  test('preserves unrelated headers', () => {
    const result = stripSecurityHeaders({ 'content-type': 'text/html', 'cache-control': 'no-cache' });
    assert.equal(result['content-type'], 'text/html');
    assert.equal(result['cache-control'], 'no-cache');
  });

  test('does not mutate the input object', () => {
    const original = { 'content-security-policy': "default-src 'self'", 'content-type': 'text/html' };
    const copy = { ...original };
    stripSecurityHeaders(original);
    assert.deepEqual(original, copy);
  });
});

// ─── inject ───────────────────────────────────────────────────────────────────

describe('inject', () => {
  let tmpDir;

  // A minimal MatchResult with a Control variation (no HTML to inject)
  const makeMatchResult = (overrides = {}) => ({
    projectId: 1,
    projectPath: tmpDir,
    config: { settings: {} },
    exp: {
      slug: 'test-exp',
      name: 'Test Experience',
      pages: {},
      variations: [{ name: 'Control', slug: 'control' }],
      variables: {},
    },
    variation: null, // Control
    ...overrides,
  });

  const baseHtml = '<!doctype html><html><head><title>Test</title></head><body><p>Hello</p></body></html>';

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ss-inject-test-'));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('inserts config script block before </body>', () => {
    const result = inject(baseHtml, makeMatchResult(), 1, 'example.com', false);
    assert.ok(result.includes('data-ss-added="config"'), 'config block missing');
    assert.ok(result.indexOf('data-ss-added="config"') < result.indexOf('</body>'), 'config not before </body>');
  });

  test('inserts bundle script tag before </body>', () => {
    const result = inject(baseHtml, makeMatchResult(), 1, 'example.com', false);
    assert.ok(result.includes('data-ss-added="bundle"'), 'bundle script missing');
    assert.ok(result.includes('/__ss__/bundle.js?project=1'), 'bundle URL missing project id');
  });

  test('inserts runtime script block before </body>', () => {
    const result = inject(baseHtml, makeMatchResult(), 1, 'example.com', false);
    assert.ok(result.includes('data-ss-added="runtime"'), 'runtime block missing');
  });

  test('sets wss:// scheme for HTTPS context', () => {
    const result = inject(baseHtml, makeMatchResult(), 1, 'example.com', true);
    assert.ok(result.includes('wss://example.com'), 'expected wss:// for HTTPS');
  });

  test('sets ws:// scheme for HTTP context', () => {
    const result = inject(baseHtml, makeMatchResult(), 1, 'example.com', false);
    assert.ok(result.includes('ws://example.com'), 'expected ws:// for HTTP');
  });

  test('window.__ss contains experience and variation data', () => {
    const result = inject(baseHtml, makeMatchResult(), 1, 'example.com', false);
    assert.ok(result.includes('"slug":"test-exp"'), 'experience slug missing from __ss');
  });

  test('no html-init block when variation has no HTML', () => {
    const result = inject(baseHtml, makeMatchResult(), 1, 'example.com', false);
    assert.ok(!result.includes('data-ss-added="html-init"'), 'unexpected html-init block');
  });

  test('includes html-init block when variation HTML file exists', () => {
    // Create experience/variation directory structure with an HTML file
    const expDir = join(tmpDir, 'experiences', 'test-exp', 'var-1', 'block-1');
    mkdirSync(expDir, { recursive: true });
    writeFileSync(join(expDir, 'modification.html'), '<div>injected</div>');

    const matchResult = makeMatchResult({
      variation: {
        name: 'Variation 1',
        slug: 'var-1',
        modifications: [{
          name: 'Block 1',
          slug: 'block-1',
          resources: ['modification.html'],
        }],
      },
    });

    const result = inject(baseHtml, matchResult, 1, 'example.com', false);
    assert.ok(result.includes('data-ss-added="html-init"'), 'html-init block missing');
    assert.ok(result.includes('injected'), 'HTML content missing from injection');
  });

  test('preserves content outside </body>', () => {
    const result = inject(baseHtml, makeMatchResult(), 1, 'example.com', false);
    assert.ok(result.includes('<title>Test</title>'), 'head content should be preserved');
    assert.ok(result.includes('<p>Hello</p>'), 'body content should be preserved');
  });

  test('handles HTML with no </body> tag gracefully', () => {
    const html = '<html><body><p>No closing tag</p>';
    // Should not throw
    const result = inject(html, makeMatchResult(), 1, 'example.com', false);
    assert.ok(typeof result === 'string');
  });
});
