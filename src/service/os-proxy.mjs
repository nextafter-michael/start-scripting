/**
 * os-proxy.mjs — Read, set, and unset the OS system proxy
 *
 * Points the operating system's HTTP + HTTPS proxy at 127.0.0.1:<port> so
 * that all browser traffic is routed through ss-proxy-service.
 *
 * Platform implementations:
 *   macOS   — `networksetup` CLI (no admin required for user network services)
 *   Windows — HKCU Internet Settings registry via PowerShell (no admin required)
 *   Linux   — gsettings (GNOME), then kwriteconfig5 (KDE), then ~/.profile env vars
 *
 * Exported API:
 *   read()              → { enabled, host, port } | null
 *   set(host, port)     → void  (throws on failure)
 *   unset()             → void  (throws on failure)
 *   isOurs(host, port)  → boolean  (was this proxy set by us?)
 */

import { execSync, execFileSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { homedir, platform } from 'os';
import { join } from 'path';

const PLATFORM = platform();

// ─── Exported API ─────────────────────────────────────────────────────────────

/**
 * Read the current system proxy setting.
 * Returns null if no proxy is set or the setting cannot be read.
 *
 * @returns {{ enabled: boolean, host: string, port: number } | null}
 */
export function read() {
  try {
    if (PLATFORM === 'darwin') return _macRead();
    if (PLATFORM === 'win32')  return _winRead();
    return _linuxRead();
  } catch {
    return null;
  }
}

/**
 * Set the system HTTP + HTTPS proxy to host:port.
 *
 * @param {string} host  e.g. '127.0.0.1'
 * @param {number} port  e.g. 8080
 */
export function set(host, port) {
  if (PLATFORM === 'darwin') return _macSet(host, port);
  if (PLATFORM === 'win32')  return _winSet(host, port);
  return _linuxSet(host, port);
}

/**
 * Remove the system proxy setting.
 */
export function unset() {
  if (PLATFORM === 'darwin') return _macUnset();
  if (PLATFORM === 'win32')  return _winUnset();
  return _linuxUnset();
}

/**
 * Return true if the current system proxy matches the given host:port.
 * Used to check whether a pre-existing proxy was set by us.
 *
 * @param {string} host
 * @param {number} port
 * @returns {boolean}
 */
export function isOurs(host, port) {
  const current = read();
  return !!(current?.enabled && current.host === host && current.port === port);
}

// ─── macOS ────────────────────────────────────────────────────────────────────
//
// `networksetup` operates on network services (e.g. "Wi-Fi", "Ethernet").
// We apply the setting to all active services so it works regardless of how
// the machine is connected.

function _macNetworkServices() {
  try {
    return execSync('networksetup -listallnetworkservices', { encoding: 'utf8' })
      .split('\n')
      .map(s => s.trim())
      .filter(s => s && !s.startsWith('*') && !s.startsWith('An asterisk'));
  } catch {
    return ['Wi-Fi', 'Ethernet'];
  }
}

function _macRead() {
  const services = _macNetworkServices();
  for (const svc of services) {
    try {
      const out = execSync(`networksetup -getwebproxy "${svc}"`, { encoding: 'utf8' });
      const enabled = /Enabled:\s*Yes/i.test(out);
      const host    = (out.match(/Server:\s*(\S+)/i) || [])[1] || '';
      const port    = parseInt((out.match(/Port:\s*(\d+)/i) || [])[1] || '0', 10);
      if (host) return { enabled, host, port };
    } catch { /* try next service */ }
  }
  return null;
}

function _macSet(host, port) {
  const services = _macNetworkServices();
  for (const svc of services) {
    try {
      execSync(`networksetup -setwebproxy "${svc}" ${host} ${port}`, { stdio: 'pipe' });
      execSync(`networksetup -setsecurewebproxy "${svc}" ${host} ${port}`, { stdio: 'pipe' });
      execSync(`networksetup -setwebproxystate "${svc}" on`, { stdio: 'pipe' });
      execSync(`networksetup -setsecurewebproxystate "${svc}" on`, { stdio: 'pipe' });
    } catch { /* non-fatal: service may be inactive */ }
  }
}

function _macUnset() {
  const services = _macNetworkServices();
  for (const svc of services) {
    try {
      execSync(`networksetup -setwebproxystate "${svc}" off`, { stdio: 'pipe' });
      execSync(`networksetup -setsecurewebproxystate "${svc}" off`, { stdio: 'pipe' });
    } catch { /* non-fatal */ }
  }
}

// ─── Windows ──────────────────────────────────────────────────────────────────
//
// WinInet proxy settings live in:
//   HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings
//
// ProxyEnable (DWORD): 0 = off, 1 = on
// ProxyServer (String): "host:port"
//
// Changes take effect immediately for new processes; running browsers pick it
// up on next request via WinInet's auto-detection.

const WIN_REG_PATH = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

function _psExec(script) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function _winRead() {
  try {
    const enabled = _psExec(
      `(Get-ItemProperty -Path 'Registry::${WIN_REG_PATH}' -Name ProxyEnable -ErrorAction SilentlyContinue).ProxyEnable`
    ).trim();
    const server = _psExec(
      `(Get-ItemProperty -Path 'Registry::${WIN_REG_PATH}' -Name ProxyServer -ErrorAction SilentlyContinue).ProxyServer`
    ).trim();
    if (!server) return null;
    const [host, portStr] = server.split(':');
    return { enabled: enabled === '1', host, port: parseInt(portStr || '0', 10) };
  } catch {
    return null;
  }
}

function _winSet(host, port) {
  _psExec(`Set-ItemProperty -Path 'Registry::${WIN_REG_PATH}' -Name ProxyServer -Value '${host}:${port}'`);
  _psExec(`Set-ItemProperty -Path 'Registry::${WIN_REG_PATH}' -Name ProxyEnable -Value 1`);
  // Notify WinInet of the change
  _psExec(`
    Add-Type -TypeDefinition @"
    using System.Runtime.InteropServices;
    public class WinInet {
      [DllImport("wininet.dll")] public static extern bool InternetSetOption(int h,int o,int b,int l);
    }
"@
    [WinInet]::InternetSetOption(0,37,0,0) | Out-Null
    [WinInet]::InternetSetOption(0,39,0,0) | Out-Null
  `);
}

function _winUnset() {
  _psExec(`Set-ItemProperty -Path 'Registry::${WIN_REG_PATH}' -Name ProxyEnable -Value 0`);
  _psExec(`
    Add-Type -TypeDefinition @"
    using System.Runtime.InteropServices;
    public class WinInet {
      [DllImport("wininet.dll")] public static extern bool InternetSetOption(int h,int o,int b,int l);
    }
"@
    [WinInet]::InternetSetOption(0,37,0,0) | Out-Null
    [WinInet]::InternetSetOption(0,39,0,0) | Out-Null
  `);
}

// ─── Linux ────────────────────────────────────────────────────────────────────
//
// Try GNOME gsettings first, then KDE kwriteconfig5, then fall back to
// writing environment variables into ~/.profile so CLI tools pick them up.
// A full desktop restart may be required for some apps to notice the change.

function _hasCmd(cmd) {
  try { execSync(`command -v ${cmd}`, { stdio: 'pipe' }); return true; }
  catch { return false; }
}

function _linuxRead() {
  // GNOME
  if (_hasCmd('gsettings')) {
    try {
      const mode = execSync("gsettings get org.gnome.system.proxy mode", { encoding: 'utf8' }).trim().replace(/'/g, '');
      if (mode === 'manual') {
        const host = execSync("gsettings get org.gnome.system.proxy.http host", { encoding: 'utf8' }).trim().replace(/'/g, '');
        const port = parseInt(execSync("gsettings get org.gnome.system.proxy.http port", { encoding: 'utf8' }).trim(), 10);
        return { enabled: true, host, port };
      }
      return { enabled: false, host: '', port: 0 };
    } catch { /* fall through */ }
  }

  // Env var fallback
  const proxyEnv = process.env.http_proxy || process.env.HTTP_PROXY || '';
  if (proxyEnv) {
    try {
      const u = new URL(proxyEnv);
      return { enabled: true, host: u.hostname, port: parseInt(u.port, 10) };
    } catch { /* ignore */ }
  }

  return null;
}

function _linuxSet(host, port) {
  // GNOME
  if (_hasCmd('gsettings')) {
    try {
      execSync(`gsettings set org.gnome.system.proxy mode 'manual'`, { stdio: 'pipe' });
      execSync(`gsettings set org.gnome.system.proxy.http host '${host}'`, { stdio: 'pipe' });
      execSync(`gsettings set org.gnome.system.proxy.http port ${port}`, { stdio: 'pipe' });
      execSync(`gsettings set org.gnome.system.proxy.https host '${host}'`, { stdio: 'pipe' });
      execSync(`gsettings set org.gnome.system.proxy.https port ${port}`, { stdio: 'pipe' });
      return;
    } catch { /* fall through to KDE */ }
  }

  // KDE
  if (_hasCmd('kwriteconfig5')) {
    try {
      execSync(`kwriteconfig5 --file kioslaverc --group 'Proxy Settings' --key ProxyType 1`, { stdio: 'pipe' });
      execSync(`kwriteconfig5 --file kioslaverc --group 'Proxy Settings' --key httpProxy 'http://${host}:${port}'`, { stdio: 'pipe' });
      execSync(`kwriteconfig5 --file kioslaverc --group 'Proxy Settings' --key httpsProxy 'http://${host}:${port}'`, { stdio: 'pipe' });
      execSync(`dbus-send --type=signal /KIO/Scheduler org.kde.KIO.Scheduler.reparseSlaveConfiguration string:''`, { stdio: 'pipe' });
      return;
    } catch { /* fall through to env */ }
  }

  // Env var fallback — write to ~/.profile
  _linuxWriteProfileEnv(host, port);
}

function _linuxUnset() {
  if (_hasCmd('gsettings')) {
    try {
      execSync(`gsettings set org.gnome.system.proxy mode 'none'`, { stdio: 'pipe' });
      return;
    } catch { /* fall through */ }
  }

  if (_hasCmd('kwriteconfig5')) {
    try {
      execSync(`kwriteconfig5 --file kioslaverc --group 'Proxy Settings' --key ProxyType 0`, { stdio: 'pipe' });
      return;
    } catch { /* fall through */ }
  }

  _linuxRemoveProfileEnv();
}

const PROFILE_MARKER_START = '# ss-proxy-service proxy settings';
const PROFILE_MARKER_END   = '# end ss-proxy-service';

function _linuxWriteProfileEnv(host, port) {
  const profilePath = join(homedir(), '.profile');
  let content = existsSync(profilePath) ? readFileSync(profilePath, 'utf8') : '';
  // Remove any existing block
  content = _removeProfileBlock(content);
  const block = [
    PROFILE_MARKER_START,
    `export http_proxy="http://${host}:${port}"`,
    `export https_proxy="http://${host}:${port}"`,
    `export HTTP_PROXY="http://${host}:${port}"`,
    `export HTTPS_PROXY="http://${host}:${port}"`,
    PROFILE_MARKER_END,
  ].join('\n');
  writeFileSync(profilePath, content.trimEnd() + '\n\n' + block + '\n', 'utf8');
}

function _linuxRemoveProfileEnv() {
  const profilePath = join(homedir(), '.profile');
  if (!existsSync(profilePath)) return;
  const content = readFileSync(profilePath, 'utf8');
  writeFileSync(profilePath, _removeProfileBlock(content), 'utf8');
}

function _removeProfileBlock(content) {
  const re = new RegExp(
    `\\n*${PROFILE_MARKER_START}[\\s\\S]*?${PROFILE_MARKER_END}\\n*`,
    'g'
  );
  return content.replace(re, '\n').trimEnd() + '\n';
}
