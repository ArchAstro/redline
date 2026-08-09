'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const CONNECTION_PATH = path.join(__dirname, '../extension/connection.js');
const CONNECT_PATH = path.join(__dirname, '../extension/connect.js');
const BACKGROUND_PATH = path.join(__dirname, '../extension/background.js');

function health(overrides = {}) {
  return {
    product: 'redline',
    package_version: '0.2.6',
    protocol: { major: 1, minor: 0 },
    capabilities: ['pairing-v1', 'idempotent-redlines-v1'],
    pairing: { available: false },
    ...overrides,
  };
}

function response(body, { ok = true, status = 200 } = {}) {
  const text = body === null ? '' : JSON.stringify(body);
  return {
    ok,
    status,
    headers: { get(name) { return name.toLowerCase() === 'content-length' ? String(text.length) : null; } },
    async text() { return text; },
    async json() { return body; },
  };
}

function memoryStorage(initial = {}) {
  const data = structuredClone(initial);
  const writes = [];
  return {
    data,
    writes,
    async get(keys) {
      if (keys === null) return structuredClone(data);
      const names = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(names.filter((name) => Object.hasOwn(data, name))
        .map((name) => [name, structuredClone(data[name])]));
    },
    async set(value) { writes.push(['set', structuredClone(value)]); Object.assign(data, structuredClone(value)); },
    async remove(keys) {
      writes.push(['remove', structuredClone(keys)]);
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    },
  };
}

test('missing helper returns the exact recoverable setup command without changing storage', async () => {
  assert.equal(fs.existsSync(CONNECTION_PATH), true, 'connection module must exist');
  const { SETUP_COMMAND, createConnectionClient } = require(CONNECTION_PATH);
  const writes = [];
  const client = createConnectionClient({
    fetch: async () => { throw new TypeError('fetch failed'); },
    storage: {
      async get() { return {}; },
      async set(value) { writes.push(value); },
      async remove(value) { writes.push(value); },
    },
  });

  assert.deepEqual(await client.probeHealth(), {
    status: 'missing_helper',
    recoverable: true,
    command: SETUP_COMMAND,
    message: 'Redline helper was not found on 127.0.0.1:7878.',
  });
  assert.equal(SETUP_COMMAND, 'npx --yes @archastro/redline setup');
  assert.deepEqual(writes, []);
});

test('active pairing window reports consent required without pairing or persistence', async () => {
  const { createConnectionClient } = require(CONNECTION_PATH);
  const expiry = '2026-08-07T19:10:00.000Z';
  const storage = memoryStorage();
  const requests = [];
  const client = createConnectionClient({
    now: () => Date.parse('2026-08-07T19:00:00.000Z'),
    storage,
    fetch: async (url, options) => {
      requests.push([url, options]);
      return response(health({ pairing: { available: true, expires_at: expiry } }));
    },
  });

  assert.deepEqual(await client.probeHealth(), {
    status: 'consent_required',
    pairingExpiresAt: expiry,
    packageVersion: '0.2.6',
    protocol: { major: 1, minor: 0 },
  });
  assert.equal(requests[0][1].signal instanceof AbortSignal, true);
  delete requests[0][1].signal;
  assert.deepEqual(requests, [[
    'http://127.0.0.1:7878/health',
    { method: 'GET', cache: 'no-store' },
  ]]);
  assert.deepEqual(storage.writes, []);
});

test('expired pairing window stops pairing and returns repair guidance', async () => {
  const { SETUP_COMMAND, createConnectionClient } = require(CONNECTION_PATH);
  const storage = memoryStorage({ redline_draft_existing: { comment: 'keep me' } });
  const client = createConnectionClient({
    now: () => Date.parse('2026-08-07T19:10:00.000Z'),
    storage,
    fetch: async () => response(health({
      pairing: { available: true, expires_at: '2026-08-07T19:10:00.000Z' },
    })),
  });

  assert.deepEqual(await client.probeHealth(), {
    status: 'pairing_expired',
    recoverable: true,
    command: SETUP_COMMAND,
    message: 'The Redline connection window expired. Run setup again.',
  });
  assert.deepEqual(storage.data.redline_draft_existing, { comment: 'keep me' });
  assert.deepEqual(storage.writes, []);
});

