const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const SYNC = path.join(ROOT, 'setup/sync-versions.js');

function readJson(root, relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

test('release version command synchronizes every public manifest', () => {
  const packageJson = readJson(ROOT, 'package.json');
  assert.equal(packageJson.scripts.version, 'npx changeset version && node setup/sync-versions.js');
  assert.equal(packageJson.scripts['check:versions'], 'node setup/sync-versions.js --check');

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-version-sync-'));
  try {
    for (const relativePath of [
      'package.json',
      'extension/manifest.json',
      '.claude-plugins/redline/.claude-plugin/plugin.json',
      'plugins/redline/.codex-plugin/plugin.json',
      '.claude-plugin/marketplace.json',
    ]) {
      const destination = path.join(temp, relativePath);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(ROOT, relativePath), destination);
    }
    const nextPackage = readJson(temp, 'package.json');
    nextPackage.version = '9.8.7';
    fs.writeFileSync(path.join(temp, 'package.json'), `${JSON.stringify(nextPackage, null, 2)}\n`);

    const result = spawnSync(process.execPath, [SYNC, '--root', temp], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(readJson(temp, 'extension/manifest.json').version, '9.8.7');
    assert.equal(readJson(temp, '.claude-plugins/redline/.claude-plugin/plugin.json').version, '9.8.7');
    assert.equal(readJson(temp, 'plugins/redline/.codex-plugin/plugin.json').version, '9.8.7');
    const marketplace = readJson(temp, '.claude-plugin/marketplace.json');
    assert.equal(marketplace.metadata.version, '9.8.7');
    assert.ok(marketplace.plugins.every(({ version }) => version === '9.8.7'));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('CI uses a Node release that provides the built-in SQLite test runtime', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  assert.match(workflow, /node-version:\s*['"]24['"]/);
});
