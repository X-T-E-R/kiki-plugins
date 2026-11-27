import test from 'node:test';
import assert from 'node:assert/strict';
import { hash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const OFFICIAL_DIR = path.join(REPO_ROOT, 'plugins', 'official');
const MARKETPLACE_PATH = path.join(REPO_ROOT, 'plugins', 'marketplace.json');
const README_PATH = path.join(REPO_ROOT, 'README.md');

// Skip opaque compressed media/font/archive assets; executables and native
// libraries (.exe, .dll, .so, .dylib, .node, .wasm, .bin) are raw-byte scanned.
const SKIP_CONTENT_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.zip', '.tgz', '.gz', '.tar', '.xz', '.pdf', '.mp4', '.webm', '.mp3', '.wav',
]);

const RAW_BINARY_EXTENSIONS = new Set([
  '.exe', '.dll', '.so', '.dylib', '.node', '.wasm', '.bin',
]);

// SHA-256 digests of lowercase blocked public-catalog identifiers (private plugins,
// internal domains, and operator handles) stored without plaintext exposure.
const BLOCKED_TOKEN_HASHES = new Set([
  '6cfb41222b43ae6425be793984f030faf5ab69d8c4abb1af7782f248c60fed6c',
  'd9a7099960f3a265f01ce1bfe5781aa2bd80f5e75d0df75ca4dc0fd05be8c073',
  '32817064d33edde915bf079f7ac45509e91283b0a0e492c52c9f9df267658df3',
  '0c58f800eb2d80a21cba83c2a08ae936d8642ead3f75ffcece6a9593af8231bc',
  '0054f6e674de6a02043e5dc832e03257ac2aca0e90aa4331aebf715f6de53383',
  '2b61e4e6824b9ca05ef72bf274e3c692a77ce8184a78b9b946ba6d7e1603188e',
  '70f56525e5e2fab7265a644d3a52cc0ce23c123784a11ad6ea760e127d45a525',
  '9359a0bf0982de21e49dbbc74a7ef5a65137c2c4e0005ee42831bf65d9104353',
]);

const PLACEHOLDER_USERNAMES = new Set([
  'public', 'default', 'administrator', 'runner', 'runneradmin', 'user', 'users',
  'alice', 'bob', 'carol', 'dave', 'dev', 'developer', 'test', 'tester', 'example',
  'foo', 'bar', 'someone', 'me', 'my', 'name', 'you', 'yourname', 'username',
  'owner', 'admin', 'demo', 'jane', 'john', 'kiki', 'guest', 'shared', 'ci',
  'build', 'builder', 'app', 'fixture', 'private', 'home', 'target', 'local',
]);

const TOKEN_RUN_RE = /[A-Za-z0-9][A-Za-z0-9._-]{2,127}/g;
const WINDOWS_USER_PATH_RE = /\b[A-Za-z]:[/\\]Users[/\\]([A-Za-z0-9._-]{2,})[/\\]/g;
const MACOS_USER_PATH_RE = /(?:^|[\s"'`(])\/Users\/([A-Za-z0-9._-]{2,})\//g;
const PRIVATE_LAN_IP_RE = /\b192\.168\.(?!0\.\d{1,3}\b|1\.\d{1,3}\b|255\.255\b)\d{1,3}\.\d{1,3}\b/g;
const CGNAT_IP_RE = /\b100\.(?!64\.0\.0\b|127\.255\.255\b)(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/g;

const digestCache = new Map();
function sha256Lower(token) {
  let digest = digestCache.get(token);
  if (digest === undefined) {
    digest = hash('sha256', token);
    if (digestCache.size < 100_000) digestCache.set(token, digest);
  }
  return digest;
}

function findBlockedHashHit(text) {
  TOKEN_RUN_RE.lastIndex = 0;
  let match;
  while ((match = TOKEN_RUN_RE.exec(text)) !== null) {
    const lower = match[0].toLowerCase();
    const candidates = new Set([lower]);
    if (lower.includes('.')) {
      const dotParts = lower.split('.').filter(Boolean);
      for (let i = 0; i < dotParts.length; i += 1) {
        if (dotParts[i].length >= 3) candidates.add(dotParts[i]);
        if (i + 1 < dotParts.length) candidates.add(`${dotParts[i]}.${dotParts[i + 1]}`);
      }
    }
    if (lower.includes('_')) {
      for (const part of lower.split('_')) {
        if (part.length >= 3) candidates.add(part);
      }
    }
    for (const candidate of candidates) {
      const digest = sha256Lower(candidate);
      if (BLOCKED_TOKEN_HASHES.has(digest)) {
        return { index: match.index, digestPrefix: digest.slice(0, 12) };
      }
    }
  }
  return null;
}

function findStructuralViolations(text, { checkIps }) {
  const hits = [];
  for (const [label, re] of [
    ['non-placeholder Windows user path', WINDOWS_USER_PATH_RE],
    ['non-placeholder macOS user path', MACOS_USER_PATH_RE],
  ]) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(text)) !== null) {
      if (!PLACEHOLDER_USERNAMES.has(match[1].toLowerCase())) {
        hits.push(`${label} at offset ${match.index}`);
        break;
      }
    }
  }
  if (checkIps) {
    for (const [label, re] of [
      ['non-placeholder private LAN IP', PRIVATE_LAN_IP_RE],
      ['CGNAT/Tailscale IP', CGNAT_IP_RE],
    ]) {
      re.lastIndex = 0;
      const match = re.exec(text);
      if (match) hits.push(`${label} at offset ${match.index}`);
    }
  }
  return hits;
}

