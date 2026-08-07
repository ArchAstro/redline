const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const PACKAGE = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

function readManifest(name = 'manifest.json') {
  return JSON.parse(fs.readFileSync(`extension/${name}`, 'utf8'));
}

test('store manifest is least-privilege MV3 with one exact connect-page reader', () => {
  const manifest = readManifest();

  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ['storage', 'activeTab', 'scripting', 'alarms']);
  assert.ok(Number(manifest.minimum_chrome_version) >= 111);
  assert.deepEqual(manifest.host_permissions, ['http://127.0.0.1:7878/*']);
  assert.deepEqual(manifest.optional_host_permissions, ['http://*/*', 'https://*/*']);
  assert.deepEqual(manifest.content_scripts, [{
    matches: ['http://127.0.0.1:7878/connect'],
    js: ['connect.js'],
    run_at: 'document_start',
    all_frames: false,
  }]);
  assert.equal(manifest.background.service_worker, 'background.js');
  assert.equal(manifest.background.type, undefined);
  assert.equal(manifest.externally_connectable, undefined);
  assert.equal(JSON.stringify(manifest).includes('auth.js'), false);
  assert.equal(JSON.stringify(manifest).includes('content.js'), false);
  assert.equal(JSON.stringify(manifest).includes('http://localhost'), false);
  assert.equal(JSON.stringify(manifest).includes('https://localhost'), false);
});

test('contributor manifest explicitly retains unpacked local-page behavior', () => {
  assert.equal(fs.existsSync('extension/manifest.dev.json'), true,
    'contributor manifest must be an explicit source file');
  const manifest = readManifest('manifest.dev.json');

  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ['activeTab', 'storage', 'alarms']);
  assert.deepEqual(manifest.host_permissions, [
    'http://127.0.0.1/*',
    'http://localhost/*',
  ]);
  assert.deepEqual(manifest.content_scripts, [{
    matches: [
      'http://localhost/*',
      'https://localhost/*',
      'http://127.0.0.1/*',
      'https://127.0.0.1/*',
      'http://*.localhost/*',
      'https://*.localhost/*',
    ],
    js: ['content.js'],
    css: ['content.css'],
    run_at: 'document_idle',
  }]);
});

test('contributor setup generates only unpacked output from the dev manifest and auth template', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-manifest-dev-'));
  try {
    const result = spawnSync(process.execPath, [
      path.join(ROOT, 'setup/redline-agent-setup.js'), '--source', ROOT,
    ], {
      cwd: ROOT,
      env: {
        ...process.env,
        HOME: home,
        REDLINE_DIR: path.join(home, 'data'),
        REDLINE_PORT: '61234',
        REDLINE_DEV_MODE: '1',
        REDLINE_EXTENSION_ID: 'hfjngaflcmkocibdgpeanmhjlkofibca',
      },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const output = path.join(home, '.redline/extension');
    const installed = JSON.parse(fs.readFileSync(path.join(output, 'manifest.json'), 'utf8'));
    assert.deepEqual(installed, readManifest('manifest.dev.json'));
    assert.equal(fs.existsSync(path.join(output, 'manifest.dev.json')), false);
    assert.match(fs.readFileSync(path.join(output, 'auth.js'), 'utf8'), /port:\s*61234/);
    assert.match(fs.readFileSync(path.join(output, 'background.js'), 'utf8'),
      /^importScripts\('auth\.js'\);/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('store worker has no generated auth dependency while contributor output receives one', () => {
  const storeWorker = fs.readFileSync('extension/background.js', 'utf8');

  assert.doesNotMatch(storeWorker, /importScripts\(['"]auth\.js['"]\)/);
  assert.doesNotMatch(storeWorker, /REDLINE_CONFIG\.port/);
  assert.match(storeWorker, /const PORT = DEV_CONFIG\?\.port \?\? 7878;/);
});

test('release syntax validation covers every store onboarding script', () => {
  for (const file of ['extension/connect.js', 'extension/connection.js', 'extension/onboarding.js']) {
    assert.match(PACKAGE.scripts['check:syntax'], new RegExp(`node -c ${file.replace('.', '\\.')}`));
  }
});
