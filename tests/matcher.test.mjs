/**
 * tests/matcher.test.mjs — Unit tests for URL rule evaluation
 *
 * Tests testRule(), testPages(), and match() from src/service/matcher.mjs.
 * Pure logic tests — no proxy or network required.
 * match() tests use a temp directory with a real config.json on disk.
 *
 * Run: node --test tests/matcher.test.mjs
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { testRule, testPages, match, add, remove } from '../src/service/matcher.mjs';

// ─── testRule ─────────────────────────────────────────────────────────────────

describe('testRule', () => {
  describe('URL_CONTAINS', () => {
    test('matches when value is present', () => {
      assert.equal(testRule('https://example.com/page', { rule: 'URL_CONTAINS', value: 'example.com' }), true);
    });
    test('no match when value is absent', () => {
      assert.equal(testRule('https://other.com/page', { rule: 'URL_CONTAINS', value: 'example.com' }), false);
    });
    test('case-insensitive by default', () => {
      assert.equal(testRule('https://EXAMPLE.COM/page', { rule: 'URL_CONTAINS', value: 'example.com' }), true);
    });
    test('case-sensitive when option set', () => {
      assert.equal(testRule('https://EXAMPLE.COM/page', {
        rule: 'URL_CONTAINS', value: 'example.com', options: { case_sensitive: true },
      }), false);
    });
    test('plain string rule defaults to URL_CONTAINS', () => {
      assert.equal(testRule('https://example.com/page', 'example.com'), true);
    });
  });

  describe('URL_MATCHES', () => {
    test('exact match passes', () => {
      assert.equal(testRule('https://example.com/page', { rule: 'URL_MATCHES', value: 'https://example.com/page' }), true);
    });
    test('partial URL fails', () => {
      assert.equal(testRule('https://example.com/page?q=1', { rule: 'URL_MATCHES', value: 'https://example.com/page' }), false);
    });
    test('ignore_query_string allows match', () => {
      assert.equal(testRule('https://example.com/page?q=1', {
        rule: 'URL_MATCHES', value: 'https://example.com/page', options: { ignore_query_string: true },
      }), true);
    });
    test('ignore_fragment strips #hash before compare', () => {
      assert.equal(testRule('https://example.com/page#section', {
        rule: 'URL_MATCHES', value: 'https://example.com/page', options: { ignore_fragment: true },
      }), true);
    });
    test('ignore_protocol strips scheme before compare', () => {
      assert.equal(testRule('https://example.com/page', {
        rule: 'URL_MATCHES', value: 'example.com/page', options: { ignore_protocol: true },
      }), true);
    });
  });

  describe('URL_STARTSWITH', () => {
    test('matches correct prefix', () => {
      assert.equal(testRule('https://example.com/page', { rule: 'URL_STARTSWITH', value: 'https://example.com' }), true);
    });
    test('fails when prefix is wrong', () => {
      assert.equal(testRule('https://example.com/page', { rule: 'URL_STARTSWITH', value: 'https://other.com' }), false);
    });
  });

  describe('URL_ENDSWITH', () => {
    test('matches correct suffix', () => {
      assert.equal(testRule('https://example.com/page', { rule: 'URL_ENDSWITH', value: '/page' }), true);
    });
    test('fails when suffix is wrong', () => {
      assert.equal(testRule('https://example.com/page', { rule: 'URL_ENDSWITH', value: '/other' }), false);
    });
  });

  describe('URL_REGEX', () => {
    test('matches valid pattern', () => {
      assert.equal(testRule('https://example.com/product/123', { rule: 'URL_REGEX', value: '/product/\\d+' }), true);
    });
    test('no match when pattern does not apply', () => {
      assert.equal(testRule('https://example.com/page', { rule: 'URL_REGEX', value: '/product/\\d+' }), false);
    });
    test('invalid regex returns false without throwing', () => {
      assert.equal(testRule('https://example.com/page', { rule: 'URL_REGEX', value: '[invalid' }), false);
    });
    test('case-insensitive by default', () => {
      assert.equal(testRule('https://EXAMPLE.COM/Page', { rule: 'URL_REGEX', value: 'example\\.com/page' }), true);
    });
    test('case-sensitive when option set', () => {
      assert.equal(testRule('https://EXAMPLE.COM/Page', {
        rule: 'URL_REGEX', value: 'example\\.com/page', options: { case_sensitive: true },
      }), false);
    });
  });

  describe('unknown rule type', () => {
    test('returns false for unrecognised rule', () => {
      assert.equal(testRule('https://example.com', { rule: 'URL_UNKNOWN', value: 'x' }), false);
    });
  });
});

// ─── testPages ────────────────────────────────────────────────────────────────

describe('testPages', () => {
  test('no rules → always matches', () => {
    assert.equal(testPages('https://example.com', {}), true);
    assert.equal(testPages('https://example.com', { include: [], exclude: [] }), true);
  });

  test('include rule that matches → true', () => {
    assert.equal(testPages('https://example.com/page', {
      include: [{ rule: 'URL_CONTAINS', value: 'example.com' }],
    }), true);
  });

  test('include rule that does not match → false', () => {
    assert.equal(testPages('https://other.com/page', {
      include: [{ rule: 'URL_CONTAINS', value: 'example.com' }],
    }), false);
  });

  test('exclude rule matching → false even if include matches', () => {
    assert.equal(testPages('https://example.com/admin', {
      include: [{ rule: 'URL_CONTAINS', value: 'example.com' }],
      exclude: [{ rule: 'URL_CONTAINS', value: '/admin' }],
    }), false);
  });

  test('exclude rule not matching → true', () => {
    assert.equal(testPages('https://example.com/page', {
      include: [{ rule: 'URL_CONTAINS', value: 'example.com' }],
      exclude: [{ rule: 'URL_CONTAINS', value: '/admin' }],
    }), true);
  });

  test('only exclude rules — non-excluded URL passes', () => {
    assert.equal(testPages('https://example.com/page', {
      exclude: [{ rule: 'URL_CONTAINS', value: '/admin' }],
    }), true);
  });

  test('only exclude rules — excluded URL fails', () => {
    assert.equal(testPages('https://example.com/admin', {
      exclude: [{ rule: 'URL_CONTAINS', value: '/admin' }],
    }), false);
  });

  test('multiple include rules — any match is sufficient', () => {
    assert.equal(testPages('https://example.com/blog', {
      include: [
        { rule: 'URL_CONTAINS', value: '/shop' },
        { rule: 'URL_CONTAINS', value: '/blog' },
      ],
    }), true);
  });
});

// ─── match() ──────────────────────────────────────────────────────────────────

describe('match()', () => {
  let tmpDir;
  const config = {
    active: { experience: 'test-exp', variation: 'control' },
    experiences: [{
      name: 'Test Experience',
      slug: 'test-exp',
      pages: {
        include: [{ rule: 'URL_CONTAINS', value: 'example.com' }],
        exclude: [],
      },
      variations: [{ name: 'Control', slug: 'control' }],
    }],
    settings: {},
  };

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ss-match-test-'));
    writeFileSync(join(tmpDir, 'config.json'), JSON.stringify(config));
    add(tmpDir);
  });

  after(() => {
    remove(tmpDir);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const project = () => ({ id: 1, path: tmpDir, enabled: 1 });

  test('returns MatchResult for a matching URL', () => {
    const result = match('https://example.com/page', [project()]);
    assert.ok(result, 'expected a match result');
    assert.equal(result.projectId, 1);
    assert.equal(result.exp.slug, 'test-exp');
    assert.equal(result.variation.slug, 'control');
  });

  test('returns null for a non-matching URL', () => {
    const result = match('https://other.com/page', [project()]);
    assert.equal(result, null);
  });

  test('returns null when project is disabled', () => {
    const result = match('https://example.com/page', [{ ...project(), enabled: 0 }]);
    assert.equal(result, null);
  });

  test('returns null when project list is empty', () => {
    assert.equal(match('https://example.com/page', []), null);
  });

  test('MatchResult includes projectPath and config', () => {
    const result = match('https://example.com/page', [project()]);
    assert.equal(result.projectPath, tmpDir);
    assert.ok(result.config, 'config should be present');
    assert.ok(Array.isArray(result.config.experiences));
  });
});
