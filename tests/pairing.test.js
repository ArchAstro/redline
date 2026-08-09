'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { StateStore } = require('../runtime/lib/state-store');

const ROOT = path.resolve(__dirname, '..');
const EXTENSION_ID = 'hfjngaflcmkocibdgpeanmhjlkofibca';
const ORIGIN = `chrome-extension://${EXTENSION_ID}`;
const INSTANCE_ID = 'rli_0123456789abcdef0123456789abcdef';
const LAUNCH_ID = 'rll_fedcba9876543210fedcba9876543210';
const STORE_IDENTITY = require('../config/extension-identity.json');
const STORE_ID = STORE_IDENTITY.extension_id;

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

function launchArguments(dir) {
  const stat = fs.lstatSync(dir, { bigint: true });
  return [`--redline-launch-id=${LAUNCH_ID}`, `--redline-dir-device=${stat.dev}`, `--redline-dir-inode=${stat.ino}`];
}

function call(port, method, pathname, options = {}) {
  const payload = options.rawBody !== undefined
    ? Buffer.from(options.rawBody)
    : options.body === undefined ? null : Buffer.from(JSON.stringify(options.body));
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, method, path: pathname,
      headers: {
        host: options.host || `127.0.0.1:${port}`,
        ...(options.origin === undefined ? {} : { origin: options.origin }),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(options.redlineHeader === undefined ? {} : { 'x-redline-protocol': options.redlineHeader }),
        ...(payload ? {
          'content-type': options.contentType || 'application/json',
          'content-length': payload.length,
        } : {}),
        ...(options.headers || {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (payload) req.end(payload); else req.end();
  });
}

function rawCall(port, request) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let response = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.end(request));
    socket.on('data', (chunk) => { response += chunk; });
    socket.on('end', () => {
      const status = Number(/^HTTP\/1\.1 (\d{3})/m.exec(response)?.[1]);
      resolve({ status, response });
    });
    socket.on('error', reject);
  });
}

function stalledCall(port, request) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let response = '';
    const timeout = setTimeout(() => { socket.destroy(); reject(new Error('stalled request did not reach its deadline')); }, 4500);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(request));
    socket.on('data', (chunk) => {
      response += chunk;
      if (response.includes('request_timeout')) {
        clearTimeout(timeout);
        socket.destroy();
        resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/m.exec(response)?.[1]), response });
      }
    });
    socket.on('error', (error) => { clearTimeout(timeout); reject(error); });
  });
}