test('malformed health is rejected as an invalid helper without clearing drafts', async () => {
  const { SETUP_COMMAND, createConnectionClient } = require(CONNECTION_PATH);
  const storage = memoryStorage({ redline_draft_existing: { comment: 'still here' } });
  const client = createConnectionClient({
    storage,
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: { get() { return '7'; } },
      async text() { return '{broken'; },
    }),
  });

  assert.deepEqual(await client.probeHealth(), {
    status: 'invalid_helper',
    recoverable: true,
    command: SETUP_COMMAND,
    message: 'Port 7878 did not return a valid Redline helper response.',
  });
  assert.deepEqual(storage.data.redline_draft_existing, { comment: 'still here' });
  assert.deepEqual(storage.writes, []);
});

test('health rejects malformed semantic versions, negative protocol versions, and non-string capabilities', async () => {
  const { createConnectionClient } = require(CONNECTION_PATH);
  for (const payload of [
    health({ package_version: 'latest' }),
    health({ protocol: { major: 1, minor: -1 } }),
    health({ capabilities: ['pairing-v1', { name: 'idempotent-redlines-v1' }] }),
  ]) {
    const client = createConnectionClient({ storage: memoryStorage(), fetch: async () => response(payload) });
    assert.equal((await client.probeHealth()).status, 'invalid_helper');
  }
});

test('helper responses larger than the fixed parser bound are rejected', async () => {
  const { createConnectionClient } = require(CONNECTION_PATH);
  const client = createConnectionClient({
    storage: memoryStorage(),
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: { get() { return String(70 * 1024); } },
      async text() { throw new Error('oversized body must not be read'); },
    }),
  });
  assert.equal((await client.probeHealth()).status, 'invalid_helper');
});

test('protocol major mismatch fails closed with extension update guidance', async () => {
  const { createConnectionClient } = require(CONNECTION_PATH);
  const storage = memoryStorage();
  const client = createConnectionClient({
    now: () => Date.parse('2026-08-07T19:00:00.000Z'),
    storage,
    fetch: async () => response(health({
      protocol: { major: 2, minor: 0 },
      pairing: { available: true, expires_at: '2026-08-07T19:10:00.000Z' },
    })),
  });

  assert.deepEqual(await client.probeHealth(), {
    status: 'extension_update_required',
    recoverable: true,
    message: 'This Redline helper requires a newer Redline extension. Update Redline in Chrome.',
  });
  assert.deepEqual(storage.writes, []);
});

test('valid helper without a pairing window requests the exact setup command', async () => {
  const { SETUP_COMMAND, createConnectionClient } = require(CONNECTION_PATH);
  const storage = memoryStorage();
  const client = createConnectionClient({
    storage,
    fetch: async () => response(health()),
  });

  assert.deepEqual(await client.probeHealth(), {
    status: 'setup_required',
    recoverable: true,
    command: SETUP_COMMAND,
    message: 'Run setup to open a local Redline connection window.',
  });
  assert.deepEqual(storage.writes, []);
});

test('affirmative consent pairs once and stores only approved connection metadata', async () => {
  const { createConnectionClient } = require(CONNECTION_PATH);
  const now = '2026-08-07T19:00:00.000Z';
  const expiry = '2026-08-07T19:10:00.000Z';
  const secret = 's'.repeat(43);
  const storage = memoryStorage({ redline_draft_existing: { comment: 'preserve' } });
  const requests = [];
  const client = createConnectionClient({
    now: () => Date.parse(now),
    storage,
    fetch: async (url, options) => {
      requests.push([url, options]);
      if (url.endsWith('/health')) {
        return response(health({ pairing: { available: true, expires_at: expiry } }));
      }
      return response({
        client_id: 'rlc_0123456789abcdef0123456789abcdef',
        token: 't'.repeat(43),
        clear_generation: 4,
        consent_version: 1,
      }, { status: 201 });
    },
  });

  const paired = await client.pair(secret, { consent: true });
  const expectedConnection = {
    port: 7878,
    client_id: 'rlc_0123456789abcdef0123456789abcdef',
    token: 't'.repeat(43),
    clear_generation: 4,
    consent_version: 1,
    protocol: { major: 1, minor: 0, helper_version: '0.2.6' },
    setup: { consent: 'accepted', consented_at: now },
  };
  assert.deepEqual(paired, { status: 'paired', connection: expectedConnection });
  assert.deepEqual(storage.data.redline_connection, expectedConnection);
  assert.deepEqual(storage.data.redline_draft_existing, { comment: 'preserve' });
  assert.equal(requests[1][1].signal instanceof AbortSignal, true);
  delete requests[1][1].signal;
  assert.deepEqual(requests[1], [
    'http://127.0.0.1:7878/pair',
    {
      method: 'POST',
      cache: 'no-store',
      headers: { 'content-type': 'application/json', 'x-redline-protocol': '1' },
      body: JSON.stringify({ secret, consent_version: 1 }),
    },
  ]);
});

