/**
 * setup.mjs — Interactive setup wizard for ss-proxy-service
 *
 * Guides the user through the one-time configuration needed to run the
 * system proxy service. Called by `ss-proxy-service setup`.
 *
 * Steps:
 *   1. Welcome + existing config check
 *   2. Port selection (default 8080, validates availability)
 *   3. CA certificate generation
 *   4. OS trust store installation
 *   5. Firefox profile detection + cert install
 *   6. System proxy configuration (detects pre-existing proxy)
 *   7. Autostart configuration
 *   8. Write ~/.ss-proxy/config.json
 *   9. Summary
 *
 * Usage:
 *   import { runSetup } from './setup.mjs';
 *   await runSetup();
 */

import { createInterface }  from 'readline';
import { createServer }     from 'net';
import { existsSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { join }             from 'path';
import { homedir, platform } from 'os';

import { ensureCA, DATA_DIR }                           from './cert.mjs';
import { installCATrust, installFirefoxTrust,
         findFirefoxProfiles }                          from './os-trust.mjs';
import { read as readProxy, set as setProxy, isOurs }  from './os-proxy.mjs';
import { install as installAutostart, isInstalled
         as isAutostartInstalled }                      from './autostart.mjs';

const CONFIG_PATH = join(DATA_DIR, 'config.json');
const CA_CERT     = join(DATA_DIR, 'ca.crt');

// ─── Prompt helpers ───────────────────────────────────────────────────────────

function ask(rl, question) {
  return new Promise(resolve => rl.question(question, a => resolve(a.trim())));
}

async function confirm(rl, question, defaultYes = true) {
  const hint = defaultYes ? '[Y/n]' : '[y/N]';
  const answer = await ask(rl, `${question} ${hint}: `);
  if (!answer) return defaultYes;
  return answer.toLowerCase().startsWith('y');
}

// ─── Port availability check ──────────────────────────────────────────────────

function isPortAvailable(port) {
  return new Promise(resolve => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => { srv.close(); resolve(true); });
    srv.listen(port, '127.0.0.1');
  });
}

// ─── Visual helpers ───────────────────────────────────────────────────────────

const W = 60;
const line  = '─'.repeat(W);
const ok    = '  ✔';
const warn  = '  ⚠';
const fail  = '  ✖';
const skip  = '  –';

function header(title) {
  console.log('\n┌' + line + '┐');
  const pad = Math.max(0, W - title.length);
  const l = Math.floor(pad / 2), r = Math.ceil(pad / 2);
  console.log('│' + ' '.repeat(l) + title + ' '.repeat(r) + '│');
  console.log('└' + line + '┘\n');
}

function step(n, total, title) {
  console.log(`\n  ── Step ${n}/${total}: ${title}`);
}

function loadConfig() {
  try { return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); }
  catch { return {}; }
}

// ─── Main setup ───────────────────────────────────────────────────────────────

