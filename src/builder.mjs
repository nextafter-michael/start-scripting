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
import { writeFileSync, readFileSync, mkdirSync, readdirSync, statSync, existsSync, watch } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// TOOL_DIR: the ss tool's install location (not the user's project)
const TOOL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * esbuild plugin: CSS injector
 *
 * Converts any .css import into JavaScript that creates a <style> tag,
 * so the final output is a single self-contained .js file.
 */
function cssInjectorPlugin() {
  return {
    name: 'css-injector',
    setup(build) {
      build.onLoad({ filter: /\.css$/ }, async (args) => {
        const { readFile } = await import('fs/promises');
        const css = await readFile(args.path, 'utf8');
        return {
          contents: `
const __ss_style = document.createElement('style');
__ss_style.textContent = ${JSON.stringify(css)};
document.head.appendChild(__ss_style);
          `.trim(),
          loader: 'js',
        };
      });
    },
  };
}

/**
 * esbuild plugin: reload signal
 *
 * After every successful build, writes the current timestamp to dist/.reload.
 * The livereload script injected by the proxy polls this and refreshes the browser.
 */
function reloadSignalPlugin(distDir) {
  return {
    name: 'reload-signal',
    setup(build) {
      build.onEnd((result) => {
        if (result.errors.length === 0) {
          writeFileSync(join(distDir, '.reload'), Date.now().toString());
          console.log(`  ↻ Rebuilt at ${new Date().toLocaleTimeString()}`);
        } else {
          console.error(`  ✖ Build failed — check your JS for errors`);
        }
      });
    },
  };
}

/**
 * Start the esbuild watcher for a single test.
 * Uses process.cwd() so it works from any project directory.
 *
 * @param {string} testName - The name of the test folder inside tests/
 */
export async function startBuilder(testName) {
  const projectDir = process.cwd();
  const entryPoint = join(projectDir, '.ss-cache', `${testName}.js`);
  const distDir = join(projectDir, 'dist');
  const outfile = join(distDir, 'bundle.js');

  mkdirSync(distDir, { recursive: true });

  if (!existsSync(entryPoint)) {
    console.error(`✖ No cache entry found for "${testName}". Run "ss new ${testName}" first.`);
    process.exit(1);
  }

  const ctx = await esbuild.context({
    entryPoints: [entryPoint],
    absWorkingDir: projectDir,
    outfile,
    bundle: true,
    format: 'iife',  // wraps everything in a function — keeps variables off the global scope
    sourcemap: true,
    plugins: [
      cssInjectorPlugin(),
      reloadSignalPlugin(distDir),
    ],
  });

  await ctx.rebuild();

  // esbuild's built-in ctx.watch() uses FSEvents but doesn't reliably
  // detect changes when the entry point is in .ss-cache/ with relative
  // imports. Instead, we watch the variation directory ourselves and
  // trigger ctx.rebuild() manually on any change.
  const { writeCacheEntry } = await import('./scaffold.mjs');
  const configPath = join(projectDir, '.ss-config.json');
  let activeVariation = 'v1';
  try {
    activeVariation = JSON.parse(readFileSync(configPath, 'utf8')).activeVariation || 'v1';
  } catch {}

  const variationDir = join(projectDir, 'tests', testName, activeVariation);
  let knownFiles = new Set(readdirSync(variationDir));
  let debounceTimer;

  watch(variationDir, { persistent: false }, () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      const currentFiles = new Set(readdirSync(variationDir));
      // Regenerate the cache entry when files are added or removed
      if (currentFiles.size !== knownFiles.size ||
          [...currentFiles].some((f) => !knownFiles.has(f))) {
        writeCacheEntry(testName, activeVariation);
        knownFiles = currentFiles;
        console.log(`  ↻ File list changed — updated imports`);
      }
      // Rebuild on every change (content edits, additions, removals)
      await ctx.rebuild();
    }, 200);
  });

  console.log(`✔ Watching tests/${testName}/`);
}

/**
 * Build all tests to dist/ for deployment (minified, one file per test).
 */
export async function buildAll() {
  const projectDir = process.cwd();
  const testsDir = join(projectDir, 'tests');

  if (!existsSync(testsDir)) {
    console.error('✖ No tests/ folder found in current directory.');
    process.exit(1);
  }

  const testNames = readdirSync(testsDir).filter((name) => {
    if (name === '_template') return false;
    return statSync(join(testsDir, name)).isDirectory();
  });

  if (testNames.length === 0) {
    console.log('No tests found in tests/');
    return;
  }

  const distDir = join(projectDir, 'dist');
  mkdirSync(distDir, { recursive: true });

  const cacheDir = join(projectDir, '.ss-cache');

  await esbuild.build({
    entryPoints: testNames.map((name) => ({
      in: join(cacheDir, `${name}.js`),
      out: name,
    })),
    outdir: distDir,
    bundle: true,
    format: 'iife',
    minify: true,
    plugins: [cssInjectorPlugin()],
  });

  console.log(`✔ Built ${testNames.length} test(s) to dist/`);
  testNames.forEach((name) => console.log(`   dist/${name}.js`));
}
