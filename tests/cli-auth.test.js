'use strict';

const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { StateStore } = require('../runtime/lib/state-store');

const ROOT = path.resolve(__dirname, '..');
const EXTENSION_ID = 'hfjngaflcmkocibdgpeanmhjlkofibca';
const INSTANCE_ID = 'rli_0123456789abcdef0123456789abcdef';
const LAUNCH_ID = 'rll_fedcba9876543210fedcba9876543210';

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function request(port, method, pathname, token, body) {
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, method, path: pathname,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (payload) req.end(payload); else req.end();
  });
}

async function startSidecar(t) {
  const port = await freePort();
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'redline cli auth '));
  const dir = path.join(parent, 'data with spaces');
  fs.mkdirSync(dir, { mode: 0o700 });
  const store = new StateStore(dir);
  const cliToken = await store.ensureCliCredential();
  const identity = fs.lstatSync(dir, { bigint: true });
  const child = spawn(process.execPath, [
    'runtime/server.js', `--redline-launch-id=${LAUNCH_ID}`,
    `--redline-dir-device=${identity.dev}`, `--redline-dir-inode=${identity.ino}`,
  ], {
    cwd: ROOT,
    env: {
      ...process.env, REDLINE_DIR: dir, REDLINE_PORT: String(port), REDLINE_DEV_MODE: '1',
      REDLINE_EXTENSION_ID: EXTENSION_ID, REDLINE_INSTANCE_ID: INSTANCE_ID, REDLINE_LAUNCH_ID: LAUNCH_ID,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  t.after(() => { child.kill(); fs.rmSync(parent, { recursive: true, force: true }); });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await request(port, 'GET', '/health')).status === 200) return { port, dir, cliToken }; } catch {}
    if (child.exitCode !== null) throw new Error(stderr);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`sidecar did not start: ${stderr}`);
}

function runCli(name, context, args = [], envOverrides = {}) {
  return spawnSync(path.join(ROOT, 'runtime/bin', name), args, {
    cwd: ROOT,
    env: { ...process.env, REDLINE_DIR: context.dir, REDLINE_PORT: String(context.port), ...envOverrides },
    encoding: 'utf8',
    timeout: 3000,
  });
}

test('pull and tail use the real private CLI credential without exposing it', async (t) => {
  const context = await startSidecar(t);
  const created = await request(context.port, 'POST', '/redlines', context.cliToken, {
    url: 'https://example.test', selected_text: 'Old', comment: 'New',
  });
  assert.equal(created.status, 201);

  const tail = runCli('redline-tail', context);
  assert.equal(tail.status, 0, tail.stderr);
  assert.match(tail.stdout, /"comment": "New"/);
  assert.equal(`${tail.stdout}${tail.stderr}`.includes(context.cliToken), false);

  const pull = runCli('redline-pull', context, ['--no-ack']);
  assert.equal(pull.status, 0, pull.stderr);
  assert.match(pull.stdout, /New/);
  assert.equal(`${pull.stdout}${pull.stderr}`.includes(context.cliToken), false);
});

