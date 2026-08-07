'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { StateStore } = require('../runtime/lib/state-store');

function tempStore(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-auth-store-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, store: new StateStore(root, options) };
}

test('initializes owner-only state and keeps plaintext credentials out of state.json', async (t) => {
  const { root, store } = tempStore(t);
  const cliToken = await store.ensureCliCredential();
  const pairing = await store.createPairingWindow();

  assert.equal(fs.statSync(root).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(root, 'state.json')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(root, 'cli-credential')).mode & 0o777, 0o600);
  const state = fs.readFileSync(path.join(root, 'state.json'), 'utf8');
  assert.equal(state.includes(cliToken), false);
  assert.equal(state.includes(pairing.secret), false);
  assert.match(state, /sha256:/);
});

test('refuses symlinked, hard-linked, and corrupt state instead of overwriting it', async (t) => {
  for (const kind of ['symlink', 'hardlink', 'corrupt']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `redline-auth-${kind}-`));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const state = path.join(root, 'state.json');
    const outside = path.join(root, 'outside');
    fs.writeFileSync(outside, kind === 'corrupt' ? 'outside' : '{}', { mode: 0o600 });
    if (kind === 'symlink') fs.symlinkSync(outside, state);
    if (kind === 'hardlink') fs.linkSync(outside, state);
    if (kind === 'corrupt') fs.writeFileSync(state, '{broken', { mode: 0o600 });
    const store = new StateStore(root);

    await assert.rejects(store.ensureCliCredential(), /(?:symlink|multiple links|invalid JSON)/i);
    assert.equal(fs.readFileSync(outside, 'utf8'), kind === 'corrupt' ? 'outside' : '{}');
    if (kind === 'corrupt') assert.equal(fs.readFileSync(state, 'utf8'), '{broken');
  }
});

test('replacement, expiry, replay, and racing pairing attempts allow exactly one success', async (t) => {
  let now = Date.parse('2026-08-07T12:00:00.000Z');
  const { store } = tempStore(t, { now: () => now });
  const first = await store.createPairingWindow();
  const second = await store.createPairingWindow();
  assert.equal(await store.consumePairingSecret(first.secret), null);

  const results = await Promise.all([
    store.consumePairingSecret(second.secret),
    store.consumePairingSecret(second.secret),
  ]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(await store.consumePairingSecret(second.secret), null);

  const expired = await store.createPairingWindow();
  now += 10 * 60 * 1000 + 1;
  assert.equal(await store.consumePairingSecret(expired.secret), null);
  assert.deepEqual(await store.pairingStatus(), { available: false });
});

test('pairing consumption is serialized across setup and sidecar processes', async (t) => {
  const { root, store } = tempStore(t);
  const pairing = await store.createPairingWindow();
  const modulePath = path.resolve(__dirname, '../runtime/lib/state-store.js');
  const code = `
    const { StateStore } = require(${JSON.stringify(modulePath)});
    let secret = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { secret += chunk; });
    process.stdin.on('end', async () => {
      const result = await new StateStore(process.argv[1]).consumePairingSecret(secret);
      process.stdout.write(result ? 'paired' : 'rejected');
    });
  `;
  const consume = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', code, root], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (status) => status === 0 ? resolve(stdout) : reject(new Error(stderr)));
    child.stdin.end(pairing.secret);
  });

  const outcomes = await Promise.all([consume(), consume()]);
  assert.deepEqual(outcomes.sort(), ['paired', 'rejected']);
});

test('each pair mints a distinct stable client and hashed capability token', async (t) => {
  const { root, store } = tempStore(t);
  const one = await store.createPairingWindow();
  const clientOne = await store.consumePairingSecret(one.secret);
  const two = await store.createPairingWindow();
  const clientTwo = await store.consumePairingSecret(two.secret);

  assert.notEqual(clientOne.clientId, clientTwo.clientId);
  assert.notEqual(clientOne.token, clientTwo.token);
  assert.equal(await store.verifyClientToken(clientOne.token), clientOne.clientId);
  assert.equal(await store.verifyClientToken('guessed-token'), null);
  const persisted = fs.readFileSync(path.join(root, 'state.json'), 'utf8');
  assert.equal(persisted.includes(clientOne.token), false);
  assert.equal(persisted.includes(clientTwo.token), false);
});

test('supports per-client and all-browser revocation with monotonic clear generation', async (t) => {
  const { store } = tempStore(t);
  const first = await store.consumePairingSecret((await store.createPairingWindow()).secret);
  const second = await store.consumePairingSecret((await store.createPairingWindow()).secret);

  assert.equal(await store.revokeClient(first.clientId), true);
  assert.equal(await store.verifyClientToken(first.token), null);
  assert.equal(await store.verifyClientToken(second.token), second.clientId);
  assert.equal(await store.revokeAllBrowsers(), 1);
  assert.equal(await store.verifyClientToken(second.token), null);
  assert.equal(await store.clearGeneration(), 0);
  assert.equal(await store.incrementClearGeneration(), 1);
  assert.equal(await store.incrementClearGeneration(), 2);
});

