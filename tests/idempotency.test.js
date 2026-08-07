'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomFillSync } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { PNG } = require('pngjs');

const { StateStore, TOMBSTONE_TTL_MS } = require('../runtime/lib/state-store');

const VALID_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function generatedPng(red, green, blue) {
  const image = new PNG({ width: 1, height: 1 });
  image.data.set([red, green, blue, 255]);
  return PNG.sync.write(image);
}

function tempStore(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-idempotency-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, store: new StateStore(root, options) };
}

async function pairedClient(store) {
  const pairing = await store.createPairingWindow();
  return store.consumePairingSecret(pairing.secret);
}

function submission(overrides = {}) {
  return {
    operation_id: 'op_0123456789abcdef',
    clear_generation: 0,
    url: 'https://example.test/settings',
    origin: 'https://example.test',
    title: 'Settings',
    project: 'website',
    selected_text: 'Save',
    comment: 'Use Publish',
    context: { after: 'changes', before: 'Review' },
    rect: { height: 20, width: 80, x: 10, y: 30 },
    ...overrides,
  };
}

test('an exact submission retry returns the original result without rewriting state', async (t) => {
  const { root, store } = tempStore(t);
  const client = await pairedClient(store);

  const first = await store.submitRedline(client.clientId, submission());
  const stateFile = path.join(root, 'state.json');
  const firstState = fs.readFileSync(stateFile);
  const firstStat = fs.statSync(stateFile);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const retry = await store.submitRedline(client.clientId, submission());

  assert.deepEqual(retry, first);
  assert.deepEqual(fs.readFileSync(stateFile), firstState);
  assert.equal(fs.statSync(stateFile).mtimeMs, firstStat.mtimeMs);
});

test('a valid large PNG submission stays within the bounded transaction path', async (t) => {
  const { root, store } = tempStore(t);
  const client = await pairedClient(store);
  const image = new PNG({ width: 1450, height: 1450 });
  randomFillSync(image.data);
  const screenshot = PNG.sync.write(image);
  assert.ok(screenshot.length > 8 * 1024 * 1024 && screenshot.length < 10 * 1024 * 1024);

  const created = await store.submitRedline(client.clientId, submission({
    operation_id: 'op_large_png_01234567',
    screenshot_png: screenshot.toString('base64'),
  }));

  assert.match(created.screenshot_id, /^ss_[0-9a-f]{32}$/);
  assert.deepEqual(fs.readFileSync(path.join(root, 'screenshots', `${created.screenshot_id}.png`)), screenshot);
});

test('an exact retry returns the immutable creation response after PATCH and ack', async (t) => {
  const { root, store } = tempStore(t);
  const client = await pairedClient(store);
  const input = submission();
  const created = await store.submitRedline(client.clientId, input);
  const original = JSON.stringify(created);

  await store.updateRedline(created.id, { comment: 'Mutated after creation' });
  await store.updateRedline(created.id, {}, { ack: true });
  const retry = await store.submitRedline(client.clientId, input);

  assert.equal(JSON.stringify(retry), original);
  assert.deepEqual(retry, created);
  const persisted = JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8'));
  assert.deepEqual(persisted.operations[client.clientId][input.operation_id].response, created);
});

test('changed reuse of an operation ID returns operation_conflict without changing the original', async (t) => {
  const { store } = tempStore(t);
  const client = await pairedClient(store);
  const first = await store.submitRedline(client.clientId, submission());

  await assert.rejects(
    store.submitRedline(client.clientId, submission({ comment: 'Use Apply' })),
    (error) => error.code === 'operation_conflict' && !error.message.includes('Use Apply'),
  );
  assert.deepEqual(await store.listRedlines(), [first]);
});

test('a PNG is promoted once and its digest is bound to the operation payload', async (t) => {
  const { root, store } = tempStore(t);
  const client = await pairedClient(store);
  const png = generatedPng(10, 20, 30);
  const changed = generatedPng(30, 20, 10);

  const first = await store.submitRedline(client.clientId, submission({ screenshot_png: png.toString('base64') }));
  const screenshot = path.join(root, 'screenshots', `${first.screenshot_id}.png`);
  assert.deepEqual(fs.readFileSync(screenshot), png);
  assert.equal(fs.statSync(screenshot).mode & 0o777, 0o600);
  assert.deepEqual(
    await store.submitRedline(client.clientId, submission({ screenshot_png: png.toString('base64') })),
    first,
  );
  await assert.rejects(
    store.submitRedline(client.clientId, submission({ screenshot_png: changed.toString('base64') })),
    (error) => error.code === 'operation_conflict',
  );
  assert.deepEqual(fs.readFileSync(screenshot), png);
});