test('CLI performs authenticated HTTP without curl or a token-emitting helper', async (t) => {
  const context = await startSidecar(t);
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-no-curl-'));
  const marker = path.join(fakeBin, 'curl-called');
  t.after(() => fs.rmSync(fakeBin, { recursive: true, force: true }));
  fs.writeFileSync(path.join(fakeBin, 'curl'), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 99\n`, { mode: 0o755 });
  const result = runCli('redline-tail', context, [], { PATH: `${fakeBin}:${process.env.PATH}` });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(fs.existsSync(path.join(ROOT, 'runtime/lib/cli-credential.js')), false);
});

test('authenticated HTTP is an importable shared module for CLI and setup callers', () => {
  const client = path.join(ROOT, 'runtime/lib/cli-http.js');
  const result = spawnSync(process.execPath, ['-e', `
    const api = require(${JSON.stringify(client)});
    if (typeof api.requestWithCliCredential !== 'function') process.exit(2);
  `], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});

test('CLI commands fail closed for missing and wrong credentials without printing secrets', async (t) => {
  const context = await startSidecar(t);
  const credential = path.join(context.dir, 'cli-credential');
  const valid = fs.readFileSync(credential, 'utf8');

  fs.rmSync(credential);
  const missing = runCli('redline-tail', context);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /CLI credential/i);

  const wrongToken = 'wrong_but_still_secret_credential_value_1234567890';
  fs.writeFileSync(credential, `${wrongToken}\n`, { mode: 0o600 });
  const wrong = runCli('redline-tail', context);
  assert.notEqual(wrong.status, 0);
  assert.equal(`${wrong.stdout}${wrong.stderr}`.includes(wrongToken), false);
  fs.writeFileSync(credential, valid, { mode: 0o600 });
});

test('CLI credential reader refuses unsafe directories, symlinks, and hard links', async (t) => {
  const context = await startSidecar(t);
  const credential = path.join(context.dir, 'cli-credential');
  const valid = fs.readFileSync(credential, 'utf8');
  fs.chmodSync(context.dir, 0o755);
  assert.notEqual(runCli('redline-tail', context).status, 0);
  fs.chmodSync(context.dir, 0o700);

  const outside = path.join(path.dirname(context.dir), 'outside-token');
  fs.writeFileSync(outside, valid, { mode: 0o600 });
  fs.rmSync(credential);
  fs.symlinkSync(outside, credential);
  assert.notEqual(runCli('redline-tail', context).status, 0);
  fs.rmSync(credential);
  fs.linkSync(outside, credential);
  assert.notEqual(runCli('redline-tail', context).status, 0);
  assert.equal(fs.readFileSync(outside, 'utf8'), valid);
});

test('watch authenticates with the real credential and emits a pending ID', async (t) => {
  const context = await startSidecar(t);
  const created = JSON.parse((await request(context.port, 'POST', '/redlines', context.cliToken, {
    selected_text: 'Watch', comment: 'Observe',
  })).text);

  const child = spawn(path.join(ROOT, 'runtime/bin/redline-watch'), ['--interval', '0.05'], {
    cwd: ROOT,
    env: { ...process.env, REDLINE_DIR: context.dir, REDLINE_PORT: String(context.port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  const output = await new Promise((resolve, reject) => {
    let stdout = '';
    const timeout = setTimeout(() => { child.kill(); reject(new Error('watch timed out')); }, 2000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.includes(created.id)) { clearTimeout(timeout); child.kill(); resolve(stdout); }
    });
    child.on('error', reject);
  });
  assert.match(output, new RegExp(created.id));
  assert.equal(output.includes(context.cliToken), false);
});

test('screenshot CLI retrieves authenticated bytes from the real sidecar into a new file', async (t) => {
  const context = await startSidecar(t);
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
  const uploaded = await request(context.port, 'POST', '/screenshots', context.cliToken, {
    data_url: `data:image/png;base64,${png.toString('base64')}`,
  });
  assert.equal(uploaded.status, 201, uploaded.text);
  const screenshotId = JSON.parse(uploaded.text).id;
  const redline = await request(context.port, 'POST', '/redlines', context.cliToken, {
    screenshot_id: screenshotId,
  });
  assert.equal(redline.status, 201, redline.text);
  const unauthenticated = await request(context.port, 'GET', `/screenshots/${screenshotId}`);
  assert.equal(unauthenticated.status, 401);

  const output = path.join(path.dirname(context.dir), 'retrieved screenshot.png');
  const result = runCli('redline-screenshot', context, [screenshotId, output]);
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.deepEqual(fs.readFileSync(output), png);
  assert.equal(fs.statSync(output).mode & 0o777, 0o600);
  assert.equal(`${result.stdout}${result.stderr}`.includes(context.cliToken), false);
});

test('screenshot CLI rejects traversal and refuses to clobber linked or existing output', async (t) => {
  const context = await startSidecar(t);
  const outside = path.join(path.dirname(context.dir), 'outside.png');
  fs.writeFileSync(outside, 'unchanged', { mode: 0o600 });
  const existing = path.join(path.dirname(context.dir), 'existing output.png');
  fs.writeFileSync(existing, 'existing', { mode: 0o600 });
  const link = path.join(path.dirname(context.dir), 'linked output.png');
  fs.symlinkSync(outside, link);

  const traversal = runCli('redline-screenshot', context, ['../outside', path.join(path.dirname(context.dir), 'new.png')]);
  assert.notEqual(traversal.status, 0);
  const linked = runCli('redline-screenshot', context, ['ss_valid123', link]);
  assert.notEqual(linked.status, 0);
  const occupied = runCli('redline-screenshot', context, ['ss_valid123', existing]);
  assert.notEqual(occupied.status, 0);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'unchanged');
  assert.equal(fs.readFileSync(existing, 'utf8'), 'existing');
  assert.deepEqual(fs.readdirSync(path.dirname(context.dir)).filter((name) => name.endsWith('.tmp')), []);
  assert.equal(`${traversal.stdout}${traversal.stderr}${linked.stdout}${linked.stderr}${occupied.stdout}${occupied.stderr}`
    .includes(context.cliToken), false);
});

test('redline skill uses the authenticated screenshot command instead of curl', () => {
  const skill = fs.readFileSync(path.join(ROOT, 'skills/redline/SKILL.md'), 'utf8');
  assert.match(skill, /redline-screenshot <screenshot_id> <output\.png>/);
  assert.doesNotMatch(skill, /curl <url> -o/);
});
