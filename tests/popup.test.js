const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync('extension/popup.html', 'utf8');
const js = fs.readFileSync('extension/popup.js', 'utf8');
const css = fs.existsSync('extension/popup.css')
  ? fs.readFileSync('extension/popup.css', 'utf8')
  : '';

test('popup defaults to pending redlines with an all-history escape hatch', () => {
  assert.match(html, /data-filter="pending"/);
  assert.match(html, /data-filter="all"/);
  assert.match(js, /let filter = 'pending'/);
  assert.match(js, /\.filter\(\(it\) => filter === 'all' \|\| it\.status === filter\)/);
});

test('popup is a compact store surface with connection and per-site controls', () => {
  assert.match(html, /<link rel="stylesheet" href="popup\.css">/);
  assert.match(html, /id="connection-status"/);
  assert.match(html, /id="enable-site"[^>]*>Enable Redline on this site/);
  assert.match(html, /id="disable-site"[^>]*>Disable on this site/);
  assert.match(html, /id="open-setup"[^>]*>Open setup page/);
  assert.match(html, /id="disable-everywhere"[^>]*>Disable everywhere/);
  assert.match(js, /onboarding\.html/);
  assert.match(js, /cannot pair/);
  assert.match(js, /Open the setup page/);
  assert.match(css, /width:\s*360px/);
});

test('popup exposes full visual mode only behind a screenshot disclosure', () => {
  assert.match(html, /id="full-visual"[^>]*type="checkbox"/);
  assert.match(html, /visible-tab screenshot/i);
  assert.match(html, /access to all websites/i);
  assert.match(html, /may need to enable sites again/i);
  assert.match(js, /enable-full-visual/);
  assert.match(js, /disable-full-visual/);
  const visualChange = js.indexOf("getElementById('full-visual').addEventListener('change'");
  const visualMutation = js.indexOf("type: 'disable-full-visual'", visualChange);
  const stateRefresh = js.indexOf("type: 'permission-state'", visualMutation);
  assert.ok(visualChange >= 0 && visualMutation > visualChange && stateRefresh > visualMutation);
  assert.doesNotMatch(js, /registerContentScripts/);
});

