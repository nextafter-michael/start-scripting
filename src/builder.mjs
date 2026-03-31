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
 * Extract the experience slug from a file path like .../experiences/<slug>/...
 * Returns null if the path is not inside an experiences directory.
 */
function expSlugFromPath(filePath) {
  const m = filePath.replace(/\\/g, '/').match(/\/experiences\/([^/]+)\//);
  return m ? m[1] : null;
}

/**
 * Read the handlebars variables for an experience from config.json.
 * Returns a plain { varName: value } object, or {} if none defined.
 */
function getHandlebarsVars(expSlug) {
  if (!expSlug) return {};
  try {
    const config = JSON.parse(readFileSync(join(process.cwd(), 'config.json'), 'utf8'));
    const exp = config.experiences?.find(e => e.slug === expSlug);
    return exp?.variables?.handlebars || {};
  } catch {
    return {};
  }
}

/**
 * Serialize a variable entry to a string for insertion into source code.
 *
 * @param {{ type: string, value: * }} entry - Variable descriptor from config.json
 * @param {'js'|'css'|'html'} context        - File type being processed
 * @returns {string}
 */
function serializeVar(entry, context) {
  const { type, value } = entry;
  if (context === 'js') {
    if (type === 'null')    return 'null';
    if (type === 'boolean') return String(Boolean(value));
    if (type === 'number')  return String(Number(value));
    if (type === 'string')  return JSON.stringify(String(value ?? ''));
    // object / array
    return JSON.stringify(value);
  }
  // CSS / HTML context
  if (type === 'null')    return '';
  if (type === 'boolean') return String(Boolean(value));
  if (type === 'number')  return String(Number(value));
  if (type === 'string')  return String(value ?? '');
  // object / array — log a warning and cast to JSON string
  console.warn(`[ss] Variable of type "${type}" used in CSS/HTML — casting to JSON string. Consider using a string variable instead.`);
  return JSON.stringify(value);
}

/**
 * Replace {{var_name}} tokens in a content string with serialized values.
 * Unknown tokens are left unchanged.
 *
 * @param {string} content
 * @param {{ [name: string]: { type: string, value: * } | string }} vars
 *   - New format: { name: { type, value } }
 *   - Legacy format (plain string values) is also accepted for migration.
 * @param {'js'|'css'|'html'} [context='js']
 */
function applyHandlebars(content, vars, context = 'js') {
  if (!vars || !Object.keys(vars).length) return content;
  return content.replace(/\{\{([^}]+)\}\}/g, (match, key) => {
    const trimmed = key.trim();
    if (!Object.prototype.hasOwnProperty.call(vars, trimmed)) return match;
    const entry = vars[trimmed];
    // Support legacy plain-string values (migration path)
    if (typeof entry !== 'object' || entry === null || !('type' in entry)) {
      return context === 'js' ? JSON.stringify(String(entry)) : String(entry);
    }
    return serializeVar(entry, context);
  });
}

/**
 * esbuild plugin: handlebars variable substitution for JS/TS/JSX/TSX/MJS/CJS files.
 *
 * Only processes files inside the project's experiences/ directory.
 * Infers the experience slug from the file path so it works for both
 * single-experience dev builds and multi-experience production builds.
 */
function handlebarsPlugin() {
  const expRoot = join(process.cwd(), 'experiences').replace(/\\/g, '/');
  return {
    name: 'handlebars',
    setup(build) {
      build.onLoad({ filter: /\.(js|ts|tsx|jsx|mjs|cjs)$/ }, async (args) => {
        const normPath = args.path.replace(/\\/g, '/');
        if (!normPath.startsWith(expRoot + '/')) return null; // not in experiences dir
        const expSlug = expSlugFromPath(args.path);
        if (!expSlug) return null;
        const vars = getHandlebarsVars(expSlug);
        if (!Object.keys(vars).length) return null; // nothing to replace — use default loader
        const { readFile } = await import('fs/promises');
        const content = await readFile(args.path, 'utf8');
        const processed = applyHandlebars(content, vars, 'js');
        const ext = args.path.split('.').pop().toLowerCase();
        const loaderMap = { ts: 'ts', tsx: 'tsx', jsx: 'jsx', mjs: 'js', cjs: 'js', js: 'js' };
        return {
          contents: processed,
          loader: loaderMap[ext] || 'js',
          watchFiles: [args.path],
        };
      });
    },
  };
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

        const _expSlug = expSlugFromPath(args.path);
        css = applyHandlebars(css, getHandlebarsVars(_expSlug), 'css');

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
    plugins: [handlebarsPlugin(), cssInjectorPlugin()],
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
            const vars = getHandlebarsVars(expSlug);
            try {
              if (ext === '.scss' || ext === '.sass') return applyHandlebars(getSass().compile(filePath).css, vars, 'css');
              return applyHandlebars(readFileSync(filePath, 'utf8'), vars, 'css');
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
              if (!stripped) return '';
              const vars = getHandlebarsVars(expSlug);
              return applyHandlebars(raw.trim(), vars, 'html');
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
  let variationSwitched = false; // force rebuild even when both snapshots are empty (e.g. switching to/from Control)
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
      variationSwitched = true;
    }

    const current = getSnapshot(variationDir);
    const lastKeys = Object.keys(lastSnapshot);
    const currentKeys = Object.keys(current);

    // Identify exactly which files changed (added, removed, or modified)
    const added    = currentKeys.filter((f) => !(f in lastSnapshot));
    const removed  = lastKeys.filter((f) => !(f in current));
    const modified = currentKeys.filter((f) => f in lastSnapshot && lastSnapshot[f] !== current[f]);
    const changedFiles = [...added, ...removed, ...modified];

    // Skip if nothing changed, unless a variation switch just happened
    // (switching to Control has no files — both snapshots are empty — but we
    //  must still rebuild so the old variation's bundle is replaced).
    if (changedFiles.length === 0 && !variationSwitched) return;
    variationSwitched = false;

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
    plugins: [handlebarsPlugin(), cssInjectorPlugin()],
  });

  console.log(`✔ Built ${experiences.length} experience(s) to dist/`);
  experiences.forEach((exp) => console.log(`   dist/${exp.slug}.js`));
}