test('signature-prefixed junk is rejected as an invalid PNG', async (t) => {
  const { store } = tempStore(t);
  const client = await pairedClient(store);
  const junk = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('not a PNG')]);

  await assert.rejects(
    store.submitRedline(client.clientId, submission({ screenshot_png: junk.toString('base64') })),
    (error) => error.code === 'invalid_submission',
  );
});

test('screenshot SHA-256 is persisted in immutable redline metadata', async (t) => {
  const { root, store } = tempStore(t);
  const client = await pairedClient(store);
  const created = await store.submitRedline(client.clientId, submission({
    screenshot_png: VALID_PNG.toString('base64'),
  }));
  const expected = require('node:crypto').createHash('sha256').update(VALID_PNG).digest('hex');
  const state = JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8'));

  assert.equal(created.screenshot_sha256, expected);
  assert.equal(state.redlines[created.id].screenshot_sha256, expected);
  assert.equal(state.operations[client.clientId][submission().operation_id].response.screenshot_sha256, expected);
});

test('serve and exact replay fail closed when a committed screenshot is replaced', async (t) => {
  const { root, store } = tempStore(t);
  const client = await pairedClient(store);
  const input = submission({ screenshot_png: VALID_PNG.toString('base64') });
  const created = await store.submitRedline(client.clientId, input);
  const screenshot = path.join(root, 'screenshots', `${created.screenshot_id}.png`);
  fs.writeFileSync(screenshot,
    Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('replaced')]), { mode: 0o600 });

  await assert.rejects(store.readScreenshot(created.screenshot_id), /integrity|PNG|digest/i);
  await assert.rejects(store.submitRedline(client.clientId, input), /integrity|PNG|digest/i);
  assert.equal(fs.existsSync(screenshot), true);
});

test('deletion removes content and screenshot but leaves a content-free 30-day tombstone', async (t) => {
  let now = Date.parse('2026-08-07T12:00:00.000Z');
  const { root, store } = tempStore(t, { now: () => now });
  const client = await pairedClient(store);
  const png = generatedPng(40, 50, 60);
  const input = submission({ screenshot_png: png.toString('base64') });
  const created = await store.submitRedline(client.clientId, input);

  assert.equal(await store.deleteRedline(created.id), true);
  assert.deepEqual(await store.listRedlines(), []);
  assert.equal(fs.existsSync(path.join(root, 'screenshots', `${created.screenshot_id}.png`)), false);
  await assert.rejects(
    store.submitRedline(client.clientId, input),
    (error) => error.code === 'operation_deleted' && !error.message.includes('delete-me'),
  );
  const persisted = JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8'));
  const tombstone = persisted.operations[client.clientId][input.operation_id];
  assert.deepEqual(Object.keys(tombstone).sort(), ['deleted_at', 'expires_at', 'redline_id']);
  assert.equal(JSON.stringify(tombstone).includes('delete-me'), false);
  assert.equal(JSON.stringify(tombstone).includes('Use Publish'), false);
  assert.equal(Object.hasOwn(tombstone, 'response'), false);
  assert.equal(Date.parse(tombstone.expires_at) - Date.parse(tombstone.deleted_at), 30 * 24 * 60 * 60 * 1000);
});

test('delete recovery rolls back precommit and completes every committed boundary idempotently', async (t) => {
  const stages = [
    'after-delete-intent-fsync',
    'after-delete-state-replace',
    'during-delete-screenshots',
    'after-delete-screenshot',
    'before-delete-intent-removal',
  ];
  for (const stage of stages) {
    const { root } = tempStore(t);
    const base = new StateStore(root);
    const client = await pairedClient(base);
    const png = generatedPng(70, 80, 90);
    const input = submission({ screenshot_png: png.toString('base64') });
    const created = await base.submitRedline(client.clientId, input);
    const screenshot = path.join(root, 'screenshots', `${created.screenshot_id}.png`);
    fs.writeFileSync(path.join(root, 'screenshots', 'ss_orphan.png'), png, { mode: 0o600 });
    const faulting = new StateStore(root, { transactionFault(current) {
      if (current === stage || (stage === 'during-delete-screenshots' && current.startsWith('after-delete-screenshot:'))) {
        throw new Error(`crash:${stage}`);
      }
    } });

    await assert.rejects(faulting.deleteRedline(created.id), new RegExp(`crash:${stage}`));
    const recovered = new StateStore(root);
    await recovered.initialize();
    await recovered.initialize();
    assert.equal(fs.existsSync(path.join(root, 'transaction-intent.json')), false, stage);
    if (stage === 'after-delete-intent-fsync') {
      assert.deepEqual(await recovered.listRedlines(), [created], stage);
      assert.equal(fs.existsSync(screenshot), true, stage);
      assert.deepEqual(await recovered.submitRedline(client.clientId, input), created, stage);
    } else {
      assert.deepEqual(await recovered.listRedlines(), [], stage);
      assert.equal(fs.existsSync(screenshot), false, stage);
      assert.deepEqual(fs.readdirSync(path.join(root, 'screenshots')), [], stage);
      await assert.rejects(recovered.submitRedline(client.clientId, input),
        (error) => error.code === 'operation_deleted');
      const state = JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8'));
      assert.deepEqual(Object.keys(state.operations[client.clientId][input.operation_id]).sort(),
        ['deleted_at', 'expires_at', 'redline_id'], stage);
      assert.equal(JSON.stringify(state.operations).includes('Mutated after creation'), false, stage);
      assert.equal(JSON.stringify(state.operations).includes(stage), false, stage);
    }
  }
});

