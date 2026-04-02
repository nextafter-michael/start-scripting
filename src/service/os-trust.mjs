/**
 * os-trust.mjs — Install and remove the local CA cert from OS trust stores
 *
 * Called once during `ss-proxy-service setup` and reversed by `uninstall`.
 *
 * Platform coverage:
 *   macOS   — User login keychain (no sudo; prompts for password via GUI dialog)
 *   Windows — CurrentUser certificate store (no admin required)
 *   Linux   — User NSS db at ~/.pki/nssdb (Chrome/Chromium); guides for system
 *
 * Firefox (all platforms):
 *   Firefox maintains its own per-profile NSS database independent of the OS
 *   trust store. We detect all Firefox profiles and install/remove the cert in
 *   each using `certutil` from the nss-tools package.
 *
 * Exported API:
 *   installCATrust(certPath)   → { ok, errors[] }
 *   removeCATrust(certPath)    → { ok, errors[] }
 *   installFirefoxTrust(certPath)  → { profiles, errors[] }
 *   removeFirefoxTrust()           → { profiles, errors[] }
 *   findFirefoxProfiles()      → string[]  (absolute paths)
 */

import { execSync } from 'child_process';
import { existsSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir, platform } from 'os';

const PLATFORM   = platform();
const CERT_NAME  = 'ss-proxy Local CA';

// ─── Main CA trust install / remove ──────────────────────────────────────────

/**
 * Install the CA certificate into the OS trust store.
 *
 * @param {string} certPath  Absolute path to ca.crt (PEM)
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function installCATrust(certPath) {
  const errors = [];
  try {
    if (PLATFORM === 'darwin') {
      _macInstall(certPath);
    } else if (PLATFORM === 'win32') {
      _winInstall(certPath);
    } else {
      _linuxInstall(certPath);
    }
  } catch (err) {
    errors.push(err.message);
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Remove the CA certificate from the OS trust store.
 *
 * @param {string} certPath  Absolute path to ca.crt (PEM)
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function removeCATrust(certPath) {
  const errors = [];
  try {
    if (PLATFORM === 'darwin') {
      _macRemove(certPath);
    } else if (PLATFORM === 'win32') {
      _winRemove();
    } else {
      _linuxRemove(certPath);
    }
  } catch (err) {
    errors.push(err.message);
  }
  return { ok: errors.length === 0, errors };
}

// ─── macOS ────────────────────────────────────────────────────────────────────
// Adds to the user's login keychain — no sudo needed, but macOS will show a
// password confirmation dialog on first install (standard keychain modification).

function _macInstall(certPath) {
  // Remove any existing entry first to avoid duplicates
  try {
    execSync(
      `security delete-certificate -c "${CERT_NAME}" ~/Library/Keychains/login.keychain-db 2>/dev/null`,
      { stdio: 'pipe' }
    );
  } catch { /* not present — ok */ }

  execSync(
    `security add-trusted-cert -d -r trustRoot -k ~/Library/Keychains/login.keychain-db "${certPath}"`,
    { stdio: 'pipe' }
  );
}

function _macRemove(_certPath) {
  try {
    execSync(
      `security delete-certificate -c "${CERT_NAME}" ~/Library/Keychains/login.keychain-db`,
      { stdio: 'pipe' }
    );
  } catch { /* not present — ok */ }
}

// ─── Windows ─────────────────────────────────────────────────────────────────
// Import into CurrentUser\Root — no admin required.
// Chrome, Edge, and IE/WebView2 all honour this store.

