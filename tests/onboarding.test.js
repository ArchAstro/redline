'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const EXTENSION = path.join(__dirname, '../extension');
const ONBOARDING_PATH = path.join(EXTENSION, 'onboarding.js');

test('onboarding prominently discloses every data and retention boundary before consent', () => {
  for (const file of ['onboarding.html', 'onboarding.css', 'onboarding.js']) {
    assert.equal(fs.existsSync(path.join(EXTENSION, file)), true, `${file} must exist`);
  }
  const html = fs.readFileSync(path.join(EXTENSION, 'onboarding.html'), 'utf8');
  const disclosure = html.match(/<section[^>]+id="data-disclosure"[\s\S]*?<\/section>/)?.[0] || '';

  assert.match(disclosure, /\shidden(?:\s|>)/,
    'the disclosure must stay hidden until a pairing secret is staged');
  assert.match(disclosure, /selected text and comments/i);
  assert.match(disclosure, /page URL, title, and nearby DOM context/i);
  assert.match(disclosure, /optional screenshots/i);
  assert.match(disclosure, /local Redline sidecar/i);
  assert.match(disclosure, /Chrome[^<]*draft/i);
  assert.match(disclosure, /Chrome[^<]*marker/i);
  assert.match(disclosure, /seven days/i);
  assert.match(disclosure, /delete individual feedback/i);
  assert.match(disclosure, /clear all local Redline data/i);
  assert.match(disclosure, /content-free clear receipt[^<]*30 days/i);
  assert.match(disclosure, /no data or telemetry[^<]*ArchAstro/i);
  assert.match(disclosure, /configured coding-model provider/i);
  assert.match(disclosure, /type="checkbox"[^>]+id="consent"/);
  assert.match(disclosure, /<button[^>]+id="connect"[^>]+disabled/);
  assert.match(disclosure, /<button[^>]+id="decline"/);
  assert.match(html, /id="declined-title"[^>]+tabindex="-1"/);
});

function storageArea(initial = {}) {
  const data = structuredClone(initial);
  const writes = [];
  return {
    data,
    writes,
    async get(keys) {
      const names = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(names.filter((name) => Object.hasOwn(data, name))
        .map((name) => [name, structuredClone(data[name])]));
    },
    async set(value) { writes.push(['set', structuredClone(value)]); Object.assign(data, structuredClone(value)); },
    async remove(keys) {
      writes.push(['remove', structuredClone(keys)]);
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    },
  };
}

function stagedSecret(secret = 's'.repeat(43), expiresAt = '2099-08-07T19:10:00.000Z') {
  return { secret, expires_at: expiresAt };
}

test('fragment discovery reads only session storage and never pairs before consent', async () => {
  const { createOnboardingController } = require(ONBOARDING_PATH);
  const secret = 's'.repeat(43);
  const sessionStorage = storageArea({ redline_pairing_secret: stagedSecret(secret) });
  const localStorage = storageArea();
  const calls = [];
  const view = { showDisclosure(state) { calls.push(['disclosure', structuredClone(state)]); } };
  const controller = createOnboardingController({
    localStorage,
    sessionStorage,
    view,
    connectionClient: {
      async probeHealth() {
        calls.push(['probe']);
        return {
          status: 'consent_required',
          pairingExpiresAt: '2099-08-07T19:10:00.000Z',
          packageVersion: '0.2.6',
          protocol: { major: 1, minor: 0 },
        };
      },
      async pair() { calls.push(['pair']); throw new Error('must not pair'); },
    },
  });

  assert.deepEqual(await controller.init(), { status: 'consent_required' });
  assert.deepEqual(calls, [
    ['probe'],
    ['disclosure', { pairingExpiresAt: '2099-08-07T19:10:00.000Z' }],
  ]);
  assert.deepEqual(sessionStorage.data, { redline_pairing_secret: stagedSecret(secret) });
  assert.deepEqual(sessionStorage.writes, []);
  assert.deepEqual(localStorage.data, {});
  assert.deepEqual(localStorage.writes, []);
});