test('credential persistence failure revokes the minted capability and preserves existing drafts', async () => {
  const { SETUP_COMMAND, createConnectionClient } = require(CONNECTION_PATH);
  const now = '2026-08-07T19:00:00.000Z';
  const expiry = '2026-08-07T19:10:00.000Z';
  const storage = memoryStorage({ redline_draft_existing: { comment: 'preserve' } });
  storage.set = async () => { throw new Error('storage unavailable'); };
  const client = createConnectionClient({
    now: () => Date.parse(now),
    storage,
    fetch: async (url, options) => {
      if (url.endsWith('/health')) return response(health({ pairing: { available: true, expires_at: expiry } }));
      if (url.endsWith('/clients/current')) {
        assert.equal(options.method, 'DELETE');
        assert.equal(options.headers.authorization, `Bearer ${'t'.repeat(43)}`);
        return response(null, { status: 204 });
      }
      return response({
          client_id: 'rlc_0123456789abcdef0123456789abcdef',
          token: 't'.repeat(43),
          clear_generation: 4,
          consent_version: 1,
        }, { status: 201 });
    },
  });

  assert.deepEqual(await client.pair('s'.repeat(43), { consent: true }), {
    status: 'pairing_failed',
    recoverable: true,
    command: SETUP_COMMAND,
    message: 'Redline connected but could not save this browser credential. Run setup again.',
  });
  assert.deepEqual(storage.data, { redline_draft_existing: { comment: 'preserve' } });
});

test('failed cleanup after persistence failure is explicit and retains a durable revocation handle', async () => {
  const { createConnectionClient } = require(CONNECTION_PATH);
  const storage = memoryStorage();
  const cleanupStorage = memoryStorage();
  storage.set = async () => { throw new Error('storage unavailable'); };
  const client = createConnectionClient({
    now: () => Date.parse('2026-08-07T19:00:00.000Z'),
    storage,
    cleanupStorage,
    fetch: async (url) => {
      if (url.endsWith('/health')) return response(health({
        pairing: { available: true, expires_at: '2026-08-07T19:10:00.000Z' },
      }));
      if (url.endsWith('/clients/current')) throw new TypeError('helper stopped');
      return response({
        client_id: 'rlc_0123456789abcdef0123456789abcdef',
        token: 't'.repeat(43),
        clear_generation: 4,
        consent_version: 1,
      }, { status: 201 });
    },
  });

  const result = await client.pair('s'.repeat(43), { consent: true });
  assert.equal(result.status, 'pairing_cleanup_required');
  assert.equal(result.recoverable, false);
  assert.equal(Object.values(cleanupStorage.data)[0].token, 't'.repeat(43));
  assert.equal(await client.revokePending(), false);
});