test('SIGKILL during committed delete leaves a stale lock and recovery converges idempotently', async (t) => {
  for (const stage of ['after-delete-state-replace', 'after-delete-screenshot']) {
    const { root } = tempStore(t);
    const store = new StateStore(root);
    const client = await pairedClient(store);
    const input = submission({
      operation_id: `op_killed_delete_${stage === 'after-delete-state-replace' ? 'state' : 'shot'}`,
      screenshot_png: generatedPng(20, 30, 40).toString('base64'),
    });
    const created = await store.submitRedline(client.clientId, input);
    const screenshot = path.join(root, 'screenshots', `${created.screenshot_id}.png`);
    const modulePath = path.resolve(__dirname, '../runtime/lib/state-store.js');
    const code = `
      const { StateStore } = require(${JSON.stringify(modulePath)});
      new StateStore(process.argv[1], { transactionFault(current) {
        if (current === ${JSON.stringify(stage)}) process.kill(process.pid, 'SIGKILL');
      } }).deleteRedline(process.argv[2]).then(() => process.exit(2), error => {
        console.error(error); process.exit(1);
      });
    `;
    const outcome = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', code, root, created.id], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject);
      child.on('exit', (status, signal) => resolve({ status, signal, stderr }));
    });

    assert.equal(outcome.signal, 'SIGKILL', `${stage}: ${outcome.stderr}`);
    assert.equal(fs.existsSync(path.join(root, 'state.lock')), true, stage);
    const recovered = new StateStore(root);
    await recovered.initialize();
    await recovered.initialize();
    assert.equal(fs.existsSync(path.join(root, 'state.lock')), false, stage);
    assert.equal(fs.existsSync(path.join(root, 'transaction-intent.json')), false, stage);
    assert.equal(fs.existsSync(screenshot), false, stage);
    assert.deepEqual(await recovered.listRedlines(), [], stage);
    await assert.rejects(recovered.submitRedline(client.clientId, input),
      (error) => error.code === 'operation_deleted');
  }
});

test('delete serializes with retry, update, and clear', async (t) => {
  const { store } = tempStore(t);
  const client = await pairedClient(store);
  const input = submission();
  const created = await store.submitRedline(client.clientId, input);

  const deletion = store.deleteRedline(created.id);
  const retry = store.submitRedline(client.clientId, input).catch((error) => error.code);
  const update = store.updateRedline(created.id, { comment: 'must not return' });
  const clear = store.clearAll();

  assert.deepEqual(await Promise.all([deletion, retry, update, clear]),
    [true, 'operation_deleted', null, 1]);
  assert.deepEqual(await store.listRedlines(), []);
});

test('browser authorization is revalidated inside each queued operation', async (t) => {
  const { store } = tempStore(t);
  const client = await pairedClient(store);
  const created = await store.submitRedline(client.clientId, submission());

  const clear = store.clearAll({ browserToken: client.token });
  const read = store.listRedlines({}, { browserToken: client.token }).catch((error) => error.code);
  const update = store.updateRedline(created.id, { comment: 'stale update' },
    { browserToken: client.token }).catch((error) => error.code);
  const deletion = store.deleteRedline(created.id,
    { browserToken: client.token }).catch((error) => error.code);

  assert.deepEqual(await Promise.all([clear, read, update, deletion]),
    [1, 'unauthorized', 'unauthorized', 'unauthorized']);
});

test('revoked browser authorization is checked before malformed operation identifiers', async (t) => {
  const { store } = tempStore(t);
  const client = await pairedClient(store);
  await store.clearAll({ browserToken: client.token });

  for (const operation of [
    () => store.readScreenshot('../invalid', { browserToken: client.token }),
    () => store.updateRedline('../invalid', {}, { browserToken: client.token }),
    () => store.deleteRedline('../invalid', { browserToken: client.token }),
  ]) {
    await assert.rejects(operation, (error) => error.code === 'unauthorized');
  }
});

