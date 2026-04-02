/**
 * autostart.mjs — Install and remove login autostart for ss-proxy-service
 *
 * Configures the OS to launch `ss-proxy-service start --silent` automatically
 * when the user logs in, without requiring admin/sudo privileges.
 *
 * Platform implementations:
 *
 *   macOS   — LaunchAgent plist at ~/Library/LaunchAgents/com.nextafter.ss-proxy-service.plist
 *             Loaded immediately via `launchctl load` after writing.
 *
 *   Windows — HKCU\Software\Microsoft\Windows\CurrentVersion\Run registry value
 *             Written via PowerShell; no admin required for HKCU.
 *
 *   Linux   — systemd user service at ~/.config/systemd/user/ss-proxy-service.service
 *             Enabled via `systemctl --user enable --now`.
 *             Falls back to a ~/.profile entry if systemd is not available.
 *
 * Exported API:
 *   install(executablePath)   Install autostart for the given binary path
 *   uninstall()               Remove autostart entry
 *   isInstalled()             Return true if an autostart entry exists
 */

import { execSync } from 'child_process';
import {
  existsSync, writeFileSync, unlinkSync, mkdirSync, readFileSync,
} from 'fs';
import { join } from 'path';
import { homedir, platform } from 'os';

const PLATFORM = platform();

// ─── Platform paths ───────────────────────────────────────────────────────────

const MACOS_PLIST_DIR  = join(homedir(), 'Library', 'LaunchAgents');
const MACOS_PLIST_PATH = join(MACOS_PLIST_DIR, 'com.nextafter.ss-proxy-service.plist');
const MACOS_LABEL      = 'com.nextafter.ss-proxy-service';

const LINUX_SYSTEMD_DIR  = join(homedir(), '.config', 'systemd', 'user');
const LINUX_SERVICE_PATH = join(LINUX_SYSTEMD_DIR, 'ss-proxy-service.service');
const LINUX_SERVICE_NAME = 'ss-proxy-service';

const WIN_REG_KEY   = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const WIN_REG_VALUE = 'ss-proxy-service';

// ─── Exported API ─────────────────────────────────────────────────────────────

/**
 * Install the autostart entry for the given executable path.
 *
 * @param {string} executablePath  Absolute path to the ss-proxy-service binary
 *                                 (or `node /path/to/ss-proxy-service.mjs`)
 */
export function install(executablePath) {
  if (PLATFORM === 'darwin') return _macInstall(executablePath);
  if (PLATFORM === 'win32')  return _winInstall(executablePath);
  return _linuxInstall(executablePath);
}

/**
 * Remove the autostart entry.
 */
export function uninstall() {
  if (PLATFORM === 'darwin') return _macUninstall();
  if (PLATFORM === 'win32')  return _winUninstall();
  return _linuxUninstall();
}

/**
 * Return true if an autostart entry currently exists.
 *
 * @returns {boolean}
 */
export function isInstalled() {
  if (PLATFORM === 'darwin') return existsSync(MACOS_PLIST_PATH);
  if (PLATFORM === 'win32')  return _winIsInstalled();
  return existsSync(LINUX_SERVICE_PATH) || _linuxProfileHasEntry();
}

// ─── macOS — LaunchAgent plist ────────────────────────────────────────────────

function _macInstall(executablePath) {
  if (!existsSync(MACOS_PLIST_DIR)) mkdirSync(MACOS_PLIST_DIR, { recursive: true });

  // Split executable string into program + args for the plist ProgramArguments array
  const parts  = _splitExec(executablePath, ['start', '--silent']);
  const argXml = parts.map(p => `\t\t<string>${_xmlEscape(p)}</string>`).join('\n');

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${MACOS_LABEL}</string>
\t<key>ProgramArguments</key>
\t<array>
${argXml}
\t</array>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<false/>
\t<key>StandardOutPath</key>
\t<string>${join(homedir(), '.ss-proxy', 'proxy.log')}</string>
\t<key>StandardErrorPath</key>
\t<string>${join(homedir(), '.ss-proxy', 'proxy.log')}</string>
\t<key>EnvironmentVariables</key>
\t<dict>
\t\t<key>PATH</key>
\t\t<string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
\t</dict>
</dict>
</plist>
`;

  writeFileSync(MACOS_PLIST_PATH, plist, 'utf8');

  // Load the agent immediately (no restart required)
  try {
    execSync(`launchctl load -w "${MACOS_PLIST_PATH}"`, { stdio: 'pipe' });
  } catch {
    // May fail if already loaded — not fatal
  }
}

function _macUninstall() {
  if (existsSync(MACOS_PLIST_PATH)) {
    try { execSync(`launchctl unload -w "${MACOS_PLIST_PATH}"`, { stdio: 'pipe' }); }
    catch { /* ignore if not loaded */ }
    unlinkSync(MACOS_PLIST_PATH);
  }
}

// ─── Windows — HKCU Run registry key ─────────────────────────────────────────

function _psExec(script) {
  return execSync(`powershell.exe -NoProfile -NonInteractive -Command "${script.replace(/"/g, '\\"')}"`, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function _winInstall(executablePath) {
  const cmd = _splitExec(executablePath, ['start', '--silent']).join(' ');
  // Write to registry — no admin required for HKCU
  execSync(
    `reg add "${WIN_REG_KEY}" /v "${WIN_REG_VALUE}" /t REG_SZ /d "${cmd}" /f`,
    { stdio: 'pipe' }
  );
}

