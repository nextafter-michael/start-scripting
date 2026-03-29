/**
 * builder.mjs — esbuild watcher and bundler
 *
 * esbuild is an extremely fast JavaScript bundler. A "bundler" takes your
 * source files (which may import other files, CSS, etc.) and combines them
 * into a single output file that can run in a browser.
 *
 * Key esbuild concepts:
 *   context()  — creates a reusable build configuration
 *   rebuild()  — manually run a single build
 *   watch()    — start watching files; auto-rebuilds when anything changes
 *   plugins    — hooks into esbuild's process to transform files in custom ways
 */

import * as esbuild from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'fs';
import { join, extname } from 'path';
import { createRequire } from 'module';

const _require = createRequire(import.meta.url);

// Valid resource extensions inside a modification block directory
const RESOURCE_EXTS = new Set(['.js', '.ts', '.tsx', '.jsx', '.mjs', '.cjs', '.css', '.scss', '.sass', '.html']);

// Extension sort order for conventional resource ordering: styles → scripts → html
const EXT_ORDER = ['.css', '.scss', '.sass', '.js', '.ts', '.tsx', '.jsx', '.mjs', '.cjs', '.html'];

/**
 * Sync config.json from what actually exists on disk inside experiences/.
 *
 * Called each poll cycle. Detects three kinds of manual directory creation:
 *
 *   experiences/<exp>/<new-folder>/          → new variation
 *   experiences/<exp>/<var>/<new-folder>/    → new modification block
 *   experiences/<exp>/<var>/<block>/<file>   → new resource file
 *
 * Slugs and display names both come from the folder/file name.
 * Existing config entries are never removed here — only additions are synced.
 *
 * @param {string} expSlug - Active experience slug (only that experience is watched)
 */
function syncExperiencesDir(expSlug) {
  const configPath = join(process.cwd(), 'config.json');
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    return; // can't do anything without a valid config
  }

  const exp = config.experiences?.find((e) => e.slug === expSlug);
  if (!exp) return;

  const expDir = join(process.cwd(), 'experiences', expSlug);
  if (!existsSync(expDir)) return;

  let dirty = false;

  // ── Variation-level: new folders directly under <exp>/ ──────────────────
  let varEntries;
  try { varEntries = readdirSync(expDir); } catch { return; }

  for (const varName of varEntries) {
    const varDir = join(expDir, varName);
    let st;
    try { st = statSync(varDir); } catch { continue; }
    if (!st.isDirectory()) continue;

    // 'control' is always present in config but has no directory — skip it
    if (varName === 'control') continue;

    const existing = exp.variations?.find((v) => v.slug === varName);
    if (!existing) {
      if (!exp.variations) exp.variations = [];
      exp.variations.push({ name: varName, slug: varName, modifications: [] });
      console.log(`  + Detected new variation: ${varName}`);
      dirty = true;
    }

    // ── Block-level: new folders directly under <var>/ ────────────────────
    const variation = exp.variations.find((v) => v.slug === varName);
    if (!variation) continue;
    if (!variation.modifications) variation.modifications = [];

    let blockEntries;
    try { blockEntries = readdirSync(varDir); } catch { continue; }

    for (const blockName of blockEntries) {
      const blockDir = join(varDir, blockName);
      let bst;
      try { bst = statSync(blockDir); } catch { continue; }
      if (!bst.isDirectory()) continue;

      const existingBlock = variation.modifications.find((m) => m.slug === blockName);
      if (!existingBlock) {
        variation.modifications.push({
          name: blockName,
          slug: blockName,
          trigger: 'DOM_READY',
          resources: [],
        });
        console.log(`  + Detected new block: ${varName}/${blockName}`);
        dirty = true;
      }

      // ── Resource-level: new files directly under <block>/ ─────────────
      const block = variation.modifications.find((m) => m.slug === blockName);
      if (!block) continue;
      if (!block.resources) block.resources = [];

      let fileEntries;
      try { fileEntries = readdirSync(blockDir); } catch { continue; }

      for (const fileName of fileEntries) {
        if (!RESOURCE_EXTS.has(extname(fileName).toLowerCase())) continue;
        const filePath = join(blockDir, fileName);
        let fst;
        try { fst = statSync(filePath); } catch { continue; }
        if (!fst.isFile()) continue;

        if (!block.resources.includes(fileName)) {
          // Maintain conventional order: styles → scripts → html
          block.resources.push(fileName);
          block.resources.sort((a, b) => {
            const ai = EXT_ORDER.indexOf(extname(a).toLowerCase());
            const bi = EXT_ORDER.indexOf(extname(b).toLowerCase());
            return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
          });
          console.log(`  + Detected new resource: ${varName}/${blockName}/${fileName}`);
          dirty = true;
        }
      }
    }
  }

  if (dirty) {
    writeFileSync(configPath, JSON.stringify(config, null, 2));
  }
}