test('reopening onboarding recognizes an authenticated consented profile', async () => {
  const { createOnboardingController } = require(ONBOARDING_PATH);
  const localStorage = storageArea({
    redline_connection: {
      port: 7878,
      client_id: 'rlc_0123456789abcdef0123456789abcdef',
      token: 't'.repeat(43),
      clear_generation: 0,
      protocol: { major: 1, minor: 0, helper_version: '0.2.6' },
      setup: { consent: 'accepted', consented_at: '2026-08-07T19:00:00.000Z' },
    },
  });
  const calls = [];
  const controller = createOnboardingController({
    localStorage,
    sessionStorage: storageArea(),
    view: { showConnected() { calls.push('connected'); } },
    connectionClient: {
      async checkConnection() { calls.push('check'); return { status: 'connected' }; },
      async probeHealth() { calls.push('probe'); throw new Error('must not probe'); },
    },
  });

  assert.deepEqual(await controller.init(), { status: 'connected' });
  assert.deepEqual(calls, ['check', 'connected']);
  assert.deepEqual(await controller.enableSite(), { status: 'site_enable_unavailable' });
});

test('decline deletes the session secret and leaves pairing and content disabled', async () => {
  const { createOnboardingController } = require(ONBOARDING_PATH);
  const sessionStorage = storageArea({ redline_pairing_secret: stagedSecret() });
  const localStorage = storageArea();
  const calls = [];
  const controller = createOnboardingController({
    localStorage,
    sessionStorage,
    view: {
      showDisclosure() { calls.push(['disclosure']); },
      showDeclined(guidance) { calls.push(['declined', structuredClone(guidance)]); },
    },
    connectionClient: {
      async probeHealth() {
        return { status: 'consent_required', pairingExpiresAt: '2099-08-07T19:10:00.000Z' };
      },
      async pair() { calls.push(['pair']); throw new Error('must not pair'); },
    },
    siteEnabler: async () => { calls.push(['enable-site']); },
  });
  await controller.init();

  assert.deepEqual(await controller.decline(), { status: 'declined' });
  assert.deepEqual(sessionStorage.data, {});
  assert.deepEqual(sessionStorage.writes, [['remove', 'redline_pairing_secret']]);
  assert.deepEqual(localStorage.data, {});
  assert.deepEqual(calls, [
    ['disclosure'],
    ['declined', {
      message: 'Redline is not connected and cannot access site content.',
      guidance: 'Clear local extension data or uninstall Redline from Chrome at any time.',
    }],
  ]);
});

test('a late health response cannot reopen consent or polling after decline', async () => {
  const { createOnboardingController } = require(ONBOARDING_PATH);
  let finishProbe;
  const probe = new Promise((resolve) => { finishProbe = resolve; });
  const calls = [];
  const timers = [];
  const controller = createOnboardingController({
    localStorage: storageArea(),
    sessionStorage: storageArea({ redline_pairing_secret: stagedSecret() }),
    view: {
      showDisclosure() { calls.push('disclosure'); },
      showDeclined() { calls.push('declined'); },
    },
    connectionClient: { async probeHealth() { return probe; } },
    scheduler: {
      setInterval() { timers.push('started'); return 1; },
      clearInterval() {},
    },
  });

  const initializing = controller.init();
  await Promise.resolve();
  assert.deepEqual(await controller.decline(), { status: 'declined' });
  finishProbe({
    status: 'consent_required',
    pairingExpiresAt: '2099-08-07T19:10:00.000Z',
  });
  await initializing;

  assert.deepEqual(calls, ['declined']);
  assert.deepEqual(timers, []);
  assert.deepEqual(await controller.enableSite(), { status: 'consent_required' });
});

test('expired discovery deletes the session secret and shows disconnected guidance', async () => {
  const { createOnboardingController } = require(ONBOARDING_PATH);
  const sessionStorage = storageArea({ redline_pairing_secret: stagedSecret() });
  const calls = [];
  const controller = createOnboardingController({
    localStorage: storageArea(),
    sessionStorage,
    view: {
      showDeclined(guidance) { calls.push(structuredClone(guidance)); },
    },
    connectionClient: {
      async probeHealth() { return { status: 'pairing_expired' }; },
    },
  });

  assert.deepEqual(await controller.init(), { status: 'pairing_expired' });
  assert.deepEqual(sessionStorage.data, {});
  assert.deepEqual(sessionStorage.writes, [['remove', 'redline_pairing_secret']]);
  assert.deepEqual(calls, [{
    message: 'The one-time connection window expired. Redline is not connected.',
    guidance: 'Run setup again, clear local extension data, or uninstall Redline from Chrome.',
  }]);
});