export async function runSetup() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const TOTAL_STEPS = 7;

  header('ss-proxy-service  setup');

  // ── Existing config warning ──────────────────────────────────────────────────
  if (existsSync(CONFIG_PATH)) {
    console.log(`  An existing configuration was found at:\n    ${CONFIG_PATH}\n`);
    const proceed = await confirm(rl, '  Re-run setup and overwrite existing settings?', false);
    if (!proceed) {
      console.log(`\n${skip} Setup cancelled. Your existing configuration is unchanged.\n`);
      rl.close();
      return;
    }
    console.log('');
  }

  const config = loadConfig();

  // ── Step 1: Port ─────────────────────────────────────────────────────────────
  step(1, TOTAL_STEPS, 'Proxy port');
  console.log('  The proxy listens on a local port. All browser traffic will route');
  console.log('  through this port. Default is 8080.\n');

  let port = 8080;
  while (true) {
    const input = await ask(rl, `  Port number [${port}]: `);
    const candidate = input ? parseInt(input, 10) : port;

    if (isNaN(candidate) || candidate < 1024 || candidate > 65535) {
      console.log(`${fail} Invalid port. Enter a number between 1024 and 65535.`);
      continue;
    }

    if (!(await isPortAvailable(candidate))) {
      console.log(`${warn} Port ${candidate} is already in use. Try another port.`);
      continue;
    }

    port = candidate;
    console.log(`${ok} Using port ${port}.`);
    break;
  }

  // ── Step 2: CA certificate ───────────────────────────────────────────────────
  step(2, TOTAL_STEPS, 'Local CA certificate');

  if (existsSync(CA_CERT)) {
    console.log(`${ok} CA certificate already exists at:\n     ${CA_CERT}`);
  } else {
    console.log('  Generating a local CA certificate used to sign per-domain certificates.');
    console.log('  This is stored only on your machine and never shared.\n');
    try {
      await ensureCA();
      console.log(`${ok} CA certificate generated:\n     ${CA_CERT}`);
    } catch (err) {
      console.log(`${fail} Failed to generate CA: ${err.message}`);
      console.log('  Setup cannot continue without a CA certificate.');
      rl.close();
      return;
    }
  }

  // ── Step 3: OS trust store ───────────────────────────────────────────────────
  step(3, TOTAL_STEPS, 'Install CA certificate (OS trust store)');
  console.log('  To intercept HTTPS traffic without browser warnings, the CA certificate');
  console.log('  must be trusted by your OS.\n');

  if (platform() === 'darwin') {
    console.log('  macOS will show a password dialog to confirm adding the certificate.');
  } else if (platform() === 'win32') {
    console.log('  Windows will add the certificate to your user (CurrentUser) store.');
    console.log('  No administrator password is required.');
  } else {
    console.log('  The certificate will be added to your user NSS database (~/.pki/nssdb)');
    console.log('  used by Chrome/Chromium. Other browsers may require manual installation.');
  }
  console.log('');

  const doTrust = await confirm(rl, '  Install CA certificate into OS trust store?');
  if (doTrust) {
    const { ok: trustOk, errors } = installCATrust(CA_CERT);
    if (trustOk) {
      console.log(`${ok} CA certificate installed in OS trust store.`);
    } else {
      console.log(`${warn} Could not install automatically:\n     ${errors.join('\n     ')}`);
      _printManualTrustInstructions(CA_CERT);
    }
  } else {
    console.log(`${skip} Skipped. You can install it manually:\n     ${CA_CERT}`);
    _printManualTrustInstructions(CA_CERT);
  }

  // ── Step 4: Firefox profiles ─────────────────────────────────────────────────
  step(4, TOTAL_STEPS, 'Firefox certificate trust');

  const ffProfiles = findFirefoxProfiles();
  if (ffProfiles.length === 0) {
    console.log(`${skip} No Firefox profiles detected.`);
  } else {
    console.log(`  Found ${ffProfiles.length} Firefox profile(s).\n`);
    const doFirefox = await confirm(rl, '  Install CA certificate in Firefox profiles?');
    if (doFirefox) {
      const { profiles, errors } = installFirefoxTrust(CA_CERT);
      if (errors.length === 0) {
        console.log(`${ok} Installed in ${profiles.length} Firefox profile(s).`);
      } else {
        console.log(`${warn} Partial install — ${errors.length} profile(s) failed:`);
        for (const e of errors) console.log(`       ${e}`);
      }
    } else {
      console.log(`${skip} Skipped. Firefox will show certificate warnings for HTTPS sites.`);
    }
  }

  // ── Step 5: System proxy ─────────────────────────────────────────────────────
  step(5, TOTAL_STEPS, 'System proxy configuration');
  console.log('  Setting the OS proxy routes browser traffic through ss-proxy-service.\n');

  const existing = readProxy();
  if (existing?.enabled && !isOurs('127.0.0.1', port)) {
    console.log(`${warn} A proxy is already configured on this machine:`);
    console.log(`       ${existing.host}:${existing.port}`);
    console.log('  This may be a corporate VPN or security proxy.');
    console.log('  Overwriting it will route traffic through ss-proxy-service instead.\n');
    const overwrite = await confirm(rl, '  Overwrite the existing proxy setting?', false);
    if (!overwrite) {
      console.log(`${skip} System proxy not changed.`);
      console.log(`       Manually set your proxy to 127.0.0.1:${port} when ready.`);
      config._proxySetByUs = false;
    } else {
      _setProxyOrWarn(port, config);
    }
  } else {
    const doProxy = await confirm(rl, `  Set system proxy to 127.0.0.1:${port}?`);
    if (doProxy) {
      _setProxyOrWarn(port, config);
    } else {
      console.log(`${skip} System proxy not changed.`);
      console.log(`       Manually set your proxy to 127.0.0.1:${port} to use the service.`);
      config._proxySetByUs = false;
    }
  }

  // ── Step 6: Autostart ────────────────────────────────────────────────────────
  step(6, TOTAL_STEPS, 'Autostart at login');
  console.log('  The proxy service can start automatically when you log in,\n');
  console.log('  so you never need to remember to run it manually.\n');

  if (isAutostartInstalled()) {
    console.log(`${ok} Autostart is already configured.`);
    config.autostart = true;
  } else {
    const doAutostart = await confirm(rl, '  Configure autostart at login?');
    if (doAutostart) {
      try {
        // Use `node <path-to-script>` as the executable for portability
        const scriptPath = new URL('../../bin/ss-proxy-service.mjs', import.meta.url).pathname
          .replace(/^\/([A-Z]:)/, '$1');
        installAutostart(`${process.execPath} ${scriptPath}`);
        console.log(`${ok} Autostart configured.`);
        config.autostart = true;
      } catch (err) {
        console.log(`${warn} Autostart setup failed: ${err.message}`);
        config.autostart = false;
      }
    } else {
      console.log(`${skip} Autostart not configured. Run \`ss-proxy-service start --silent\` manually.`);
      config.autostart = false;
    }
  }

  // ── Step 7: Write config ─────────────────────────────────────────────────────
  step(7, TOTAL_STEPS, 'Saving configuration');

  config.port     = port;
  config.logLevel = config.logLevel || 'info';

  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
  console.log(`${ok} Configuration saved to:\n     ${CONFIG_PATH}`);

  // ── Summary ───────────────────────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(W + 2));
  console.log('\n  Setup complete!\n');
  console.log(`  Proxy port:  ${port}`);
  console.log(`  CA cert:     ${CA_CERT}`);
  console.log(`  Config:      ${CONFIG_PATH}`);
  console.log('');
  console.log('  Start the service:');
  console.log('    ss-proxy-service start            (foreground)');
  console.log('    ss-proxy-service start --silent   (background daemon)');
  console.log('');
  console.log('  Register a project:');
  console.log('    cd /path/to/your/project');
  console.log('    ss-proxy-service register');
  console.log('');

  rl.close();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _setProxyOrWarn(port, config) {
  try {
    setProxy('127.0.0.1', port);
    console.log(`${ok} System proxy set to 127.0.0.1:${port}.`);
    config._proxySetByUs = true;
  } catch (err) {
    console.log(`${warn} Could not set system proxy: ${err.message}`);
    console.log(`       Manually set your proxy to 127.0.0.1:${port}.`);
    config._proxySetByUs = false;
  }
}

function _printManualTrustInstructions(certPath) {
  const p = platform();
  console.log('\n  Manual installation instructions:');
  if (p === 'darwin') {
    console.log(`    sudo security add-trusted-cert -d -r trustRoot \\`);
    console.log(`      -k /Library/Keychains/System.keychain "${certPath}"`);
  } else if (p === 'win32') {
    console.log(`    In PowerShell (as Administrator):`);
    console.log(`    Import-Certificate -FilePath "${certPath}" -CertStoreLocation Cert:\\LocalMachine\\Root`);
  } else {
    console.log(`    sudo cp "${certPath}" /usr/local/share/ca-certificates/ss-proxy.crt`);
    console.log(`    sudo update-ca-certificates`);
    console.log(`    # Fedora/RHEL:`);
    console.log(`    sudo cp "${certPath}" /etc/pki/ca-trust/source/anchors/ss-proxy.crt`);
    console.log(`    sudo update-ca-trust`);
  }
  console.log('');
}
