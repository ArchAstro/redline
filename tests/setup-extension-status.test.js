const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const SETUP = path.join(ROOT, 'setup/redline-agent-setup.js');
const PACKAGE_VERSION = require('../package.json').version;
const { requestPairingWindow, runStorePairingFlow } = require('../setup/redline-agent-setup');
const { openBrowser } = require('../setup/open-browser');
const { loadExtensionIdentity } = require('../runtime/lib/extension-identity');
const { findInstalledExtension, inspectInstalledExtension } = require('../setup/chrome-profile-discovery');
const { StateStore } = require('../runtime/lib/state-store');

const STORE_IDENTITY = require('../config/extension-identity.json');
const STORE_ID = STORE_IDENTITY.extension_id;

function runStatus(home, envOverrides = {}) {
  return spawnSync(process.execPath, [SETUP, '--extension-status'], {
    cwd: ROOT,
    env: { ...process.env, HOME: home, REDLINE_PORT: '65534', REDLINE_DEV_MODE: '1', REDLINE_EXTENSION_ID: STORE_ID, ...envOverrides },
    encoding: 'utf8',
  });
}

function runStoreStatus(home, envOverrides = {}) {
  return spawnSync(process.execPath, [SETUP, '--extension-status'], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: home,
      REDLINE_TEST_MODE: '1',
      REDLINE_EXTENSION_PRESENT: '1',
      REDLINE_TEST_HELPER_UP: '1',
      ...envOverrides,
    },
    encoding: 'utf8',
  });
}

function runSetup(args, home, envOverrides = {}) {
  return spawnSync(process.execPath, [SETUP, ...args, '--source', ROOT], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: home,
      REDLINE_PORT: '65534',
      REDLINE_DEV_MODE: '1',
      REDLINE_EXTENSION_ID: STORE_ID,
      ...envOverrides,
    },
    encoding: 'utf8',
  });
}

function runSetupRaw(args, home) {
  return spawnSync(process.execPath, [SETUP, ...args], {
    cwd: ROOT,
    env: { ...process.env, HOME: home, REDLINE_PORT: '65534' },
    encoding: 'utf8',
  });
}

test('browser opener keeps the pairing URL out of process metadata and uses the Linux portal', async () => {
  const calls = [];
  const secretUrl = 'http://127.0.0.1:7878/connect#pair=secret';
  const spawn = (command, args, options) => { calls.push({ command, args, options }); return { status: 0 }; };
  await openBrowser(secretUrl, { platform: 'darwin', spawn });
  assert.equal(calls[0].command, 'osascript');
  assert.deepEqual(calls[0].args, ['-']);
  assert.equal(JSON.stringify(calls[0].args).includes(secretUrl), false);
  assert.equal(JSON.stringify(calls[0].options.env || {}).includes(secretUrl), false);
  assert.match(calls[0].options.input, /connect#pair=secret/);
  let portalUrl;
  await openBrowser(secretUrl, {
    platform: 'linux',
    spawn: () => { throw new Error('Linux must not spawn'); },
    portalClient: async (url) => { portalUrl = url; },
  });
  assert.equal(portalUrl, secretUrl);
  assert.equal(calls.length, 1);
});

test('Store identity requires an exact non-placeholder Chrome ID', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-identity-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'identity.json');
  fs.writeFileSync(file, JSON.stringify(STORE_IDENTITY));
  assert.equal(loadExtensionIdentity(file).extensionId, STORE_ID);
  for (const id of ['a'.repeat(32), 'abcdefghijklmnop', 'ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP', 'abcdefghijklmnopabcdefghijklmnop']) {
    fs.writeFileSync(file, JSON.stringify({ extension_id: id, web_store_url: 'https://chromewebstore.google.com/detail/redline/' + id }));
    assert.throws(() => loadExtensionIdentity(file), /identity.*invalid/i);
  }
});

