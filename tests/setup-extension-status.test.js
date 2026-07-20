const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const SETUP = path.join(ROOT, 'setup/redline-agent-setup.js');
const PACKAGE_VERSION = require('../package.json').version;

function runStatus(home) {
  return spawnSync(process.execPath, [SETUP, '--extension-status'], {
    cwd: ROOT,
    env: { ...process.env, HOME: home, REDLINE_PORT: '65534' },
    encoding: 'utf8',
  });
}

function runSetup(args, home, envOverrides = {}) {
  return spawnSync(process.execPath, [SETUP, ...args, '--plugin-source', ROOT], {
    cwd: ROOT,
    env: { ...process.env, HOME: home, REDLINE_PORT: '65534', ...envOverrides },
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

test('setup exits nonzero when requested components cannot be installed', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-setup-failure-'));
  try {
    const missingSource = path.join(home, 'missing-package');
    const result = spawnSync(process.execPath, [SETUP, '--plugin-source', missingSource], {
      cwd: ROOT,
      env: { ...process.env, HOME: home },
      encoding: 'utf8',
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Chrome extension source missing/i);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('setup fails when an otherwise valid package omits the Chrome extension', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-missing-extension-home-'));
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-missing-extension-source-'));
  try {
    fs.cpSync(path.join(ROOT, '.claude-plugins'), path.join(source, '.claude-plugins'), { recursive: true });
    fs.cpSync(path.join(ROOT, '.claude-plugin'), path.join(source, '.claude-plugin'), { recursive: true });
    const result = spawnSync(process.execPath, [SETUP, '--claude-only', '--plugin-source', source], {
      cwd: ROOT,
      env: { ...process.env, HOME: home },
      encoding: 'utf8',
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Chrome extension source missing/);
    assert.equal(fs.existsSync(path.join(home, '.redline/extension')), false);
    assert.equal(fs.existsSync(path.join(home, '.claude')), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(source, { recursive: true, force: true });
  }
});

test('uninstall still works when the saved extension mode JSON is malformed', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-uninstall-invalid-config-'));
  try {
    const extension = path.join(home, '.redline/extension');
    fs.mkdirSync(extension, { recursive: true });
    fs.writeFileSync(path.join(home, '.redline/config.json'), '{ invalid JSON');
    const result = runSetup(['--uninstall'], home);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.existsSync(extension), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('setup fails before installing when required Unix commands are missing', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-setup-prereqs-'));
  try {
    const result = runSetup([], home, { PATH: '' });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /missing required commands/i);
    assert.match(result.stderr, /bash/);
    assert.match(result.stderr, /curl/);
    assert.match(result.stderr, /jq/);
    assert.equal(fs.existsSync(path.join(home, '.redline')), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('setup injects custom sidecar directory and port configuration into the extension', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-status-custom-'));
  const customDir = path.join(home, 'custom-redline-data');
  try {
    const result = runSetup([], home, {
      REDLINE_DIR: customDir,
      REDLINE_PORT: '61234',
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const token = fs.readFileSync(path.join(customDir, 'auth-token'), 'utf8').trim();
    const installedAuth = fs.readFileSync(path.join(home, '.redline/extension/auth.js'), 'utf8');
    assert.match(installedAuth, new RegExp(token));
    assert.match(installedAuth, /port:\s*61234/);
    assert.equal(fs.existsSync(path.join(home, '.redline/auth-token')), false);
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
    assert.match(result.stdout, /reload the page tabs/);

    const manifest = JSON.parse(fs.readFileSync(path.join(home, '.redline/extension/manifest.json'), 'utf8'));
    assert.ok(manifest.host_permissions.includes('<all_urls>'));
    assert.ok(manifest.content_scripts[0].matches.includes('<all_urls>'));

    const authTokenPath = path.join(home, '.redline/auth-token');
    const authToken = fs.readFileSync(authTokenPath, 'utf8').trim();
    const installedAuth = fs.readFileSync(path.join(home, '.redline/extension/auth.js'), 'utf8');
    assert.ok(authToken.length >= 43);
    assert.equal(fs.statSync(authTokenPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(home, '.redline')).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(home, '.redline/extension')).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(home, '.redline/extension/auth.js')).mode & 0o777, 0o600);
    assert.match(installedAuth, new RegExp(authToken));
    assert.doesNotMatch(installedAuth, /__REDLINE_AUTH_TOKEN__/);

    const config = JSON.parse(fs.readFileSync(path.join(home, '.redline/config.json'), 'utf8'));
    assert.equal(config.extensionMode, 'full');
    assert.equal(fs.statSync(path.join(home, '.claude/settings.json')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(home, '.agents/plugins/marketplace.json')).mode & 0o777, 0o600);

    const rerun = runSetup([], home);
    assert.equal(rerun.status, 0);
    assert.match(rerun.stdout, /screenshots: enabled/);
    assert.match(rerun.stdout, /claude:\s+already up to date/);
    assert.match(rerun.stdout, /codex:\s+already up to date/);
    assert.match(rerun.stdout, /extension:\s+already up to date/);

    const persistedManifest = JSON.parse(fs.readFileSync(path.join(home, '.redline/extension/manifest.json'), 'utf8'));
    assert.ok(persistedManifest.host_permissions.includes('<all_urls>'));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('setup preserves other Codex marketplace entries', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-marketplace-merge-'));
  try {
    const marketplacePath = path.join(home, '.agents/plugins/marketplace.json');
    fs.mkdirSync(path.dirname(marketplacePath), { recursive: true });
    fs.writeFileSync(marketplacePath, JSON.stringify({
      name: 'personal',
      interface: { displayName: 'Personal tools' },
      plugins: [{ name: 'existing', source: { source: 'local', path: './plugins/existing' } }],
    }));

    const result = runSetup([], home);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const marketplace = JSON.parse(fs.readFileSync(marketplacePath, 'utf8'));
    assert.deepEqual(marketplace.plugins.map((plugin) => plugin.name), ['existing', 'redline']);
    assert.equal(marketplace.name, 'personal');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('setup rejects malformed shared JSON without overwriting it', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-invalid-json-'));
  try {
    const marketplacePath = path.join(home, '.agents/plugins/marketplace.json');
    const malformed = '{ definitely not valid JSON';
    fs.mkdirSync(path.dirname(marketplacePath), { recursive: true });
    fs.writeFileSync(marketplacePath, malformed);

    const result = runSetup([], home);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /invalid JSON/);
    assert.equal(fs.readFileSync(marketplacePath, 'utf8'), malformed);
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
    assert.ok(result.stdout.includes(`package: ${PACKAGE_VERSION}`));
    assert.match(result.stdout, /out of sync/);
    assert.match(result.stdout, /redline setup/);
    assert.match(result.stdout, /chrome:\/\/extensions/);
    assert.match(result.stdout, /Reload/);
    assert.match(result.stdout, /reload the page tabs/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('extension status detects changed files even when the version matches', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-status-file-stale-'));
  try {
    assert.equal(runSetup(['--with-screenshots'], home).status, 0);
    fs.appendFileSync(path.join(home, '.redline/extension/background.js'), '\n// stale copy\n');

    const result = runStatus(home);

    assert.equal(result.status, 1);
    assert.match(result.stdout, /out of sync/);
    assert.doesNotMatch(result.stdout, /files match/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
