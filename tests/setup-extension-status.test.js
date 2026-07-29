const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const SETUP = path.join(ROOT, 'setup/redline-agent-setup.js');
const PACKAGE_VERSION = require('../package.json').version;

function runStatus(home, envOverrides = {}) {
  return spawnSync(process.execPath, [SETUP, '--extension-status'], {
    cwd: ROOT,
    env: { ...process.env, HOME: home, REDLINE_PORT: '65534', ...envOverrides },
    encoding: 'utf8',
  });
}

function runSetup(args, home, envOverrides = {}) {
  return spawnSync(process.execPath, [SETUP, ...args, '--source', ROOT], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: home,
      REDLINE_PORT: '65534',
      ...envOverrides,
    },
    encoding: 'utf8',
  });
}

test('extension status reports a missing synced extension', () => {
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

test('setup fails when the package omits the Chrome extension', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-missing-extension-home-'));
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-missing-extension-source-'));
  try {
    const result = spawnSync(process.execPath, [SETUP, '--source', source], {
      cwd: ROOT,
      env: { ...process.env, HOME: home },
      encoding: 'utf8',
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Chrome extension source missing/);
    assert.equal(fs.existsSync(path.join(home, '.redline')), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(source, { recursive: true, force: true });
  }
});

test('uninstall works when the saved extension mode JSON is malformed', () => {
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

test('setup fails before writing when required Unix commands are missing', () => {
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

test('setup works without an installed agent or npx', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-no-agent-'));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-runtime-bin-'));
  try {
    for (const command of ['bash', 'curl', 'jq']) {
      const commandPath = path.join(bin, command);
      fs.writeFileSync(commandPath, '#!/bin/sh\nexit 0\n');
      fs.chmodSync(commandPath, 0o755);
    }

    const result = runSetup([], home, { PATH: bin });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.existsSync(path.join(home, '.redline/extension/manifest.json')), true);
    assert.equal(fs.existsSync(path.join(home, '.agents')), false);
    assert.equal(fs.existsSync(path.join(home, '.claude')), false);
    assert.equal(fs.existsSync(path.join(home, '.codex')), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test('setup and uninstall never modify user-managed skills or plugin state', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-user-skill-state-'));
  try {
    const skillPath = path.join(home, '.agents/skills/redline/SKILL.md');
    const lockPath = path.join(home, '.agents/.skill-lock.json');
    const legacyPath = path.join(home, '.claude/plugins/cache/redline/sentinel.txt');
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(skillPath, 'unrelated user-managed skill\n');
    fs.writeFileSync(lockPath, '{"source":"someone/else"}\n');
    fs.writeFileSync(legacyPath, 'keep me\n');

    assert.equal(runSetup([], home).status, 0);
    assert.equal(runSetup(['--uninstall'], home).status, 0);

    assert.equal(fs.readFileSync(skillPath, 'utf8'), 'unrelated user-managed skill\n');
    assert.equal(fs.readFileSync(lockPath, 'utf8'), '{"source":"someone/else"}\n');
    assert.equal(fs.readFileSync(legacyPath, 'utf8'), 'keep me\n');
    assert.equal(fs.existsSync(path.join(home, '.redline/extension')), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('removed agent-scoped flags direct users to npx skills', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-agent-flags-'));
  try {
    const result = runSetup(['--codex-only'], home);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /manage agent skills directly with npx skills/i);
    assert.equal(fs.existsSync(path.join(home, '.redline')), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('setup injects custom sidecar directory and port configuration', () => {
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

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /screenshots: enabled/);
    assert.match(result.stdout, /Agent skills are unchanged/);
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

    const config = JSON.parse(fs.readFileSync(path.join(home, '.redline/config.json'), 'utf8'));
    assert.equal(config.extensionMode, 'full');

    const rerun = runSetup([], home);
    assert.equal(rerun.status, 0, rerun.stderr || rerun.stdout);
    assert.match(rerun.stdout, /screenshots: enabled/);
    assert.match(rerun.stdout, /extension:\s+already up to date/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('setup local-only switches back to the low-permission extension', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-status-local-'));
  try {
    assert.equal(runSetup(['--with-screenshots'], home).status, 0);

    const result = runSetup(['--local-only'], home);

    assert.equal(result.status, 0, result.stderr || result.stdout);
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
    assert.match(full.stdout, /synced: extension files match/);
    assert.doesNotMatch(full.stdout, /skills:/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('extension status reports version mismatch and reload guidance', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-status-stale-'));
  try {
    const extension = path.join(home, '.redline/extension');
    fs.mkdirSync(extension, { recursive: true });
    fs.writeFileSync(path.join(extension, 'manifest.json'), JSON.stringify({
      manifest_version: 3,
      name: 'Redline',
      version: '0.1.0',
    }));

    const result = runStatus(home);

    assert.equal(result.status, 1);
    assert.match(result.stdout, /installed: 0\.1\.0/);
    assert.ok(result.stdout.includes(`package: ${PACKAGE_VERSION}`));
    assert.match(result.stdout, /out of sync/);
    assert.match(result.stdout, /chrome:\/\/extensions/);
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
