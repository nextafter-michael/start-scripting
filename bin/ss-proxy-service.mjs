#!/usr/bin/env node
/**
 * bin/ss-proxy-service.mjs — CLI for the ss system proxy daemon
 *
 * Commands:
 *   setup                  Interactive setup wizard (first-run)
 *   start [--silent]       Start the proxy (foreground or detached daemon)
 *   stop                   Stop the running daemon via IPC
 *   restart                Restart the running daemon via IPC
 *   status                 Print running state + registered projects
 *   register [path]        Add a project directory to the registry
 *   unregister [path]      Remove a project from the registry
 *   upgrade                Upgrade ss-proxy-service (same pattern as ss upgrade)
 *   uninstall              Reverse setup + delete service data
 */

import { program }                  from 'commander';
import { createInterface }          from 'readline';
import { existsSync, openSync, closeSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { join, resolve }            from 'path';
import { homedir }                  from 'os';
import { spawn }                    from 'child_process';

// ── When spawned as detached daemon, run proxy directly ───────────────────────
// The parent passes --daemon as a hidden flag when spawning via `start --silent`.
if (process.argv.includes('--daemon')) {
  const { readFileSync: rf } = await import('fs');
  const { join: pj }         = await import('path');
  const { homedir: hd }      = await import('os');
  const { writeFileSync: wf } = await import('fs');

  const configPath = pj(hd(), '.ss-proxy', 'config.json');
  let port = 8080;
  try { port = JSON.parse(rf(configPath, 'utf8')).port || 8080; } catch { /* use default */ }

  const pidPath = pj(hd(), '.ss-proxy', 'proxy.pid');
  wf(pidPath, String(process.pid), 'utf8');

  const { startProxy } = await import('../src/service/proxy.mjs');
  await startProxy({ port });
  process.exit(0);
}

// ── Paths ─────────────────────────────────────────────────────────────────────

const DATA_DIR    = join(homedir(), '.ss-proxy');
const CONFIG_PATH = join(DATA_DIR, 'config.json');
const PID_PATH    = join(DATA_DIR, 'proxy.pid');

const TOOL_DIR    = join(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'), '..', '..');
const THIS_SCRIPT = join(TOOL_DIR, 'bin', 'ss-proxy-service.mjs');

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadConfig() {
  try { return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); }
  catch { return { port: 8080 }; }
}

function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, a => { rl.close(); resolve(a.trim()); }));
}

function isRunning() {
  if (!existsSync(PID_PATH)) return false;
  try {
    const pid = parseInt(readFileSync(PID_PATH, 'utf8'), 10);
    if (!pid) return false;
    process.kill(pid, 0); // throws if process doesn't exist
    return true;
  } catch {
    return false;
  }
}

// ── setup ─────────────────────────────────────────────────────────────────────

program
  .command('setup')
  .description('Interactive setup wizard (run once after installation)')
  .action(async () => {
    const { runSetup } = await import('../src/service/setup.mjs');
    await runSetup();
  });

// ── start ─────────────────────────────────────────────────────────────────────

program
  .command('start')
  .description('Start the proxy service')
  .option('-s, --silent', 'Run as a background daemon (detached)')
  .action(async (opts) => {
    if (!existsSync(CONFIG_PATH)) {
      console.error('  No configuration found. Run `ss-proxy-service setup` first.');
      process.exit(1);
    }

    if (opts.silent) {
      // ── Detached daemon mode ───────────────────────────────────────────────
      if (isRunning()) {
        console.log('  ss-proxy-service is already running.');
        return;
      }

      const logPath = join(DATA_DIR, 'proxy.log');
      const logFd   = openSync(logPath, 'a');
      const child   = spawn(process.execPath, [THIS_SCRIPT, '--daemon'], {
        detached: true,
        stdio:    ['ignore', logFd, logFd],
      });
      child.unref();
      closeSync(logFd);

      const { port } = loadConfig();
      console.log(`  ss-proxy-service started in the background.`);
      console.log(`  Proxy:  127.0.0.1:${port}`);
      console.log(`  Logs:   ${logPath}`);
      console.log(`  PID:    ${child.pid}`);
    } else {
      // ── Foreground mode ────────────────────────────────────────────────────
      const { port } = loadConfig();
      console.log(`  Starting ss-proxy-service on 127.0.0.1:${port}`);
      console.log('  Press Ctrl+C to stop.\n');

      writeFileSync(PID_PATH, String(process.pid), 'utf8');

      process.on('SIGINT',  () => { _cleanup(); process.exit(0); });
      process.on('SIGTERM', () => { _cleanup(); process.exit(0); });

      const { startProxy } = await import('../src/service/proxy.mjs');
      await startProxy({ port });
    }
  });

