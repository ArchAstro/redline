const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const SIDECAR = path.join(ROOT, 'runtime/bin/redline-sidecar');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function psPgid(pid) {
  const result = spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  return Number(result.stdout.trim());
}

function childPids(pid) {
  const result = spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' });
  if (result.status !== 0) return [];
  return result.stdout.trim().split(/\s+/).filter(Boolean).map(Number);
}

function descendantPids(pid) {
  const descendants = [];
  const pending = childPids(pid);
  while (pending.length > 0) {
    const child = pending.shift();
    descendants.push(child);
    pending.push(...childPids(child));
  }
  return descendants;
}

function runSidecar(args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(SIDECAR, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (status, signal) => resolve({
      status,
      signal,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
  });
}

function readHealth(port) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port, path: '/health' }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (error) { reject(error); }
      });
    });
    request.setTimeout(250, () => request.destroy(new Error('health timeout')));
    request.on('error', reject);
  });
}

function readSidecarState(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'sidecar.pid'), 'utf8'));
}

function readSidecarPid(dir) {
  return readSidecarState(dir).pid;
}

async function startHealthFixture(t, port, response) {
  const script = `
    const http = require('node:http');
    const response = JSON.parse(process.env.FIXTURE_RESPONSE);
    const server = http.createServer((req, res) => {
      res.writeHead(response.status, { 'content-type': 'application/json' });
      res.end(response.body);
    });
    server.listen(Number(process.env.FIXTURE_PORT), '127.0.0.1', () => console.log('ready'));
  `;
  const child = spawn(process.execPath, ['-e', script], {
    env: {
      ...process.env,
      FIXTURE_PORT: String(port),
      FIXTURE_RESPONSE: JSON.stringify(response),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());

  await new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('exit', (code) => reject(new Error(`health fixture exited ${code}: ${stderr}`)));
    child.stdout.once('data', resolve);
  });
}

async function startTrickleHealthFixture(t, port) {
  const script = `
    const http = require('node:http');
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{');
      const interval = setInterval(() => res.write(' '), 700);
      res.on('close', () => clearInterval(interval));
    });
    server.listen(Number(process.env.FIXTURE_PORT), '127.0.0.1', () => console.log('ready'));
  `;
  const child = spawn(process.execPath, ['-e', script], {
    env: { ...process.env, FIXTURE_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());

  await new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('exit', (code) => reject(new Error(`trickle fixture exited ${code}: ${stderr}`)));
    child.stdout.once('data', resolve);
  });
}

test('redline-sidecar rejects a non-Redline process occupying its port', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-sidecar-collision-'));
  const port = await freePort();
  const env = {
    ...process.env,
    HOME: home,
    REDLINE_DIR: path.join(home, '.redline'),
    REDLINE_PORT: String(port),
  };
  await startHealthFixture(t, port, { status: 200, body: JSON.stringify({ ok: true }) });
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const started = spawnSync(SIDECAR, ['start'], { cwd: ROOT, env, encoding: 'utf8' });

  assert.equal(started.status, 1);
  assert.match(started.stderr, new RegExp(`Redline cannot start: port ${port} is occupied`));
  assert.match(started.stderr, /health response product is not redline/);
  assert.match(started.stderr, /choose another REDLINE_PORT/i);
  assert.equal(fs.existsSync(path.join(home, '.redline', 'sidecar.pid')), false);
});

test('redline-sidecar reports malformed and incompatible health responses', async (t) => {
  const cases = [
    {
      name: 'malformed JSON',
      response: { status: 200, body: '{broken' },
      reason: /health response is not valid JSON/,
    },
    {
      name: 'incompatible protocol',
      response: {
        status: 200,
        body: JSON.stringify({
          product: 'redline',
          package_version: '9.0.0',
          protocol: { major: 2, minor: 0 },
          capabilities: ['pairing-v1', 'idempotent-redlines-v1'],
          pairing: { available: false },
        }),
      },
      reason: /incompatible Redline protocol major 2; expected 1/,
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async (subtest) => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-sidecar-bad-health-'));
      const port = await freePort();
      const env = {
        ...process.env,
        HOME: home,
        REDLINE_DIR: path.join(home, '.redline'),
        REDLINE_PORT: String(port),
      };
      await startHealthFixture(subtest, port, fixture.response);
      subtest.after(() => fs.rmSync(home, { recursive: true, force: true }));

      const started = spawnSync(SIDECAR, ['start'], { cwd: ROOT, env, encoding: 'utf8' });

      assert.equal(started.status, 1);
      assert.match(started.stderr, fixture.reason);
    });
  }
});

test('health probe has a total deadline even when a responder trickles bytes', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-sidecar-trickle-'));
  const port = await freePort();
  const env = {
    ...process.env,
    HOME: home,
    REDLINE_DIR: path.join(home, '.redline'),
    REDLINE_PORT: String(port),
  };
  await startTrickleHealthFixture(t, port);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const startedAt = Date.now();

  const started = spawnSync(SIDECAR, ['start'], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 3200,
  });

  assert.equal(started.error, undefined, 'health probe exceeded its total deadline');
  assert.equal(started.status, 1);
  assert.ok(Date.now() - startedAt < 2500);
  assert.match(started.stderr, /health probe exceeded its 1500ms deadline/);
  assert.equal(fs.existsSync(path.join(home, '.redline', 'sidecar.pid')), false);
});

