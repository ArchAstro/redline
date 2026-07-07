const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

test('extension host permissions use Chrome match patterns without ports', () => {
  const manifest = JSON.parse(fs.readFileSync('extension/manifest.json', 'utf8'));

  assert.deepEqual(manifest.host_permissions, [
    'http://127.0.0.1/*',
    'http://localhost/*',
  ]);
});