// ── stop ──────────────────────────────────────────────────────────────────────

program
  .command('stop')
  .description('Stop the running daemon')
  .action(async () => {
    const { sendIpcCommand } = await import('../src/service/ipc.mjs');
    try {
      await sendIpcCommand({ action: 'stop' });
      console.log('  ss-proxy-service stopped.');
    } catch (err) {
      // Fall back to SIGTERM via PID file
      if (existsSync(PID_PATH)) {
        try {
          const pid = parseInt(readFileSync(PID_PATH, 'utf8'), 10);
          process.kill(pid, 'SIGTERM');
          console.log('  ss-proxy-service stopped.');
        } catch {
          console.error('  Could not stop service:', err.message);
          process.exit(1);
        }
      } else {
        console.error('  ss-proxy-service is not running.');
      }
    }
  });

// ── restart ───────────────────────────────────────────────────────────────────

program
  .command('restart')
  .description('Restart the running daemon')
  .action(async () => {
    const { sendIpcCommand } = await import('../src/service/ipc.mjs');
    try {
      await sendIpcCommand({ action: 'restart' });
      console.log('  ss-proxy-service restarting...');
    } catch (err) {
      console.error('  Could not reach daemon:', err.message);
      console.log('  Trying cold restart...');
      // stop + start
      try {
        if (existsSync(PID_PATH)) {
          const pid = parseInt(readFileSync(PID_PATH, 'utf8'), 10);
          try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
        }
      } catch { /* ignore */ }
      setTimeout(() => {
        const child = spawn(process.execPath, [THIS_SCRIPT, 'start', '--silent'], {
          stdio: 'inherit',
        });
        child.on('exit', code => process.exit(code || 0));
      }, 500);
    }
  });

// ── status ────────────────────────────────────────────────────────────────────

program
  .command('status')
  .description('Show service status and registered projects')
  .action(async () => {
    const running = isRunning();
    const { port } = loadConfig();

    console.log('');
    console.log(`  Service:  ${running ? '● running' : '○ stopped'}`);
    if (running) console.log(`  Port:     127.0.0.1:${port}`);
    console.log('');

    // Try to get live status from the daemon
    if (running) {
      try {
        const { sendIpcCommand } = await import('../src/service/ipc.mjs');
        const data = await sendIpcCommand({ action: 'status' }, 2000);
        if (data.connections?.length) {
          console.log('  Active connections:');
          for (const c of data.connections) {
            console.log(`    project ${c.projectId}: ${c.clients} client(s)`);
          }
          console.log('');
        }
      } catch { /* daemon started but IPC not ready yet */ }
    }

    // Show registered projects from the registry
    const { list } = await import('../src/service/db.mjs');
    const projects = list();
    if (projects.length === 0) {
      console.log('  No projects registered.');
      console.log('  Run `ss-proxy-service register` in a project directory.');
    } else {
      console.log(`  Registered projects (${projects.length}):`);
      for (const p of projects) {
        const state   = p.enabled ? '  enabled' : ' disabled';
        const exists  = existsSync(join(p.path, 'config.json')) ? '' : ' (missing config.json)';
        console.log(`    [${state}]  ${p.path}${exists}`);
      }
    }
    console.log('');
  });

// ── register ──────────────────────────────────────────────────────────────────

program
  .command('register [path]')
  .description('Add a project directory to the proxy registry')
  .action(async (projectPath) => {
    const { register } = await import('../src/service/db.mjs');
    const { startWatchingOne } = await import('../src/service/watcher.mjs');

    const target = projectPath ? resolve(projectPath) : process.cwd();
    try {
      const { created, project } = register(target);
      if (created) {
        console.log(`  ✔ Registered: ${target} (id: ${project.id})`);
        // If the daemon is running, tell it to reload its project list
        try {
          const { sendIpcCommand } = await import('../src/service/ipc.mjs');
          await sendIpcCommand({ action: 'reload' }, 1000);
        } catch { /* daemon not running — new project will load on next start */ }
      } else {
        console.log(`  – Already registered: ${target}`);
      }
    } catch (err) {
      console.error(`  ✖ ${err.message}`);
      process.exit(1);
    }
  });

// ── unregister ────────────────────────────────────────────────────────────────

