'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { StateStore } = require('../runtime/lib/state-store');

const VALID_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function png() {
  return VALID_PNG_BASE64;
}

function runClear(dir, port) {
  return new Promise((resolve, reject) => {
    const child = spawn(path.resolve(__dirname, '../runtime/bin/redline-clear'), [], {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, REDLINE_DIR: dir, REDLINE_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (status) => resolve({ status, stdout, stderr }));
  });
}

test('clear atomically removes browser data, advances generation, and preserves CLI access', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-clear-state-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new StateStore(dir);
  const cli = await store.ensureCliCredential();
  const first = await store.consumePairingSecret((await store.createPairingWindow()).secret);
  const second = await store.consumePairingSecret((await store.createPairingWindow()).secret);
  const draft = {
    operation_id: 'op_clear_01234567', clear_generation: 0,
    selected_text: 'old', comment: 'remove', screenshot_png: png('clear'),
  };
  const created = await store.submitRedline(first.clientId, draft);
  await store.deleteRedline(created.id);
  await store.createPairingWindow();

  assert.equal(await store.clearAll(), 1);
  assert.deepEqual(await store.listRedlines(), []);
  assert.equal(await store.verifyCliToken(cli), true);
  assert.equal(await store.verifyClientToken(first.token), null);
  assert.equal(await store.verifyClientToken(second.token), null);
  assert.deepEqual(await store.pairingStatus(), { available: false });
  assert.deepEqual(fs.readdirSync(path.join(dir, 'screenshots')), []);
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  assert.deepEqual(state.operations, {});

  const repaired = await store.consumePairingSecret((await store.createPairingWindow()).secret);
  await assert.rejects(
    store.submitRedline(repaired.clientId, draft),
    (error) => error.code === 'data_cleared' && !error.message.includes('old'),
  );
});

test('redline-clear uses the private CLI credential and admin clear endpoint', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-clear-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const token = await new StateStore(dir).ensureCliCredential();
  let observed = null;
  const server = http.createServer((request, response) => {
    observed = { method: request.method, url: request.url, authorization: request.headers.authorization };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"clear_generation":4}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const result = await runClear(dir, server.address().port);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /generation 4/);
  assert.deepEqual(observed, { method: 'POST', url: '/admin/clear', authorization: `Bearer ${token}` });
  assert.equal(result.stdout.includes(token), false);
});

