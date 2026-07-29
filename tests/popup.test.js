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

test('popup loads injected auth before making sidecar requests', () => {
  assert.match(html, /<script src="auth\.js"><\/script>\s*<script src="popup\.js"><\/script>/);
  assert.match(js, /REDLINE_AUTH_HEADERS/);
  assert.match(js, /x-redline-token/);
});

test('popup identifies a 401 as a stale loaded extension', () => {
  assert.match(js, /response\.status === 401/);
  assert.match(js, /Reload Redline in chrome:\/\/extensions/i);
});

test('popup preserves a redline and reports an error when deletion fails', () => {
  const deleteRequest = js.indexOf("chrome.runtime.sendMessage({ type: 'delete-redline', id: it.id })");
  const responseCheck = js.indexOf('if (!response?.ok)', deleteRequest);
  const localRemoval = js.indexOf('allItems = allItems.filter', deleteRequest);

  assert.ok(deleteRequest >= 0);
  assert.ok(responseCheck > deleteRequest);
  assert.ok(localRemoval > responseCheck);
  assert.match(js, /deleteStatus\.textContent = error\.message/);
  assert.doesNotMatch(js, /sidecarFetch\(`\$\{BASE\}\/redlines\/\$\{it\.id\}`/);
});
