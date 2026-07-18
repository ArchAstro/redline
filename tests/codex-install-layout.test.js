const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const SETUP = path.join(ROOT, 'setup/redline-agent-setup.js');
const CANONICAL_SERVER = path.join(ROOT, '.claude-plugins/redline/server.js');
const VERSION = require('../plugins/redline/.codex-plugin/plugin.json').version;

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

function requestHealth(port) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/health`, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }));
    });
    req.on('error', reject);
  });
}

function runSetup(home, args = []) {
  return spawnSync(process.execPath, [SETUP, '--codex-only', ...args], {
    cwd: ROOT,
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
  });
}

function mode(file) {
  return fs.statSync(file).mode & 0o777;
}

function executableInstallFiles(installRoot) {
  return [
    path.join(installRoot, 'server.js'),
    ...fs.readdirSync(path.join(installRoot, 'bin'))
      .map((name) => path.join(installRoot, 'bin', name)),
  ];
}

function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

async function waitForProcessExit(pid) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (!processIsRunning(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`sidecar process ${pid} did not exit`);
}

test('Codex-only setup installs self-contained sidecars in both plugin roots', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-codex-install-'));
  const port = await freePort();
  const env = {
    ...process.env,
    HOME: home,
    REDLINE_PORT: String(port),
    REDLINE_DIR: path.join(home, '.redline-test'),
  };
  const cacheRoot = path.join(home, '.codex/plugins/cache/redline/redline', VERSION);
  const marketplacePluginRoot = path.join(home, '.agents/plugins/plugins/redline');
  const installedBin = path.join(cacheRoot, 'bin/redline-sidecar');
  const pidFile = path.join(env.REDLINE_DIR, 'sidecar.pid');
  let sidecarPid = null;

  try {
    const setup = runSetup(home);
    assert.equal(setup.status, 0, setup.stderr || setup.stdout);

    const canonicalSource = fs.readFileSync(CANONICAL_SERVER, 'utf8');
    for (const installRoot of [cacheRoot, marketplacePluginRoot]) {
      const installedServer = path.join(installRoot, 'server.js');
      assert.equal(fs.readFileSync(installedServer, 'utf8'), canonicalSource);
      assert.ok(fs.statSync(installedServer).mode & 0o111, `${installedServer} must be executable`);
      assert.ok(fs.statSync(path.join(installRoot, 'bin/redline-sidecar')).mode & 0o111);
    }

    const installedExecutables = [cacheRoot, marketplacePluginRoot]
      .flatMap(executableInstallFiles);
    for (const file of installedExecutables) fs.chmodSync(file, 0o644);

    const dryRun = runSetup(home, ['--dry-run']);
    assert.equal(dryRun.status, 0, dryRun.stderr || dryRun.stdout);
    assert.match(dryRun.stdout, new RegExp(`codex:\\s+installed v${VERSION.replaceAll('.', '\\.')}`));
    for (const file of installedExecutables) assert.equal(mode(file), 0o644);

    const reinstall = runSetup(home);
    assert.equal(reinstall.status, 0, reinstall.stderr || reinstall.stdout);
    assert.match(reinstall.stdout, new RegExp(`codex:\\s+installed v${VERSION.replaceAll('.', '\\.')}`));
    for (const file of installedExecutables) assert.ok(mode(file) & 0o111, `${file} must be executable`);

    const unchanged = runSetup(home);
    assert.equal(unchanged.status, 0, unchanged.stderr || unchanged.stdout);
    assert.match(unchanged.stdout, /codex:\s+already up to date/);

    const start = spawnSync(installedBin, ['start'], { env, encoding: 'utf8' });
    assert.equal(start.status, 0, start.stderr || start.stdout);
    sidecarPid = Number.parseInt(fs.readFileSync(pidFile, 'utf8'), 10);
    assert.ok(Number.isInteger(sidecarPid));

    const health = await requestHealth(port);
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);
    assert.equal(health.body.port, port);
  } finally {
    if (sidecarPid !== null) {
      const stop = spawnSync(installedBin, ['stop'], { env, encoding: 'utf8' });
      assert.equal(stop.status, 0, stop.stderr || stop.stdout);
      await waitForProcessExit(sidecarPid);
      assert.equal(processIsRunning(sidecarPid), false);
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
});