/**
 * esbuild plugin: style injector
 *
 * Converts any .css / .scss / .sass import into JavaScript that creates a
 * <style> tag, so the final output is a single self-contained .js file.
 * The stable id="__ss_styles" lets the WebSocket handler hot-swap CSS
 * without a full page reload.
 *
 * SCSS/SASS are compiled via the `sass` package if it is installed. If it
 * isn't, esbuild will throw a clear "Cannot find package 'sass'" error at
 * build time rather than silently falling back.
 */
function cssInjectorPlugin() {
  return {
    name: 'css-injector',
    setup(build) {
      build.onLoad({ filter: /\.(css|scss|sass)$/ }, async (args) => {
        const { readFile } = await import('fs/promises');
        const ext = args.path.split('.').pop().toLowerCase();

        let css;
        if (ext === 'scss' || ext === 'sass') {
          const sass = await import('sass');
          const result = sass.compile(args.path, { style: 'expanded' });
          css = result.css;
        } else {
          css = await readFile(args.path, 'utf8');
        }

        return {
          contents: `
const __ss_style = document.createElement('style');
__ss_style.id = '__ss_styles';
__ss_style.type = 'text/css';
__ss_style.setAttribute('data-ss-added', 'styles');
__ss_style.textContent = ${JSON.stringify(css)};
document.head.appendChild(__ss_style);
          `.trim(),
          loader: 'js',
          watchFiles: [args.path],
        };
      });
    },
  };
}

/**
 * Shared build options — used by both the watcher and one-off builds.
 */
function buildOptions(entryPoint, projectDir, outfile) {
  return {
    entryPoints: [entryPoint],
    absWorkingDir: projectDir,
    outfile,
    bundle: true,
    format: 'iife',
    sourcemap: true,
    // esbuild handles ts/tsx/jsx natively; loaders map extensions to their transformer
    loader: {
      '.ts':  'ts',
      '.tsx': 'tsx',
      '.jsx': 'jsx',
      '.mjs': 'js',
      '.cjs': 'js',
    },
    plugins: [cssInjectorPlugin()],
  };
}

const CSS_EXTS  = new Set(['.css', '.scss', '.sass']);
const HTML_EXTS = new Set(['.html']);

/**
 * Read and concatenate compiled CSS from all modification blocks in config order.
 * .css files are read as-is. .scss/.sass files are compiled via the `sass`
 * package so the hot-swap message always sends valid CSS the browser can apply.
 * Falls back to empty string per file on any read/compile error.
 */