test('failed cleanup survives the onboarding page and a new client retries the revocation', async () => {
  const { createConnectionClient } = require(CONNECTION_PATH);
  const storage = memoryStorage();
  const cleanupStorage = memoryStorage();
  storage.set = async () => { throw new Error('storage unavailable'); };
  let helperAvailable = false;
  const fetch = async (url) => {
    if (url.endsWith('/health')) return response(health({
      pairing: { available: true, expires_at: '2026-08-07T19:10:00.000Z' },
    }));
    if (url.endsWith('/clients/current')) {
      if (!helperAvailable) throw new TypeError('helper stopped');
      return response(null, { status: 204 });
    }
    return response({
      client_id: 'rlc_0123456789abcdef0123456789abcdef',
      token: 't'.repeat(43),
      clear_generation: 4,
      consent_version: 1,
    }, { status: 201 });
  };
  const first = createConnectionClient({
    now: () => Date.parse('2026-08-07T19:00:00.000Z'),
    storage,
    cleanupStorage,
    fetch,
  });

  assert.equal((await first.pair('s'.repeat(43), { consent: true })).status,
    'pairing_cleanup_required');
  assert.equal(Object.values(cleanupStorage.data)[0].token, 't'.repeat(43));

  helperAvailable = true;
  const reopened = createConnectionClient({ storage, cleanupStorage, fetch });
  assert.equal(await reopened.revokePending(), true);
  assert.deepEqual(cleanupStorage.data, {});
});

test('pairing fails closed when a minted credential cannot be durably queued for cleanup', async () => {
  const { createConnectionClient } = require(CONNECTION_PATH);
  const storage = memoryStorage();
  const cleanupStorage = memoryStorage();
  storage.set = async () => { throw new Error('connection storage unavailable'); };
  cleanupStorage.set = async () => { throw new Error('cleanup storage unavailable'); };
  let revocations = 0;
  const client = createConnectionClient({
    now: () => Date.parse('2026-08-07T19:00:00.000Z'),
    storage,
    cleanupStorage,
    fetch: async (url) => {
      if (url.endsWith('/health')) return response(health({
        pairing: { available: true, expires_at: '2026-08-07T19:10:00.000Z' },
      }));
      if (url.endsWith('/clients/current')) {
        revocations += 1;
        throw new TypeError('helper stopped');
      }
      return response({
        client_id: 'rlc_0123456789abcdef0123456789abcdef',
        token: 't'.repeat(43),
        clear_generation: 4,
        consent_version: 1,
      }, { status: 201 });
    },
  });

  const result = await client.pair('s'.repeat(43), { consent: true });

  assert.equal(result.status, 'pairing_cleanup_persistence_failed');
  assert.equal(result.recoverable, false);
  assert.equal(revocations, 1);
  assert.deepEqual(cleanupStorage.data, {});
});

test('malformed successful pairing response revokes a minted credential before failing', async () => {
  const { SETUP_COMMAND, createConnectionClient } = require(CONNECTION_PATH);
  const storage = memoryStorage();
  const cleanupStorage = memoryStorage();
  const requests = [];
  const client = createConnectionClient({
    now: () => Date.parse('2026-08-07T19:00:00.000Z'),
    storage,
    cleanupStorage,
    fetch: async (url, options) => {
      requests.push([url, options]);
      if (url.endsWith('/health')) return response(health({
        pairing: { available: true, expires_at: '2026-08-07T19:10:00.000Z' },
      }));
      if (url.endsWith('/clients/current')) return response(null, { status: 204 });
      return response({
        client_id: 'rlc_0123456789abcdef0123456789abcdef',
        token: 't'.repeat(43),
        clear_generation: 4,
        consent_version: 1,
        unexpected: true,
      }, { status: 201 });
    },
  });

  assert.deepEqual(await client.pair('s'.repeat(43), { consent: true }), {
    status: 'pairing_failed', recoverable: true, command: SETUP_COMMAND,
  });
  assert.equal(requests.filter(([url]) => url.endsWith('/clients/current')).length, 1);
  assert.deepEqual(storage.data, {});
  assert.deepEqual(cleanupStorage.data, {});
});

test('pairing expiry after consent returns typed repair state without credential writes', async () => {
  const { SETUP_COMMAND, createConnectionClient } = require(CONNECTION_PATH);
  const storage = memoryStorage();
  let request = 0;
  const client = createConnectionClient({
    now: () => Date.parse('2026-08-07T19:00:00.000Z'),
    storage,
    fetch: async () => {
      request += 1;
      if (request === 1) {
        return response(health({
          pairing: { available: true, expires_at: '2026-08-07T19:10:00.000Z' },
        }));
      }
      return response({ error: { code: 'invalid_pairing_secret' } }, { ok: false, status: 401 });
    },
  });

  assert.deepEqual(await client.pair('s'.repeat(43), { consent: true }), {
    status: 'pairing_expired',
    recoverable: true,
    command: SETUP_COMMAND,
    message: 'The Redline connection window expired or was already used. Run setup again.',
  });
  assert.deepEqual(storage.writes, []);
});