test('affirmative consent pairs once, consumes the session secret, and reveals site enablement', async () => {
  const { createOnboardingController } = require(ONBOARDING_PATH);
  const secret = 's'.repeat(43);
  const sessionStorage = storageArea({ redline_pairing_secret: stagedSecret(secret) });
  const calls = [];
  const controller = createOnboardingController({
    localStorage: storageArea(),
    sessionStorage,
    view: {
      showDisclosure() { calls.push(['disclosure']); },
      showConnected() { calls.push(['connected']); },
    },
    connectionClient: {
      async probeHealth() {
        return { status: 'consent_required', pairingExpiresAt: '2099-08-07T19:10:00.000Z' };
      },
      async pair(value, options) {
        calls.push(['pair', value, structuredClone(options)]);
        return { status: 'paired', connection: { client_id: 'rlc_0123456789abcdef0123456789abcdef' } };
      },
    },
  });
  await controller.init();

  assert.deepEqual(await controller.acceptConsent(true), { status: 'paired' });
  assert.deepEqual(calls, [
    ['disclosure'],
    ['pair', secret, { consent: true }],
    ['connected'],
  ]);
  assert.deepEqual(sessionStorage.data, {});
  assert.deepEqual(sessionStorage.writes, [['remove', 'redline_pairing_secret']]);
});

test('concurrent affirmative actions share one pairing attempt', async () => {
  const { createOnboardingController } = require(ONBOARDING_PATH);
  const sessionStorage = storageArea({ redline_pairing_secret: stagedSecret() });
  let pairCalls = 0;
  let finishPair;
  const pairResult = new Promise((resolve) => { finishPair = resolve; });
  const controller = createOnboardingController({
    localStorage: storageArea(),
    sessionStorage,
    view: { showDisclosure() {}, showConnected() {} },
    connectionClient: {
      async probeHealth() {
        return { status: 'consent_required', pairingExpiresAt: '2099-08-07T19:10:00.000Z' };
      },
      async pair() { pairCalls += 1; return pairResult; },
    },
  });
  await controller.init();

  const first = controller.acceptConsent(true);
  const second = controller.acceptConsent(true);
  finishPair({ status: 'paired', connection: {} });

  assert.deepEqual(await Promise.all([first, second]), [{ status: 'paired' }, { status: 'paired' }]);
  assert.equal(pairCalls, 1);
  assert.deepEqual(sessionStorage.writes, [['remove', 'redline_pairing_secret']]);
});

test('a successful pairing invalidates a health poll that started before consent', async () => {
  const { createOnboardingController } = require(ONBOARDING_PATH);
  let visibilityListener;
  let checks = 0;
  let finishCheck;
  const checkGate = new Promise((resolve) => { finishCheck = resolve; });
  const calls = [];
  const controller = createOnboardingController({
    localStorage: storageArea(),
    sessionStorage: storageArea({ redline_pairing_secret: stagedSecret() }),
    view: {
      showDisclosure() { calls.push('disclosure'); },
      showConnected() { calls.push('connected'); },
      showStatus() { calls.push('status'); },
    },
    connectionClient: {
      async checkConnection() {
        checks += 1;
        if (checks > 1) await checkGate;
        return { status: 'disconnected' };
      },
      async probeHealth() {
        return { status: 'consent_required', pairingExpiresAt: '2099-08-07T19:10:00.000Z' };
      },
      async pair() { return { status: 'paired', connection: {} }; },
    },
    visibility: {
      isVisible: () => true,
      subscribe(listener) { visibilityListener = listener; return () => {}; },
    },
  });

  assert.deepEqual(await controller.init(), { status: 'consent_required' });
  calls.length = 0;
  const refresh = visibilityListener();
  await Promise.resolve();
  assert.deepEqual(await controller.acceptConsent(true), { status: 'paired' });
  finishCheck();
  assert.equal(await refresh, undefined);
  assert.deepEqual(calls, ['connected']);
});

test('successful consent stops onboarding health polling immediately', async () => {
  const { createOnboardingController } = require(ONBOARDING_PATH);
  const cleared = [];
  const controller = createOnboardingController({
    localStorage: storageArea(),
    sessionStorage: storageArea({ redline_pairing_secret: stagedSecret() }),
    view: { showDisclosure() {}, showConnected() {} },
    connectionClient: {
      async probeHealth() {
        return { status: 'consent_required', pairingExpiresAt: '2099-08-07T19:10:00.000Z' };
      },
      async pair() { return { status: 'paired', connection: {} }; },
    },
    scheduler: {
      setInterval() { return 7; },
      clearInterval(id) { cleared.push(id); },
    },
  });
  await controller.init();

  assert.deepEqual(await controller.acceptConsent(true), { status: 'paired' });
  assert.deepEqual(cleared, [7]);
});