function readCssFiles(expSlug, varSlug) {
  try {
    const configPath = join(process.cwd(), 'config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    const exp = config.experiences?.find((e) => e.slug === expSlug);
    const variation = exp?.variations?.find((v) => v.slug === varSlug);
    if (!variation?.modifications?.length) return '';

    // sass is an optional peer dep — loaded on first SASS file encountered
    let sassCompiler = null;
    function getSass() {
      if (!sassCompiler) sassCompiler = _require('sass');
      return sassCompiler;
    }

    return variation.modifications
      .flatMap((mod) => {
        const blockDir = join(process.cwd(), 'experiences', expSlug, varSlug, mod.slug);
        return (mod.resources || [])
          .filter(f => CSS_EXTS.has(extname(f).toLowerCase()))
          .map(f => {
            const filePath = join(blockDir, f);
            const ext = extname(f).toLowerCase();
            try {
              if (ext === '.scss' || ext === '.sass') return getSass().compile(filePath).css;
              return readFileSync(filePath, 'utf8');
            } catch { return ''; }
          });
      })
      .join('\n');
  } catch {
    return '';
  }
}

/**
 * Read and concatenate HTML from all modification blocks in config order.
 */
function readVariationHtml(expSlug, varSlug) {
  try {
    const configPath = join(process.cwd(), 'config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    const exp = config.experiences?.find((e) => e.slug === expSlug);
    const variation = exp?.variations?.find((v) => v.slug === varSlug);
    if (!variation?.modifications?.length) return '';

    return variation.modifications
      .flatMap((mod) => {
        const blockDir = join(process.cwd(), 'experiences', expSlug, varSlug, mod.slug);
        return (mod.resources || [])
          .filter(f => HTML_EXTS.has(extname(f).toLowerCase()))
          .map(f => {
            try {
              const raw = readFileSync(join(blockDir, f), 'utf8');
              const stripped = raw.replace(/<!--[\s\S]*?-->/g, '').trim();
              return stripped ? raw.trim() : '';
            } catch { return ''; }
          });
      })
      .filter(Boolean)
      .join('\n');
  } catch {
    return '';
  }
}

/**
 * Recursively snapshot all file mtimes in a directory tree.
 * Keys are absolute file paths.
 */
function getSnapshot(dir) {
  const snapshot = {};
  function walk(d) {
    try {
      for (const f of readdirSync(d)) {
        const full = join(d, f);
        try {
          const st = statSync(full);
          if (st.isDirectory()) {
            walk(full);
          } else {
            snapshot[full] = st.mtimeMs;
          }
        } catch {}
      }
    } catch {}
  }
  walk(dir);
  return snapshot;
}

/**
 * Start the esbuild watcher for a single experience/variation.
 *
 * @param {string} expSlug   - Active experience slug (e.g. "homepage-hero")
 * @param {string} varSlug   - Active variation slug (e.g. "variation-1")
 * @param {Function} broadcast - WebSocket broadcast function from proxy
 */
export async function startBuilder(expSlug, varSlug, broadcast) {
  const projectDir = process.cwd();
  const entryPoint = join(projectDir, 'dist/entry', `${expSlug}.js`);
  const distDir = join(projectDir, 'dist');
  const outfile = join(distDir, 'bundle.js');

  mkdirSync(distDir, { recursive: true });

  if (!existsSync(entryPoint)) {
    console.error(`✖ No cache entry found for "${expSlug}". Run "ss new experience" first.`);
    process.exit(1);
  }

  // Initial build — no broadcast here since no page is open yet
  await esbuild.build(buildOptions(entryPoint, projectDir, outfile));

  // Poll file mtimes every 500ms and do a fresh build when anything changes.
  // We use esbuild.build() (not ctx.rebuild()) because the incremental context
  // caches file contents and doesn't reliably pick up changes on all systems.
  const { writeCacheEntry } = await import('./scaffold.mjs');
  const configPath = join(projectDir, 'config.json');

  function readActiveVariation() {
    try {
      return JSON.parse(readFileSync(configPath, 'utf8')).active?.variation;
    } catch {
      return null;
    }
  }

  let activeVariation = readActiveVariation() || varSlug;
  let variationDir = join(projectDir, 'experiences', expSlug, activeVariation);

  let lastSnapshot = getSnapshot(variationDir);

  let rebuilding = false;
  setInterval(async () => {
    if (rebuilding) return;

    // Sync any folders/files manually created on disk into config.json
    syncExperiencesDir(expSlug);

    // Re-read config each cycle so variation switches are picked up
    const currentVariation = readActiveVariation() || activeVariation;
    if (currentVariation !== activeVariation) {
      console.log(`  ↻ Variation switched to ${currentVariation}`);
      activeVariation = currentVariation;
      variationDir = join(projectDir, 'experiences', expSlug, activeVariation);
      lastSnapshot = {};
    }

    const current = getSnapshot(variationDir);
    const lastKeys = Object.keys(lastSnapshot);
    const currentKeys = Object.keys(current);

    // Identify exactly which files changed (added, removed, or modified)
    const added    = currentKeys.filter((f) => !(f in lastSnapshot));
    const removed  = lastKeys.filter((f) => !(f in current));
    const modified = currentKeys.filter((f) => f in lastSnapshot && lastSnapshot[f] !== current[f]);
    const changedFiles = [...added, ...removed, ...modified];

    if (changedFiles.length === 0) return;

    const hasJs   = changedFiles.some((f) => ['.js','.ts','.tsx','.jsx','.mjs','.cjs'].includes(extname(f).toLowerCase()));
    const hasCss  = changedFiles.some((f) => ['.css','.scss','.sass'].includes(extname(f).toLowerCase()));
    const hasHtml = changedFiles.some((f) => extname(f).toLowerCase() === '.html');

    writeCacheEntry(expSlug, activeVariation);
    lastSnapshot = current;
    rebuilding = true;
    try {
      await esbuild.build(buildOptions(entryPoint, projectDir, outfile));
      console.log(`  ↻ Rebuilt at ${new Date().toLocaleTimeString()}`);

      if (hasJs) {
        // JS changes have side effects — only a full reload is safe
        broadcast({ type: 'reload' });
      } else {
        // CSS and HTML can be hot-swapped without losing page state
        if (hasCss) broadcast({ type: 'css-update', css: readCssFiles(expSlug, activeVariation) });
        if (hasHtml) broadcast({ type: 'html-update', html: readVariationHtml(expSlug, activeVariation) });
      }
    } catch (err) {
      console.error(`  ✖ Build error:`, err.message);
    } finally {
      rebuilding = false;
    }
  }, 500);

  console.log(`✔ Watching experiences/${expSlug}/`);
}

/**
 * Build all experiences to dist/ for deployment (minified, one file per experience).
 * Uses the current dist/entry entries (active variation at time of last connect/switch).
 */
export async function buildAll() {
  const configPath = join(process.cwd(), 'config.json');

  if (!existsSync(configPath)) {
    console.error('✖ No config.json found. Run "ss init" first.');
    process.exit(1);
  }

  let config;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    console.error('✖ Could not parse config.json.');
    process.exit(1);
  }

  const experiences = config.experiences || [];

  if (experiences.length === 0) {
    console.log('No experiences in config.json');
    return;
  }

  const distDir = join(process.cwd(), 'dist');
  mkdirSync(distDir, { recursive: true });

  const cacheDir = join(process.cwd(), 'dist/entry');

  await esbuild.build({
    entryPoints: experiences.map((exp) => ({
      in: join(cacheDir, `${exp.slug}.js`),
      out: exp.slug,
    })),
    outdir: distDir,
    bundle: true,
    format: 'iife',
    minify: true,
    plugins: [cssInjectorPlugin()],
  });

  console.log(`✔ Built ${experiences.length} experience(s) to dist/`);
  experiences.forEach((exp) => console.log(`   dist/${exp.slug}.js`));
}