function _winInstall(certPath) {
  const winPath = certPath.replace(/\//g, '\\');
  execSync(
    `powershell.exe -NoProfile -NonInteractive -Command "Import-Certificate -FilePath '${winPath}' -CertStoreLocation Cert:\\CurrentUser\\Root"`,
    { stdio: 'pipe' }
  );
}

function _winRemove() {
  // Find and delete by subject CN
  execSync(
    `powershell.exe -NoProfile -NonInteractive -Command "Get-ChildItem Cert:\\CurrentUser\\Root | Where-Object { $_.Subject -like '*ss-proxy*' } | Remove-Item"`,
    { stdio: 'pipe' }
  );
}

// ─── Linux ────────────────────────────────────────────────────────────────────
// Install into the user NSS database (~/.pki/nssdb) used by Chrome/Chromium.
// System-wide installation requires sudo — we skip it and show manual instructions.

function _linuxInstall(certPath) {
  const nssDir = join(homedir(), '.pki', 'nssdb');
  if (!existsSync(nssDir)) {
    mkdirSync(nssDir, { recursive: true });
    try { execSync(`certutil -d sql:${nssDir} -N --empty-password`, { stdio: 'pipe' }); }
    catch { /* may already be initialised */ }
  }

  if (_hasCertutil()) {
    execSync(
      `certutil -d sql:${nssDir} -A -t "CT,," -n "${CERT_NAME}" -i "${certPath}"`,
      { stdio: 'pipe' }
    );
  } else {
    throw new Error(
      'certutil not found. Install it with:\n' +
      '  Ubuntu/Debian: sudo apt install libnss3-tools\n' +
      '  Fedora/RHEL:   sudo dnf install nss-tools'
    );
  }
}

function _linuxRemove(_certPath) {
  const nssDir = join(homedir(), '.pki', 'nssdb');
  if (!existsSync(nssDir) || !_hasCertutil()) return;
  try {
    execSync(`certutil -d sql:${nssDir} -D -n "${CERT_NAME}"`, { stdio: 'pipe' });
  } catch { /* not present — ok */ }
}

function _hasCertutil() {
  try { execSync('certutil -V', { stdio: 'pipe' }); return true; }
  catch { return false; }
}

// ─── Firefox profiles ─────────────────────────────────────────────────────────

/**
 * Return an array of absolute paths to all detected Firefox profile directories.
 *
 * @returns {string[]}
 */
export function findFirefoxProfiles() {
  const candidates = [];

  if (PLATFORM === 'darwin') {
    candidates.push(join(homedir(), 'Library', 'Application Support', 'Firefox', 'Profiles'));
  } else if (PLATFORM === 'win32') {
    candidates.push(join(process.env.APPDATA || '', 'Mozilla', 'Firefox', 'Profiles'));
  } else {
    candidates.push(join(homedir(), '.mozilla', 'firefox'));
    candidates.push(join(homedir(), 'snap', 'firefox', 'common', '.mozilla', 'firefox'));
  }

  const profiles = [];
  for (const base of candidates) {
    if (!existsSync(base)) continue;
    try {
      for (const entry of readdirSync(base, { withFileTypes: true })) {
        if (entry.isDirectory()) profiles.push(join(base, entry.name));
      }
    } catch { /* permission error — skip */ }
  }
  return profiles;
}

/**
 * Install the CA cert into all detected Firefox profile NSS databases.
 *
 * Requires `certutil` (nss-tools / libnss3-tools on Linux, included with
 * Firefox on macOS/Windows via `~/.mozilla` NSS or the `certutil` bundled
 * in the Firefox install directory).
 *
 * @param {string} certPath  Absolute path to ca.crt
 * @returns {{ profiles: string[], errors: string[] }}
 */
export function installFirefoxTrust(certPath) {
  const profiles = findFirefoxProfiles();
  const errors   = [];

  if (!_hasCertutil()) {
    // On macOS/Windows, Firefox ships its own certutil in the install directory
    const bundled = _findBundledCertutil();
    if (!bundled) {
      return {
        profiles: [],
        errors: ['certutil not found — Firefox profiles were not updated. Install nss-tools to enable Firefox support.'],
      };
    }
  }

  for (const profile of profiles) {
    try {
      // Remove existing entry first to handle updates
      try {
        execSync(`certutil -d sql:"${profile}" -D -n "${CERT_NAME}" 2>/dev/null`, { stdio: 'pipe' });
      } catch { /* not present — ok */ }

      execSync(
        `certutil -d sql:"${profile}" -A -t "CT,," -n "${CERT_NAME}" -i "${certPath}"`,
        { stdio: 'pipe' }
      );
    } catch (err) {
      // Try legacy (non-sql) db format
      try {
        execSync(
          `certutil -d "${profile}" -A -t "CT,," -n "${CERT_NAME}" -i "${certPath}"`,
          { stdio: 'pipe' }
        );
      } catch {
        errors.push(`${profile}: ${err.message}`);
      }
    }
  }

  return { profiles, errors };
}

/**
 * Remove the CA cert from all detected Firefox profile NSS databases.
 *
 * @returns {{ profiles: string[], errors: string[] }}
 */
export function removeFirefoxTrust() {
  const profiles = findFirefoxProfiles();
  const errors   = [];

  for (const profile of profiles) {
    try {
      execSync(`certutil -d sql:"${profile}" -D -n "${CERT_NAME}"`, { stdio: 'pipe' });
    } catch {
      try {
        execSync(`certutil -d "${profile}" -D -n "${CERT_NAME}"`, { stdio: 'pipe' });
      } catch { /* not present — ok */ }
    }
  }

  return { profiles, errors };
}

// ─── Internal ─────────────────────────────────────────────────────────────────

function _findBundledCertutil() {
  // Firefox ships certutil in its install directory on macOS/Windows
  const candidates = PLATFORM === 'darwin'
    ? ['/Applications/Firefox.app/Contents/MacOS/certutil']
    : [
        join(process.env['PROGRAMFILES'] || 'C:\\Program Files', 'Mozilla Firefox', 'certutil.exe'),
        join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Mozilla Firefox', 'certutil.exe'),
      ];

  return candidates.find(p => existsSync(p)) ?? null;
}