test('decline during pairing removes a late credential and keeps drafts disconnected', async () => {
  const { createOnboardingController } = require(ONBOARDING_PATH);
  const localStorage = storageArea({ redline_draft_existing: { comment: 'keep' } });
  let finishPair;
  const pairGate = new Promise((resolve) => { finishPair = resolve; });
  const calls = [];
  const controller = createOnboardingController({
    localStorage,
    sessionStorage: storageArea({ redline_pairing_secret: stagedSecret() }),
    view: {
      showDisclosure() { calls.push('disclosure'); },
      showConnected() { calls.push('connected'); },
      showDeclined() { calls.push('declined'); },
    },
    connectionClient: {
      async probeHealth() {
        return { status: 'consent_required', pairingExpiresAt: '2099-08-07T19:10:00.000Z' };
      },
      async pair() {
        await pairGate;
        await localStorage.set({ redline_connection: { token: 'late-token' } });
        return { status: 'paired', connection: { token: 'late-token' } };
      },
      async revoke(connection) { calls.push(['revoke', connection.token]); return true; },
    },
  });
  await controller.init();

  const pairing = controller.acceptConsent(true);
  assert.deepEqual(await controller.decline(), { status: 'declined' });
  finishPair();

  assert.deepEqual(await pairing, { status: 'declined' });
  assert.deepEqual(localStorage.data, { redline_draft_existing: { comment: 'keep' } });
  assert.deepEqual(calls, ['disclosure', 'declined', ['revoke', 'late-token']]);
  assert.deepEqual(await controller.enableSite(), { status: 'consent_required' });
});

test('decline race reports local cleanup failure only after the server capability is revoked', async () => {
  const { createOnboardingController } = require(ONBOARDING_PATH);
  const localStorage = storageArea();
  localStorage.remove = async () => { throw new Error('storage remove failed'); };
  let finishPair;
  const pairGate = new Promise((resolve) => { finishPair = resolve; });
  const errors = [];
  const controller = createOnboardingController({
    localStorage,
    sessionStorage: storageArea({ redline_pairing_secret: stagedSecret() }),
    view: {
      showDisclosure() {},
      showDeclined() {},
      showConnectionError(error) { errors.push(structuredClone(error)); },
    },
    connectionClient: {
      async probeHealth() {
        return { status: 'consent_required', pairingExpiresAt: '2099-08-07T19:10:00.000Z' };
      },
      async pair() {
        await pairGate;
        await localStorage.set({ redline_connection: { token: 'revoked-token' } });
        return { status: 'paired', connection: { token: 'revoked-token' } };
      },
      async revoke() { return true; },
    },
  });
  await controller.init();
  const pairing = controller.acceptConsent(true);
  await controller.decline();
  finishPair();

  assert.deepEqual(await pairing, { status: 'local_cleanup_required' });
  assert.deepEqual(errors, [{ status: 'local_cleanup_required' }]);
});

test('consent-time pairing expiry deletes the secret and stays disconnected', async () => {
  const { createOnboardingController } = require(ONBOARDING_PATH);
  const sessionStorage = storageArea({ redline_pairing_secret: stagedSecret() });
  const calls = [];
  const controller = createOnboardingController({
    localStorage: storageArea(),
    sessionStorage,
    view: {
      showDisclosure() {},
      showDeclined(guidance) { calls.push(structuredClone(guidance)); },
    },
    connectionClient: {
      async probeHealth() {
        return { status: 'consent_required', pairingExpiresAt: '2099-08-07T19:10:00.000Z' };
      },
      async pair() { return { status: 'pairing_expired' }; },
    },
  });
  await controller.init();

  assert.deepEqual(await controller.acceptConsent(true), { status: 'pairing_expired' });
  assert.deepEqual(sessionStorage.data, {});
  assert.deepEqual(calls, [{
    message: 'The one-time connection window expired. Redline is not connected.',
    guidance: 'Run setup again, clear local extension data, or uninstall Redline from Chrome.',
  }]);
  assert.deepEqual(await controller.enableSite(), { status: 'consent_required' });
});