test('Chrome discovery reads modern Secure Preferences when Preferences has no settings', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-secure-prefs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profile = path.join(root, 'Default');
  const version = '0.3.2';
  const versionDirectory = '0.3.2_0';
  fs.mkdirSync(path.join(profile, 'Extensions', STORE_ID, versionDirectory), { recursive: true });
  fs.writeFileSync(path.join(root, 'Local State'), JSON.stringify({ profile: { last_used: 'Default' } }));
  fs.writeFileSync(path.join(profile, 'Preferences'), JSON.stringify({
    extensions: { install_signature: { ids: [STORE_ID] } },
  }));
  fs.writeFileSync(path.join(profile, 'Secure Preferences'), JSON.stringify({
    extensions: { settings: { [STORE_ID]: { disable_reasons: [], manifest: { version } } } },
  }));
  fs.writeFileSync(path.join(profile, 'Extensions', STORE_ID, versionDirectory, 'manifest.json'),
    JSON.stringify({ manifest_version: 3, name: 'Redline', version }));

  assert.equal(findInstalledExtension({ extensionId: STORE_ID, profileRoots: [root] }), true);
  assert.deepEqual(inspectInstalledExtension({ extensionId: STORE_ID, profileRoots: [root] }), {
    status: 'enabled',
    version,
    profile: 'Default',
    source: 'secure_preferences',
  });

  fs.writeFileSync(path.join(profile, 'Secure Preferences'), JSON.stringify({
    extensions: { settings: { [STORE_ID]: { disable_reasons: ['USER'], manifest: { version } } } },
  }));
  assert.equal(findInstalledExtension({ extensionId: STORE_ID, profileRoots: [root] }), false);
});

test('Chrome discovery accepts only an enabled extension in a known real profile', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-profile-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profile = path.join(root, 'Default');
  const version = '0.2.6';
  const versionDirectory = '0.2.6_0';
  fs.mkdirSync(path.join(profile, 'Extensions', STORE_ID, versionDirectory), { recursive: true });
  fs.writeFileSync(path.join(root, 'Local State'), JSON.stringify({ profile: { last_used: 'Default' } }));
  fs.writeFileSync(path.join(profile, 'Preferences'), JSON.stringify({ extensions: { settings: { [STORE_ID]: { state: 1 } } } }));
  fs.writeFileSync(path.join(profile, 'Extensions', STORE_ID, versionDirectory, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Redline', version }));
  assert.equal(findInstalledExtension({ extensionId: STORE_ID, profileRoots: [root] }), true);
  fs.writeFileSync(path.join(profile, 'Preferences'), JSON.stringify({ extensions: { settings: { [STORE_ID]: { state: 0 } } } }));
  assert.equal(findInstalledExtension({ extensionId: STORE_ID, profileRoots: [root] }), false);
});

test('Chrome discovery only trusts the active profile from bounded Local State', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-active-profile-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const profileName of ['Default', 'Profile 2']) {
    const profile = path.join(root, profileName);
    fs.mkdirSync(path.join(profile, 'Extensions', STORE_ID, '0.2.6_0'), { recursive: true });
    fs.writeFileSync(path.join(profile, 'Preferences'), JSON.stringify({
      extensions: { settings: { [STORE_ID]: { state: profileName === 'Profile 2' ? 1 : 0 } } },
    }));
    fs.writeFileSync(path.join(profile, 'Extensions', STORE_ID, '0.2.6_0', 'manifest.json'),
      JSON.stringify({ manifest_version: 3, name: 'Redline', version: '0.2.6' }));
  }
  fs.writeFileSync(path.join(root, 'Local State'), JSON.stringify({ profile: { last_used: 'Default' } }));
  assert.equal(findInstalledExtension({ extensionId: STORE_ID, profileRoots: [root] }), false);
  fs.writeFileSync(path.join(root, 'Local State'), JSON.stringify({ profile: { last_used: 'Profile 2' } }));
  assert.equal(findInstalledExtension({ extensionId: STORE_ID, profileRoots: [root] }), true);
});

test('Chrome discovery rejects oversized metadata and bounded-scan exhaustion', (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-profile-bounds-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const oversized = path.join(parent, 'oversized');
  fs.mkdirSync(oversized);
  fs.writeFileSync(path.join(oversized, 'Local State'), ' '.repeat(1024 * 1024 + 1));
  assert.throws(() => findInstalledExtension({ extensionId: STORE_ID, profileRoots: [oversized] }), /oversized|limit/i);

  const roots = Array.from({ length: 5 }, (_, index) => {
    const root = path.join(parent, `root-${index}`);
    fs.mkdirSync(root);
    return root;
  });
  assert.throws(() => findInstalledExtension({ extensionId: STORE_ID, profileRoots: roots }), /root.*limit/i);

  const versions = path.join(parent, 'versions');
  const profile = path.join(versions, 'Default');
  const extensionRoot = path.join(profile, 'Extensions', STORE_ID);
  fs.mkdirSync(extensionRoot, { recursive: true });
  fs.writeFileSync(path.join(versions, 'Local State'), JSON.stringify({ profile: { last_used: 'Default' } }));
  fs.writeFileSync(path.join(profile, 'Preferences'), JSON.stringify({ extensions: { settings: { [STORE_ID]: { state: 1 } } } }));
  for (let index = 0; index < 65; index += 1) fs.mkdirSync(path.join(extensionRoot, `0.2.${index}`));
  assert.throws(() => findInstalledExtension({ extensionId: STORE_ID, profileRoots: [versions] }), /version.*limit/i);
});

