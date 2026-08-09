'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const IDENTITY_PATH = path.join(ROOT, 'config/extension-identity.json');
const EXPECTED_EXTENSION_ID = 'bbllmeihbcmemadgmongicpklkjjgoaf';

function extensionIdFromPublicKey(publicKey) {
  const digest = crypto.createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('hex');
  return digest.slice(0, 32).replace(/[0-9a-f]/g, (digit) =>
    String.fromCharCode('a'.charCodeAt(0) + Number.parseInt(digit, 16)));
}

test('production identity contains the Store public key and its exact derived extension ID', () => {
  const identity = JSON.parse(fs.readFileSync(IDENTITY_PATH, 'utf8'));

  assert.equal(identity.extension_id, EXPECTED_EXTENSION_ID);
  assert.match(identity.public_key, /^[A-Za-z0-9+/]+={0,2}$/);
  assert.equal(extensionIdFromPublicKey(identity.public_key), EXPECTED_EXTENSION_ID);
  assert.equal(
    identity.web_store_url,
    `https://chromewebstore.google.com/detail/redline/${EXPECTED_EXTENSION_ID}`,
  );
});

test('identity loader rejects a public key that does not derive to the configured ID', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-extension-identity-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const file = path.join(temp, 'identity.json');
  const differentKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey
    .export({ format: 'der', type: 'spki' })
    .toString('base64');
  fs.writeFileSync(file, JSON.stringify({
    extension_id: EXPECTED_EXTENSION_ID,
    public_key: differentKey,
    web_store_url: `https://chromewebstore.google.com/detail/redline/${EXPECTED_EXTENSION_ID}`,
  }));

  const { loadExtensionIdentity } = require('../runtime/lib/extension-identity');
  assert.throws(() => loadExtensionIdentity(file), /public key.*extension ID/i);
});

test('contributor manifest generation embeds the assigned public key for a stable ID', () => {
  const identity = JSON.parse(fs.readFileSync(IDENTITY_PATH, 'utf8'));
  const setup = require('../setup/redline-agent-setup');
  const devManifest = fs.readFileSync(path.join(ROOT, 'extension/manifest.dev.json'), 'utf8');
  const generated = JSON.parse(setup.patchExtensionManifestForMode(devManifest, 'local', identity.public_key));

  assert.equal(generated.key, identity.public_key);
  assert.equal(extensionIdFromPublicKey(generated.key), identity.extension_id);
  assert.equal(JSON.parse(devManifest).key, undefined);
});