test('pairing network failure after consent returns recoverable repair copy', async () => {
  const { SETUP_COMMAND, createConnectionClient } = require(CONNECTION_PATH);
  let request = 0;
  const storage = memoryStorage();
  const client = createConnectionClient({
    now: () => Date.parse('2026-08-07T19:00:00.000Z'),
    storage,
    fetch: async () => {
      request += 1;
      if (request === 1) {
        return response(health({
          pairing: { available: true, expires_at: '2026-08-07T19:10:00.000Z' },
        }));
      }
      throw new TypeError('helper stopped');
    },
  });

  assert.deepEqual(await client.pair('s'.repeat(43), { consent: true }), {
    status: 'pairing_failed',
    recoverable: true,
    command: SETUP_COMMAND,
    message: 'Redline could not reach the local helper while pairing.',
  });
  assert.deepEqual(storage.writes, []);
});

test('stale profile token returns repair guidance and preserves credentials and drafts', async () => {
  const { SETUP_COMMAND, createConnectionClient } = require(CONNECTION_PATH);
  const connection = {
    port: 7878,
    client_id: 'rlc_0123456789abcdef0123456789abcdef',
    token: 't'.repeat(43),
    clear_generation: 4,
    consent_version: 1,
    protocol: { major: 1, minor: 0, helper_version: '0.2.6' },
    setup: { consent: 'accepted', consented_at: '2026-08-07T19:00:00.000Z' },
  };
  const storage = memoryStorage({
    redline_connection: connection,
    redline_draft_existing: { comment: 'do not discard' },
  });
  const requests = [];
  const client = createConnectionClient({
    storage,
    fetch: async (url, options) => {
      requests.push([url, options]);
      return response({ error: { code: 'unauthorized' } }, { ok: false, status: 401 });
    },
  });

  assert.deepEqual(await client.checkConnection(), {
    status: 'stale_token',
    recoverable: true,
    command: SETUP_COMMAND,
    message: 'This browser connection is stale. Run setup again to reconnect.',
  });
  assert.equal(requests[0][1].signal instanceof AbortSignal, true);
  delete requests[0][1].signal;
  assert.deepEqual(requests, [[
    'http://127.0.0.1:7878/generation',
    { method: 'GET', cache: 'no-store', headers: { authorization: `Bearer ${connection.token}` } },
  ]]);
  assert.deepEqual(storage.data.redline_connection, connection);
  assert.deepEqual(storage.data.redline_draft_existing, { comment: 'do not discard' });
  assert.deepEqual(storage.writes, []);
});

test('packaged fragment reader clears the exact top-frame connect URL before one message', () => {
  assert.equal(fs.existsSync(CONNECT_PATH), true, 'packaged fragment reader must exist');
  const events = [];
  const window = {};
  window.top = window;
  const context = {
    URL,
    URLSearchParams,
    window,
    location: { href: `http://127.0.0.1:7878/connect#pair=${'s'.repeat(43)}&expires_at=2026-08-07T19%3A10%3A00.000Z` },
    history: {
      replaceState(state, title, url) { events.push(['replace', state, title, url]); },
    },
    chrome: {
      runtime: {
        sendMessage(message) { events.push(['message', structuredClone(message)]); },
      },
    },
  };

  const source = fs.readFileSync(CONNECT_PATH, 'utf8');
  vm.runInNewContext(source, context);
  vm.runInNewContext(source, context);

  assert.deepEqual(events, [
    ['replace', null, '', 'http://127.0.0.1:7878/connect'],
    ['message', {
      type: 'redline-stage-pairing-secret',
      source: 'redline-connect-v1',
      secret: 's'.repeat(43),
      expires_at: '2026-08-07T19:10:00.000Z',
    }],
  ]);
});

