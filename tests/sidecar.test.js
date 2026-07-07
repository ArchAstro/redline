const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function request(port, method, pathname, { origin, body } = {}) {
  const payload = body == null ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      method,
      path: pathname,
      headers: {
        ...(origin ? { origin } : {}),
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
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
    if (payload) req.write(payload);
    req.end();
  });
}

async function startSidecar(t) {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-test-'));
  const child = spawn(process.execPath, ['plugins/redline/server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, REDLINE_PORT: String(port), REDLINE_DIR: dir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  t.after(() => {
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  const started = Date.now();
  while (Date.now() - started < 3000) {
    if (child.exitCode != null) {
      throw new Error(`sidecar exited early: ${stderr}`);
    }
    try {
      const health = await request(port, 'GET', '/health');
      if (health.status === 200) return { port, dir };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`sidecar did not start: ${stderr}`);
}

test('sidecar rejects browser requests from arbitrary website origins', async (t) => {
  const { port } = await startSidecar(t);

  const response = await request(port, 'GET', '/redlines', {
    origin: 'https://attacker.example',
  });

  assert.equal(response.status, 403);
  assert.equal(response.headers['access-control-allow-origin'], undefined);
});

test('sidecar allows Chrome extension origins and reflects the allowed origin', async (t) => {
  const { port } = await startSidecar(t);

  const response = await request(port, 'POST', '/redlines', {
    origin: 'chrome-extension://abcdefghijklmnop',
    body: { url: 'https://app.example', origin: 'https://app.example', selected_text: 'Save', comment: 'Use Submit' },
  });

  assert.equal(response.status, 201);
  assert.equal(response.headers['access-control-allow-origin'], 'chrome-extension://abcdefghijklmnop');
  assert.equal(response.json.comment, 'Use Submit');
});

test('sidecar updates an existing redline without changing its id', async (t) => {
  const { port } = await startSidecar(t);

  const created = await request(port, 'POST', '/redlines', {
    body: { url: 'https://app.example', origin: 'https://app.example', selected_text: 'Save', comment: 'Use Submit' },
  });
  assert.equal(created.status, 201);

  const updated = await request(port, 'PATCH', `/redlines/${created.json.id}`, {
    body: { comment: 'Use Publish', project: 'website' },
  });

  assert.equal(updated.status, 200);
  assert.equal(updated.json.id, created.json.id);
  assert.equal(updated.json.comment, 'Use Publish');
  assert.equal(updated.json.project, 'website');
  assert.equal(updated.json.created_at, created.json.created_at);
  assert.match(updated.json.updated_at, /^\d{4}-\d{2}-\d{2}T/);

  const list = await request(port, 'GET', '/redlines?status=pending');
  assert.equal(list.json.length, 1);
  assert.equal(list.json[0].comment, 'Use Publish');
});