program
  .command('unregister [path]')
  .description('Remove a project directory from the proxy registry')
  .action(async (projectPath) => {
    const { unregister } = await import('../src/service/db.mjs');

    const target = projectPath ? resolve(projectPath) : process.cwd();
    const { removed } = unregister(target);
    if (removed) {
      console.log(`  ✔ Unregistered: ${target}`);
    } else {
      console.log(`  – Not found in registry: ${target}`);
    }
  });

// ── upgrade ───────────────────────────────────────────────────────────────────

program
  .command('upgrade')
  .description('Upgrade ss-proxy-service to the latest version')
  .action(() => {
    const updaterPath = join(TOOL_DIR, 'src', 'updater.mjs');
    const logPath     = join(DATA_DIR,  '.ss-upgrade.log');

    if (!existsSync(updaterPath)) {
      console.error('  Updater script not found. Re-install ss first.');
      process.exit(1);
    }

    const logFd = openSync(logPath, 'w');
    const child = spawn(process.execPath, [updaterPath, TOOL_DIR], {
      detached: true,
      stdio:    ['ignore', logFd, logFd],
    });
    child.unref();
    closeSync(logFd);

    console.log('  Upgrading in the background...');
    console.log(`  Logs: ${logPath}`);
    console.log('  The upgrade will print "Upgrade completed: vX.Y.Z" when done.');
  });

// ── uninstall ─────────────────────────────────────────────────────────────────

program
  .command('uninstall')
  .description('Remove ss-proxy-service, unset system proxy, and clean up')
  .action(async () => {
    console.log('');
    console.log('  This will:');
    console.log('    • Stop the running service');
    console.log('    • Unset the system proxy');
    console.log('    • Remove the autostart entry');
    console.log('    • Remove the CA certificate from trust stores');
    console.log('    • Delete ~/.ss-proxy/ (config, certs, registry)\n');

    const confirmAnswer = await ask('  Type "yes" to confirm: ');
    if (confirmAnswer.toLowerCase() !== 'yes') {
      console.log('  Uninstall cancelled.');
      return;
    }

    // Stop daemon
    if (isRunning()) {
      console.log('\n  Stopping service...');
      try {
        const { sendIpcCommand } = await import('../src/service/ipc.mjs');
        await sendIpcCommand({ action: 'stop' }, 3000);
      } catch {
        try {
          const pid = parseInt(readFileSync(PID_PATH, 'utf8'), 10);
          process.kill(pid, 'SIGTERM');
        } catch { /* already stopped */ }
      }
      console.log('  ✔ Service stopped.');
    }

    // Unset system proxy
    try {
      const config = loadConfig();
      if (config._proxySetByUs !== false) {
        const { unset: unsetProxy } = await import('../src/service/os-proxy.mjs');
        unsetProxy();
        console.log('  ✔ System proxy removed.');
      }
    } catch (err) {
      console.log(`  ⚠ Could not remove system proxy: ${err.message}`);
    }

    // Remove autostart
    try {
      const { uninstall: uninstallAutostart } = await import('../src/service/autostart.mjs');
      uninstallAutostart();
      console.log('  ✔ Autostart entry removed.');
    } catch (err) {
      console.log(`  ⚠ Could not remove autostart: ${err.message}`);
    }

    // Remove CA from trust stores
    const caCert = join(DATA_DIR, 'ca.crt');
    if (existsSync(caCert)) {
      try {
        const { removeCATrust }      = await import('../src/service/os-trust.mjs');
        const { removeFirefoxTrust } = await import('../src/service/os-trust.mjs');
        removeCATrust(caCert);
        removeFirefoxTrust();
        console.log('  ✔ CA certificate removed from trust stores.');
      } catch (err) {
        console.log(`  ⚠ Could not remove CA cert: ${err.message}`);
      }
    }

    // Delete ~/.ss-proxy/
    try {
      rmSync(DATA_DIR, { recursive: true, force: true });
      console.log(`  ✔ Deleted ${DATA_DIR}`);
    } catch (err) {
      console.log(`  ⚠ Could not delete ${DATA_DIR}: ${err.message}`);
    }

    console.log('\n  ss-proxy-service has been uninstalled.');
    console.log('  Your project directories and config.json files are untouched.\n');
  });

// ── Parse ─────────────────────────────────────────────────────────────────────

program.parse();

// ── Cleanup helper ────────────────────────────────────────────────────────────

function _cleanup() {
  try { if (existsSync(PID_PATH)) rmSync(PID_PATH); } catch { /* ignore */ }
}
