/**
 * uninstaller.mjs — detached uninstall script for `ss uninstall`
 *
 * Invoked as a detached child process by bin/ss.mjs so that Node can exit
 * before the installation directory is deleted (you can't rmdir the folder
 * that contains the currently-running script while it's still open).
 *
 * Arguments:
 *   node uninstaller.mjs <toolDir>
 *
 * Steps:
 *   1. Short delay so the parent process fully exits and releases any file locks.
 *   2. `npm unlink` in toolDir — removes the global `ss` symlink that `npm link` created.
 *      Falls back to `npm rm -g start-scripting` if unlink exits non-zero.
 *   3. Recursively delete the installation directory (toolDir).
 *   4. Print a final confirmation to stdout (piped to a log file by the parent).
 */

import { execSync } from 'child_process';
import { rmSync, existsSync } from 'fs';
import { resolve } from 'path';

const toolDir = resolve(process.argv[2] || '');

if (!toolDir || !existsSync(toolDir)) {
  console.error('uninstaller: toolDir not found:', toolDir);
  process.exit(1);
}

// Give the parent process (bin/ss.mjs) time to exit cleanly.
await new Promise(r => setTimeout(r, 1500));

// ── Step 1: Remove the global `ss` symlink ────────────────────────────────────
//
// `npm link` (or `npm install -g`) registers the bin defined in package.json.
// `npm unlink` undoes this without touching user project directories.
// We run both strategies to cover different install methods.
try {
  execSync('npm unlink', { cwd: toolDir, stdio: 'pipe' });
  console.log('✔ Removed global ss symlink (npm unlink)');
} catch {
  // npm unlink failed — try the explicit global remove form
  try {
    execSync('npm rm -g start-scripting', { cwd: toolDir, stdio: 'pipe' });
    console.log('✔ Removed global ss symlink (npm rm -g)');
  } catch (e2) {
    // Not fatal — the directory removal below is the critical step.
    // The symlink may already be absent or npm may not be in PATH.
    console.warn('  ⚠ Could not remove npm symlink automatically.');
    console.warn('    If `ss` is still on your PATH after uninstall, run:');
    console.warn('      npm rm -g start-scripting');
    console.warn('    or delete the symlink from your npm bin directory manually.');
  }
}

// ── Step 2: Delete the installation directory ─────────────────────────────────
try {
  rmSync(toolDir, { recursive: true, force: true });
  console.log(`✔ Deleted installation directory: ${toolDir}`);
} catch (err) {
  console.error(`✖ Could not delete ${toolDir}: ${err.message}`);
  console.error('  You may need to delete it manually.');
  process.exit(1);
}

console.log('\n  ss has been uninstalled.');
console.log('  Your project directories and their config.json files are untouched.');
console.log('  To reinstall, clone the repository and run npm link again.');
