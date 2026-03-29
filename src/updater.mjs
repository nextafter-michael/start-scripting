/**
 * updater.mjs — Self-update logic for the ss tool
 *
 * This module is designed to be spawned as a DETACHED child process by
 * `ss upgrade` so the running Node process isn't killed when the source
 * directory is replaced mid-update.
 *
 * Steps:
 *   1. Read repo URL + current version from the tool's own package.json
 *   2. Clone the repo into a sibling temp directory
 *   3. Remove the contents of the current tool directory (preserving .git/)
 *   4. Move the cloned files into place
 *   5. Run setup.bat (Windows) or setup.sh (Unix) to npm install + npm link
 *   6. Print "Upgrade completed: vX.Y.Z" and exit
 *
 * Run directly:
 *   node src/updater.mjs <toolDir>
 */

import { execSync } from 'child_process';
import { readFileSync, readdirSync, rmSync, renameSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';

const toolDir = process.argv[2];

if (!toolDir) {
  console.error('updater: missing toolDir argument');
  process.exit(1);
}

function run(cmd, cwd) {
  execSync(cmd, { cwd, stdio: 'inherit' });
}

try {
  // ── 1. Read repo URL from package.json ──────────────────────────────────
  const pkg = JSON.parse(readFileSync(join(toolDir, 'package.json'), 'utf8'));
  const repoUrl = pkg.repository?.url;
  if (!repoUrl) {
    console.error('updater: no repository.url found in package.json');
    process.exit(1);
  }

  // ── 2. Clone into a unique temp directory ────────────────────────────────
  const tmpBase = tmpdir();
  const tmpName = `ss-upgrade-${randomBytes(4).toString('hex')}`;
  const tmpPath = join(tmpBase, tmpName);

  console.log(`  Cloning ${repoUrl}...`);
  run(`git clone --depth 1 "${repoUrl}" "${tmpPath}"`, tmpBase);

  // Read the new version before we do anything else
  const newPkg = JSON.parse(readFileSync(join(tmpPath, 'package.json'), 'utf8'));
  const newVersion = newPkg.version || '(unknown)';

  // ── 3. Remove current tool files, preserve .git/ ─────────────────────────
  for (const entry of readdirSync(toolDir)) {
    if (entry === '.git') continue;
    rmSync(join(toolDir, entry), { recursive: true, force: true });
  }

  // ── 4. Move cloned files into the tool directory ─────────────────────────
  for (const entry of readdirSync(tmpPath)) {
    if (entry === '.git') continue;
    renameSync(join(tmpPath, entry), join(toolDir, entry));
  }

  // Clean up temp clone (.git was not copied)
  rmSync(tmpPath, { recursive: true, force: true });

  // ── 5. Run setup script ──────────────────────────────────────────────────
  const isWindows = process.platform === 'win32';
  if (isWindows) {
    const bat = join(toolDir, 'setup.bat');
    if (existsSync(bat)) {
      console.log('  Running setup.bat...');
      run(`"${bat}"`, toolDir);
    } else {
      run('npm install && npm link', toolDir);
    }
  } else {
    const sh = join(toolDir, 'setup.sh');
    if (existsSync(sh)) {
      console.log('  Running setup.sh...');
      run(`bash "${sh}"`, toolDir);
    } else {
      run('npm install && npm link', toolDir);
    }
  }

  // ── 6. Done ──────────────────────────────────────────────────────────────
  console.log(`\nUpgrade completed: v${newVersion}`);

} catch (err) {
  console.error(`\nUpgrade failed: ${err.message}`);
  process.exit(1);
}
