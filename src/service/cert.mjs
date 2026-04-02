/**
 * cert.mjs — Local CA and per-domain certificate management
 *
 * Generates and caches everything needed for HTTPS interception:
 *   1. A self-signed root CA (generated once, stored in DATA_DIR)
 *   2. Per-hostname leaf certificates signed by that CA (cached in DATA_DIR/certs/)
 *
 * Both are stored as PEM files. The CA private key never leaves DATA_DIR.
 *
 * Usage:
 *   import { ensureCA, getCert, DATA_DIR } from './cert.mjs';
 *
 *   await ensureCA();                    // call once at startup
 *   const { cert, key } = await getCert('example.com');
 */

import forge from 'node-forge';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, statSync,
} from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// ─── Paths ────────────────────────────────────────────────────────────────────

export const DATA_DIR  = join(homedir(), '.ss-proxy');
const CERT_DIR         = join(DATA_DIR, 'certs');
const CA_CERT_PATH     = join(DATA_DIR, 'ca.crt');
const CA_KEY_PATH      = join(DATA_DIR, 'ca.key');

// ─── In-memory cache: hostname → { cert, key } PEM strings ───────────────────

const _cache = new Map();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ensureDirs() {
  if (!existsSync(DATA_DIR))  mkdirSync(DATA_DIR,  { recursive: true });
  if (!existsSync(CERT_DIR))  mkdirSync(CERT_DIR,  { recursive: true });
}

/** Age of a file in milliseconds, or Infinity if it doesn't exist. */
function fileAgeMs(filePath) {
  try { return Date.now() - statSync(filePath).mtimeMs; }
  catch { return Infinity; }
}

const ONE_YEAR_MS   = 365  * 24 * 60 * 60 * 1000;
const ELEVEN_MO_MS  = 335  * 24 * 60 * 60 * 1000; // regenerate before expiry

// ─── CA ───────────────────────────────────────────────────────────────────────

let _caCache = null; // { cert: forge cert obj, key: forge key obj }

/**
 * Ensure the local CA exists on disk. Generates it if missing.
 * Safe to call multiple times — no-ops if CA files already exist.
 */
export async function ensureCA() {
  ensureDirs();

  if (existsSync(CA_CERT_PATH) && existsSync(CA_KEY_PATH)) {
    _caCache = _loadCA();
    return;
  }

  console.log('[ss-proxy] Generating local CA certificate...');

  const keys = forge.pki.rsa.generateKeyPair(4096);
  const cert  = forge.pki.createCertificate();

  cert.publicKey    = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter  = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10);

  const attrs = [
    { name: 'commonName',         value: 'ss-proxy Local CA' },
    { name: 'organizationName',   value: 'start-scripting'   },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, pathLenConstraint: 0, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);

  cert.sign(keys.privateKey, forge.md.sha256.create());

  const certPem = forge.pki.certificateToPem(cert);
  const keyPem  = forge.pki.privateKeyToPem(keys.privateKey);

  writeFileSync(CA_CERT_PATH, certPem,  'utf8');
  writeFileSync(CA_KEY_PATH,  keyPem,   'utf8');

  // Restrict key file to owner read/write only
  try { chmodSync(CA_KEY_PATH, 0o600); } catch { /* Windows may not support chmod */ }

  _caCache = { cert, key: keys.privateKey };
  console.log(`[ss-proxy] CA certificate written to ${CA_CERT_PATH}`);
}

function _loadCA() {
  const certPem = readFileSync(CA_CERT_PATH, 'utf8');
  const keyPem  = readFileSync(CA_KEY_PATH,  'utf8');
  return {
    cert: forge.pki.certificateFromPem(certPem),
    key:  forge.pki.privateKeyFromPem(keyPem),
  };
}

// ─── Per-domain certificates ──────────────────────────────────────────────────

/**
 * Return { cert, key } PEM strings for the given hostname.
 *
 * Checks the in-memory cache first, then disk. If the on-disk cert is older
 * than 11 months (or missing), generates a fresh one signed by the local CA.
 *
 * @param {string} hostname  e.g. 'example.com' or '*.example.com'
 * @returns {{ cert: string, key: string }}
 */
export async function getCert(hostname) {
  if (_cache.has(hostname)) return _cache.get(hostname);

  const certPath = join(CERT_DIR, `${sanitize(hostname)}.crt`);
  const keyPath  = join(CERT_DIR, `${sanitize(hostname)}.key`);

  // Serve from disk if fresh enough
  if (existsSync(certPath) && existsSync(keyPath)) {
    if (fileAgeMs(certPath) < ELEVEN_MO_MS) {
      const pair = {
        cert: readFileSync(certPath, 'utf8'),
        key:  readFileSync(keyPath,  'utf8'),
      };
      _cache.set(hostname, pair);
      return pair;
    }
  }

  // Generate a new leaf cert signed by our CA
  const pair = _generateLeafCert(hostname);
  writeFileSync(certPath, pair.cert, 'utf8');
  writeFileSync(keyPath,  pair.key,  'utf8');
  _cache.set(hostname, pair);
  return pair;
}

/**
 * Remove a hostname from the in-memory cache (forces re-read/regenerate next
 * time getCert is called — useful for testing).
 */
export function evictCert(hostname) {
  _cache.delete(hostname);
}

/**
 * Return the PEM content of the CA certificate (used by os-trust.mjs and
 * the setup wizard to install it in trust stores).
 */
export function getCACert() {
  if (!existsSync(CA_CERT_PATH)) return null;
  return readFileSync(CA_CERT_PATH, 'utf8');
}

// ─── Internal ─────────────────────────────────────────────────────────────────

function _generateLeafCert(hostname) {
  if (!_caCache) _caCache = _loadCA();

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert  = forge.pki.createCertificate();

  cert.publicKey = keys.publicKey;

  // Serial: use current timestamp so each cert is unique
  cert.serialNumber = Date.now().toString(16);

  cert.validity.notBefore = new Date();
  cert.validity.notAfter  = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);

  const attrs = [
    { name: 'commonName',         value: hostname },
    { name: 'organizationName',   value: 'start-scripting' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(_caCache.cert.subject.attributes);

  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    {
      name: 'extKeyUsage',
      serverAuth: true,
    },
    {
      name: 'subjectAltName',
      altNames: [{ type: 2, value: hostname }], // type 2 = DNS
    },
    { name: 'subjectKeyIdentifier' },
  ]);

  cert.sign(_caCache.key, forge.md.sha256.create());

  return {
    cert: forge.pki.certificateToPem(cert),
    key:  forge.pki.privateKeyToPem(keys.privateKey),
  };
}

/** Convert a hostname to a safe filename (strips wildcards, etc.). */
function sanitize(hostname) {
  return hostname.replace(/[^a-zA-Z0-9._-]/g, '_');
}