function isIpCheckExempt(rel) {
  return /(?:^|\/)test\/|\.(?:test|spec)\.[cm]?[jt]s$|(?:^|\/)vendor\//i.test(rel);
}

async function walkFiles(dir) {
  const out = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.tmp') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walkFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

test('public marketplace catalog excludes blocked identifiers and local host traces', async () => {
  const raw = await readFile(MARKETPLACE_PATH, 'utf8');
  const catalog = JSON.parse(raw);
  assert.ok(Array.isArray(catalog.plugins) && catalog.plugins.length > 0, 'marketplace.json must list plugins');

  for (const entry of catalog.plugins) {
    const idHit = findBlockedHashHit(String(entry.id ?? ''));
    assert.equal(idHit, null, `marketplace entry id matched blocked digest ${idHit?.digestPrefix}`);
    const srcHit = findBlockedHashHit(String(entry.source ?? ''));
    assert.equal(srcHit, null, `marketplace entry source matched blocked digest ${srcHit?.digestPrefix}`);
  }

  const rawHit = findBlockedHashHit(raw);
  assert.equal(rawHit, null, `plugins/marketplace.json matched blocked digest ${rawHit?.digestPrefix}`);
  assert.deepEqual(findStructuralViolations(raw, { checkIps: true }), []);
});

test('plugins/official (including compiled binaries) and root README pass zero-plaintext redline and structural scans', async () => {
  const files = [...await walkFiles(OFFICIAL_DIR), README_PATH];
  const violations = [];

  for (const file of files) {
    const rel = path.relative(REPO_ROOT, file).split(path.sep).join('/');
    const ext = path.extname(file).toLowerCase();
    const pathHit = findBlockedHashHit(rel);
    if (pathHit) violations.push(`${rel} (path matched blocked digest ${pathHit.digestPrefix})`);
    if (SKIP_CONTENT_EXTENSIONS.has(ext)) continue;

    if (RAW_BINARY_EXTENSIONS.has(ext)) {
      const buf = await readFile(file);
      for (const encoding of ['latin1', 'utf16le']) {
        const decoded = buf.toString(encoding);
        const hit = findBlockedHashHit(decoded);
        if (hit) violations.push(`${rel}@${encoding}:${hit.index} (blocked digest ${hit.digestPrefix})`);
        for (const issue of findStructuralViolations(decoded, { checkIps: false })) {
          violations.push(`${rel}@${encoding} (${issue})`);
        }
      }
      continue;
    }

    const text = await readFile(file, 'utf8');
    const lines = text.split(/\r?\n/);
    const checkIps = !isIpCheckExempt(rel);
    for (let i = 0; i < lines.length; i += 1) {
      const hit = findBlockedHashHit(lines[i]);
      if (hit) violations.push(`${rel}:${i + 1} (blocked digest ${hit.digestPrefix})`);
      for (const issue of findStructuralViolations(lines[i], { checkIps })) {
        violations.push(`${rel}:${i + 1} (${issue})`);
      }
    }
  }

  assert.deepEqual(violations, [], `Public redline violations found:\n${violations.join('\n')}`);
});