test('Chrome discovery bounds descriptor reads when profile JSON grows on the same inode', (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-profile-growth-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'chrome');
  fs.mkdirSync(root);
  const localState = path.join(root, 'Local State');
  fs.writeFileSync(localState, JSON.stringify({ profile: { last_used: 'Default' } }));
  const before = fs.lstatSync(localState);
  const external = path.join(parent, 'outside');
  fs.writeFileSync(external, 'unchanged');
  let grew = false;
  const growingFs = Object.create(fs);
  growingFs.readSync = (...args) => {
    if (!grew) {
      grew = true;
      fs.appendFileSync(localState, 'x'.repeat(1024 * 1024 + 1));
      const after = fs.lstatSync(localState);
      assert.equal(after.dev, before.dev);
      assert.equal(after.ino, before.ino);
    }
    return fs.readSync(...args);
  };

  assert.throws(() => findInstalledExtension({
    extensionId: STORE_ID, profileRoots: [root], fsImpl: growingFs,
  }), /oversized|grew|changed.*read/i);
  assert.equal(grew, true);
  assert.equal(fs.readFileSync(external, 'utf8'), 'unchanged');
});

test('Chrome discovery rejects malformed suffixes, traversal, and similar version prefixes', (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-profile-version-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const cases = [
    ['0.2.6_00', '0.2.6'],
    ['0.2.6_01', '0.2.6'],
    ['0.2.6_-1', '0.2.6'],
    ['0.2.6_extra', '0.2.6'],
    ['0.2.60_0', '0.2.6'],
    ['0.2.6_0', '0.2.60'],
    ['0.2.6.0_0', '0.2.6'],
    ['0.2.6_0', '../0.2.6'],
  ];
  for (const [index, [versionDirectory, manifestVersion]] of cases.entries()) {
    const root = path.join(parent, String(index));
    const profile = path.join(root, 'Default');
    const versionRoot = path.join(profile, 'Extensions', STORE_ID, versionDirectory);
    fs.mkdirSync(versionRoot, { recursive: true });
    fs.writeFileSync(path.join(root, 'Local State'), JSON.stringify({ profile: { last_used: 'Default' } }));
    fs.writeFileSync(path.join(profile, 'Preferences'), JSON.stringify({ extensions: { settings: { [STORE_ID]: { state: 1 } } } }));
    fs.writeFileSync(path.join(versionRoot, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Redline', version: manifestVersion }));
    assert.equal(findInstalledExtension({ extensionId: STORE_ID, profileRoots: [root] }), false, `${versionDirectory} vs ${manifestVersion}`);
  }
});

test('Chrome discovery fails closed on malformed and linked profile data', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-profile-bad-'));
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-profile-target-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, 'Default'));
  fs.writeFileSync(path.join(root, 'Local State'), JSON.stringify({ profile: { last_used: 'Default' } }));
  fs.writeFileSync(path.join(root, 'Default', 'Preferences'), '{bad');
  assert.throws(() => findInstalledExtension({ extensionId: STORE_ID, profileRoots: [root] }), /malformed Chrome profile/i);
  fs.rmSync(path.join(root, 'Default'), { recursive: true });
  fs.symlinkSync(target, path.join(root, 'Default'));
  assert.throws(() => findInstalledExtension({ extensionId: STORE_ID, profileRoots: [root] }), /symlink/i);
  fs.rmSync(path.join(root, 'Default'));
  fs.mkdirSync(path.join(root, 'Default'));
  fs.writeFileSync(path.join(root, 'Default', 'Preferences'), JSON.stringify({ extensions: { settings: { [STORE_ID]: { state: 1 } } } }));
  fs.symlinkSync(target, path.join(root, 'Default', 'Extensions'));
  fs.mkdirSync(path.join(target, STORE_ID, '0.2.6'), { recursive: true });
  fs.writeFileSync(path.join(target, STORE_ID, '0.2.6', 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Redline', version: '0.2.6' }));
  assert.throws(() => findInstalledExtension({ extensionId: STORE_ID, profileRoots: [root] }), /symlink/i);
});

test('store setup starts helper before opening a direct fragment and Store listing', async (t) => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-store-setup-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  const events = [];
  let output = '';
  const result = await runStorePairingFlow({
    dataRoot,
    platform: 'darwin',
    extensionId: STORE_ID,
    storeListingUrl: 'https://chromewebstore.example/redline',
    extensionPresent: false,
    startHelper: async () => { events.push('helper'); },
    createPairingWindow: async () => ({ secret: 's'.repeat(43), expiresAt: new Date(Date.now() + 600000).toISOString() }),
    openUrl: (url) => { events.push(url); },
    stdout: { write: (value) => { output += value; } },
    stderr: { write: (value) => { output += value; } },
  });

  assert.equal(events[0], 'helper');
  assert.match(events[1], /^http:\/\/127\.0\.0\.1:7878\/connect#pair=[A-Za-z0-9_-]{43}&expires_at=\d{4}-\d{2}-\d{2}T\d{2}%3A\d{2}%3A\d{2}\.\d{3}Z$/);
  assert.equal(events[2], 'https://chromewebstore.example/redline');
  assert.equal(events[1].includes('%23'), false);
  assert.equal(output.includes(events[1].split('pair=')[1]), false);
  assert.deepEqual(result, { pairingExpiresAt: result.pairingExpiresAt, openedStoreListing: true });
});

test('store setup rerun replaces the previous pairing window', async (t) => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-store-rerun-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  const urls = [];
  const options = {
    dataRoot, platform: 'linux', extensionId: STORE_ID,
    storeListingUrl: 'https://chromewebstore.example/redline', extensionPresent: true,
    startHelper: async () => {},
    createPairingWindow: async () => ({ secret: require('node:crypto').randomBytes(32).toString('base64url'), expiresAt: new Date(Date.now() + 600000).toISOString() }),
    openUrl: (url) => urls.push(url), stdout: { write: () => {} },
  };
  await runStorePairingFlow(options);
  await runStorePairingFlow(options);
  assert.notEqual(urls[0], urls[1]);
  assert.equal(urls.some((url) => url.startsWith('https://')), false);
});

