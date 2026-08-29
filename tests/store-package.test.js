'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const zlib = require('node:zlib');

const ROOT = path.resolve(__dirname, '..');
const PACKAGE = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const ARCHIVE = path.join(ROOT, `dist/redline-chrome-${PACKAGE.version}.zip`);
const EXPECTED_FILES = [
  'manifest.json',
  'background.js',
  'permissions.js',
  'revocations.js',
  'connect.js',
  'connection.js',
  'content.js',
  'content.css',
  'onboarding.html',
  'onboarding.css',
  'onboarding.js',
  'popup.html',
  'popup.css',
  'popup.js',
  'icon-128.png',
];

function run(script) {
  return spawnSync(process.execPath, [script], { cwd: ROOT, encoding: 'utf8' });
}

function readZip(file) {
  const bytes = fs.readFileSync(file);
  const entries = new Map();
  let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    const method = bytes.readUInt16LE(offset + 8);
    const compressedSize = bytes.readUInt32LE(offset + 18);
    const uncompressedSize = bytes.readUInt32LE(offset + 22);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = bytes.subarray(nameStart, nameStart + nameLength).toString('utf8');
    const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
    const contents = method === 0 ? compressed : zlib.inflateRawSync(compressed);
    assert.equal(contents.length, uncompressedSize);
    entries.set(name, contents);
    offset = dataStart + compressedSize;
  }
  assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
  return entries;
}

test('functional Store package is deterministic and contains only the reviewed allowlist', () => {
  fs.rmSync(ARCHIVE, { force: true });
  const first = run('scripts/build-store-extension.js');
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const firstBytes = fs.readFileSync(ARCHIVE);
  const firstHash = crypto.createHash('sha256').update(firstBytes).digest('hex');

  const second = run('scripts/build-store-extension.js');
  assert.equal(second.status, 0, second.stderr || second.stdout);
  const secondBytes = fs.readFileSync(ARCHIVE);
  assert.equal(crypto.createHash('sha256').update(secondBytes).digest('hex'), firstHash);
  assert.deepEqual(secondBytes, firstBytes);

  const entries = readZip(ARCHIVE);
  assert.deepEqual([...entries.keys()], EXPECTED_FILES);
  const manifest = JSON.parse(entries.get('manifest.json').toString('utf8'));
  assert.equal(manifest.version, PACKAGE.version);
  assert.equal(manifest.key, undefined, 'Store uploads must rely on their assigned item identity');
  assert.deepEqual(manifest.host_permissions, [
    'http://127.0.0.1/*',
    'https://127.0.0.1/*',
    'http://localhost/*',
    'https://localhost/*',
    'http://*.localhost/*',
    'https://*.localhost/*',
  ]);
  assert.deepEqual(manifest.optional_host_permissions, ['<all_urls>']);

  const joined = [...entries.values()].map((value) => value.toString('utf8')).join('\n');
  assert.doesNotMatch(joined, /__REDLINE_AUTH_TOKEN__|BEGIN (?:RSA )?PRIVATE KEY|REDLINE_DEV_MODE|manifest\.dev\.json|sourceMappingURL=/);
});

test('Store validator rejects identity mismatch before an upload artifact is trusted', () => {
  const identityPath = path.join(ROOT, 'config/extension-identity.json');
  const original = fs.readFileSync(identityPath, 'utf8');
  const identity = JSON.parse(original);
  identity.extension_id = 'hfjngaflcmkocibdgpeanmhjlkofibca';
  fs.writeFileSync(identityPath, `${JSON.stringify(identity, null, 2)}\n`);
  try {
    const result = run('scripts/validate-store-extension.js');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /public key.*extension ID/i);
  } finally {
    fs.writeFileSync(identityPath, original);
  }
});

test('CI validates the exact Chrome Store artifact contract', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  assert.match(workflow, /npm run check:chrome-store/);
});
