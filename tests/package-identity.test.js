'use strict';

const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const STORE_IDENTITY = require('../config/extension-identity.json');
const STORE_ID = STORE_IDENTITY.extension_id;
const INSTANCE_ID = 'rli_0123456789abcdef0123456789abcdef';
const LAUNCH_ID = 'rll_fedcba9876543210fedcba9876543210';

test('installed tarball resolves a fixture Store identity when config is supplied at pack time', async (t) => {
  const sourcePackage = require('../package.json');
  assert.ok(sourcePackage.files.includes('config/'));
  assert.equal(sourcePackage.bin?.['redline-screenshot'], 'runtime/bin/redline-screenshot');
  assert.equal(sourcePackage.dependencies?.['@homebridge/dbus-native'], '0.7.7');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-pack-identity-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const staging = path.join(temp, 'staging');
  fs.mkdirSync(staging);
  for (const entry of ['package.json', 'LICENSE', 'README.md', 'runtime', 'setup', 'extension', 'skills', 'docs']) {
    fs.cpSync(path.join(ROOT, entry), path.join(staging, entry), { recursive: true });
  }
  fs.mkdirSync(path.join(staging, 'config'));
  fs.writeFileSync(
    path.join(staging, 'config', 'extension-identity.json'),
    `${JSON.stringify(STORE_IDENTITY, null, 2)}\n`,
  );
  const packed = spawnSync('npm', ['pack', '--json', '--ignore-scripts'], { cwd: staging, encoding: 'utf8' });
  assert.equal(packed.status, 0, packed.stderr);
  const tarball = path.join(staging, JSON.parse(packed.stdout)[0].filename);
  const installed = path.join(temp, 'installed');
  fs.mkdirSync(installed);
  const extracted = spawnSync('tar', ['-xzf', tarball, '-C', installed], { encoding: 'utf8' });
  assert.equal(extracted.status, 0, extracted.stderr);
  const packageRoot = path.join(installed, 'package');
  assert.equal(require(path.join(packageRoot, 'setup/redline-agent-setup.js')).loadStoreIdentity(packageRoot).extensionId, STORE_ID);
  let portalUrl;
  await require(path.join(packageRoot, 'setup/open-browser.js')).openBrowser('https://example.test/redline', {
    platform: 'linux', portalClient: async (url) => { portalUrl = url; },
    spawn: () => { throw new Error('Linux tarball smoke must not spawn'); },
  });
  assert.equal(portalUrl, 'https://example.test/redline');

  const dataRoot = path.join(temp, 'data');
  fs.mkdirSync(dataRoot, { mode: 0o700 });
  const identity = fs.lstatSync(dataRoot, { bigint: true });
  const listenPort = await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => resolve(port)); });
    probe.on('error', reject);
  });
  const child = spawn(process.execPath, [path.join(packageRoot, 'runtime/server.js'),
    `--redline-launch-id=${LAUNCH_ID}`, `--redline-dir-device=${identity.dev}`, `--redline-dir-inode=${identity.ino}`,
  ], {
    cwd: packageRoot,
    env: {
      ...process.env, REDLINE_DIR: dataRoot, REDLINE_PORT: '7878', REDLINE_LISTEN_PORT: String(listenPort),
      REDLINE_TEST_MODE: '1', REDLINE_INSTANCE_ID: INSTANCE_ID, REDLINE_LAUNCH_ID: LAUNCH_ID,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  t.after(() => child.kill());
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  let healthy = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    healthy = await new Promise((resolve) => {
      const req = http.get({ hostname: '127.0.0.1', port: listenPort, path: '/health', headers: { host: '127.0.0.1:7878' } },
        (res) => { res.resume(); resolve(res.statusCode === 200); });
      req.on('error', () => resolve(false));
    });
    if (healthy) break;
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(healthy, true, stderr);
});