test('malformed Chrome profile evidence fails before creating pairing state', async (t) => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-store-malformed-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  let created = false;
  await assert.rejects(runStorePairingFlow({
    dataRoot, platform: 'darwin', extensionId: STORE_ID,
    storeListingUrl: `https://chromewebstore.google.com/detail/redline/${STORE_ID}`,
    startHelper: async () => {},
    discoverExtension: () => { throw new Error('malformed Chrome profile Preferences'); },
    createPairingWindow: async () => { created = true; return { secret: 's'.repeat(43), expiresAt: '2030-01-01T00:00:00.000Z' }; },
    openUrl: () => {}, stdout: { write: () => {} },
  }), /malformed Chrome profile/);
  assert.equal(created, false);
});

test('connect open failure invalidates the exact pairing window and gives a secret-free rerun command', async (t) => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-connect-failure-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  const store = new StateStore(dataRoot);
  let secret;
  await assert.rejects(runStorePairingFlow({
    dataRoot, platform: 'darwin', extensionId: STORE_ID,
    storeListingUrl: `https://chromewebstore.google.com/detail/redline/${STORE_ID}`,
    extensionPresent: true, startHelper: async () => {},
    createPairingWindow: async () => { const pairing = await store.createPairingWindow(); secret = pairing.secret; return pairing; },
    invalidatePairing: (value) => store.invalidatePairingWindow(value),
    openUrl: () => { throw new Error('open failed'); }, stdout: { write: () => {} },
  }), (error) => {
    assert.match(error.message, /redline setup/);
    assert.equal(error.message.includes(secret), false);
    return true;
  });
  assert.deepEqual(await store.pairingStatus(), { available: false });
});

test('connect failure remains primary when pairing invalidation also fails', async (t) => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-connect-double-failure-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  const store = new StateStore(dataRoot);
  let secret;
  await assert.rejects(runStorePairingFlow({
    dataRoot, platform: 'darwin', extensionId: STORE_ID,
    storeListingUrl: `https://chromewebstore.google.com/detail/redline/${STORE_ID}`,
    extensionPresent: true, startHelper: async () => {},
    createPairingWindow: async () => { const pairing = await store.createPairingWindow(); secret = pairing.secret; return pairing; },
    invalidatePairing: async () => { throw new Error(`cleanup failed ${secret}`); },
    openUrl: async () => { throw new Error(`open failed ${secret}`); },
    stdout: { write: () => {} }, stderr: { write: () => {} },
  }), (error) => {
    assert.equal(error.message, 'Could not open the Redline connection page. Run redline setup again.');
    assert.match(error.cause?.message || '', /pairing.*expire automatically/i);
    assert.equal(`${error.message}${error.cause?.message}`.includes(secret), false);
    return true;
  });
  const status = await store.pairingStatus();
  assert.equal(status.available, true);
  assert.ok(Date.parse(status.expiresAt) > Date.now());
});