test('popup requests optional access inside its user gesture before worker reconciliation', () => {
  assert.doesNotMatch(html, /auth\.js/);
  assert.doesNotMatch(js, /REDLINE_AUTH_HEADERS|x-redline-token|fetch\(/);
  const siteClick = js.indexOf("getElementById('enable-site').addEventListener('click'");
  const siteRequest = js.indexOf('chrome.permissions.request', siteClick);
  const siteReconcile = js.indexOf("type: 'enable-site'", siteClick);
  const visualChange = js.indexOf("getElementById('full-visual').addEventListener('change'");
  const visualRequest = js.indexOf('chrome.permissions.request', visualChange);
  const visualReconcile = js.indexOf("type: 'enable-full-visual'", visualChange);
  assert.ok(siteClick >= 0 && siteRequest > siteClick && siteReconcile > siteRequest);
  assert.ok(visualChange >= 0 && visualRequest > visualChange && visualReconcile > visualRequest);
  assert.match(js, /type: 'connection-status'/);
  assert.match(js, /type: 'permission-state'/);
  assert.match(js, /error_code/);
  assert.match(js, /restricted_url/);
  assert.match(js, /Chrome pages cannot be enabled/i);
});

test('popup preserves a redline and reports an error when deletion fails', () => {
  const deleteRequest = js.indexOf("chrome.runtime.sendMessage({ type: 'delete-redline', id: it.id })");
  const responseCheck = js.indexOf('if (!response?.ok)', deleteRequest);
  const localRemoval = js.indexOf('allItems = allItems.filter', deleteRequest);

  assert.ok(deleteRequest >= 0);
  assert.ok(responseCheck > deleteRequest);
  assert.ok(localRemoval > responseCheck);
  assert.match(js, /deleteStatus\.textContent = error\.message/);
  assert.doesNotMatch(js, /fetch\(`\$\{BASE\}\/redlines\/\$\{it\.id\}`/);
});

test('popup lets users inspect an attached screenshot through the trusted worker', () => {
  assert.match(js, /it\.screenshot_id \? '<button class="screenshot">View screenshot<\/button>'/);
  assert.match(js, /type: 'get-screenshot', id: screenshotId/);
  assert.match(js, /URL\.createObjectURL/);
  assert.match(js, /chrome\.tabs\.create\(\{ url: objectUrl \}\)/);
  assert.doesNotMatch(js, /\/screenshots\//);
});

test('popup keeps refresh, disconnect, and clear-data controls', () => {
  assert.match(html, /id="refreshShot"/);
  assert.match(html, /id="disconnect"/);
  assert.match(html, /id="clear-data"/);
  assert.match(js, /type: 'refresh-screenshot'/);
  assert.match(js, /type: 'disconnect'/);
  assert.match(js, /type: 'clear-data'/);
  assert.match(js, /other Chrome profiles retain their browser-local drafts and permissions/i);
});

test('popup can recover from a stale background worker after an extension upgrade', () => {
  assert.match(html, /id="restart-extension"[^>]*hidden>Restart Redline<\/button>/);
  assert.match(html, /id="enable-site"[^>]*data-worker-control[^>]*disabled/);
  assert.match(js, /const WORKER_PROTOCOL_VERSION = 1/);
  assert.match(js, /connection\.protocol_version !== WORKER_PROTOCOL_VERSION/);
  assert.match(js, /worker_version_mismatch/);
  assert.match(js, /showRestartRecovery\(message\)/);
  assert.match(js, /chrome\.runtime\.reload\(\)/);
  assert.match(js, /window\.close\(\)/);
  assert.match(js, /!permissionState\?\.pattern/);
});

test('an old worker response exposes a working restart action', async () => {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) {
      const handlers = {};
      elements.set(id, {
        id,
        handlers,
        hidden: false,
        disabled: false,
        checked: false,
        dataset: {},
        classList: { add() {}, remove() {}, toggle() {} },
        addEventListener(type, handler) { handlers[type] = handler; },
        appendChild() {},
        querySelector() { return null; },
        textContent: '',
        innerHTML: '',
      });
    }
    return elements.get(id);
  };
  const workerControls = [
    'enable-site', 'disable-site', 'full-visual', 'refreshShot',
    'disconnect', 'disable-everywhere', 'clear-data',
  ].map(element);
  const filters = ['pending', 'all'].map((name) => {
    const control = element(`filter-${name}`);
    control.dataset.filter = name;
    workerControls.push(control);
    return control;
  });
  for (const id of ['site-message', 'connection-status', 'restart-extension', 'open-setup', 'origin', 'list', 'counts']) {
    element(id);
  }
  let reloaded = false;
  let closed = false;
  const context = {
    URL,
    console,
    confirm: () => false,
    setTimeout,
    clearTimeout,
    chrome: {
      tabs: { query: async () => [{ id: 7, url: 'http://127.0.0.1:5173/' }] },
      runtime: {
        sendMessage: async () => ({ ok: false, error: 'unknown message: connection-status' }),
        reload() { reloaded = true; },
      },
      permissions: {},
    },
    document: {
      getElementById: element,
      querySelectorAll(selector) {
        if (selector === '[data-worker-control]') return workerControls;
        if (selector === '[data-filter]') return filters;
        return [];
      },
      createElement() { return element('created'); },
    },
    window: { close() { closed = true; } },
  };

  vm.runInNewContext(js, context);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(element('connection-status').textContent, 'Restart needed');
  assert.match(element('site-message').textContent, /after an update/i);
  assert.doesNotMatch(element('site-message').textContent, /unknown message/i);
  assert.equal(element('restart-extension').hidden, false);
  assert.equal(workerControls.every((control) => control.disabled), true);

  element('restart-extension').handlers.click({ currentTarget: element('restart-extension') });
  assert.equal(reloaded, true);
  assert.equal(closed, true);
});