test('legacy redlines.json migrates exactly once without changing redlines or screenshots', async (t) => {
  const { root } = tempStore(t);
  const legacy = [{
    id: 'rl_legacy123', created_at: '2026-01-01T00:00:00.000Z', status: 'pending',
    selected_text: 'Legacy copy', comment: 'Keep this', screenshot_id: 'ss_legacy123',
  }];
  fs.mkdirSync(path.join(root, 'screenshots'), { mode: 0o700 });
  fs.writeFileSync(path.join(root, 'screenshots', 'ss_legacy123.png'), VALID_PNG, { mode: 0o600 });
  fs.writeFileSync(path.join(root, 'redlines.json'), `${JSON.stringify(legacy)}\n`, { mode: 0o600 });
  const migrated = [{
    ...legacy[0],
    screenshot_sha256: require('node:crypto').createHash('sha256').update(VALID_PNG).digest('hex'),
  }];

  const store = new StateStore(root);
  await store.initialize();
  assert.deepEqual(await store.listRedlines(), migrated);
  assert.equal(fs.existsSync(path.join(root, 'screenshots', 'ss_legacy123.png')), true);
  assert.equal(fs.existsSync(path.join(root, 'redlines.json')), false);
  assert.equal(fs.existsSync(path.join(root, 'redlines.json.migrated')), true);

  await new StateStore(root).initialize();
  assert.deepEqual(await store.listRedlines(), migrated);
});

test('Task 5 state upgrades to the idempotent schema without changing credentials', async (t) => {
  const { root, store } = tempStore(t);
  const cli = await store.ensureCliCredential();
  const stateFile = path.join(root, 'state.json');
  const current = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  fs.writeFileSync(stateFile, `${JSON.stringify({
    version: 1,
    cli_hash: current.cli_hash,
    pairing: current.pairing,
    clients: current.clients,
    clear_generation: current.clear_generation,
  }, null, 2)}\n`, { mode: 0o600 });

  const upgraded = new StateStore(root);
  await upgraded.initialize();

  assert.equal(await upgraded.verifyCliToken(cli), true);
  const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(persisted.version, 2);
  assert.deepEqual(persisted.redlines, {});
  assert.deepEqual(persisted.operations, {});
});

test('submission recovery rolls back precommit staging and completes committed screenshot promotion', async (t) => {
  for (const stage of ['after-screenshot-stage', 'after-intent-fsync', 'after-state-replace', 'after-screenshot-promote']) {
    const { root } = tempStore(t);
    const faulting = new StateStore(root, { transactionFault(current) {
      if (current === stage) throw new Error(`crash:${stage}`);
    } });
    const client = await pairedClient(faulting);
    const input = submission({ screenshot_png: generatedPng(100, 110, 120).toString('base64') });

    await assert.rejects(faulting.submitRedline(client.clientId, input), new RegExp(`crash:${stage}`));
    if (stage === 'after-screenshot-stage') {
      assert.deepEqual(
        fs.readdirSync(path.join(root, 'staging')).map((name) => name.replace(/[0-9a-f]{32}/, '<operation>')),
        ['op_<operation>.png'],
      );
      assert.equal(fs.existsSync(path.join(root, 'transaction-intent.json')), false);
    }
    const recovered = new StateStore(root);
    await recovered.initialize();
    const items = await recovered.listRedlines();
    if (['after-screenshot-stage', 'after-intent-fsync'].includes(stage)) {
      assert.deepEqual(items, [], stage);
      assert.deepEqual(fs.readdirSync(path.join(root, 'staging')), [], stage);
    } else {
      assert.equal(items.length, 1, stage);
      assert.equal(fs.existsSync(path.join(root, 'screenshots', `${items[0].screenshot_id}.png`)), true, stage);
      assert.deepEqual(await recovered.submitRedline(client.clientId, input), items[0], stage);
    }
    assert.equal(fs.existsSync(path.join(root, 'transaction-intent.json')), false, stage);
  }
});

test('a transaction intent with unknown fields fails closed and preserves all evidence', async (t) => {
  const { root } = tempStore(t);
  const faulting = new StateStore(root, { transactionFault(stage) {
    if (stage === 'after-intent-fsync') throw new Error('stop after durable intent');
  } });
  const client = await pairedClient(faulting);
  await assert.rejects(faulting.submitRedline(client.clientId, submission({
    screenshot_png: generatedPng(1, 2, 3).toString('base64'),
  })), /stop after durable intent/);
  const intentFile = path.join(root, 'transaction-intent.json');
  const intent = JSON.parse(fs.readFileSync(intentFile, 'utf8'));
  intent.unexpected_page_content = 'preserve this evidence';
  const corrupt = `${JSON.stringify(intent, null, 2)}\n`;
  fs.writeFileSync(intentFile, corrupt, { mode: 0o600 });
  const stagingBefore = fs.readdirSync(path.join(root, 'staging'));

  await assert.rejects(new StateStore(root).initialize(), /invalid schema.*preserving/i);
  assert.equal(fs.readFileSync(intentFile, 'utf8'), corrupt);
  assert.deepEqual(fs.readdirSync(path.join(root, 'staging')), stagingBefore);
});

