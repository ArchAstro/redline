const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const html = fs.readFileSync('extension/popup.html', 'utf8');
const js = fs.readFileSync('extension/popup.js', 'utf8');

test('popup defaults to pending redlines with an all-history escape hatch', () => {
  assert.match(html, /data-filter="pending"/);
  assert.match(html, /data-filter="all"/);
  assert.match(js, /let filter = 'pending'/);
  assert.match(js, /\.filter\(\(it\) => filter === 'all' \|\| it\.status === filter\)/);
});

test('popup gives useful setup and extension reload guidance', () => {
  assert.match(js, /redline start/);
  assert.match(html, /chrome:\/\/extensions/);
  assert.match(js, /chrome\.tabs\.create\(\{ url: 'chrome:\/\/extensions'/);
  assert.match(html, /~\/\.redline\/extension/);
});