function _winUninstall() {
  try {
    execSync(`reg delete "${WIN_REG_KEY}" /v "${WIN_REG_VALUE}" /f`, { stdio: 'pipe' });
  } catch { /* key may not exist */ }
}

function _winIsInstalled() {
  try {
    execSync(`reg query "${WIN_REG_KEY}" /v "${WIN_REG_VALUE}"`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// ─── Linux — systemd user service (fallback: ~/.profile) ──────────────────────

function _hasSystemd() {
  try { execSync('systemctl --user status', { stdio: 'pipe' }); return true; }
  catch (e) {
    // Exit code 1 with output means systemd is running but no unit was specified
    return e.status === 1;
  }
}

function _linuxInstall(executablePath) {
  if (_hasSystemd()) {
    if (!existsSync(LINUX_SYSTEMD_DIR)) mkdirSync(LINUX_SYSTEMD_DIR, { recursive: true });

    const parts = _splitExec(executablePath, ['start', '--silent']);
    const execStart = parts.join(' ');

    const unit = `[Unit]
Description=ss-proxy-service — A/B test system proxy
After=network.target

[Service]
Type=simple
ExecStart=${execStart}
Restart=on-failure
RestartSec=5
StandardOutput=append:${join(homedir(), '.ss-proxy', 'proxy.log')}
StandardError=append:${join(homedir(), '.ss-proxy', 'proxy.log')}

[Install]
WantedBy=default.target
`;

    writeFileSync(LINUX_SERVICE_PATH, unit, 'utf8');

    try {
      execSync('systemctl --user daemon-reload', { stdio: 'pipe' });
      execSync(`systemctl --user enable --now ${LINUX_SERVICE_NAME}`, { stdio: 'pipe' });
    } catch {
      // May fail on headless systems — unit file is still written
      console.warn('[ss-proxy] systemctl enable failed — autostart unit is written but may need manual activation.');
    }
  } else {
    // Fallback: add to ~/.profile
    _linuxWriteProfileEntry(executablePath);
  }
}

function _linuxUninstall() {
  if (existsSync(LINUX_SERVICE_PATH)) {
    try {
      execSync(`systemctl --user disable --now ${LINUX_SERVICE_NAME}`, { stdio: 'pipe' });
    } catch { /* ignore */ }
    unlinkSync(LINUX_SERVICE_PATH);
    try { execSync('systemctl --user daemon-reload', { stdio: 'pipe' }); } catch { /* ignore */ }
  }
  _linuxRemoveProfileEntry();
}

function _linuxProfileHasEntry() {
  const p = join(homedir(), '.profile');
  if (!existsSync(p)) return false;
  return readFileSync(p, 'utf8').includes(LINUX_PROFILE_MARKER);
}

const LINUX_PROFILE_MARKER = '# ss-proxy-service autostart';

function _linuxWriteProfileEntry(executablePath) {
  const profilePath = join(homedir(), '.profile');
  let content = existsSync(profilePath) ? readFileSync(profilePath, 'utf8') : '';
  if (content.includes(LINUX_PROFILE_MARKER)) return; // already present
  const parts = _splitExec(executablePath, ['start', '--silent']);
  const line  = `\n${LINUX_PROFILE_MARKER}\n(${parts.join(' ')} &)\n`;
  writeFileSync(profilePath, content + line, 'utf8');
}

function _linuxRemoveProfileEntry() {
  const profilePath = join(homedir(), '.profile');
  if (!existsSync(profilePath)) return;
  const content = readFileSync(profilePath, 'utf8');
  const cleaned = content.replace(
    new RegExp(`\\n${LINUX_PROFILE_MARKER}\\n[^\\n]+\\n`, 'g'),
    '\n'
  );
  if (cleaned !== content) writeFileSync(profilePath, cleaned, 'utf8');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build the argv array for the autostart command.
 *
 * executablePath may be:
 *   - A direct binary path: '/usr/local/bin/ss-proxy-service'
 *   - A node script invocation: '/path/to/node /path/to/ss-proxy-service.mjs'
 *
 * @param {string}   executablePath
 * @param {string[]} extraArgs
 * @returns {string[]}
 */
function _splitExec(executablePath, extraArgs = []) {
  // If it contains a space and the first part looks like a node binary, split it
  const parts = executablePath.trim().split(/\s+/);
  return [...parts, ...extraArgs];
}

function _xmlEscape(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
