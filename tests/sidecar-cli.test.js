const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const SIDECAR = path.join(ROOT, '.claude-plugins/redline/bin/redline-sidecar');

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

test('redline-sidecar start detaches the daemon into its own process group', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-sidecar-cli-'));
  const dir = path.join(home, '.redline');
  const port = await freePort();
  const env = { ...process.env, HOME: home, REDLINE_DIR: dir, REDLINE_PORT: String(port) };

  try {
    const started = spawnSync(SIDECAR, ['start'], { cwd: ROOT, env, encoding: 'utf8' });
    assert.equal(started.status, 0, `${started.stdout}\n${started.stderr}`);

    const pid = Number(fs.readFileSync(path.join(dir, 'sidecar.pid'), 'utf8').trim());
    assert.ok(pid > 0);
    assert.equal(psPgid(pid), pid);
  } finally {
    spawnSync(SIDECAR, ['stop'], { cwd: ROOT, env, encoding: 'utf8' });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
