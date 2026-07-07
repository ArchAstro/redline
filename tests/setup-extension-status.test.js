const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const SETUP = path.join(ROOT, 'setup/redline-agent-setup.js');

function runStatus(home) {
  return spawnSync(process.execPath, [SETUP, '--extension-status'], {
    cwd: ROOT,
    env: { ...process.env, HOME: home, REDLINE_PORT: '65534' },
    encoding: 'utf8',
  });
}

function runSetup(args, home) {
  return spawnSync(process.execPath, [SETUP, ...args, '--plugin-source', ROOT], {
    cwd: ROOT,
    env: { ...process.env, HOME: home, REDLINE_PORT: '65534' },
    encoding: 'utf8',
  });
}

test('extension status reports missing synced extension', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-status-missing-'));
  try {
    const result = runStatus(home);

    assert.equal(result.status, 1);
    assert.match(result.stdout, /Chrome extension status/);
    assert.match(result.stdout, /missing/);
    assert.match(result.stdout, /redline setup --with-screenshots/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('setup with screenshots syncs a full-access extension and persists the mode', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-status-full-'));
  try {
    const result = runSetup(['--with-screenshots'], home);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /screenshots: enabled/);
    assert.match(result.stdout, /works on any http\/https page/);

    const manifest = JSON.parse(fs.readFileSync(path.join(home, '.redline/extension/manifest.json'), 'utf8'));
    assert.ok(manifest.host_permissions.includes('<all_urls>'));
    assert.ok(manifest.content_scripts[0].matches.includes('<all_urls>'));

    const config = JSON.parse(fs.readFileSync(path.join(home, '.redline/config.json'), 'utf8'));
    assert.equal(config.extensionMode, 'full');

    const rerun = runSetup([], home);
    assert.equal(rerun.status, 0);
    assert.match(rerun.stdout, /screenshots: enabled/);

    const persistedManifest = JSON.parse(fs.readFileSync(path.join(home, '.redline/extension/manifest.json'), 'utf8'));
    assert.ok(persistedManifest.host_permissions.includes('<all_urls>'));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('setup local-only switches back to the low-permission extension', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-status-local-'));
  try {
    assert.equal(runSetup(['--with-screenshots'], home).status, 0);

    const result = runSetup(['--local-only'], home);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /screenshots: limited/);

    const manifest = JSON.parse(fs.readFileSync(path.join(home, '.redline/extension/manifest.json'), 'utf8'));
    assert.ok(!manifest.host_permissions.includes('<all_urls>'));
    assert.ok(!manifest.content_scripts[0].matches.includes('<all_urls>'));

    const config = JSON.parse(fs.readFileSync(path.join(home, '.redline/config.json'), 'utf8'));
    assert.equal(config.extensionMode, 'local');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('extension status reports screenshot capability and upgrade command', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-status-mode-'));
  try {
    assert.equal(runSetup(['--local-only'], home).status, 0);

    const limited = runStatus(home);
    assert.equal(limited.status, 1);
    assert.match(limited.stdout, /mode: local-only/);
    assert.match(limited.stdout, /screenshots: limited/);
    assert.match(limited.stdout, /redline setup --with-screenshots/);

    assert.equal(runSetup(['--with-screenshots'], home).status, 0);
    const full = runStatus(home);
    assert.equal(full.status, 1);
    assert.match(full.stdout, /mode: full-access/);
    assert.match(full.stdout, /screenshots: enabled/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('extension status reports version mismatch and reload guidance', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-status-stale-'));
  try {
    const ext = path.join(home, '.redline/extension');
    fs.mkdirSync(ext, { recursive: true });
    fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify({
      manifest_version: 3,
      name: 'Redline',
      version: '0.1.0',
    }));

    const result = runStatus(home);

    assert.equal(result.status, 1);
    assert.match(result.stdout, /installed: 0\.1\.0/);
    assert.match(result.stdout, /package: 0\.2\.3/);
    assert.match(result.stdout, /out of sync/);
    assert.match(result.stdout, /redline setup/);
    assert.match(result.stdout, /chrome:\/\/extensions/);
    assert.match(result.stdout, /Reload/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
