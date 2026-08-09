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

test('content script expires browser marker content after seven days', () => {
  assert.match(content, /const MARKER_TTL_MS = 7 \* 24 \* 60 \* 60 \* 1000/);
  assert.match(content, /expires_at/);
  assert.match(content, /Date\.parse\(expires_at\) > Date\.now\(\)/);
});

test('marker persistence failure cannot turn a committed submission into a displayed failure', () => {
  assert.match(content, /addHighlight\(resp\.item, range, ser\);\s*try \{\s*await upsertLocal/s);
  assert.match(content, /console\.warn\('\[redline\] marker persistence failed:'/);
});

test('content script brokers marker storage through the trusted service worker', () => {
  assert.match(content, /async function getLocal\(/);
  assert.match(content, /async function setLocal\(/);
  assert.match(content, /type: 'marker-storage-get'/);
  assert.match(content, /type: 'marker-storage-set'/);
  assert.doesNotMatch(content, /chrome\.storage\.local/);
});

test('content script explains that an invalidated extension requires a page refresh', () => {
  assert.match(content, /function submissionErrorMessage\(/);
  assert.match(content, /Redline updated\. Refresh this page and try again\./);
  assert.match(content, /Extension context invalidated/i);
});

test('content script tears down page UI when site permission is revoked', () => {
  assert.match(content, /function disableRedline\(/);
  assert.match(content, /chrome\.runtime\.onMessage\.addListener/);
  assert.match(content, /message\.type === 'redline-disable-site'/);
  assert.match(content, /STATE\.button\?\.remove\(\)/);
  assert.match(content, /STATE\.popover\?\.remove\(\)/);
  assert.match(content, /CSS\.highlights\.delete\('rl-redline'\)/);
  assert.match(content, /clearInterval\(STATE\.reconcileTimer\)/);
  assert.match(content, /STATE\.observer\?\.disconnect\(\)/);
});

test('reinjecting the content script re-enables the same loaded page without duplicate listeners', () => {
  assert.match(content, /if \(window\.__rlInjected\) \{\s*window\.__rlEnable\?\.\(\);\s*return;\s*\}/);
  assert.match(content, /function enableRedline\(\)/);
  assert.match(content, /STATE\.disabled = false/);
  assert.match(content, /window\.__rlEnable = enableRedline/);
  assert.match(content, /function startReconciliation\(\)/);
});