test('default Store mode gives an actionable diagnostic for a collision on 7878', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-sidecar-store-collision-'));
  const fakeBin = path.join(home, 'bin');
  const fakeNode = path.join(fakeBin, 'node');
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(fakeNode, `#!/usr/bin/env bash
if [[ "\${1:-}" == */sidecar-lifecycle.js ]] && [ "\${2:-}" = "start" ]; then
  echo "Redline cannot start: port 7878 is occupied by an incompatible service (health response product is not redline)." >&2
  echo "Stop the process using 127.0.0.1:7878, then run redline-sidecar start again. For unpacked development, choose another REDLINE_PORT." >&2
  exit 1
fi
if [ "\${1:-}" = "-e" ]; then exec "$REAL_NODE" "$@"; fi
if [ "\${1:-}" = "-" ] && [[ "\${2:-}" == /* ]]; then exec "$REAL_NODE" "$@"; fi
if [ "\${1:-}" = "-" ] && [[ "\${3:-}" == /* ]]; then exec "$REAL_NODE" "$@"; fi
echo "health response product is not redline"
exit 20
`, { mode: 0o755 });
  const env = {
    ...process.env,
    HOME: home,
    REDLINE_DIR: path.join(home, '.redline'),
    PATH: `${fakeBin}:${process.env.PATH}`,
    REAL_NODE: process.execPath,
  };
  delete env.REDLINE_PORT;

  try {
    const started = spawnSync(SIDECAR, ['start'], { cwd: ROOT, env, encoding: 'utf8' });

    assert.equal(started.status, 1);
    assert.match(started.stderr, /Redline cannot start: port 7878 is occupied/);
    assert.match(started.stderr, /Stop the process using 127\.0\.0\.1:7878/);
    assert.match(started.stderr, /For unpacked development, choose another REDLINE_PORT/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('redline-sidecar rejects invalid REDLINE_PORT before creating a child or pidfile', () => {
  for (const value of ['54336junk', '0', '65536', ' 7878', '7878 ', '']) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-sidecar-invalid-port-'));
    const dir = path.join(home, '.redline');
    const fakeBin = path.join(home, 'bin');
    const nodeWrapper = path.join(fakeBin, 'node');
    const nodeCalls = path.join(home, 'node-calls');
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(nodeWrapper, `#!/usr/bin/env bash
if [ "\${1:-}" = "-e" ]; then target="\${3:-}"; else target="\${2:-}"; fi
printf '%s|%s\n' "\${1:-}" "$target" >> "$NODE_CALLS"
exec "$REAL_NODE" "$@"
`, { mode: 0o755 });
    const env = {
      ...process.env,
      HOME: home,
      REDLINE_DIR: dir,
      REDLINE_PORT: value,
      PATH: `${fakeBin}:${process.env.PATH}`,
      REAL_NODE: process.execPath,
      NODE_CALLS: nodeCalls,
    };
    const startedAt = Date.now();

    try {
      const started = spawnSync(SIDECAR, ['start'], {
        cwd: ROOT,
        env,
        encoding: 'utf8',
        timeout: 4000,
      });

      assert.equal(started.error, undefined, `launcher hung for REDLINE_PORT=${JSON.stringify(value)}`);
      assert.equal(started.status, 1);
      assert.ok(Date.now() - startedAt < 1000, `launcher did not fail fast for ${JSON.stringify(value)}`);
      assert.equal(started.stderr.includes(
        `invalid Redline port ${JSON.stringify(value)}; expected a canonical decimal integer from 1 to 65535`,
      ), true);
      assert.equal(fs.existsSync(path.join(dir, 'sidecar.pid')), false);
      assert.equal(fs.existsSync(path.join(dir, 'sidecar.log')), false);
      assert.equal(fs.existsSync(path.join(dir, 'sidecar.start.lock')), false);
      assert.deepEqual(fs.readFileSync(nodeCalls, 'utf8').trim().split('\n'), [
        `${path.join(ROOT, 'runtime/lib/sidecar-lifecycle.js')}|start`,
      ]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
});

test('custom REDLINE_PORT starts a detached developer sidecar and recognizes it on retry', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-sidecar-cli-'));
  const dir = path.join(home, '.redline');
  const port = await freePort();
  const env = { ...process.env, HOME: home, REDLINE_DIR: dir, REDLINE_PORT: String(port) };

  try {
    const started = spawnSync(SIDECAR, ['start'], { cwd: ROOT, env, encoding: 'utf8' });
    assert.equal(started.status, 0, `${started.stdout}\n${started.stderr}`);

    const launchState = readSidecarState(dir);
    const pid = launchState.pid;
    const instanceId = fs.readFileSync(path.join(dir, 'instance-id'), 'utf8').trim();
    const directory = fs.lstatSync(dir, { bigint: true });
    assert.ok(pid > 0);
    assert.deepEqual(launchState, {
      version: 1,
      pid,
      port,
      instance_id: instanceId,
      launch_id: launchState.launch_id,
      directory: { device: String(directory.dev), inode: String(directory.ino) },
    });
    assert.match(launchState.launch_id, /^rll_[0-9a-f]{32}$/);
    assert.equal(fs.statSync(path.join(dir, 'sidecar.pid')).mode & 0o777, 0o600);
    assert.match(instanceId, /^rli_[0-9a-f]{32}$/);
    assert.equal(fs.statSync(path.join(dir, 'instance-id')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(dir, 'instance-id.initialized')).mode & 0o777, 0o600);
    assert.equal(psPgid(pid), pid);

    const status = spawnSync(SIDECAR, ['status'], { cwd: ROOT, env, encoding: 'utf8' });
    assert.equal(status.status, 0, `${status.stdout}\n${status.stderr}`);
    assert.match(status.stdout, new RegExp(`up \\(pid ${pid}, port ${port}\\)`));

    const retried = spawnSync(SIDECAR, ['start'], { cwd: ROOT, env, encoding: 'utf8' });
    assert.equal(retried.status, 0, `${retried.stdout}\n${retried.stderr}`);
    assert.match(retried.stdout, new RegExp(`already running \\(pid ${pid}, port ${port}\\)`));
    assert.equal(fs.readFileSync(path.join(dir, 'instance-id'), 'utf8').trim(), instanceId);
  } finally {
    spawnSync(SIDECAR, ['stop'], { cwd: ROOT, env, encoding: 'utf8' });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('structured sidecar start, status, and stop work from package and data paths with spaces', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline sidecar spaced paths '));
  const packageRoot = path.join(home, 'package root with spaces');
  const dir = path.join(home, 'data directory with spaces');
  const sidecar = path.join(packageRoot, 'runtime/bin/redline-sidecar');
  const port = await freePort();
  const env = { ...process.env, HOME: home, REDLINE_DIR: dir, REDLINE_PORT: String(port) };
  let pid;

  fs.mkdirSync(packageRoot, { recursive: true });
  fs.cpSync(path.join(ROOT, 'runtime'), path.join(packageRoot, 'runtime'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(packageRoot, 'package.json'));

  try {
    const started = spawnSync(sidecar, ['start'], { cwd: packageRoot, env, encoding: 'utf8' });
    assert.equal(started.status, 0, `${started.stdout}\n${started.stderr}`);
    pid = readSidecarPid(dir);

    const status = spawnSync(sidecar, ['status'], { cwd: packageRoot, env, encoding: 'utf8' });
    assert.equal(status.status, 0, `${status.stdout}\n${status.stderr}`);
    assert.match(status.stdout, new RegExp(`up \\(pid ${pid}, port ${port}\\)`));

    const stopped = spawnSync(sidecar, ['stop'], {
      cwd: packageRoot,
      env: { ...env, REDLINE_PORT: 'malformed' },
      encoding: 'utf8',
    });
    assert.equal(stopped.status, 0, `${stopped.stdout}\n${stopped.stderr}`);
    assert.equal(fs.existsSync(path.join(dir, 'sidecar.pid')), false);
  } finally {
    if (pid && psPgid(pid) !== null) process.kill(pid, 'SIGKILL');
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('stop terminates a managed sidecar even when instance identity is missing or corrupt', async () => {
  for (const identityState of ['missing', 'corrupt']) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-sidecar-stop-bad-identity-'));
    const dir = path.join(home, '.redline');
    const port = await freePort();
    const env = { ...process.env, HOME: home, REDLINE_DIR: dir, REDLINE_PORT: String(port) };
    let pid;
    try {
      const started = spawnSync(SIDECAR, ['start'], { cwd: ROOT, env, encoding: 'utf8' });
      assert.equal(started.status, 0, `${started.stdout}\n${started.stderr}`);
      pid = readSidecarPid(dir);
      if (identityState === 'missing') fs.rmSync(path.join(dir, 'instance-id'));
      else fs.writeFileSync(path.join(dir, 'instance-id'), 'corrupt\n', { mode: 0o600 });

      const stopped = spawnSync(SIDECAR, ['stop'], { cwd: ROOT, env, encoding: 'utf8', timeout: 3000 });

      assert.equal(stopped.error, undefined);
      assert.equal(stopped.status, 0, `${stopped.stdout}\n${stopped.stderr}`);
      assert.match(stopped.stdout, new RegExp(`stopped \\(pid ${pid}\\)`));
      assert.equal(psPgid(pid), null);
      assert.equal(fs.existsSync(path.join(dir, 'sidecar.pid')), false);
    } finally {
      if (pid && psPgid(pid) !== null) process.kill(pid, 'SIGKILL');
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
});

test('stop ignores malformed REDLINE_PORT and still stops the managed sidecar', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-sidecar-stop-bad-port-'));
  const dir = path.join(home, '.redline');
  const port = await freePort();
  const startEnv = { ...process.env, HOME: home, REDLINE_DIR: dir, REDLINE_PORT: String(port) };
  const stopEnv = { ...startEnv, REDLINE_PORT: 'bad-port' };
  let pid;
  try {
    const started = spawnSync(SIDECAR, ['start'], { cwd: ROOT, env: startEnv, encoding: 'utf8' });
    assert.equal(started.status, 0, `${started.stdout}\n${started.stderr}`);
    pid = readSidecarPid(dir);

    const stopped = spawnSync(SIDECAR, ['stop'], { cwd: ROOT, env: stopEnv, encoding: 'utf8', timeout: 3000 });

    assert.equal(stopped.error, undefined);
    assert.equal(stopped.status, 0, `${stopped.stdout}\n${stopped.stderr}`);
    assert.equal(psPgid(pid), null);
    assert.equal(fs.existsSync(path.join(dir, 'sidecar.pid')), false);
  } finally {
    if (pid && psPgid(pid) !== null) process.kill(pid, 'SIGKILL');
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('help performs no port, directory, or identity initialization', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-sidecar-help-boundary-'));
  const dir = path.join(home, 'must-not-exist');
  const env = { ...process.env, HOME: home, REDLINE_DIR: dir, REDLINE_PORT: 'bad-port' };
  try {
    const helped = spawnSync(SIDECAR, ['help'], { cwd: ROOT, env, encoding: 'utf8' });

    assert.equal(helped.status, 0, helped.stderr);
    assert.match(helped.stdout, /usage: redline-sidecar/);
    assert.equal(fs.existsSync(dir), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('logs validates only REDLINE_DIR and the log artifact', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-sidecar-logs-boundary-'));
  const dir = path.join(home, '.redline');
  const identity = path.join(dir, 'instance-id');
  const env = { ...process.env, HOME: home, REDLINE_DIR: dir, REDLINE_PORT: 'bad-port' };
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'sidecar.log'), 'line one\nline two\n', { mode: 0o600 });
  fs.writeFileSync(identity, 'corrupt\n', { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'instance-id.initialized'), 'redline-instance-v1\n', { mode: 0o600 });
  try {
    const logged = spawnSync(SIDECAR, ['logs'], { cwd: ROOT, env, encoding: 'utf8' });

    assert.equal(logged.status, 0, logged.stderr);
    assert.match(logged.stdout, /line one\nline two/);
    assert.equal(fs.readFileSync(identity, 'utf8'), 'corrupt\n');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('concurrent starts publish exactly one live managed owner', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-sidecar-concurrent-'));
  const dir = path.join(home, '.redline');
  const port = await freePort();
  const fakeBin = path.join(home, 'bin');
  const nodeWrapper = path.join(fakeBin, 'node');
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(nodeWrapper, `#!/usr/bin/env bash
if [ "\${1:-}" = "-" ] && [[ "\${2:-}" == */server.js ]]; then sleep 0.4; fi
exec "$REAL_NODE" "$@"
`, { mode: 0o755 });
  const env = {
    ...process.env,
    HOME: home,
    REDLINE_DIR: dir,
    REDLINE_PORT: String(port),
    PATH: `${fakeBin}:${process.env.PATH}`,
    REAL_NODE: process.execPath,
  };

  try {
    const results = await Promise.all([
      runSidecar(['start'], { cwd: ROOT, env }),
      runSidecar(['start'], { cwd: ROOT, env }),
    ]);
    for (const result of results) {
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    }

    const ownerPid = readSidecarPid(dir);
    assert.ok(ownerPid > 0);
    assert.equal(psPgid(ownerPid), ownerPid);
    const reportedStarts = results
      .map((result) => result.stdout.match(/started \(pid (\d+),/)?.[1])
      .filter(Boolean)
      .map(Number);
    assert.deepEqual([...new Set(reportedStarts)], [ownerPid]);

    const stopped = spawnSync(SIDECAR, ['stop'], { cwd: ROOT, env, encoding: 'utf8' });
    assert.equal(stopped.status, 0, `${stopped.stdout}\n${stopped.stderr}`);
    assert.equal(psPgid(ownerPid), null);
  } finally {
    spawnSync(SIDECAR, ['stop'], { cwd: ROOT, env, encoding: 'utf8' });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('start safely recovers a lock owned by a dead launcher', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-sidecar-stale-lock-'));
  const dir = path.join(home, '.redline');
  const lockDir = path.join(dir, 'sidecar.start.lock');
  const port = await freePort();
  const env = { ...process.env, HOME: home, REDLINE_DIR: dir, REDLINE_PORT: String(port) };

  try {
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, 'owner.pid'), '99999999\n', { mode: 0o600 });

    const started = spawnSync(SIDECAR, ['start'], { cwd: ROOT, env, encoding: 'utf8' });

    assert.equal(started.status, 0, `${started.stdout}\n${started.stderr}`);
    const pid = readSidecarPid(dir);
    assert.equal(psPgid(pid), pid);
    assert.equal(fs.existsSync(lockDir), false);
  } finally {
    spawnSync(SIDECAR, ['stop'], { cwd: ROOT, env, encoding: 'utf8' });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a symlinked startup lock cannot mutate outside files or hang startup', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-sidecar-lock-symlink-'));
  const dir = path.join(home, '.redline');
  const outside = path.join(home, 'outside');
  const outsideOwner = path.join(outside, 'owner.pid');
  const port = await freePort();
  const env = { ...process.env, HOME: home, REDLINE_DIR: dir, REDLINE_PORT: String(port) };
  fs.mkdirSync(dir);
  fs.mkdirSync(outside);
  fs.writeFileSync(outsideOwner, '99999999\n', { mode: 0o644 });
  fs.symlinkSync(outside, path.join(dir, 'sidecar.start.lock'));
  const startedAt = Date.now();

  try {
    const started = spawnSync(SIDECAR, ['start'], {
      cwd: ROOT,
      env,
      encoding: 'utf8',
      timeout: 2500,
    });

    assert.equal(started.error, undefined, 'symlinked lock made startup exceed its bounded deadline');
    assert.equal(started.status, 1);
    assert.ok(Date.now() - startedAt < 2000);
    assert.match(started.stderr, /startup lock.*symlink|startup lock.*directory/i);
    assert.equal(fs.readFileSync(outsideOwner, 'utf8'), '99999999\n');
    assert.equal(fs.statSync(outsideOwner).mode & 0o777, 0o644);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a hard-linked lock owner cannot be consumed as lifecycle state', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-sidecar-lock-owner-hardlink-'));
  const dir = path.join(home, '.redline');
  const lockDir = path.join(dir, 'sidecar.start.lock');
  const outside = path.join(home, 'outside-owner');
  const port = await freePort();
  const env = { ...process.env, HOME: home, REDLINE_DIR: dir, REDLINE_PORT: String(port) };
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(outside, '99999999\n', { mode: 0o644 });
  fs.linkSync(outside, path.join(lockDir, 'owner.pid'));

  try {
    const started = spawnSync(SIDECAR, ['start'], { cwd: ROOT, env, encoding: 'utf8', timeout: 2500 });

    assert.equal(started.error, undefined);
    assert.equal(started.status, 1);
    assert.match(started.stderr, /lock owner.*multiple links|lock owner.*hard link/i);
    assert.equal(fs.readFileSync(outside, 'utf8'), '99999999\n');
    assert.equal(fs.statSync(outside).mode & 0o777, 0o644);
    assert.equal(fs.statSync(outside).nlink, 2);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('symlinked PID and log artifacts are rejected without touching outside files', async () => {
  for (const artifact of ['sidecar.pid', 'sidecar.log']) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-sidecar-artifact-symlink-'));
    const dir = path.join(home, '.redline');
    const outside = path.join(home, 'outside-artifact');
    const port = await freePort();
    const env = { ...process.env, HOME: home, REDLINE_DIR: dir, REDLINE_PORT: String(port) };
    fs.mkdirSync(dir);
    fs.writeFileSync(outside, artifact === 'sidecar.pid' ? '99999999\n' : 'outside-log\n', { mode: 0o644 });
    fs.symlinkSync(outside, path.join(dir, artifact));

    try {
      const started = spawnSync(SIDECAR, ['start'], { cwd: ROOT, env, encoding: 'utf8', timeout: 2500 });

      assert.equal(started.error, undefined);
      assert.equal(started.status, 1);
      assert.match(started.stderr, new RegExp(`${artifact.replace('.', '\\.')}.*symlink|${artifact.replace('.', '\\.')}.*regular file`, 'i'));
      assert.equal(
        fs.readFileSync(outside, 'utf8'),
        artifact === 'sidecar.pid' ? '99999999\n' : 'outside-log\n',
      );
      assert.equal(fs.statSync(outside).mode & 0o777, 0o644);
    } finally {
      spawnSync(SIDECAR, ['stop'], { cwd: ROOT, env, encoding: 'utf8' });
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
});

test('hard-linked PID and log artifacts are rejected without mutating outside inodes', async () => {
  for (const artifact of ['sidecar.pid', 'sidecar.log']) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-sidecar-artifact-hardlink-'));
    const dir = path.join(home, '.redline');
    const outside = path.join(home, 'outside-artifact');
    const port = await freePort();
    const env = { ...process.env, HOME: home, REDLINE_DIR: dir, REDLINE_PORT: String(port) };
    const contents = artifact === 'sidecar.pid' ? '99999999\n' : 'outside-log\n';
    fs.mkdirSync(dir);
    fs.writeFileSync(outside, contents, { mode: 0o644 });
    fs.linkSync(outside, path.join(dir, artifact));

    try {
      const started = spawnSync(SIDECAR, ['start'], { cwd: ROOT, env, encoding: 'utf8', timeout: 2500 });

      assert.equal(started.error, undefined);
      assert.equal(started.status, 1);
      assert.match(started.stderr, /multiple links|hard-linked lifecycle state|refusing a hard link/i);
      assert.equal(fs.readFileSync(outside, 'utf8'), contents);
      assert.equal(fs.statSync(outside).mode & 0o777, 0o644);
      assert.equal(fs.statSync(outside).nlink, 2);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
});

test('a predictable launch-result symlink cannot overwrite an outside file', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-sidecar-result-symlink-'));
  const dir = path.join(home, '.redline');
  const outside = path.join(home, 'outside-result');
  const port = await freePort();
  const env = {
    ...process.env,
    HOME: home,
    NODE_ENV: 'test',
    REDLINE_DIR: dir,
    REDLINE_PORT: String(port),
    REDLINE_TEST_PAUSE_BEFORE_PID_PUBLISH_MS: '500',
  };
  fs.mkdirSync(dir);
  fs.writeFileSync(outside, 'outside-content\n', { mode: 0o644 });
  const launched = spawn(SIDECAR, ['start'], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const predictableResult = path.join(dir, `sidecar.launch-result.${launched.pid}`);
  fs.symlinkSync(outside, predictableResult);

  try {
    const result = await new Promise((resolve) => launched.once('close', (status) => resolve({ status })));
    assert.equal(result.status, 0);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'outside-content\n');
    assert.equal(fs.statSync(outside).mode & 0o777, 0o644);
    assert.equal(fs.lstatSync(predictableResult).isSymbolicLink(), true);
  } finally {
    spawnSync(SIDECAR, ['stop'], { cwd: ROOT, env, encoding: 'utf8' });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a hard-linked instance identity is rejected without mutating the outside inode', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-sidecar-instance-hardlink-'));
  const dir = path.join(home, '.redline');
  const outside = path.join(home, 'outside-instance');
  const port = await freePort();
  const env = { ...process.env, HOME: home, REDLINE_DIR: dir, REDLINE_PORT: String(port) };
  fs.mkdirSync(dir);
  fs.writeFileSync(outside, 'rli_0123456789abcdef0123456789abcdef\n', { mode: 0o644 });
  fs.linkSync(outside, path.join(dir, 'instance-id'));
  fs.writeFileSync(path.join(dir, 'instance-id.initialized'), 'redline-instance-v1\n', { mode: 0o600 });

  try {
    const started = spawnSync(SIDECAR, ['start'], { cwd: ROOT, env, encoding: 'utf8' });

    assert.equal(started.status, 1);
    assert.match(started.stderr, /instance identity.*multiple links|instance identity.*hard link/i);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'rli_0123456789abcdef0123456789abcdef\n');
    assert.equal(fs.statSync(outside).mode & 0o777, 0o644);
    assert.equal(fs.statSync(outside).nlink, 2);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('terminating startup cleans the unpublished child, lock, and temporary PID state', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-sidecar-signal-cleanup-'));
  const dir = path.join(home, '.redline');
  const port = await freePort();
  const env = {
    ...process.env,
    HOME: home,
    NODE_ENV: 'test',
    REDLINE_DIR: dir,
    REDLINE_PORT: String(port),
    REDLINE_TEST_PAUSE_BEFORE_PID_PUBLISH_MS: '2000',
  };
  const launched = spawn(SIDECAR, ['start'], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let unpublishedPid;

  try {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      try {
        unpublishedPid = (await readHealth(port)).process.pid;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    assert.ok(unpublishedPid > 0, 'launcher never created its unpublished child');
    assert.notEqual(psPgid(unpublishedPid), null);

    launched.kill('SIGTERM');
    const result = await new Promise((resolve) => launched.on('close', (status, signal) => resolve({ status, signal })));
    assert.equal(result.status, 143);

    const stoppedBy = Date.now() + 2000;
    while (psPgid(unpublishedPid) !== null && Date.now() < stoppedBy) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(psPgid(unpublishedPid), null);
    assert.equal(fs.existsSync(path.join(dir, 'sidecar.start.lock')), false);
    assert.equal(fs.existsSync(path.join(dir, 'sidecar.pid')), false);
    assert.deepEqual(
      fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.startsWith('sidecar.pid.tmp.')) : [],
      [],
    );
  } finally {
    if (launched.exitCode == null && launched.signalCode == null) launched.kill('SIGKILL');
    if (unpublishedPid && psPgid(unpublishedPid) !== null) process.kill(unpublishedPid, 'SIGKILL');
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('terminating a launcher with a stopped supervisor escalates cleanup and reaps descendants', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-sidecar-stopped-supervisor-'));
  const dir = path.join(home, '.redline');
  const port = await freePort();
  const env = {
    ...process.env,
    HOME: home,
    NODE_ENV: 'test',
    REDLINE_DIR: dir,
    REDLINE_PORT: String(port),
    REDLINE_TEST_PAUSE_BEFORE_PID_PUBLISH_MS: '5000',
  };
  const launched = spawn(SIDECAR, ['start'], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let supervisorPid;
  let sidecarPid;
  let descendants = [];

  try {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      try {
        sidecarPid = (await readHealth(port)).process.pid;
        const directChildren = childPids(launched.pid);
        supervisorPid = directChildren.find((pid) => pid !== sidecarPid);
        if (supervisorPid) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(supervisorPid > 0, 'launcher supervisor was not observed');
    assert.ok(sidecarPid > 0, 'sidecar child was not observed');
    descendants = descendantPids(launched.pid);
    assert.equal(descendants.includes(supervisorPid), true);
    assert.equal(descendants.includes(sidecarPid), true);

    process.kill(supervisorPid, 'SIGSTOP');
    launched.kill('SIGTERM');
    const closed = await Promise.race([
      new Promise((resolve) => launched.once('close', (status) => resolve({ closed: true, status }))),
      new Promise((resolve) => setTimeout(() => resolve({ closed: false }), 2000)),
    ]);

    assert.equal(closed.closed, true, 'launcher cleanup blocked indefinitely on a stopped supervisor');
    assert.equal(closed.status, 143);
    const stoppedBy = Date.now() + 3000;
    while (Date.now() < stoppedBy && descendants.some((pid) => psPgid(pid) !== null)) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    for (const pid of descendants) assert.equal(psPgid(pid), null, `descendant ${pid} survived cleanup`);
    await assert.rejects(readHealth(port));
    assert.equal(fs.existsSync(path.join(dir, 'sidecar.start.lock')), false);
    assert.equal(fs.existsSync(path.join(dir, 'sidecar.pid')), false);
    assert.deepEqual(fs.readdirSync(dir).filter((name) => name.startsWith('sidecar.pid.tmp.')), []);
  } finally {
    if (supervisorPid) {
      try { process.kill(supervisorPid, 'SIGKILL'); } catch {}
    }
    if (launched.exitCode == null && launched.signalCode == null) launched.kill('SIGKILL');
    for (const pid of [...descendants, sidecarPid].filter(Boolean)) {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('SIGKILL before PID publication cannot leave an unmanaged listener or startup state', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-sidecar-crash-publication-'));
  const dir = path.join(home, '.redline');
  const port = await freePort();
  const env = {
    ...process.env,
    HOME: home,
    NODE_ENV: 'test',
    REDLINE_DIR: dir,
    REDLINE_PORT: String(port),
    REDLINE_TEST_PAUSE_BEFORE_PID_PUBLISH_MS: '2000',
  };
  const launched = spawn(SIDECAR, ['start'], {
    cwd: ROOT,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let childPid;

  try {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      try {
        const health = await readHealth(port);
        childPid = health.process.pid;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    assert.ok(childPid > 0, 'spawned child never became healthy');
    assert.equal(fs.existsSync(path.join(dir, 'sidecar.pid')), false);

    process.kill(-launched.pid, 'SIGKILL');
    await new Promise((resolve) => launched.once('close', resolve));

    const stoppedBy = Date.now() + 3000;
    while (Date.now() < stoppedBy) {
      const artifacts = fs.existsSync(dir) && fs.readdirSync(dir).some((name) =>
        name === 'sidecar.pid' || name === 'sidecar.start.lock' || name.startsWith('sidecar.pid.tmp.'));
      if (psPgid(childPid) === null && !artifacts) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await assert.rejects(readHealth(port));
    assert.equal(psPgid(childPid), null);
    assert.equal(fs.existsSync(path.join(dir, 'sidecar.start.lock')), false);
    assert.equal(fs.existsSync(path.join(dir, 'sidecar.pid')), false);
    assert.deepEqual(fs.readdirSync(dir).filter((name) => name.startsWith('sidecar.pid.tmp.')), []);
  } finally {
    try { process.kill(-launched.pid, 'SIGKILL'); } catch {}
    if (childPid && psPgid(childPid) !== null) process.kill(childPid, 'SIGKILL');
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('terminating after PID publication but before commit removes the unpublished PID', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-sidecar-signal-after-pid-'));
  const dir = path.join(home, '.redline');
  const port = await freePort();
  const env = {
    ...process.env,
    HOME: home,
    NODE_ENV: 'test',
    REDLINE_DIR: dir,
    REDLINE_PORT: String(port),
    REDLINE_TEST_PAUSE_AFTER_PID_PUBLISH_MS: '2000',
  };
  const launched = spawn(SIDECAR, ['start'], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let childPid;

  try {
    const pidFile = path.join(dir, 'sidecar.pid');
    const deadline = Date.now() + 3000;
    while (!fs.existsSync(pidFile) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(fs.existsSync(pidFile), true, 'launcher never reached PID publication');
    childPid = readSidecarPid(dir);
    assert.ok(childPid > 0);

    launched.kill('SIGTERM');
    const result = await new Promise((resolve) => launched.on('close', (status) => resolve({ status })));
    assert.equal(result.status, 143);

    const stoppedBy = Date.now() + 3000;
    while ((psPgid(childPid) !== null || fs.existsSync(pidFile)) && Date.now() < stoppedBy) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await assert.rejects(readHealth(port));
    assert.equal(psPgid(childPid), null);
    assert.equal(fs.existsSync(pidFile), false);
    assert.equal(fs.existsSync(path.join(dir, 'sidecar.start.lock')), false);
    assert.deepEqual(fs.readdirSync(dir).filter((name) => name.startsWith('sidecar.pid.tmp.')), []);
  } finally {
    if (launched.exitCode == null && launched.signalCode == null) launched.kill('SIGKILL');
    if (childPid && psPgid(childPid) !== null) process.kill(childPid, 'SIGKILL');
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('child failure before readiness leaves no lock or published PID', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-sidecar-child-failure-'));
  const dir = path.join(home, '.redline');
  const port = await freePort();
  const env = { ...process.env, HOME: home, REDLINE_DIR: dir, REDLINE_PORT: String(port) };
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'redlines.json'), '{broken', { mode: 0o600 });

  try {
    const started = spawnSync(SIDECAR, ['start'], { cwd: ROOT, env, encoding: 'utf8' });

    assert.equal(started.status, 1);
    assert.match(started.stderr, /Redline child failed before readiness/);
    assert.equal(fs.existsSync(path.join(dir, 'sidecar.start.lock')), false);
    assert.equal(fs.existsSync(path.join(dir, 'sidecar.pid')), false);
    assert.deepEqual(fs.readdirSync(dir).filter((name) => name.startsWith('sidecar.pid.tmp.')), []);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a compatible Redline from a different REDLINE_DIR is an actionable collision', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-sidecar-different-dir-'));
  const port = await freePort();
  const firstDir = path.join(home, 'first');
  const secondDir = path.join(home, 'second');
  const firstEnv = { ...process.env, HOME: home, REDLINE_DIR: firstDir, REDLINE_PORT: String(port) };
  const secondEnv = { ...process.env, HOME: home, REDLINE_DIR: secondDir, REDLINE_PORT: String(port) };

  try {
    const first = spawnSync(SIDECAR, ['start'], { cwd: ROOT, env: firstEnv, encoding: 'utf8' });
    assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
    const ownerPid = readSidecarPid(firstDir);
    assert.ok(ownerPid > 0);

    const second = spawnSync(SIDECAR, ['start'], { cwd: ROOT, env: secondEnv, encoding: 'utf8' });

    assert.equal(second.status, 1);
    assert.match(second.stderr, new RegExp(`port ${port} is serving compatible Redline from another data directory`));
    assert.match(second.stderr, new RegExp(`REDLINE_DIR=${secondDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.equal(fs.existsSync(path.join(secondDir, 'sidecar.pid')), false);
    assert.equal(psPgid(ownerPid), ownerPid);
  } finally {
    spawnSync(SIDECAR, ['stop'], { cwd: ROOT, env: firstEnv, encoding: 'utf8' });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a copied live PID cannot make another REDLINE_DIR claim the responder', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-sidecar-copied-pid-'));
  const firstDir = path.join(home, 'first');
  const secondDir = path.join(home, 'second');
  const firstPort = await freePort();
  const bootstrapPort = await freePort();
  const firstEnv = { ...process.env, HOME: home, REDLINE_DIR: firstDir, REDLINE_PORT: String(firstPort) };
  const secondBootstrapEnv = {
    ...process.env,
    HOME: home,
    REDLINE_DIR: secondDir,
    REDLINE_PORT: String(bootstrapPort),
  };
  const secondEnv = { ...secondBootstrapEnv, REDLINE_PORT: String(firstPort) };

  try {
    const bootstrapped = spawnSync(SIDECAR, ['start'], {
      cwd: ROOT,
      env: secondBootstrapEnv,
      encoding: 'utf8',
    });
    assert.equal(bootstrapped.status, 0, `${bootstrapped.stdout}\n${bootstrapped.stderr}`);
    spawnSync(SIDECAR, ['stop'], { cwd: ROOT, env: secondBootstrapEnv, encoding: 'utf8' });

    const first = spawnSync(SIDECAR, ['start'], { cwd: ROOT, env: firstEnv, encoding: 'utf8' });
    assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
    const firstPid = fs.readFileSync(path.join(firstDir, 'sidecar.pid'), 'utf8');
    fs.writeFileSync(path.join(secondDir, 'sidecar.pid'), firstPid, { mode: 0o600 });

    const second = spawnSync(SIDECAR, ['start'], { cwd: ROOT, env: secondEnv, encoding: 'utf8' });

    assert.equal(second.status, 1);
    assert.match(second.stderr, /instance identity does not match REDLINE_DIR|another data directory/i);
  } finally {
    spawnSync(SIDECAR, ['stop'], { cwd: ROOT, env: firstEnv, encoding: 'utf8' });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('stop cannot signal another directory owner through copied PID state', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-sidecar-copied-stop-'));
  const firstDir = path.join(home, 'first');
  const secondDir = path.join(home, 'second');
  const firstPort = await freePort();
  const bootstrapPort = await freePort();
  const firstEnv = { ...process.env, HOME: home, REDLINE_DIR: firstDir, REDLINE_PORT: String(firstPort) };
  const secondEnv = { ...process.env, HOME: home, REDLINE_DIR: secondDir, REDLINE_PORT: String(bootstrapPort) };

  try {
    const bootstrapped = spawnSync(SIDECAR, ['start'], { cwd: ROOT, env: secondEnv, encoding: 'utf8' });
    assert.equal(bootstrapped.status, 0, `${bootstrapped.stdout}\n${bootstrapped.stderr}`);
    const bootstrapStop = spawnSync(SIDECAR, ['stop'], { cwd: ROOT, env: secondEnv, encoding: 'utf8' });
    assert.equal(bootstrapStop.status, 0, `${bootstrapStop.stdout}\n${bootstrapStop.stderr}`);

    const first = spawnSync(SIDECAR, ['start'], { cwd: ROOT, env: firstEnv, encoding: 'utf8' });
    assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
    const firstPidState = fs.readFileSync(path.join(firstDir, 'sidecar.pid'), 'utf8');
    const firstPid = JSON.parse(firstPidState).pid;
    fs.writeFileSync(path.join(secondDir, 'sidecar.pid'), firstPidState, { mode: 0o600 });

    const stopped = spawnSync(SIDECAR, ['stop'], {
      cwd: ROOT,
      env: { ...secondEnv, REDLINE_PORT: 'malformed' },
      encoding: 'utf8',
    });

    assert.equal(stopped.status, 1, `${stopped.stdout}\n${stopped.stderr}`);
    assert.equal(psPgid(firstPid), firstPid, 'the original directory owner must remain alive');
    assert.equal(fs.readFileSync(path.join(firstDir, 'sidecar.pid'), 'utf8'), firstPidState);
  } finally {
    spawnSync(SIDECAR, ['stop'], { cwd: ROOT, env: firstEnv, encoding: 'utf8' });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('forged directory fields cannot make copied launch metadata own another sidecar', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-sidecar-forged-directory-'));
  const firstDir = path.join(home, 'first');
  const secondDir = path.join(home, 'second');
  const firstPort = await freePort();
  const secondPort = await freePort();
  const firstEnv = { ...process.env, HOME: home, REDLINE_DIR: firstDir, REDLINE_PORT: String(firstPort) };
  const secondEnv = { ...process.env, HOME: home, REDLINE_DIR: secondDir, REDLINE_PORT: String(secondPort) };
  let secondPid;

  try {
    const initialized = spawnSync(SIDECAR, ['start'], { cwd: ROOT, env: firstEnv, encoding: 'utf8' });
    assert.equal(initialized.status, 0, `${initialized.stdout}\n${initialized.stderr}`);
    const initializedStop = spawnSync(SIDECAR, ['stop'], { cwd: ROOT, env: firstEnv, encoding: 'utf8' });
    assert.equal(initializedStop.status, 0, `${initializedStop.stdout}\n${initializedStop.stderr}`);

    const second = spawnSync(SIDECAR, ['start'], { cwd: ROOT, env: secondEnv, encoding: 'utf8' });
    assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
    const secondState = readSidecarState(secondDir);
    secondPid = secondState.pid;
    const secondRaw = fs.readFileSync(path.join(secondDir, 'sidecar.pid'), 'utf8');
    const firstDirectory = fs.lstatSync(firstDir, { bigint: true });
    const forged = {
      ...secondState,
      directory: { device: String(firstDirectory.dev), inode: String(firstDirectory.ino) },
    };
    fs.writeFileSync(path.join(firstDir, 'sidecar.pid'), `${JSON.stringify(forged)}\n`, { mode: 0o600 });

    const stopped = spawnSync(SIDECAR, ['stop'], {
      cwd: ROOT,
      env: { ...firstEnv, REDLINE_PORT: 'malformed' },
      encoding: 'utf8',
    });

    assert.equal(stopped.status, 1, `${stopped.stdout}\n${stopped.stderr}`);
    assert.equal(psPgid(secondPid), secondPid);
    assert.equal(fs.readFileSync(path.join(secondDir, 'sidecar.pid'), 'utf8'), secondRaw);
  } finally {
    spawnSync(SIDECAR, ['stop'], { cwd: ROOT, env: secondEnv, encoding: 'utf8' });
    if (secondPid && psPgid(secondPid) !== null) process.kill(secondPid, 'SIGKILL');
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('stop fails closed without deleting tampered live launch metadata', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-sidecar-tampered-stop-'));
  const dir = path.join(home, '.redline');
  const port = await freePort();
  const env = { ...process.env, HOME: home, REDLINE_DIR: dir, REDLINE_PORT: String(port) };
  let pid;

  try {
    const started = spawnSync(SIDECAR, ['start'], { cwd: ROOT, env, encoding: 'utf8' });
    assert.equal(started.status, 0, `${started.stdout}\n${started.stderr}`);
    const state = readSidecarState(dir);
    pid = state.pid;
    state.launch_id = 'rll_00000000000000000000000000000000';
    const tampered = `${JSON.stringify(state)}\n`;
    fs.writeFileSync(path.join(dir, 'sidecar.pid'), tampered, { mode: 0o600 });

    const stopped = spawnSync(SIDECAR, ['stop'], {
      cwd: ROOT,
      env: { ...env, REDLINE_PORT: 'malformed' },
      encoding: 'utf8',
    });

    assert.equal(stopped.status, 1, `${stopped.stdout}\n${stopped.stderr}`);
    assert.equal(psPgid(pid), pid);
    assert.equal(fs.readFileSync(path.join(dir, 'sidecar.pid'), 'utf8'), tampered);
  } finally {
    if (pid && psPgid(pid) !== null) process.kill(pid, 'SIGKILL');
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a whole-directory copy preserves identity but cannot claim the original live launch', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-sidecar-whole-copy-'));
  const firstDir = path.join(home, 'first');
  const copiedDir = path.join(home, 'copied');
  const port = await freePort();
  const firstEnv = { ...process.env, HOME: home, REDLINE_DIR: firstDir, REDLINE_PORT: String(port) };
  const copiedEnv = { ...process.env, HOME: home, REDLINE_DIR: copiedDir, REDLINE_PORT: String(port) };

  try {
    const first = spawnSync(SIDECAR, ['start'], { cwd: ROOT, env: firstEnv, encoding: 'utf8' });
    assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
    const ownerPid = readSidecarPid(firstDir);
    const instanceId = fs.readFileSync(path.join(firstDir, 'instance-id'), 'utf8');
    fs.cpSync(firstDir, copiedDir, { recursive: true });

    const copied = spawnSync(SIDECAR, ['start'], { cwd: ROOT, env: copiedEnv, encoding: 'utf8' });

    assert.equal(copied.status, 1, `${copied.stdout}\n${copied.stderr}`);
    assert.match(copied.stderr, /another data directory or an unmanaged process/);
    assert.equal(fs.readFileSync(path.join(copiedDir, 'instance-id'), 'utf8'), instanceId);
    assert.equal(psPgid(ownerPid), ownerPid);
  } finally {
    spawnSync(SIDECAR, ['stop'], { cwd: ROOT, env: firstEnv, encoding: 'utf8' });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('initialized data directories fail safely when instance identity is missing or corrupt', async () => {
  for (const replacement of [null, 'corrupt\n']) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-sidecar-bad-instance-'));
    const dir = path.join(home, '.redline');
    const port = await freePort();
    const env = { ...process.env, HOME: home, REDLINE_DIR: dir, REDLINE_PORT: String(port) };
    try {
      const started = spawnSync(SIDECAR, ['start'], { cwd: ROOT, env, encoding: 'utf8' });
      assert.equal(started.status, 0, `${started.stdout}\n${started.stderr}`);
      spawnSync(SIDECAR, ['stop'], { cwd: ROOT, env, encoding: 'utf8' });
      const instanceFile = path.join(dir, 'instance-id');
      if (replacement === null) fs.rmSync(instanceFile);
      else fs.writeFileSync(instanceFile, replacement, { mode: 0o600 });

      const restarted = spawnSync(SIDECAR, ['start'], { cwd: ROOT, env, encoding: 'utf8' });

      assert.equal(restarted.status, 1);
      assert.match(restarted.stderr, /instance identity.*missing|instance identity.*corrupt/i);
      assert.equal(fs.existsSync(path.join(dir, 'sidecar.pid')), false);
    } finally {
      spawnSync(SIDECAR, ['stop'], { cwd: ROOT, env, encoding: 'utf8' });
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
});

test('instance identity files reject symlinks without touching their targets', async () => {
  for (const linkedName of ['instance-id', 'instance-id.initialized']) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-sidecar-instance-symlink-'));
    const dir = path.join(home, '.redline');
    const target = path.join(home, 'target');
    const port = await freePort();
    const env = { ...process.env, HOME: home, REDLINE_DIR: dir, REDLINE_PORT: String(port) };
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'instance-id'), 'rli_0123456789abcdef0123456789abcdef\n', { mode: 0o600 });
    fs.writeFileSync(path.join(dir, 'instance-id.initialized'), 'redline-instance-v1\n', { mode: 0o600 });
    fs.writeFileSync(target, 'do-not-touch\n', { mode: 0o644 });
    fs.rmSync(path.join(dir, linkedName));
    fs.symlinkSync(target, path.join(dir, linkedName));

    try {
      const started = spawnSync(SIDECAR, ['start'], { cwd: ROOT, env, encoding: 'utf8' });

      assert.equal(started.status, 1);
      assert.match(started.stderr, /instance identity.*not a regular file/i);
      assert.equal(fs.readFileSync(target, 'utf8'), 'do-not-touch\n');
      assert.equal(fs.existsSync(path.join(dir, 'sidecar.pid')), false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
});

test('one REDLINE_DIR cannot silently manage sidecars on two ports', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-sidecar-different-port-'));
  const dir = path.join(home, '.redline');
  const firstPort = await freePort();
  const secondPort = await freePort();
  const firstEnv = { ...process.env, HOME: home, REDLINE_DIR: dir, REDLINE_PORT: String(firstPort) };
  const secondEnv = { ...process.env, HOME: home, REDLINE_DIR: dir, REDLINE_PORT: String(secondPort) };
  let firstPid = null;

  try {
    const first = spawnSync(SIDECAR, ['start'], { cwd: ROOT, env: firstEnv, encoding: 'utf8' });
    assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
    firstPid = readSidecarPid(dir);

    const second = spawnSync(SIDECAR, ['start'], { cwd: ROOT, env: secondEnv, encoding: 'utf8' });

    assert.equal(second.status, 1);
    assert.match(second.stderr, new RegExp(`REDLINE_DIR=${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} already manages live Redline PID ${firstPid}`));
    assert.equal(readSidecarPid(dir), firstPid);
    assert.equal(psPgid(firstPid), firstPid);
  } finally {
    spawnSync(SIDECAR, ['stop'], { cwd: ROOT, env: firstEnv, encoding: 'utf8' });
    if (firstPid && psPgid(firstPid) !== null) process.kill(firstPid);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('redline-sidecar stop preserves unproven state for a PID owned by another process', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-sidecar-stale-pid-'));
  const dir = path.join(home, '.redline');
  const port = await freePort();
  const env = { ...process.env, HOME: home, REDLINE_DIR: dir, REDLINE_PORT: String(port) };
  const sleeper = require('node:child_process').spawn('sleep', ['30']);

  try {
    fs.mkdirSync(dir, { recursive: true });
    const directory = fs.lstatSync(dir, { bigint: true });
    fs.writeFileSync(path.join(dir, 'sidecar.pid'), `${JSON.stringify({
      version: 1,
      pid: sleeper.pid,
      port,
      instance_id: 'rli_0123456789abcdef0123456789abcdef',
      launch_id: 'rll_fedcba9876543210fedcba9876543210',
      directory: { device: String(directory.dev), inode: String(directory.ino) },
    })}\n`, { mode: 0o600 });
    const stopped = spawnSync(SIDECAR, ['stop'], { cwd: ROOT, env, encoding: 'utf8' });

    assert.equal(stopped.status, 1);
    assert.match(stopped.stdout, /ignored stale pid file/);
    assert.equal(fs.existsSync(path.join(dir, 'sidecar.pid')), true);
    assert.equal(sleeper.exitCode, null);
  } finally {
    sleeper.kill();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('redline-sidecar start preserves live launch state it cannot prove', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-sidecar-unproven-start-'));
  const dir = path.join(home, '.redline');
  const port = await freePort();
  const env = { ...process.env, HOME: home, REDLINE_DIR: dir, REDLINE_PORT: String(port) };
  const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'instance-id'), 'rli_0123456789abcdef0123456789abcdef\n', { mode: 0o600 });
    fs.writeFileSync(path.join(dir, 'instance-id.initialized'), 'redline-instance-v1\n', { mode: 0o600 });
    const directory = fs.lstatSync(dir, { bigint: true });
    const raw = `${JSON.stringify({
      version: 1,
      pid: sleeper.pid,
      port,
      instance_id: 'rli_0123456789abcdef0123456789abcdef',
      launch_id: 'rll_fedcba9876543210fedcba9876543210',
      directory: { device: String(directory.dev), inode: String(directory.ino) },
    })}\n`;
    fs.writeFileSync(path.join(dir, 'sidecar.pid'), raw, { mode: 0o600 });

    const started = spawnSync(SIDECAR, ['start'], { cwd: ROOT, env, encoding: 'utf8' });

    assert.equal(started.status, 1, `${started.stdout}\n${started.stderr}`);
    assert.match(started.stderr, /live launch state.*cannot be proven/i);
    assert.equal(fs.readFileSync(path.join(dir, 'sidecar.pid'), 'utf8'), raw);
    assert.equal(sleeper.exitCode, null);
    await assert.rejects(readHealth(port));
  } finally {
    sleeper.kill();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('dead canonical legacy PID state is removed by start, status, and stop', async () => {
  for (const command of ['start', 'status', 'stop']) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `redline-sidecar-legacy-dead-${command}-`));
    const dir = path.join(home, '.redline');
    const port = await freePort();
    const env = { ...process.env, HOME: home, REDLINE_DIR: dir, REDLINE_PORT: String(port) };
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'sidecar.pid'), '99999999\n', { mode: 0o600 });

      const result = spawnSync(SIDECAR, [command], { cwd: ROOT, env, encoding: 'utf8' });

      if (command === 'start') {
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
        assert.equal(readSidecarState(dir).version, 1);
        spawnSync(SIDECAR, ['stop'], { cwd: ROOT, env, encoding: 'utf8' });
      } else {
        assert.equal(result.status, command === 'status' ? 1 : 0, `${result.stdout}\n${result.stderr}`);
        assert.equal(fs.existsSync(path.join(dir, 'sidecar.pid')), false);
      }
    } finally {
      spawnSync(SIDECAR, ['stop'], { cwd: ROOT, env, encoding: 'utf8' });
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
});

test('numeric-looking noncanonical PID state is not treated as legacy', () => {
  for (const raw of [' 99999999\n', '99999999 \n', '99999999\n\n', '099999999\n']) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-sidecar-legacy-noncanonical-'));
    const dir = path.join(home, '.redline');
    const env = { ...process.env, HOME: home, REDLINE_DIR: dir, REDLINE_PORT: 'malformed' };
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'sidecar.pid'), raw, { mode: 0o600 });

      const stopped = spawnSync(SIDECAR, ['stop'], { cwd: ROOT, env, encoding: 'utf8' });

      assert.equal(stopped.status, 1, `${stopped.stdout}\n${stopped.stderr}`);
      assert.match(stopped.stderr, /invalid launch metadata/i);
      assert.equal(fs.readFileSync(path.join(dir, 'sidecar.pid'), 'utf8'), raw);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
});

test('stop preserves a live canonical legacy PID when argv boundaries are ambiguous', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-sidecar-legacy-live-'));
  const dir = path.join(home, '.redline');
  const preload = path.join(home, 'legacy-server-preload.js');
  const port = await freePort();
  const env = { ...process.env, HOME: home, REDLINE_DIR: dir, REDLINE_PORT: 'malformed' };
  fs.writeFileSync(preload, `
    const Module = require('node:module');
    const path = require('node:path');
    const original = Module._extensions['.js'];
    Module._extensions['.js'] = function legacyFixture(module, filename) {
      if (path.resolve(filename) === path.resolve(process.env.REDLINE_TEST_LEGACY_MAIN)) {
        setInterval(() => {}, 1000);
        return;
      }
      return original(module, filename);
    };
  `);
  const legacy = spawn(process.execPath, [path.join(ROOT, 'runtime/server.js')], {
    env: {
      ...process.env,
      NODE_OPTIONS: `--require=${preload}`,
      REDLINE_TEST_LEGACY_MAIN: path.join(ROOT, 'runtime/server.js'),
    },
    stdio: 'ignore',
  });

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'sidecar.pid'), `${legacy.pid}\n`, { mode: 0o600 });

    const stopped = spawnSync(SIDECAR, ['stop'], { cwd: ROOT, env, encoding: 'utf8', timeout: 3000 });

    assert.equal(stopped.error, undefined);
    assert.equal(stopped.status, 1, `${stopped.stdout}\n${stopped.stderr}`);
    assert.match(stopped.stderr, /legacy.*ownership cannot be proven/i);
    assert.equal(legacy.exitCode, null);
    assert.equal(fs.readFileSync(path.join(dir, 'sidecar.pid'), 'utf8'), `${legacy.pid}\n`);
  } finally {
    if (psPgid(legacy.pid) !== null) legacy.kill('SIGKILL');
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('live legacy PID state with a spaced script path is preserved', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline legacy spaced path '));
  const dir = path.join(home, '.redline');
  const script = path.join(home, 'legacy server path with spaces.js');
  const env = { ...process.env, HOME: home, REDLINE_DIR: dir, REDLINE_PORT: 'malformed' };
  fs.writeFileSync(script, 'setInterval(() => {}, 1000);\n');
  const legacy = spawn(process.execPath, [script], { stdio: 'ignore' });

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'sidecar.pid'), `${legacy.pid}\n`, { mode: 0o600 });

    const stopped = spawnSync(SIDECAR, ['stop'], { cwd: ROOT, env, encoding: 'utf8' });

    assert.equal(stopped.status, 1, `${stopped.stdout}\n${stopped.stderr}`);
    assert.match(stopped.stderr, /legacy.*ownership cannot be proven/i);
    assert.equal(legacy.exitCode, null);
    assert.equal(fs.readFileSync(path.join(dir, 'sidecar.pid'), 'utf8'), `${legacy.pid}\n`);
  } finally {
    legacy.kill('SIGKILL');
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('live numeric PID state for another process fails closed with upgrade instructions', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-sidecar-legacy-wrong-process-'));
  const dir = path.join(home, '.redline');
  const env = { ...process.env, HOME: home, REDLINE_DIR: dir, REDLINE_PORT: 'malformed' };
  const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  const raw = `${sleeper.pid}\n`;

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'sidecar.pid'), raw, { mode: 0o600 });

    const stopped = spawnSync(SIDECAR, ['stop'], { cwd: ROOT, env, encoding: 'utf8' });

    assert.equal(stopped.status, 1, `${stopped.stdout}\n${stopped.stderr}`);
    assert.match(stopped.stderr, /legacy.*ownership cannot be proven/i);
    assert.match(stopped.stderr, /Verify PID .*remove .*sidecar\.pid.*start/i);
    assert.equal(sleeper.exitCode, null);
    assert.equal(fs.readFileSync(path.join(dir, 'sidecar.pid'), 'utf8'), raw);
  } finally {
    sleeper.kill('SIGKILL');
    fs.rmSync(home, { recursive: true, force: true });
  }
});
