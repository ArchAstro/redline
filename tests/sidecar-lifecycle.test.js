'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ensureDataDir,
  inspectLifecycleFile,
  removeLifecycleFile,
} = require('../runtime/lib/sidecar-lifecycle');

test('ensureDataDir can validate absence without creating command state', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-lifecycle-dir-'));
  const dir = path.join(home, 'absent');
  try {
    assert.equal(ensureDataDir(dir, { create: false }), false);
    assert.equal(fs.existsSync(dir), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('lifecycle file inspection rejects symlinks and hard links without mutation', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-lifecycle-files-'));
  const outside = path.join(home, 'outside');
  const symlink = path.join(home, 'symlink');
  const hardlink = path.join(home, 'hardlink');
  fs.writeFileSync(outside, '123\n', { mode: 0o644 });
  fs.symlinkSync(outside, symlink);
  fs.linkSync(outside, hardlink);
  try {
    assert.throws(() => inspectLifecycleFile(symlink, 'test file'), /not a regular file/);
    assert.throws(() => inspectLifecycleFile(hardlink, 'test file'), /multiple links/);
    assert.equal(fs.readFileSync(outside, 'utf8'), '123\n');
    assert.equal(fs.statSync(outside).mode & 0o777, 0o644);
    assert.equal(fs.statSync(outside).nlink, 2);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('lifecycle removal requires the expected owner value', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-lifecycle-owner-'));
  const file = path.join(home, 'sidecar.pid');
  fs.writeFileSync(file, '123\n', { mode: 0o600 });
  try {
    assert.throws(() => removeLifecycleFile(file, 'sidecar.pid', '456'), /ownership changed/);
    assert.equal(fs.existsSync(file), true);
    assert.equal(removeLifecycleFile(file, 'sidecar.pid', '123'), true);
    assert.equal(fs.existsSync(file), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
