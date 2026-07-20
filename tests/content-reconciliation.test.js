const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const content = fs.readFileSync('extension/content.js', 'utf8');

test('content script reconciles visible highlights after ack and focus changes', () => {
  assert.match(content, /async function reconcileHighlights\(/);
  assert.match(content, /pendingServerIdsForPage\(\)/);
  assert.match(content, /const RECONCILE_INTERVAL_MS = 2000/);
  assert.match(content, /window\.addEventListener\('focus', reconcileHighlights\)/);
  assert.match(content, /window\.addEventListener\('pageshow', reconcileHighlights\)/);
  assert.match(content, /document\.addEventListener\('visibilitychange'/);
});

test('content script does not poll the sidecar when the page has no local highlights', () => {
  assert.match(
    content,
    /const data = \(await getLocal\(\[key\]\)\)\[key\] \|\| \[\];\s*if \(!data\.length\) \{[\s\S]*?return;[\s\S]*?\}\s*let pendingIds/s
  );
});

test('content script removes stale highlights when page text changes', () => {
  assert.match(content, /function textStillMatches\(/);
  assert.match(content, /function pruneStaleHighlights\(/);
  assert.match(content, /new MutationObserver/);
});

test('content script handles missing extension storage without crashing', () => {
  assert.match(content, /function storageLocal\(/);
  assert.match(content, /async function getLocal\(/);
  assert.match(content, /async function setLocal\(/);
  assert.doesNotMatch(content, /chrome\.storage\.local/);
});

test('content script explains that an invalidated extension requires a page refresh', () => {
  assert.match(content, /function submissionErrorMessage\(/);
  assert.match(content, /Redline updated\. Refresh this page and try again\./);
  assert.match(content, /Extension context invalidated/i);
});