test('redline-clear fails without claiming success when the sidecar rejects clear', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-clear-failure-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await new StateStore(dir).ensureCliCredential();
  const server = http.createServer((_request, response) => {
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end('{"error":{"code":"clear_failed"}}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const result = await runClear(dir, server.address().port);

  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout, /cleared/i);
  assert.doesNotMatch(result.stderr, /clear_failed/);
});

test('clear crash recovery rolls back precommit and completes every postcommit deletion stage', async (t) => {
  const stages = [
    'before-intent-write',
    'after-intent-fsync',
    'after-state-replace',
    'after-delete:screenshots:ss_one.png',
    'after-delete:screenshots:ss_two.png',
    'after-delete:staging:stage_one.png',
    'after-delete:root:redlines.json.migrated',
    'before-intent-removal',
  ];
  for (const stage of stages) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-clear-crash-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const base = new StateStore(dir);
    const cli = await base.ensureCliCredential();
    const client = await base.consumePairingSecret((await base.createPairingWindow()).secret);
    await base.submitRedline(client.clientId, {
      operation_id: 'op_crash_clear_01', clear_generation: 0, comment: 'preserve or clear',
    });
    fs.writeFileSync(path.join(dir, 'screenshots', 'ss_one.png'), Buffer.from('one'), { mode: 0o600 });
    fs.writeFileSync(path.join(dir, 'screenshots', 'ss_two.png'), Buffer.from('two'), { mode: 0o600 });
    fs.writeFileSync(path.join(dir, 'staging', 'stage_one.png'), Buffer.from('stage'), { mode: 0o600 });
    fs.writeFileSync(path.join(dir, 'redlines.json.migrated'), '[]\n', { mode: 0o600 });
    const faulting = new StateStore(dir, { clearFault(current) {
      if (current === stage) throw new Error(`crash:${stage}`);
    } });

    await assert.rejects(faulting.clearAll(), new RegExp(`crash:${stage.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    const recovered = new StateStore(dir);
    await recovered.initialize();
    assert.equal(await recovered.verifyCliToken(cli), true, stage);
    if (['before-intent-write', 'after-intent-fsync'].includes(stage)) {
      assert.equal(await recovered.clearGeneration(), 0, stage);
      assert.equal((await recovered.listRedlines()).length, 1, stage);
    } else {
      assert.equal(await recovered.clearGeneration(), 1, stage);
      assert.deepEqual(await recovered.listRedlines(), [], stage);
      assert.deepEqual(fs.readdirSync(path.join(dir, 'screenshots')), [], stage);
      assert.deepEqual(fs.readdirSync(path.join(dir, 'staging')), [], stage);
      assert.equal(fs.existsSync(path.join(dir, 'redlines.json.migrated')), false, stage);
    }
    assert.equal(fs.existsSync(path.join(dir, 'clear-intent.json')), false, stage);
  }
});

test('a clear intent with unknown fields fails closed without deleting evidence', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-clear-intent-schema-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const base = new StateStore(dir);
  await base.initialize();
  fs.writeFileSync(path.join(dir, 'screenshots', 'ss_evidence.png'), Buffer.from('evidence'), { mode: 0o600 });
  const faulting = new StateStore(dir, { clearFault(stage) {
    if (stage === 'after-intent-fsync') throw new Error('stop after durable clear intent');
  } });
  await assert.rejects(faulting.clearAll(), /stop after durable clear intent/);
  const intentFile = path.join(dir, 'clear-intent.json');
  const intent = JSON.parse(fs.readFileSync(intentFile, 'utf8'));
  intent.unexpected_page_content = 'preserve this evidence';
  const corrupt = `${JSON.stringify(intent, null, 2)}\n`;
  fs.writeFileSync(intentFile, corrupt, { mode: 0o600 });

  await assert.rejects(new StateStore(dir).initialize(), /invalid schema.*preserving/i);
  assert.equal(fs.readFileSync(intentFile, 'utf8'), corrupt);
  assert.equal(fs.readFileSync(path.join(dir, 'screenshots', 'ss_evidence.png'), 'utf8'), 'evidence');
});

test('SIGKILL during committed clear leaves a stale lock and recovery finishes every deletion', async (t) => {
  for (const stage of ['after-state-replace', 'after-delete:screenshots:ss_killed.png', 'before-intent-removal']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-clear-sigkill-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const store = new StateStore(dir);
    const cli = await store.ensureCliCredential();
    const client = await store.consumePairingSecret((await store.createPairingWindow()).secret);
    await store.submitRedline(client.clientId, {
      operation_id: 'op_before_killed_clear', clear_generation: 0, comment: 'must be cleared',
    });
    fs.writeFileSync(path.join(dir, 'screenshots', 'ss_killed.png'), Buffer.from('delete me'), { mode: 0o600 });
    fs.writeFileSync(path.join(dir, 'staging', 'stage_killed.png'), Buffer.from('delete me'), { mode: 0o600 });
    const modulePath = path.resolve(__dirname, '../runtime/lib/state-store.js');
    const code = `
      const { StateStore } = require(${JSON.stringify(modulePath)});
      new StateStore(process.argv[1], { clearFault(current) {
        if (current === process.argv[2]) process.kill(process.pid, 'SIGKILL');
      } }).clearAll();
    `;
    const outcome = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', code, dir, stage], { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject);
      child.on('exit', (status, signal) => resolve({ status, signal, stderr }));
    });

    assert.equal(outcome.signal, 'SIGKILL', `${stage}: ${outcome.stderr}`);
    assert.equal(fs.existsSync(path.join(dir, 'state.lock')), true, stage);
    const recovered = new StateStore(dir);
    await recovered.initialize();
    await recovered.initialize();
    assert.equal(fs.existsSync(path.join(dir, 'state.lock')), false, stage);
    assert.equal(fs.existsSync(path.join(dir, 'clear-intent.json')), false, stage);
    assert.equal(await recovered.clearGeneration(), 1, stage);
    assert.deepEqual(await recovered.listRedlines(), [], stage);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'screenshots')), [], stage);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'staging')), [], stage);
    assert.equal(await recovered.verifyCliToken(cli), true, stage);
  }
});

test('committed clear recovery refuses files outside its exact deletion set', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-clear-reference-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const base = new StateStore(dir);
  await base.initialize();
  fs.writeFileSync(path.join(dir, 'screenshots', 'ss_target.png'), Buffer.from('target'), { mode: 0o600 });
  const faulting = new StateStore(dir, { clearFault(stage) {
    if (stage === 'after-state-replace') throw new Error('stop after committed clear');
  } });
  await assert.rejects(faulting.clearAll(), /stop after committed clear/);
  const outsideSet = path.join(dir, 'screenshots', 'ss_unlisted.png');
  fs.writeFileSync(outsideSet, Buffer.from('preserve'), { mode: 0o600 });
  const intentFile = path.join(dir, 'clear-intent.json');
  const intentBefore = fs.readFileSync(intentFile, 'utf8');

  await assert.rejects(new StateStore(dir).initialize(), /deletion set.*preserving/i);
  assert.equal(fs.readFileSync(intentFile, 'utf8'), intentBefore);
  assert.equal(fs.readFileSync(outsideSet, 'utf8'), 'preserve');
  assert.equal(fs.existsSync(path.join(dir, 'screenshots', 'ss_target.png')), true);
});

test('clear serializes against pair, create, and delete without allowing an old draft through', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-clear-race-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new StateStore(dir);
  const oldClient = await store.consumePairingSecret((await store.createPairingWindow()).secret);
  const old = await store.submitRedline(oldClient.clientId, {
    operation_id: 'op_before_clear_01', clear_generation: 0, comment: 'old',
  });

  const outcomes = await Promise.allSettled([
    store.clearAll(),
    store.createPairingWindow(),
    store.submitRedline(oldClient.clientId, {
      operation_id: 'op_racing_clear_01', clear_generation: 0, comment: 'must not survive',
    }),
    store.deleteRedline(old.id),
  ]);

  assert.equal(outcomes[0].status, 'fulfilled');
  assert.equal(outcomes[1].status, 'fulfilled');
  assert.equal(outcomes[2].status, 'rejected');
  assert.match(outcomes[2].reason.code, /unauthorized|data_cleared/);
  assert.equal(outcomes[3].status, 'fulfilled');
  assert.deepEqual(await store.listRedlines(), []);
  assert.equal(await store.clearGeneration(), 1);
});

test('cross-process clear racing a submission converges on an empty next generation', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-clear-process-race-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new StateStore(dir);
  const client = await store.consumePairingSecret((await store.createPairingWindow()).secret);
  const modulePath = path.resolve(__dirname, '../runtime/lib/state-store.js');
  const run = (code, args = []) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', code, dir, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (status) => resolve({ status, stderr }));
  });
  const clearCode = `const {StateStore}=require(${JSON.stringify(modulePath)});new StateStore(process.argv[1]).clearAll().catch(e=>{console.error(e.code||e.message);process.exit(1)});`;
  const submitCode = `const {StateStore}=require(${JSON.stringify(modulePath)});new StateStore(process.argv[1]).submitRedline(process.argv[2],{operation_id:'op_process_race_01',clear_generation:0,comment:'race'}).catch(e=>{if(!['unauthorized','data_cleared'].includes(e.code)){console.error(e);process.exit(1)}});`;

  const outcomes = await Promise.all([run(clearCode), run(submitCode, [client.clientId])]);
  assert.equal(outcomes[0].status, 0, outcomes[0].stderr);
  assert.equal(outcomes[1].status, 0, outcomes[1].stderr);
  const recovered = new StateStore(dir);
  await recovered.initialize();
  assert.equal(await recovered.clearGeneration(), 1);
  assert.deepEqual(await recovered.listRedlines(), []);
});

test('clear removes the content-bearing legacy migration backup', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-clear-legacy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'redlines.json'), JSON.stringify([{
    id: 'rl_legacyclear', comment: 'sensitive old feedback', selected_text: 'private copy',
  }]), { mode: 0o600 });
  const store = new StateStore(dir);
  await store.initialize();
  assert.equal(fs.existsSync(path.join(dir, 'redlines.json.migrated')), true);

  await store.clearAll();

  assert.equal(fs.existsSync(path.join(dir, 'redlines.json.migrated')), false);
  assert.equal(JSON.stringify(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'))).includes('sensitive'), false);
});