test('Store open failure preserves the usable pairing window and prints non-secret recovery', async (t) => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-store-open-failure-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  const store = new StateStore(dataRoot);
  let secret;
  let opens = 0;
  let warning = '';
  const result = await runStorePairingFlow({
    dataRoot, platform: 'darwin', extensionId: STORE_ID,
    storeListingUrl: `https://chromewebstore.google.com/detail/redline/${STORE_ID}`,
    extensionPresent: false, startHelper: async () => {},
    createPairingWindow: async () => { const pairing = await store.createPairingWindow(); secret = pairing.secret; return pairing; },
    invalidatePairing: (value) => store.invalidatePairingWindow(value),
    openUrl: () => { opens += 1; if (opens === 2) throw new Error('store failed'); },
    stdout: { write: () => {} }, stderr: { write: (value) => { warning += value; } },
  });
  assert.equal(result.openedStoreListing, false);
  assert.deepEqual((await store.pairingStatus()).available, true);
  assert.match(warning, /Chrome Web Store.*redline setup/i);
  assert.equal(warning.includes(secret), false);
});

test('Linux setup awaits the portal and creates a usable pairing window', async (t) => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-linux-portal-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  const store = new StateStore(dataRoot);
  let portalUrl;
  let releasePortal;
  let setupSettled = false;
  const portalGate = new Promise((resolve) => { releasePortal = resolve; });
  const setup = runStorePairingFlow({
    dataRoot, platform: 'linux', extensionId: STORE_ID,
    storeListingUrl: `https://chromewebstore.google.com/detail/redline/${STORE_ID}`,
    extensionPresent: true, startHelper: async () => {},
    createPairingWindow: () => store.createPairingWindow(),
    invalidatePairing: (value) => store.invalidatePairingWindow(value),
    portalClient: async (url) => { portalUrl = url; await portalGate; },
    stdout: { write: () => {} }, stderr: { write: () => {} },
  }).finally(() => { setupSettled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(setupSettled, false);
  releasePortal();
  await setup;
  const secret = new URLSearchParams(new URL(portalUrl).hash.slice(1)).get('pair');
  assert.match(secret, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(await store.consumePairingSecret(secret, { consentVersion: 1 }));
});

test('Linux portal connect failure invalidates pairing without leaking its secret', async (t) => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-linux-connect-failure-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  const store = new StateStore(dataRoot);
  let secret;
  await assert.rejects(runStorePairingFlow({
    dataRoot, platform: 'linux', extensionId: STORE_ID,
    storeListingUrl: `https://chromewebstore.google.com/detail/redline/${STORE_ID}`,
    extensionPresent: true, startHelper: async () => {},
    createPairingWindow: async () => { const pairing = await store.createPairingWindow(); secret = pairing.secret; return pairing; },
    invalidatePairing: (value) => store.invalidatePairingWindow(value),
    portalClient: async () => { throw new Error(`portal failed ${secret}`); },
    stdout: { write: () => {} }, stderr: { write: () => {} },
  }), (error) => {
    assert.match(error.message, /redline setup/i);
    assert.equal(error.message.includes(secret), false);
    return true;
  });
  assert.deepEqual(await store.pairingStatus(), { available: false });
});

test('Linux Store portal failure preserves pairing and non-secret recovery semantics', async (t) => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-linux-store-failure-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  const store = new StateStore(dataRoot);
  let secret;
  let opens = 0;
  let warning = '';
  const result = await runStorePairingFlow({
    dataRoot, platform: 'linux', extensionId: STORE_ID,
    storeListingUrl: `https://chromewebstore.google.com/detail/redline/${STORE_ID}`,
    extensionPresent: false, startHelper: async () => {},
    createPairingWindow: async () => { const pairing = await store.createPairingWindow(); secret = pairing.secret; return pairing; },
    invalidatePairing: (value) => store.invalidatePairingWindow(value),
    portalClient: async () => { opens += 1; if (opens === 2) throw new Error(`store failed ${secret}`); },
    stdout: { write: () => {} }, stderr: { write: (value) => { warning += value; } },
  });
  assert.equal(result.openedStoreListing, false);
  assert.deepEqual((await store.pairingStatus()).available, true);
  assert.match(warning, /Chrome Web Store.*redline setup/i);
  assert.equal(warning.includes(secret), false);
});