test('precommit create recovery preserves a staged PNG replaced after intent fsync', async (t) => {
  const { root } = tempStore(t);
  const faulting = new StateStore(root, { transactionFault(stage) {
    if (stage === 'after-intent-fsync') throw new Error('stop after durable intent');
  } });
  const client = await pairedClient(faulting);
  await assert.rejects(faulting.submitRedline(client.clientId, submission({
    screenshot_png: generatedPng(21, 22, 23).toString('base64'),
  })), /stop after durable intent/);
  const intentFile = path.join(root, 'transaction-intent.json');
  const intentText = fs.readFileSync(intentFile, 'utf8');
  const intent = JSON.parse(intentText);
  const stagedFile = path.join(root, 'staging', intent.staging_file);
  const replacement = generatedPng(201, 202, 203);
  fs.writeFileSync(stagedFile, replacement, { mode: 0o600 });

  await assert.rejects(new StateStore(root).initialize(), (error) => {
    assert.equal(error.code, 'recovery_evidence_mismatch');
    assert.match(error.message, /staged transaction screenshot.*intent.*preserving/i);
    return true;
  });
  assert.equal(fs.readFileSync(intentFile, 'utf8'), intentText);
  assert.deepEqual(fs.readFileSync(stagedFile), replacement);
  assert.deepEqual(fs.readdirSync(path.join(root, 'screenshots')), []);
});

test('precommit create recovery preserves its intent when the staged PNG is unexpectedly missing', async (t) => {
  const { root } = tempStore(t);
  const faulting = new StateStore(root, { transactionFault(stage) {
    if (stage === 'after-intent-fsync') throw new Error('stop after durable intent');
  } });
  const client = await pairedClient(faulting);
  await assert.rejects(faulting.submitRedline(client.clientId, submission({
    screenshot_png: generatedPng(31, 32, 33).toString('base64'),
  })), /stop after durable intent/);
  const intentFile = path.join(root, 'transaction-intent.json');
  const intentText = fs.readFileSync(intentFile, 'utf8');
  const intent = JSON.parse(intentText);
  fs.unlinkSync(path.join(root, 'staging', intent.staging_file));

  await assert.rejects(new StateStore(root).initialize(), (error) => {
    assert.equal(error.code, 'recovery_evidence_mismatch');
    assert.match(error.message, /staged transaction screenshot is missing.*preserving/i);
    return true;
  });
  assert.equal(fs.readFileSync(intentFile, 'utf8'), intentText);
  assert.deepEqual(fs.readdirSync(path.join(root, 'screenshots')), []);
});

test('a create intent cannot redirect recovery to a different operation staging file', async (t) => {
  const { root } = tempStore(t);
  const faulting = new StateStore(root, { transactionFault(stage) {
    if (stage === 'after-intent-fsync') throw new Error('stop after durable intent');
  } });
  const client = await pairedClient(faulting);
  await assert.rejects(faulting.submitRedline(client.clientId, submission({
    screenshot_png: generatedPng(4, 5, 6).toString('base64'),
  })), /stop after durable intent/);
  const intentFile = path.join(root, 'transaction-intent.json');
  const intent = JSON.parse(fs.readFileSync(intentFile, 'utf8'));
  intent.staging_file = 'op_00000000000000000000000000000000.png';
  const corrupt = `${JSON.stringify(intent, null, 2)}\n`;
  fs.writeFileSync(intentFile, corrupt, { mode: 0o600 });
  fs.writeFileSync(path.join(root, 'staging', intent.staging_file), generatedPng(7, 8, 9), { mode: 0o600 });
  const stagingBefore = fs.readdirSync(path.join(root, 'staging')).sort();

  await assert.rejects(new StateStore(root).initialize(), /invalid schema.*preserving/i);
  assert.equal(fs.readFileSync(intentFile, 'utf8'), corrupt);
  assert.deepEqual(fs.readdirSync(path.join(root, 'staging')).sort(), stagingBefore);
});

