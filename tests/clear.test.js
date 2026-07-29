const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('redline-clear removes the database and captured screenshots', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-clear-'));
  try {
    fs.mkdirSync(path.join(dir, 'screenshots'));
    fs.writeFileSync(path.join(dir, 'redlines.json'), '[]');
    fs.writeFileSync(path.join(dir, 'screenshots', 'ss_test.png'), 'png');

    const result = spawnSync('bash', ['runtime/bin/redline-clear'], {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, REDLINE_DIR: dir },
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(path.join(dir, 'redlines.json')), false);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'screenshots')), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('redline-clear exits nonzero and does not claim success when cleanup fails', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-clear-failure-'));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-clear-bin-'));
  try {
    fs.mkdirSync(path.join(dir, 'screenshots'));
    fs.writeFileSync(path.join(dir, 'redlines.json'), '[]');
    fs.writeFileSync(path.join(dir, 'screenshots', 'ss_test.png'), 'png');
    const fakeRm = path.join(bin, 'rm');
    fs.writeFileSync(fakeRm, `#!/usr/bin/env bash\ncase "$*" in *screenshots*) exit 1;; *) exec /bin/rm "$@";; esac\n`);
    fs.chmodSync(fakeRm, 0o755);

    const result = spawnSync('bash', ['runtime/bin/redline-clear'], {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, REDLINE_DIR: dir },
      encoding: 'utf8',
    });

    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout, /cleared/);
    assert.equal(fs.existsSync(path.join(dir, 'screenshots', 'ss_test.png')), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  }
});