test('recoverable connection errors preserve staged secret and existing drafts', async () => {
  const { createOnboardingController } = require(ONBOARDING_PATH);
  const secret = 's'.repeat(43);
  const sessionStorage = storageArea({ redline_pairing_secret: stagedSecret(secret) });
  const localStorage = storageArea({ redline_draft_existing: { comment: 'keep this' } });
  const errors = [];
  const controller = createOnboardingController({
    localStorage,
    sessionStorage,
    view: {
      showDisclosure() {},
      showConnectionError(error) { errors.push(structuredClone(error)); },
    },
    connectionClient: {
      async probeHealth() {
        return { status: 'consent_required', pairingExpiresAt: '2099-08-07T19:10:00.000Z' };
      },
      async pair() {
        return {
          status: 'pairing_failed', recoverable: true,
          command: 'npx --yes @archastro/redline setup',
        };
      },
    },
  });
  await controller.init();

  assert.deepEqual(await controller.acceptConsent(true), { status: 'pairing_failed' });
  assert.deepEqual(sessionStorage.data, { redline_pairing_secret: stagedSecret(secret) });
  assert.deepEqual(localStorage.data, { redline_draft_existing: { comment: 'keep this' } });
  assert.deepEqual(errors, [{
    status: 'pairing_failed',
    command: 'npx --yes @archastro/redline setup',
  }]);
});

test('site enablement is blocked before consent and creates no draft after pairing', async () => {
  const { createOnboardingController } = require(ONBOARDING_PATH);
  const localStorage = storageArea();
  const sessionStorage = storageArea({ redline_pairing_secret: stagedSecret() });
  let enabled = 0;
  const controller = createOnboardingController({
    localStorage,
    sessionStorage,
    view: { showDisclosure() {}, showConnected() {} },
    siteEnabler: async () => { enabled += 1; return { origin: 'https://example.test/*' }; },
    connectionClient: {
      async probeHealth() {
        return { status: 'consent_required', pairingExpiresAt: '2099-08-07T19:10:00.000Z' };
      },
      async pair() { return { status: 'paired', connection: {} }; },
    },
  });
  await controller.init();

  assert.deepEqual(await controller.enableSite(), { status: 'consent_required' });
  assert.equal(enabled, 0);
  await controller.acceptConsent(true);
  assert.deepEqual(await controller.enableSite(), {
    status: 'site_enabled', origin: 'https://example.test/*',
  });
  assert.equal(enabled, 1);
  assert.equal(Object.keys(localStorage.data).some((key) => /draft|pending|redline/i.test(key)), false);
  assert.deepEqual(localStorage.writes, []);
});

test('health polling exists only while onboarding is visible', async () => {
  const { createOnboardingController } = require(ONBOARDING_PATH);
  let visible = false;
  let visibilityListener;
  let probes = 0;
  const timers = [];
  const cleared = [];
  const controller = createOnboardingController({
    localStorage: storageArea(),
    sessionStorage: storageArea(),
    view: { showSetup() {}, showStatus() {} },
    connectionClient: {
      async probeHealth() { probes += 1; return { status: 'missing_helper' }; },
    },
    visibility: {
      isVisible() { return visible; },
      subscribe(listener) { visibilityListener = listener; return () => {}; },
    },
    scheduler: {
      setInterval(callback, delay) { timers.push({ callback, delay }); return timers.length; },
      clearInterval(id) { cleared.push(id); },
    },
  });

  assert.deepEqual(await controller.init(), { status: 'setup_required' });
  assert.equal(probes, 0);
  assert.deepEqual(timers, []);

  visible = true;
  await visibilityListener();
  assert.equal(probes, 1);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 1000);

  visible = false;
  await visibilityListener();
  assert.deepEqual(cleared, [1]);
  controller.dispose();
  assert.deepEqual(cleared, [1]);
});

test('visible polling stops after ten minutes and returns to setup guidance', async () => {
  const { createOnboardingController } = require(ONBOARDING_PATH);
  let currentTime = 1_000;
  let timerCallback;
  const cleared = [];
  let setupViews = 0;
  let probes = 0;
  const controller = createOnboardingController({
    localStorage: storageArea(),
    sessionStorage: storageArea(),
    view: {
      showSetup() { setupViews += 1; },
      showStatus() {},
    },
    connectionClient: {
      async probeHealth() { probes += 1; return { status: 'missing_helper' }; },
    },
    now: () => currentTime,
    scheduler: {
      setInterval(callback) { timerCallback = callback; return 9; },
      clearInterval(id) { cleared.push(id); },
    },
  });
  await controller.init();
  assert.equal(probes, 1);

  currentTime += 600_001;
  await timerCallback();

  assert.deepEqual(cleared, [9]);
  assert.equal(probes, 1);
  assert.equal(setupViews, 2);
  controller.dispose();
});