test('committed create recovery validates intent references before promoting a screenshot', async (t) => {
  const { root } = tempStore(t);
  const faulting = new StateStore(root, { transactionFault(stage) {
    if (stage === 'after-state-replace') throw new Error('stop after committed state');
  } });
  const client = await pairedClient(faulting);
  await assert.rejects(faulting.submitRedline(client.clientId, submission({
    screenshot_png: generatedPng(10, 11, 12).toString('base64'),
  })), /stop after committed state/);
  const intentFile = path.join(root, 'transaction-intent.json');
  const intent = JSON.parse(fs.readFileSync(intentFile, 'utf8'));
  intent.screenshot_id = 'ss_00000000000000000000000000000000';
  intent.screenshot_file = `${intent.screenshot_id}.png`;
  const corrupt = `${JSON.stringify(intent, null, 2)}\n`;
  fs.writeFileSync(intentFile, corrupt, { mode: 0o600 });
  const stagingBefore = fs.readdirSync(path.join(root, 'staging'));

  await assert.rejects(new StateStore(root).initialize(), /references.*preserving/i);
  assert.equal(fs.readFileSync(intentFile, 'utf8'), corrupt);
  assert.deepEqual(fs.readdirSync(path.join(root, 'staging')), stagingBefore);
  assert.deepEqual(fs.readdirSync(path.join(root, 'screenshots')), []);
});

test('committed delete recovery refuses an expanded screenshot deletion set', async (t) => {
  const { root } = tempStore(t);
  const store = new StateStore(root);
  const client = await pairedClient(store);
  const input = submission({ screenshot_png: generatedPng(13, 14, 15).toString('base64') });
  const created = await store.submitRedline(client.clientId, input);
  const faulting = new StateStore(root, { transactionFault(stage) {
    if (stage === 'after-delete-state-replace') throw new Error('stop after committed delete');
  } });
  await assert.rejects(faulting.deleteRedline(created.id), /stop after committed delete/);
  const evidence = path.join(root, 'screenshots', 'ss_unrelated.png');
  fs.writeFileSync(evidence, generatedPng(16, 17, 18), { mode: 0o600 });
  const intentFile = path.join(root, 'transaction-intent.json');
  const intent = JSON.parse(fs.readFileSync(intentFile, 'utf8'));
  intent.screenshot_files.push('ss_unrelated.png');
  const corrupt = `${JSON.stringify(intent, null, 2)}\n`;
  fs.writeFileSync(intentFile, corrupt, { mode: 0o600 });

  await assert.rejects(new StateStore(root).initialize(), /(?:invalid schema|deletion set).*preserving/i);
  assert.equal(fs.readFileSync(intentFile, 'utf8'), corrupt);
  assert.equal(fs.existsSync(evidence), true);
});

test('precommit delete recovery preserves an intent when a bound target changes', async (t) => {
  const { root } = tempStore(t);
  const store = new StateStore(root);
  const client = await pairedClient(store);
  const created = await store.submitRedline(client.clientId, submission({
    screenshot_png: generatedPng(19, 20, 21).toString('base64'),
  }));
  const faulting = new StateStore(root, { transactionFault(stage) {
    if (stage === 'after-delete-intent-fsync') throw new Error('stop before delete commit');
  } });
  await assert.rejects(faulting.deleteRedline(created.id), /stop before delete commit/);
  const screenshot = path.join(root, 'screenshots', `${created.screenshot_id}.png`);
  fs.writeFileSync(screenshot, generatedPng(22, 23, 24), { mode: 0o600 });
  const intentFile = path.join(root, 'transaction-intent.json');
  const intentBefore = fs.readFileSync(intentFile, 'utf8');

  await assert.rejects(new StateStore(root).initialize(), /deletion target changed.*preserving/i);
  assert.equal(fs.readFileSync(intentFile, 'utf8'), intentBefore);
  assert.equal(fs.existsSync(screenshot), true);
});

test('expired tombstones are removed inside the serialized mutation boundary', async (t) => {
  let now = Date.parse('2026-08-07T12:00:00.000Z');
  const { store } = tempStore(t, { now: () => now });
  const client = await pairedClient(store);
  const input = submission();
  const first = await store.submitRedline(client.clientId, input);
  await store.deleteRedline(first.id);
  now += 30 * 24 * 60 * 60 * 1000 + 1;

  const replacement = await store.submitRedline(client.clientId, input);

  assert.notEqual(replacement.id, first.id);
  assert.deepEqual(await store.listRedlines(), [replacement]);
});

test('tombstones require canonical timestamps and exactly the configured 30-day TTL', async (t) => {
  for (const mutation of ['noncanonical', 'wrong-ttl']) {
    const now = Date.parse('2026-08-07T12:00:00.000Z');
    const { root, store } = tempStore(t, { now: () => now });
    const client = await pairedClient(store);
    const input = submission();
    const created = await store.submitRedline(client.clientId, input);
    await store.deleteRedline(created.id);
    const stateFile = path.join(root, 'state.json');
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const tombstone = state.operations[client.clientId][input.operation_id];
    if (mutation === 'noncanonical') tombstone.deleted_at = '2026-08-07T12:00:00+00:00';
    else tombstone.expires_at = new Date(now + TOMBSTONE_TTL_MS + 1).toISOString();
    const corrupt = `${JSON.stringify(state, null, 2)}\n`;
    fs.writeFileSync(stateFile, corrupt, { mode: 0o600 });

    await assert.rejects(new StateStore(root, { now: () => now }).initialize(), /invalid operation state/i);
    assert.equal(fs.readFileSync(stateFile, 'utf8'), corrupt);
  }
});