test('setup pairing request reads the private CLI credential and authenticates the admin call', async (t) => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redline setup auth '));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  const token = require('node:crypto').randomBytes(32).toString('base64url');
  fs.writeFileSync(path.join(dataRoot, 'cli-credential'), token + '\n', { mode: 0o600 });
  let authorization;
  const server = require('node:http').createServer((req, res) => {
    authorization = req.headers.authorization;
    res.writeHead(201, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ secret: 'p'.repeat(43), expires_at: '2030-01-01T00:00:00.000Z' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const result = await requestPairingWindow({ dataRoot, port: server.address().port });
  assert.equal(authorization, `Bearer ${token}`);
  assert.equal(result.secret, 'p'.repeat(43));
  fs.chmodSync(dataRoot, 0o755);
  await assert.rejects(requestPairingWindow({ dataRoot, port: server.address().port }), /credential/i);
});

test('unsupported platforms fail before helper, state, or browser actions', async (t) => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-store-platform-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  let acted = false;
  await assert.rejects(runStorePairingFlow({
    dataRoot, platform: 'win32', extensionId: STORE_ID,
    storeListingUrl: 'https://chromewebstore.example/redline',
    startHelper: async () => { acted = true; }, openUrl: () => { acted = true; },
  }), /macOS and Linux/);
  assert.equal(acted, false);
  assert.deepEqual(fs.readdirSync(dataRoot), []);
});

test('production store setup fails closed before creating state when identity is unavailable', async (t) => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-store-identity-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  await assert.rejects(runStorePairingFlow({
    dataRoot, platform: 'darwin', startHelper: async () => {}, openUrl: () => {},
  }), /Chrome Web Store identity/);
  assert.deepEqual(fs.readdirSync(dataRoot), []);
});