test('packaged fragment reader rejects nonliteral pairing fragment spellings', () => {
  const source = fs.readFileSync(CONNECT_PATH, 'utf8');
  for (const hash of [
    `#pair=${'%73'.repeat(43)}`,
    `#pair=${'s'.repeat(43)}&`,
    `#pair=${'s'.repeat(43)}&other=1`,
  ]) {
    const events = [];
    const window = {};
    window.top = window;
    vm.runInNewContext(source, {
      URL,
      URLSearchParams,
      window,
      location: { href: `http://127.0.0.1:7878/connect${hash}` },
      history: { replaceState() { events.push('replace'); } },
      chrome: { runtime: { sendMessage() { events.push('message'); } } },
    });
    assert.deepEqual(events, [], hash);
  }
});

function fragmentBackground(localInitial = {}, devConfig, { failInjection = false, omitAccessApis = false } = {}) {
  const session = memoryStorage();
  const local = memoryStorage(localInitial);
  const storageAccess = [];
  if (!omitAccessApis) {
    local.setAccessLevel = async (details) => storageAccess.push(['local', structuredClone(details)]);
    session.setAccessLevel = async (details) => storageAccess.push(['session', structuredClone(details)]);
  }
  let messageHandler;
  let installedHandler;
  let alarmHandler;
  const installEvents = [];
  const alarms = [];
  const runtimeId = 'hfjngaflcmkocibdgpeanmhjlkofibca';
  const context = {
    AbortController,
    URL,
    URLSearchParams,
    TextEncoder,
    atob,
    console,
    crypto: require('node:crypto').webcrypto,
    fetch: async () => { throw new Error('unexpected fetch'); },
    setTimeout,
    clearTimeout,
    REDLINE_CONFIG: devConfig,
    importScripts() {},
    chrome: {
      storage: { local, session },
      alarms: {
        async create(name, details) { alarms.push(['create', name, structuredClone(details)]); },
        async get() { return undefined; },
        async clear(name) { alarms.push(['clear', name]); return true; },
        onAlarm: { addListener(handler) { alarmHandler = handler; } },
      },
      tabs: {
        async query(query) {
          installEvents.push(['query', structuredClone(query)]);
          return [{
            id: 17,
            url: `http://127.0.0.1:7878/connect#pair=${'s'.repeat(43)}&expires_at=2026-08-07T19%3A10%3A00.000Z`,
          }];
        },
        async create(details) { installEvents.push(['create', structuredClone(details)]); },
        onUpdated: { addListener() {} },
        onRemoved: { addListener() {} },
      },
      scripting: {
        async executeScript(details) {
          installEvents.push(['execute', structuredClone(details)]);
          if (failInjection) throw new Error('tab closed');
        },
      },
      runtime: {
        id: runtimeId,
        getURL(pathname) { return `chrome-extension://${runtimeId}/${pathname}`; },
        onMessage: { addListener(handler) { messageHandler = handler; } },
        onInstalled: { addListener(handler) { installedHandler = handler; } },
      },
    },
  };
  context.RedlineRevocations = require('../extension/revocations');
  vm.runInNewContext(fs.readFileSync(BACKGROUND_PATH, 'utf8'), context);
  return {
    session,
    local,
    storageAccess,
    runtimeId,
    installEvents,
    alarms,
    async install(details = { reason: 'install' }) {
      assert.equal(typeof installedHandler, 'function', 'installation handler must be registered');
      await installedHandler(details);
    },
    send(message, sender) {
      return new Promise((resolve) => messageHandler(message, sender,
        (value) => resolve(structuredClone(value))));
    },
    async fireAlarm(name) {
      assert.equal(typeof alarmHandler, 'function');
      await alarmHandler({ name });
    },
  };
}

test('background restricts connection and pairing storage to trusted extension contexts', async () => {
  const background = fragmentBackground();
  await Promise.resolve();

  assert.deepEqual(background.storageAccess, [
    ['local', { accessLevel: 'TRUSTED_CONTEXTS' }],
    ['session', { accessLevel: 'TRUSTED_CONTEXTS' }],
  ]);
});

test('background fails closed when trusted-context storage APIs are unavailable', async () => {
  const background = fragmentBackground({}, undefined, { omitAccessApis: true });
  const secret = 's'.repeat(43);

  assert.deepEqual(await background.send({
    type: 'redline-stage-pairing-secret', source: 'redline-connect-v1', secret,
  }, {
    id: background.runtimeId,
    frameId: 0,
    url: 'http://127.0.0.1:7878/connect',
    tab: { id: 17, url: 'http://127.0.0.1:7878/connect' },
  }), {
    ok: false,
    error_code: 'storage_access_failed',
    error: 'Redline could not protect its local browser credentials. Reload the extension and retry.',
  });
  assert.deepEqual(background.session.data, {});
});