test('corrupt operation state fails closed and preserves the evidence byte-for-byte', async (t) => {
  const { root, store } = tempStore(t);
  await store.ensureCliCredential();
  const stateFile = path.join(root, 'state.json');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  state.operations = { bad_client: { op_bad_state: { payload_hash: 'not-a-hash', redline_id: '../outside' } } };
  const corrupt = `${JSON.stringify(state, null, 2)}\n`;
  fs.writeFileSync(stateFile, corrupt, { mode: 0o600 });

  await assert.rejects(new StateStore(root).initialize(), /invalid operation state/i);
  assert.equal(fs.readFileSync(stateFile, 'utf8'), corrupt);
});

test('operation snapshots reject unexpected content and preserve corrupt evidence', async (t) => {
  const { root, store } = tempStore(t);
  const client = await pairedClient(store);
  const input = submission();
  await store.submitRedline(client.clientId, input);
  const stateFile = path.join(root, 'state.json');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  state.operations[client.clientId][input.operation_id].response.unexpected_secret = 'preserve me';
  const corrupt = `${JSON.stringify(state, null, 2)}\n`;
  fs.writeFileSync(stateFile, corrupt, { mode: 0o600 });

  await assert.rejects(new StateStore(root).initialize(), /invalid operation state/i);
  assert.equal(fs.readFileSync(stateFile, 'utf8'), corrupt);
});

test('corrupt redline content types fail closed and preserve the evidence byte-for-byte', async (t) => {
  const { root, store } = tempStore(t);
  await store.ensureCliCredential();
  const stateFile = path.join(root, 'state.json');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  state.redlines = { rl_corrupt: { id: 'rl_corrupt', comment: { secret: 'must remain' } } };
  const corrupt = `${JSON.stringify(state, null, 2)}\n`;
  fs.writeFileSync(stateFile, corrupt, { mode: 0o600 });

  await assert.rejects(new StateStore(root).initialize(), /invalid redline state/i);
  assert.equal(fs.readFileSync(stateFile, 'utf8'), corrupt);
});

test('canonical hashing ignores object key order but binds meaningful array and content differences', async (t) => {
  const { store } = tempStore(t);
  const client = await pairedClient(store);
  const first = await store.submitRedline(client.clientId, submission({
    context: { nested: { b: 2, a: 1 }, labels: ['one', 'two'] },
  }));
  assert.deepEqual(await store.submitRedline(client.clientId, submission({
    context: { labels: ['one', 'two'], nested: { a: 1, b: 2 } },
  })), first);
  await assert.rejects(store.submitRedline(client.clientId, submission({
    context: { labels: ['two', 'one'], nested: { a: 1, b: 2 } },
  })), (error) => error.code === 'operation_conflict');
});

test('operation IDs are scoped to a browser client', async (t) => {
  const { store } = tempStore(t);
  const firstClient = await pairedClient(store);
  const secondClient = await pairedClient(store);
  const first = await store.submitRedline(firstClient.clientId, submission());
  const second = await store.submitRedline(secondClient.clientId, submission());
  assert.notEqual(first.id, second.id);
  assert.equal((await store.listRedlines()).length, 2);
});

test('cross-process submissions with the same client operation create exactly one redline', async (t) => {
  const { root, store } = tempStore(t);
  const client = await pairedClient(store);
  const modulePath = path.resolve(__dirname, '../runtime/lib/state-store.js');
  const input = submission({ screenshot_png: undefined });
  const code = `
    const { StateStore } = require(${JSON.stringify(modulePath)});
    new StateStore(process.argv[1]).submitRedline(process.argv[2], JSON.parse(process.argv[3]))
      .then(item => process.stdout.write(item.id), error => { console.error(error); process.exit(1); });
  `;
  const submit = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', code, root, client.clientId, JSON.stringify(input)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (status) => status === 0 ? resolve(stdout) : reject(new Error(stderr)));
  });

  const results = await Promise.all([submit(), submit(), submit()]);
  assert.equal(new Set(results).size, 1);
  assert.equal((await store.listRedlines()).length, 1);
});