test('CLI reports a missing Store identity without a stack trace or creating user state', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-store-cli-identity-'));
  try {
    const result = spawnSync(process.execPath, [SETUP], {
      cwd: ROOT,
      env: {
        ...process.env,
        HOME: home,
        REDLINE_DIR: path.join(home, '.redline'),
        REDLINE_TEST_MODE: '1',
        REDLINE_IDENTITY_PATH: path.join(home, 'missing-extension-identity.json'),
      },
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Chrome Web Store identity/);
    assert.doesNotMatch(result.stderr, /at main \(/);
    assert.equal(fs.existsSync(path.join(home, '.redline')), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('extension status reports a missing synced extension', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-status-missing-'));
  try {
    const result = runStatus(home);

    assert.equal(result.status, 1);
    assert.match(result.stdout, /Chrome extension status/);
    assert.match(result.stdout, /missing/);
    assert.match(result.stdout, /redline setup --with-screenshots/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Store status diagnoses the installed extension and helper without unpacked guidance', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-store-status-'));
  try {
    const result = runStoreStatus(home);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Chrome Web Store extension status/);
    assert.match(result.stdout, /installed and enabled/i);
    assert.match(result.stdout, /helper:.*up/i);
    assert.match(result.stdout, /popup.*pair/i);
    assert.doesNotMatch(result.stdout, /Load unpacked|~\/\.redline\/extension|--with-screenshots/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Store status fails when the helper has no paired browsers', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-store-status-unpaired-'));
  const dataRoot = path.join(home, 'redline-data');
  try {
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.writeFileSync(path.join(dataRoot, 'state.json'), JSON.stringify({
      version: 2, clients: {}, redlines: {},
    }));
    const result = runStoreStatus(home, { REDLINE_DIR: dataRoot });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /pairing:.*no browser connected/i);
    assert.match(result.stdout, /redline setup/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Store status gives Store setup guidance when the extension or helper is missing', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-store-status-missing-'));
  try {
    const missingExtension = runStoreStatus(home, { REDLINE_EXTENSION_PRESENT: '0' });
    assert.equal(missingExtension.status, 1);
    assert.match(missingExtension.stdout, /Chrome Web Store.*missing/i);
    assert.match(missingExtension.stdout, new RegExp(STORE_ID));
    assert.doesNotMatch(missingExtension.stdout, /Load unpacked|--with-screenshots/);

    const missingHelper = runStoreStatus(home, { REDLINE_TEST_HELPER_UP: '0' });
    assert.equal(missingHelper.status, 1);
    assert.match(missingHelper.stdout, /helper:.*down/i);
    assert.match(missingHelper.stdout, /redline setup/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('setup fails when the package omits the Chrome extension', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-missing-extension-home-'));
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-missing-extension-source-'));
  try {
    const result = spawnSync(process.execPath, [SETUP, '--source', source], {
      cwd: ROOT,
      env: { ...process.env, HOME: home, REDLINE_PORT: '65534', REDLINE_DEV_MODE: '1', REDLINE_EXTENSION_ID: STORE_ID },
      encoding: 'utf8',
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Chrome extension source missing/);
    assert.equal(fs.existsSync(path.join(home, '.redline')), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(source, { recursive: true, force: true });
  }
});

test('--source requires a path value', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-source-missing-'));
  try {
    const result = runSetupRaw(['--source'], home);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /--source requires a path value/i);
    assert.equal(fs.existsSync(path.join(home, '.redline')), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('--source rejects a flag as its path value', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-source-flag-'));
  try {
    const result = runSetupRaw(['--source', '--dry-run'], home);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /--source requires a path value/i);
    assert.equal(fs.existsSync(path.join(home, '.redline')), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('--source= requires a non-empty path value', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-source-inline-empty-'));
  try {
    const result = runSetupRaw(['--source='], home);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /--source requires a path value/i);
    assert.equal(fs.existsSync(path.join(home, '.redline')), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('--plugin-source requires a path value', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-plugin-source-missing-'));
  try {
    const result = runSetupRaw(['--plugin-source'], home);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /--plugin-source requires a path value/i);
    assert.equal(fs.existsSync(path.join(home, '.redline')), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('--plugin-source rejects a flag as its path value', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-plugin-source-flag-'));
  try {
    const result = runSetupRaw(['--plugin-source', '--dry-run'], home);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /--plugin-source requires a path value/i);
    assert.equal(fs.existsSync(path.join(home, '.redline')), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('--plugin-source= requires a non-empty path value', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-plugin-source-inline-empty-'));
  try {
    const result = runSetupRaw(['--plugin-source='], home);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /--plugin-source requires a path value/i);
    assert.equal(fs.existsSync(path.join(home, '.redline')), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('uninstall works when the saved extension mode JSON is malformed', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-uninstall-invalid-config-'));
  try {
    const extension = path.join(home, '.redline/extension');
    fs.mkdirSync(extension, { recursive: true });
    fs.writeFileSync(path.join(home, '.redline/config.json'), '{ invalid JSON');

    const result = runSetup(['--uninstall'], home);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.existsSync(extension), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('setup fails before writing when required Unix commands are missing', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-setup-prereqs-'));
  try {
    const result = runSetup([], home, { PATH: '' });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /missing required commands/i);
    assert.match(result.stderr, /bash/);
    assert.match(result.stderr, /curl/);
    assert.match(result.stderr, /jq/);
    assert.equal(fs.existsSync(path.join(home, '.redline')), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('setup works without an installed agent or npx', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-no-agent-'));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-runtime-bin-'));
  try {
    for (const command of ['bash', 'curl', 'jq']) {
      const commandPath = path.join(bin, command);
      fs.writeFileSync(commandPath, '#!/bin/sh\nexit 0\n');
      fs.chmodSync(commandPath, 0o755);
    }

    const result = runSetup([], home, { PATH: bin });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.existsSync(path.join(home, '.redline/extension/manifest.json')), true);
    assert.equal(fs.existsSync(path.join(home, '.agents')), false);
    assert.equal(fs.existsSync(path.join(home, '.claude')), false);
    assert.equal(fs.existsSync(path.join(home, '.codex')), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test('setup and uninstall never modify user-managed skills or plugin state', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-user-skill-state-'));
  try {
    const preservedFiles = new Map([
      ['.agents/skills/redline/SKILL.md', Buffer.from('unrelated user-managed skill\n')],
      ['.agents/.skill-lock.json', Buffer.from('{"source":"someone/else"}\n')],
      ['.claude/plugins/cache/redline/sentinel.bin', Buffer.from([0x00, 0xff, 0x52, 0x4c])],
      ['.codex/plugins/cache/redline/sentinel.txt', Buffer.from('keep Codex plugin state\n')],
    ]);
    for (const [relativePath, content] of preservedFiles) {
      const destination = path.join(home, relativePath);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, content);
    }

    const assertPreserved = () => {
      for (const [relativePath, content] of preservedFiles) {
        assert.deepEqual(fs.readFileSync(path.join(home, relativePath)), content);
      }
    };

    assert.equal(runSetup([], home).status, 0);
    assertPreserved();
    assert.equal(runSetup(['--uninstall'], home).status, 0);

    assertPreserved();
    assert.equal(fs.existsSync(path.join(home, '.redline/extension')), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('removed agent-scoped flags direct users to npx skills', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-agent-flags-'));
  try {
    const result = runSetup(['--codex-only'], home);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /manage agent skills directly with npx skills/i);
    assert.equal(fs.existsSync(path.join(home, '.redline')), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('setup injects custom sidecar directory and port configuration', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-status-custom-'));
  const customDir = path.join(home, 'custom-redline-data');
  try {
    const result = runSetup([], home, {
      REDLINE_DIR: customDir,
      REDLINE_PORT: '61234',
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const token = fs.readFileSync(path.join(customDir, 'auth-token'), 'utf8').trim();
    const installedAuth = fs.readFileSync(path.join(home, '.redline/extension/auth.js'), 'utf8');
    assert.match(installedAuth, new RegExp(token));
    assert.match(installedAuth, /port:\s*61234/);
    assert.equal(fs.existsSync(path.join(home, '.redline/auth-token')), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('setup with screenshots syncs a full-access extension and persists the mode', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-status-full-'));
  try {
    const result = runSetup(['--with-screenshots'], home);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /screenshots: enabled/);
    assert.match(result.stdout, /Agent skills are unchanged/);
    const manifest = JSON.parse(fs.readFileSync(path.join(home, '.redline/extension/manifest.json'), 'utf8'));
    assert.ok(manifest.host_permissions.includes('<all_urls>'));
    assert.ok(manifest.content_scripts[0].matches.includes('<all_urls>'));

    const authTokenPath = path.join(home, '.redline/auth-token');
    const authToken = fs.readFileSync(authTokenPath, 'utf8').trim();
    const installedAuth = fs.readFileSync(path.join(home, '.redline/extension/auth.js'), 'utf8');
    assert.ok(authToken.length >= 43);
    assert.equal(fs.statSync(authTokenPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(home, '.redline')).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(home, '.redline/extension')).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(home, '.redline/extension/auth.js')).mode & 0o777, 0o600);
    assert.match(installedAuth, new RegExp(authToken));

    const config = JSON.parse(fs.readFileSync(path.join(home, '.redline/config.json'), 'utf8'));
    assert.equal(config.extensionMode, 'full');

    const rerun = runSetup([], home);
    assert.equal(rerun.status, 0, rerun.stderr || rerun.stdout);
    assert.match(rerun.stdout, /screenshots: enabled/);
    assert.match(rerun.stdout, /extension:\s+already up to date/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('setup local-only switches back to the low-permission extension', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-status-local-'));
  try {
    assert.equal(runSetup(['--with-screenshots'], home).status, 0);

    const result = runSetup(['--local-only'], home);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /screenshots: limited/);
    const manifest = JSON.parse(fs.readFileSync(path.join(home, '.redline/extension/manifest.json'), 'utf8'));
    assert.ok(!manifest.host_permissions.includes('<all_urls>'));
    assert.ok(!manifest.content_scripts[0].matches.includes('<all_urls>'));
    const config = JSON.parse(fs.readFileSync(path.join(home, '.redline/config.json'), 'utf8'));
    assert.equal(config.extensionMode, 'local');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('extension status reports screenshot capability and upgrade command', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-status-mode-'));
  try {
    assert.equal(runSetup(['--local-only'], home).status, 0);

    const limited = runStatus(home);
    assert.equal(limited.status, 1);
    assert.match(limited.stdout, /mode: local-only/);
    assert.match(limited.stdout, /screenshots: limited/);
    assert.match(limited.stdout, /redline setup --with-screenshots/);

    assert.equal(runSetup(['--with-screenshots'], home).status, 0);
    const full = runStatus(home);
    assert.equal(full.status, 1);
    assert.match(full.stdout, /mode: full-access/);
    assert.match(full.stdout, /screenshots: enabled/);
    assert.match(full.stdout, /synced: extension files match/);
    assert.doesNotMatch(full.stdout, /skills:/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('extension status reports version mismatch and reload guidance', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-status-stale-'));
  try {
    const extension = path.join(home, '.redline/extension');
    fs.mkdirSync(extension, { recursive: true });
    fs.writeFileSync(path.join(extension, 'manifest.json'), JSON.stringify({
      manifest_version: 3,
      name: 'Redline',
      version: '0.1.0',
    }));

    const result = runStatus(home);

    assert.equal(result.status, 1);
    assert.match(result.stdout, /installed: 0\.1\.0/);
    assert.ok(result.stdout.includes(`package: ${PACKAGE_VERSION}`));
    assert.match(result.stdout, /out of sync/);
    assert.match(result.stdout, /chrome:\/\/extensions/);
    assert.match(result.stdout, /reload the page tabs/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('extension status detects changed files even when the version matches', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-status-file-stale-'));
  try {
    assert.equal(runSetup(['--with-screenshots'], home).status, 0);
    fs.appendFileSync(path.join(home, '.redline/extension/background.js'), '\n// stale copy\n');

    const result = runStatus(home);

    assert.equal(result.status, 1);
    assert.match(result.stdout, /out of sync/);
    assert.doesNotMatch(result.stdout, /files match/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