test('verifies a distinct persistent CLI credential using timing-safe hashes', async (t) => {
  const { store } = tempStore(t);
  const cli = await store.ensureCliCredential();
  const paired = await store.consumePairingSecret((await store.createPairingWindow()).secret);

  assert.notEqual(cli, paired.token);
  assert.equal(await store.verifyCliToken(cli), true);
  assert.equal(await store.verifyCliToken('wrong'), false);
  assert.equal(await store.ensureCliCredential(), cli);
});

test('uses atomic replacement and leaves no temporary state files', async (t) => {
  const { root, store } = tempStore(t);
  await store.ensureCliCredential();
  for (let i = 0; i < 20; i += 1) await store.incrementClearGeneration();
  const state = JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8'));
  assert.equal(state.clear_generation, 20);
  assert.deepEqual(fs.readdirSync(root).filter((name) => name.includes('.tmp.')), []);
  assert.equal(crypto.createHash('sha256').update(JSON.stringify(state)).digest().length, 32);
});

function ageLock(root) {
  const old = new Date(Date.now() - 5000);
  const lock = path.join(root, 'state.lock');
  if (!fs.existsSync(lock)) return;
  for (const name of fs.readdirSync(lock)) fs.utimesSync(path.join(lock, name), old, old);
  fs.utimesSync(lock, old, old);
}

test('recovers stable empty and malformed lock publication without touching linked files', async (t) => {
  for (const malformed of ['empty', 'partial']) {
    const { root } = tempStore(t);
    const lock = path.join(root, 'state.lock');
    fs.mkdirSync(lock, { mode: 0o700 });
    if (malformed === 'partial') fs.writeFileSync(path.join(lock, 'owner.tmp'), '{', { mode: 0o600 });
    ageLock(root);
    await new StateStore(root).ensureCliCredential();
    assert.equal(fs.existsSync(lock), false);
  }

  const { root } = tempStore(t);
  const outside = path.join(root, 'outside');
  fs.writeFileSync(outside, 'keep', { mode: 0o600 });
  fs.mkdirSync(path.join(root, 'state.lock'), { mode: 0o700 });
  fs.symlinkSync(outside, path.join(root, 'state.lock', 'owner.json'));
  ageLock(root);
  await assert.rejects(new StateStore(root).ensureCliCredential(), /symlink/i);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'keep');
});

test('does not delete a lock while its owner metadata is still being initialized', async (t) => {
  const { root } = tempStore(t);
  const lock = path.join(root, 'state.lock');
  fs.mkdirSync(lock, { mode: 0o700 });
  let settled = false;
  const pending = new StateStore(root).ensureCliCredential().finally(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(settled, false);
  fs.rmdirSync(lock);
  await pending;
});

test('recovers a lock whose PID was reused with a different process start identity', async (t) => {
  const { root } = tempStore(t);
  const lock = path.join(root, 'state.lock');
  fs.mkdirSync(lock, { mode: 0o700 });
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({
    pid: process.pid, nonce: 'a'.repeat(32), process_start: 'old-process',
  }) + '\n', { mode: 0o600 });
  ageLock(root);
  const store = new StateStore(root, { processIdentity: () => 'current-process' });
  await store.ensureCliCredential();
  assert.equal(fs.existsSync(lock), false);
});

test('retries when another owner releases the lock during inspection', async (t) => {
  for (const operation of ['openSync', 'readdirSync']) {
    const { root } = tempStore(t);
    const lock = path.join(root, 'state.lock');
    fs.mkdirSync(lock, { mode: 0o700 });
    const original = fs[operation];
    let raced = false;
    fs[operation] = function (target, ...args) {
      if (!raced && target === lock) {
        raced = true;
        fs.rmdirSync(lock);
      }
      return original.call(this, target, ...args);
    };
    try {
      const credential = await new StateStore(root).ensureCliCredential();
      assert.match(credential, /^[A-Za-z0-9_-]{43}$/, operation);
    } finally {
      fs[operation] = original;
    }
    assert.equal(raced, true, operation);
  }
});

test('recovers SIGKILL at every state-lock publication stage', async (t) => {
  const modulePath = path.resolve(__dirname, '../runtime/lib/state-store.js');
  for (const stage of ['before-create', 'after-create', 'after-write', 'after-fsync']) {
    const { root } = tempStore(t);
    const code = `
      const { StateStore } = require(${JSON.stringify(modulePath)});
      new StateStore(process.argv[1], { lockFault: current => {
        if (current === process.argv[2]) process.kill(process.pid, 'SIGKILL');
      }}).ensureCliCredential();
    `;
    const outcome = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', code, root, stage], { stdio: 'ignore' });
      child.on('error', reject);
      child.on('exit', (status, signal) => resolve({ status, signal }));
    });
    assert.equal(outcome.signal, 'SIGKILL', stage);
    ageLock(root);
    await new StateStore(root).ensureCliCredential();
    assert.equal(fs.existsSync(path.join(root, 'state.lock')), false, stage);
  }
});