test('invalid fields and PNGs are rejected before any screenshot or intent is staged', async (t) => {
  const { root, store } = tempStore(t);
  const client = await pairedClient(store);
  const invalid = [
    [submission({ operation_id: '../escape' }), 'invalid_submission'],
    [submission({ clear_generation: '0' }), 'invalid_submission'],
    [submission({ comment: 'x'.repeat(128 * 1024 + 1) }), 'payload_too_large'],
    [submission({ context: [] }), 'invalid_submission'],
    [submission({ screenshot_png: Buffer.from('not png').toString('base64') }), 'invalid_submission'],
  ];
  for (const [input, code] of invalid) {
    await assert.rejects(async () => store.submitRedline(client.clientId, input),
      (error) => error.code === code);
  }
  for (const name of ['staging', 'screenshots']) {
    const directory = path.join(root, name);
    assert.equal(!fs.existsSync(directory) || fs.readdirSync(directory).length === 0, true, name);
  }
  assert.equal(fs.existsSync(path.join(root, 'transaction-intent.json')), false);
});

test('canonical payloads recursively reject every non-JSON value', async (t) => {
  const { store } = tempStore(t);
  const client = await pairedClient(store);
  const sparse = [];
  sparse.length = 1;
  const cyclic = {};
  cyclic.self = cyclic;
  const symbolKeyed = {};
  symbolKeyed[Symbol('not-json')] = 'hidden';
  const invalidValues = [
    Infinity,
    -Infinity,
    NaN,
    undefined,
    () => {},
    Symbol('not-json'),
    symbolKeyed,
    1n,
    sparse,
    new Date('2026-08-07T00:00:00.000Z'),
    new Map([['key', 'value']]),
    cyclic,
  ];

  for (let index = 0; index < invalidValues.length; index += 1) {
    await assert.rejects(
      store.submitRedline(client.clientId, submission({
        operation_id: `op_non_json_${String(index).padStart(2, '0')}`,
        context: { value: invalidValues[index] },
      })),
      (error) => error.code === 'invalid_submission',
      `invalid value ${index}`,
    );
  }
});

test('null and infinity cannot collapse to the same idempotency payload', async (t) => {
  const { store } = tempStore(t);
  const client = await pairedClient(store);
  const input = submission({ context: { value: null } });
  await store.submitRedline(client.clientId, input);

  await assert.rejects(
    store.submitRedline(client.clientId, submission({ context: { value: Infinity } })),
    (error) => error.code === 'invalid_submission',
  );
});

test('linked content and corrupt intents fail closed without touching external evidence', async (t) => {
  for (const kind of ['staging-symlink', 'screenshot-hardlink', 'transaction-intent', 'clear-intent']) {
    const { root, store } = tempStore(t);
    await store.initialize();
    const outside = path.join(root, 'outside-evidence');
    fs.writeFileSync(outside, 'keep', { mode: 0o600 });
    let evidence;
    if (kind === 'staging-symlink') {
      evidence = path.join(root, 'staging', 'evil.png');
      fs.symlinkSync(outside, evidence);
    } else if (kind === 'screenshot-hardlink') {
      evidence = path.join(root, 'screenshots', 'ss_evil.png');
      fs.linkSync(outside, evidence);
    } else {
      evidence = path.join(root, kind === 'transaction-intent' ? 'transaction-intent.json' : 'clear-intent.json');
      fs.writeFileSync(evidence, '{"path":"../../outside-evidence"}\n', { mode: 0o600 });
    }

    await assert.rejects(new StateStore(root).initialize(), /(?:symlink|multiple links|intent.*invalid schema)/i, kind);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'keep', kind);
    assert.equal(fs.existsSync(evidence), true, kind);
  }
});

test('rename-boundary link swaps cannot chmod an external inode', async (t) => {
  const png = VALID_PNG;
  for (const kind of ['state', 'screenshot']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `redline-rename-${kind}-`));
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-outside-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    t.after(() => fs.rmSync(outsideRoot, { recursive: true, force: true }));
    const outside = path.join(outsideRoot, 'evidence');
    fs.writeFileSync(outside, kind === 'state' ? 'not json' : png, { mode: 0o644 });
    const originalMode = fs.statSync(outside).mode & 0o777;
    const store = new StateStore(root);
    let client;
    if (kind === 'screenshot') client = await pairedClient(store);

    const originalRename = fs.renameSync;
    fs.renameSync = (source, destination) => {
      const target = kind === 'state'
        ? destination === path.join(root, 'state.json')
        : path.dirname(destination) === path.join(root, 'screenshots');
      if (target) {
        fs.unlinkSync(source);
        fs.linkSync(outside, source);
      }
      return originalRename(source, destination);
    };
    try {
      if (kind === 'state') {
        await assert.rejects(store.initialize(), /multiple links/i);
      } else {
        await assert.rejects(store.submitRedline(client.clientId, submission({
          screenshot_png: png.toString('base64'),
        })), /multiple links/i);
      }
    } finally {
      fs.renameSync = originalRename;
    }
    assert.equal(fs.statSync(outside).mode & 0o777, originalMode, kind);
  }
});