async function start(t) {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-pair-http-'));
  const store = new StateStore(dir);
  const cliToken = await store.ensureCliCredential();
  const child = spawn(process.execPath, ['runtime/server.js', ...launchArguments(dir)], {
    cwd: ROOT,
    env: {
      ...process.env, REDLINE_DIR: dir, REDLINE_PORT: String(port), REDLINE_DEV_MODE: '1',
      REDLINE_EXTENSION_ID: EXTENSION_ID, REDLINE_INSTANCE_ID: INSTANCE_ID, REDLINE_LAUNCH_ID: LAUNCH_ID,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  t.after(() => { child.kill(); fs.rmSync(dir, { recursive: true, force: true }); });
  for (let i = 0; i < 100; i += 1) {
    try { if ((await call(port, 'GET', '/health')).status === 200) return { port, dir, store, cliToken }; } catch {}
    if (child.exitCode !== null) throw new Error(`sidecar exited: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`sidecar failed to start: ${stderr}`);
}

async function startStoreMode(t) {
  const listenPort = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-store-http-'));
  const identityPath = path.join(dir, 'extension-identity.json');
  fs.writeFileSync(identityPath, JSON.stringify(STORE_IDENTITY), { mode: 0o600 });
  const store = new StateStore(dir);
  const cliToken = await store.ensureCliCredential();
  const child = spawn(process.execPath, ['runtime/server.js', ...launchArguments(dir)], {
    cwd: ROOT,
    env: {
      ...process.env, REDLINE_DIR: dir, REDLINE_PORT: '7878', REDLINE_LISTEN_PORT: String(listenPort),
      REDLINE_TEST_MODE: '1', REDLINE_IDENTITY_PATH: identityPath,
      REDLINE_EXTENSION_ID: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      REDLINE_INSTANCE_ID: INSTANCE_ID, REDLINE_LAUNCH_ID: LAUNCH_ID,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  t.after(() => { child.kill(); fs.rmSync(dir, { recursive: true, force: true }); });
  for (let i = 0; i < 100; i += 1) {
    try {
      if ((await call(listenPort, 'GET', '/health', { host: '127.0.0.1:7878' })).status === 200) {
        return { port: listenPort, dir, store, cliToken, origin: `chrome-extension://${STORE_ID}` };
      }
    } catch {}
    if (child.exitCode !== null) throw new Error(`Store sidecar exited: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Store sidecar failed to start: ${stderr}`);
}

async function pair(context, secret, overrides = {}) {
  return call(context.port, 'POST', '/pair', {
    origin: ORIGIN,
    redlineHeader: '1',
    body: { secret, consent_version: 1 },
    ...overrides,
  });
}

test('health exposes non-secret pairing availability and fixed CORS only', async (t) => {
  const context = await start(t);
  const unavailable = await call(context.port, 'GET', '/health', { origin: ORIGIN });
  assert.deepEqual(unavailable.json.pairing, { available: false });
  assert.equal(unavailable.headers['access-control-allow-origin'], ORIGIN);
  assert.equal(unavailable.headers['cache-control'], 'no-store');

  const window = await context.store.createPairingWindow();
  const available = await call(context.port, 'GET', '/health');
  assert.deepEqual(available.json.pairing, { available: true, expires_at: window.expiresAt });
  assert.equal(available.text.includes(window.secret), false);

  const attacker = await call(context.port, 'GET', '/health', { origin: 'https://attacker.example' });
  assert.equal(attacker.status, 403);
  assert.equal(attacker.headers['access-control-allow-origin'], undefined);
});

test('CLI-authenticated admin endpoint creates a one-time pairing window', async (t) => {
  const context = await start(t);
  assert.equal((await call(context.port, 'POST', '/admin/pairing')).status, 401);
  assert.equal((await call(context.port, 'POST', '/admin/pairing', { token: 'x'.repeat(43) })).status, 401);
  const response = await call(context.port, 'POST', '/admin/pairing', { token: context.cliToken });
  assert.equal(response.status, 201);
  assert.match(response.json.secret, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(Number.isFinite(Date.parse(response.json.expires_at)));
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal((await pair(context, response.json.secret)).status, 201);
});

test('CLI-authenticated invalidation clears only the named pairing window', async (t) => {
  const context = await start(t);
  const created = await call(context.port, 'POST', '/admin/pairing', { token: context.cliToken });
  assert.equal((await call(context.port, 'DELETE', '/admin/pairing', {
    body: { secret: created.json.secret },
  })).status, 401);
  assert.equal((await call(context.port, 'DELETE', '/admin/pairing', {
    token: context.cliToken, body: { secret: 'x'.repeat(43) },
  })).status, 204);
  assert.equal((await pair(context, created.json.secret)).status, 201);
  const replacement = await call(context.port, 'POST', '/admin/pairing', { token: context.cliToken });
  assert.equal((await call(context.port, 'DELETE', '/admin/pairing', {
    token: context.cliToken, body: { secret: replacement.json.secret },
  })).status, 204);
  assert.deepEqual((await call(context.port, 'GET', '/health')).json.pairing, { available: false });
  assert.equal((await pair(context, replacement.json.secret)).status, 401);
});

test('Store mode pairs only across the fixed production Host and official Origin', async (t) => {
  const context = await startStoreMode(t);
  const created = await call(context.port, 'POST', '/admin/pairing', {
    host: '127.0.0.1:7878', token: context.cliToken,
  });
  const exact = await call(context.port, 'POST', '/pair', {
    host: '127.0.0.1:7878', origin: context.origin, redlineHeader: '1',
    body: { secret: created.json.secret, consent_version: 1 },
  });
  assert.equal(exact.status, 201);
  assert.equal((await call(context.port, 'GET', '/health')).status, 400);
  assert.equal((await call(context.port, 'GET', '/health', {
    host: '127.0.0.1:7878', origin: 'chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  })).status, 403);
  assert.equal((await call(context.port, 'GET', '/redlines', {
    host: '127.0.0.1:7878', origin: context.origin,
    headers: { 'x-redline-token': 'x'.repeat(43) },
  })).status, 401);
});

test('pairs once and returns a distinct browser capability accepted by protected APIs', async (t) => {
  const context = await start(t);
  const window = await context.store.createPairingWindow();
  const response = await pair(context, window.secret);
  assert.equal(response.status, 201);
  assert.match(response.json.client_id, /^rlc_/);
  assert.ok(response.json.token.length >= 43);
  assert.equal(response.headers['access-control-allow-origin'], ORIGIN);

  const list = await call(context.port, 'GET', '/redlines', { origin: ORIGIN, token: response.json.token });
  assert.equal(list.status, 200);
  assert.equal((await pair(context, window.secret)).status, 401);
});

test('pairing requires an explicit supported consent grant without consuming the secret', async (t) => {
  const context = await start(t);
  const window = await context.store.createPairingWindow();

  for (const body of [
    { secret: window.secret },
    { secret: window.secret, consent_version: 0 },
    { secret: window.secret, consent_version: '1' },
    { secret: window.secret, consent_version: 2 },
  ]) {
    const rejected = await pair(context, window.secret, { body });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.json.error.code, 'consent_required');
  }

  assert.equal((await pair(context, window.secret)).status, 201);
});

test('pairing rejects undeclared request fields without consuming the secret', async (t) => {
  const context = await start(t);
  const window = await context.store.createPairingWindow();
  const rejected = await pair(context, window.secret, {
    body: { secret: window.secret, consent_version: 1, analytics: true },
  });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.json.error.code, 'invalid_request');
  assert.equal((await pair(context, window.secret)).status, 201);
});

test('a browser can revoke only its own authenticated capability', async (t) => {
  const context = await start(t);
  const first = await pair(context, (await context.store.createPairingWindow()).secret);
  const second = await pair(context, (await context.store.createPairingWindow()).secret);

  assert.equal((await call(context.port, 'DELETE', '/clients/current', {
    origin: ORIGIN, token: first.json.token,
  })).status, 204);
  assert.equal((await call(context.port, 'GET', '/generation', {
    origin: ORIGIN, token: first.json.token,
  })).status, 401);
  assert.equal((await call(context.port, 'GET', '/generation', {
    origin: ORIGIN, token: second.json.token,
  })).status, 200);
  assert.equal((await call(context.port, 'DELETE', '/clients/current', {
    origin: ORIGIN, token: first.json.token,
  })).status, 401);
});

test('rejects the full pairing boundary matrix without reflecting origins or secrets', async (t) => {
  const context = await start(t);
  const valid = await context.store.createPairingWindow();
  const cases = [
    ['missing origin', { origin: undefined }],
    ['null origin', { origin: 'null' }],
    ['other extension', { origin: 'chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }],
    ['website origin', { origin: 'https://attacker.example' }],
    ['wrong host', { host: 'localhost:7878' }],
    ['wrong protocol', { redlineHeader: '2' }],
    ['missing header', { redlineHeader: undefined }],
    ['wrong content type', { contentType: 'text/plain' }],
    ['malformed body', { rawBody: '{broken' }],
    ['missing secret', { body: {} }],
  ];
  for (const [name, overrides] of cases) {
    const response = await pair(context, valid.secret, overrides);
    assert.ok(response.status >= 400, name);
    assert.equal(response.text.includes(valid.secret), false, name);
    if (overrides.origin && overrides.origin !== ORIGIN) {
      assert.equal(response.headers['access-control-allow-origin'], undefined, name);
    }
    assert.match(response.json.error.code, /^[a-z_]+$/, name);
  }
  assert.equal((await pair(context, 'guessed-secret')).status, 401);
});

test('rejects duplicate security headers regardless of valid-invalid order', async (t) => {
  const context = await start(t);
  const valid = {
    Host: `127.0.0.1:${context.port}`,
    Origin: ORIGIN,
    Authorization: `Bearer ${context.cliToken}`,
    'Content-Type': 'application/json',
    'X-Redline-Protocol': '1',
    'X-Redline-Token': 'x'.repeat(43),
  };
  const invalid = {
    Host: 'attacker.invalid', Origin: 'https://attacker.invalid', Authorization: 'Bearer wrong',
    'Content-Type': 'text/plain', 'X-Redline-Protocol': '2', 'X-Redline-Token': 'y'.repeat(43),
  };
  for (const name of Object.keys(valid)) {
    for (const order of [[valid[name], invalid[name]], [invalid[name], valid[name]]]) {
      const headers = [
        `Host: 127.0.0.1:${context.port}`, `Origin: ${ORIGIN}`, 'Content-Type: application/json',
        'X-Redline-Protocol: 1', 'Content-Length: 14',
      ].filter((line) => !line.toLowerCase().startsWith(`${name.toLowerCase()}:`));
      headers.push(`${name}: ${order[0]}`, `${name}: ${order[1]}`);
      const response = await rawCall(context.port,
        `POST /pair HTTP/1.1\r\n${headers.join('\r\n')}\r\nConnection: close\r\n\r\n{"secret":"x"}`);
      assert.equal(response.status, 400, `${name} ${order.join(' then ')}`);
    }
  }
});

test('authenticated JSON mutations enforce media type, typed parsing, and body bounds', async (t) => {
  const context = await start(t);
  for (const [method, route] of [['POST', '/redlines'], ['POST', '/screenshots']]) {
    const media = await call(context.port, method, route, { token: context.cliToken, contentType: 'text/plain', rawBody: '{}' });
    assert.equal(media.status, 415, `${method} ${route}`);
    assert.equal(media.json.error.code, 'unsupported_media_type');
    const malformed = await call(context.port, method, route, { token: context.cliToken, rawBody: '{broken' });
    assert.equal(malformed.status, 400, `${method} ${route}`);
    assert.equal(malformed.json.error.code, 'invalid_json');
  }
  const oversized = await call(context.port, 'POST', '/redlines', {
    token: context.cliToken, rawBody: JSON.stringify({ comment: 'x'.repeat(1024 * 1024 + 1) }),
  });
  assert.equal(oversized.status, 413);
  assert.equal(oversized.json.error.code, 'payload_too_large');

  const created = await call(context.port, 'POST', '/redlines', { token: context.cliToken, body: {} });
  for (const options of [{ contentType: 'text/plain', rawBody: '{}' }, { rawBody: '{broken' }]) {
    const response = await call(context.port, 'PATCH', `/redlines/${created.json.id}`, { token: context.cliToken, ...options });
    assert.ok([400, 415].includes(response.status));
  }

  const stalled = await stalledCall(context.port,
    `POST /redlines HTTP/1.1\r\nHost: 127.0.0.1:${context.port}\r\nAuthorization: Bearer ${context.cliToken}\r\nContent-Type: application/json\r\nContent-Length: 100\r\nConnection: close\r\n\r\n{`);
  assert.equal(stalled.status, 408);
});

test('pairing rejects every non-object JSON value with the central typed response', async (t) => {
  const context = await start(t);
  for (const rawBody of ['null', '[]', '"text"', '42', 'true', 'false']) {
    const response = await call(context.port, 'POST', '/pair', {
      origin: ORIGIN, redlineHeader: '1', rawBody,
    });
    assert.equal(response.status, 400, rawBody);
    assert.equal(response.json?.error?.code, 'invalid_json_object', rawBody);
  }
});

test('pairing preflight is narrow and non-reflective', async (t) => {
  const context = await start(t);
  const valid = await call(context.port, 'OPTIONS', '/pair', {
    origin: ORIGIN,
    headers: {
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type, x-redline-protocol',
    },
  });
  assert.equal(valid.status, 204);
  assert.equal(valid.headers['access-control-allow-origin'], ORIGIN);
  assert.equal(valid.headers['access-control-allow-methods'], 'POST');
  assert.equal(valid.headers['access-control-allow-headers'], 'Content-Type, X-Redline-Protocol');
  assert.equal(valid.headers['access-control-allow-credentials'], undefined);

  const invalid = await call(context.port, 'OPTIONS', '/pair', {
    origin: 'https://attacker.example',
    headers: { 'access-control-request-method': 'POST' },
  });
  assert.equal(invalid.status, 403);
  assert.equal(invalid.headers['access-control-allow-origin'], undefined);

  for (const requestedHeaders of [
    undefined,
    '',
    'content-type',
    'x-redline-protocol',
    'content-type, content-type, x-redline-protocol',
    'content-type,,x-redline-protocol',
  ]) {
    const headers = { 'access-control-request-method': 'POST' };
    if (requestedHeaders !== undefined) headers['access-control-request-headers'] = requestedHeaders;
    const response = await call(context.port, 'OPTIONS', '/pair', { origin: ORIGIN, headers });
    assert.equal(response.status, 403, String(requestedHeaders));
    assert.equal(response.headers['access-control-allow-headers'], undefined);
  }
});

test('paired browser API preflight permits only its bearer and JSON headers', async (t) => {
  const context = await start(t);
  const response = await call(context.port, 'OPTIONS', '/redlines', {
    origin: ORIGIN,
    headers: {
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization, content-type',
    },
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers['access-control-allow-origin'], ORIGIN);
  assert.equal(response.headers['access-control-allow-methods'], 'POST');
  assert.equal(response.headers['access-control-allow-headers'], 'Authorization, Content-Type');

  const extra = await call(context.port, 'OPTIONS', '/redlines', {
    origin: ORIGIN,
    headers: {
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization, x-attacker',
    },
  });
  assert.equal(extra.status, 403);
});

test('all non-public endpoints require CLI admin or paired-browser bearer auth', async (t) => {
  const context = await start(t);
  for (const [method, route] of [['GET', '/redlines'], ['POST', '/redlines'], ['POST', '/screenshots']]) {
    const missing = await call(context.port, method, route, { body: method === 'POST' ? {} : undefined });
    assert.equal(missing.status, 401, `${method} ${route}`);
    const admin = await call(context.port, method, route, {
      token: context.cliToken,
      body: method === 'POST' ? (route === '/screenshots' ? { data_url: 'bad' } : {}) : undefined,
    });
    assert.notEqual(admin.status, 401, `${method} ${route}`);
  }
});

test('connect page is local static HTML with no script that can read the fragment', async (t) => {
  const context = await start(t);
  const response = await call(context.port, 'GET', '/connect');
  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /^text\/html/);
  assert.doesNotMatch(response.text, /<script|location\.hash|src=/i);
});
