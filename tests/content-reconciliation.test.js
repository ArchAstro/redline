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

test('content script removes stale highlights when page text changes', () => {
  assert.match(content, /function textStillMatches\(/);
  assert.match(content, /function pruneStaleHighlights\(/);
  assert.match(content, /new MutationObserver/);
});