test('the setup polling deadline cannot expire an active replacement pairing window', async () => {
  const { createOnboardingController } = require(ONBOARDING_PATH);
  let currentTime = Date.parse('2099-08-07T19:00:00.000Z');
  let poll;
  const sessionStorage = storageArea({
    redline_pairing_secret: stagedSecret('s'.repeat(43), '2099-08-07T19:20:00.000Z'),
  });
  const declined = [];
  const controller = createOnboardingController({
    localStorage: storageArea(),
    sessionStorage,
    view: {
      showDisclosure() {},
      showDeclined(guidance) { declined.push(structuredClone(guidance)); },
    },
    connectionClient: {
      async probeHealth() {
        return {
          status: 'consent_required',
          pairingExpiresAt: '2099-08-07T19:20:00.000Z',
        };
      },
    },
    now: () => currentTime,
    scheduler: {
      setInterval(callback) { poll = callback; return 4; },
      clearInterval() {},
      setTimeout() { return 5; },
      clearTimeout() {},
    },
  });
  await controller.init();

  currentTime += 600_001;
  await poll();

  assert.equal(sessionStorage.data.redline_pairing_secret.secret, 's'.repeat(43));
  assert.equal(declined.length, 0);
  assert.deepEqual(await controller.enableSite(), { status: 'consent_required' });
});

test('server-reported expiry deletes a staged secret while onboarding is hidden', async () => {
  const { createOnboardingController } = require(ONBOARDING_PATH);
  const expiresAt = '2099-08-07T19:10:00.000Z';
  let currentTime = Date.parse('2099-08-07T19:00:00.000Z');
  let visible = true;
  let visibilityListener;
  let expiryCallback;
  const sessionStorage = storageArea({ redline_pairing_secret: stagedSecret() });
  const declined = [];
  const controller = createOnboardingController({
    localStorage: storageArea(),
    sessionStorage,
    view: {
      showDisclosure() {},
      showDeclined(guidance) { declined.push(structuredClone(guidance)); },
    },
    connectionClient: {
      async probeHealth() { return { status: 'consent_required', pairingExpiresAt: expiresAt }; },
    },
    now: () => currentTime,
    visibility: {
      isVisible() { return visible; },
      subscribe(listener) { visibilityListener = listener; return () => {}; },
    },
    scheduler: {
      setInterval() { return 6; },
      clearInterval() {},
      setTimeout(callback, delay) {
        expiryCallback = callback;
        assert.equal(delay, 600_000);
        return 7;
      },
      clearTimeout() {},
    },
  });
  await controller.init();

  visible = false;
  await visibilityListener();
  currentTime = Date.parse(expiresAt);
  await expiryCallback();

  assert.deepEqual(sessionStorage.data, {});
  assert.equal(declined.length, 1);
  assert.deepEqual(await controller.enableSite(), { status: 'consent_required' });
});

test('extension-first onboarding exposes one exact copyable setup command and a browser binder', () => {
  const html = fs.readFileSync(path.join(EXTENSION, 'onboarding.html'), 'utf8');
  const source = fs.readFileSync(ONBOARDING_PATH, 'utf8');
  const { SETUP_COMMAND, bindOnboardingPage } = require(ONBOARDING_PATH);

  assert.equal(SETUP_COMMAND, 'npx --yes @archastro/redline setup');
  assert.equal(html.split(SETUP_COMMAND).length - 1, 1);
  assert.match(html, /<code>npx --yes @archastro\/redline setup<\/code>/);
  assert.match(html, /id="copy-command"[^>]+title="Copy setup command"/);
  assert.equal(typeof bindOnboardingPage, 'function');
  assert.match(source, /navigator\.clipboard\.writeText\(SETUP_COMMAND\)/);
  assert.match(source, /connect\.disabled = !consent\.checked/);
  assert.match(source, /cleanupStorage:\s*chrome\.storage\.local/);
  assert.doesNotMatch(html, /id="enable-site"/);
  assert.match(html, /Redline toolbar button/i);
});
