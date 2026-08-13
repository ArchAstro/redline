const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'setup/redline.js');

function runRedline(args, home) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    env: {
      ...process.env, HOME: home, REDLINE_PORT: '65534', REDLINE_DEV_MODE: '1',
      REDLINE_EXTENSION_ID: 'hfjngaflcmkocibdgpeanmhjlkofibca',
    },
    encoding: 'utf8',
  });
}

test('redline version prints the package, helper, and extension inventory', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-cli-version-'));
  try {
    const result = runRedline(['version'], home);
    const pkg = require('../package.json');

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, new RegExp(`^@archastro/redline ${pkg.version}$`, 'm'));
    assert.match(result.stdout, new RegExp(`^cli: ${pkg.version}$`, 'm'));
    assert.match(result.stdout, /^helper: down$/m);
    assert.match(result.stdout, /^extension: /m);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('redline --version is an alias for version', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-cli-version-flag-'));
  try {
    const result = runRedline(['--version'], home);
    const pkg = require('../package.json');

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, new RegExp(`^@archastro/redline ${pkg.version}$`, 'm'));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('redline with no arguments prints a quickstart', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-cli-help-'));
  try {
    const result = runRedline([], home);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /Redline/);
    assert.match(result.stdout, /redline setup/);
    assert.match(result.stdout, /Chrome Web Store/);
    assert.match(result.stdout, /pair/i);
    assert.match(result.stdout, /redline status/);
    assert.match(result.stdout, /redline start/);
    assert.doesNotMatch(result.stdout, /Sync local Chrome extension files/);
    assert.doesNotMatch(result.stdout, /Open chrome:\/\/extensions[^]*Load unpacked/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('redline status routes to extension diagnostics', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-cli-status-'));
  try {
    const result = runRedline(['status'], home);

    assert.equal(result.status, 1);
    assert.match(result.stdout, /Chrome extension status/);
    assert.match(result.stdout, /missing/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('redline setup routes to extension setup', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-cli-setup-'));
  try {
    const result = runRedline(['setup', '--dry-run', '--source', ROOT], home);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /Redline extension setup \(dry run\)/);
    assert.match(result.stdout, /Chrome/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