test('background stages a fragment secret only from the exact packaged top-frame sender', async () => {
  const background = fragmentBackground();
  const secret = 's'.repeat(43);
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const message = {
    type: 'redline-stage-pairing-secret', source: 'redline-connect-v1', secret, expires_at: expiresAt,
  };
  const sender = {
    id: background.runtimeId,
    frameId: 0,
    url: 'http://127.0.0.1:7878/connect',
    tab: { id: 17, url: 'http://127.0.0.1:7878/connect' },
  };

  assert.deepEqual(await background.send(message, sender), { ok: true, status: 'staged' });
  assert.equal(background.session.data.redline_pairing_secret.secret, secret);
  assert.equal(background.session.data.redline_pairing_secret.expires_at, expiresAt);
  assert.deepEqual(background.alarms.at(-1), [
    'create', 'redline-pairing-secret-expiry',
    { when: Date.parse(background.session.data.redline_pairing_secret.expires_at) },
  ]);

  const rejected = [
    [{ ...message, source: 'page-script' }, sender],
    [message, { ...sender, id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }],
    [message, { ...sender, frameId: 1 }],
    [message, { ...sender, url: 'http://127.0.0.1:7878/connect/other' }],
    [message, { ...sender, tab: { id: 18, url: 'https://example.test/' } }],
  ];
  for (const [candidateMessage, candidateSender] of rejected) {
    assert.deepEqual(await background.send(candidateMessage, candidateSender), {
      ok: false,
      error_code: 'invalid_connect_sender',
      error: 'Pairing secret sender was rejected.',
    });
  }
  assert.equal(background.session.data.redline_pairing_secret.secret, secret);
});

test('service-worker alarm removes an expired pairing secret after onboarding closes', async () => {
  const background = fragmentBackground();
  background.session.data.redline_pairing_secret = {
    secret: 's'.repeat(43),
    expires_at: '2020-01-01T00:00:00.000Z',
  };

  await background.fireAlarm('redline-pairing-secret-expiry');

  assert.deepEqual(background.session.data, {});
});

test('installation injects only the packaged fragment reader into exact open connect tabs', async () => {
  const background = fragmentBackground();

  await background.install();

  assert.deepEqual(background.installEvents, [
    ['query', { url: 'http://127.0.0.1:7878/connect' }],
    ['execute', {
      target: { tabId: 17, frameIds: [0] },
      files: ['connect.js'],
    }],
    ['create', {
      url: `chrome-extension://${background.runtimeId}/onboarding.html`,
      active: true,
    }],
  ]);
});

test('a closed connect tab cannot prevent the install onboarding page from opening', async () => {
  const background = fragmentBackground({}, undefined, { failInjection: true });

  await background.install();

  assert.deepEqual(background.installEvents.at(-1), ['create', {
    url: `chrome-extension://${background.runtimeId}/onboarding.html`,
    active: true,
  }]);
});

test('custom-port contributor install does not run Store onboarding or fragment recovery', async () => {
  const background = fragmentBackground({}, { port: 61234, token: 'dev-token' });

  await background.install();

  assert.deepEqual(background.installEvents, []);
});

test('production content handling rejects a stored profile credential without accepted consent', async () => {
  const background = fragmentBackground({
    redline_connection: {
      port: 7878,
      client_id: 'rlc_0123456789abcdef0123456789abcdef',
      token: 't'.repeat(43),
      clear_generation: 0,
      protocol: { major: 1, minor: 0, helper_version: '0.2.6' },
    },
  });

  assert.deepEqual(await background.send({
    type: 'submit-redline',
    payload: { comment: 'must remain blocked' },
  }, { tab: { id: 17 } }), {
    ok: false,
    error_code: 'connection_required',
    error: 'Redline needs to be connected again before submitting.',
  });
  assert.equal(Object.keys(background.local.data).some((key) => /pending|draft/.test(key)), false);
});
