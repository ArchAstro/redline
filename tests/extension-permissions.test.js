const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const PERMISSIONS_PATH = path.resolve(__dirname, '../extension/permissions.js');

function loadPermissions() {
  assert.equal(fs.existsSync(PERMISSIONS_PATH), true, 'extension/permissions.js must exist');
  globalThis.crypto ||= webcrypto;
  delete require.cache[PERMISSIONS_PATH];
  return require(PERMISSIONS_PATH);
}

function event() {
  const listeners = [];
  return {
    addListener(listener) { listeners.push(listener); },
    async emit(value) { await Promise.all(listeners.map((listener) => listener(value))); },
  };
}

function chromeFakes({ granted = [], storedOrigins = [], grantRequests = true, registrations = [] } = {}) {
  const origins = new Set(granted);
  const storageData = { redline_enabled_origins: [...storedOrigins] };
  const scripts = new Map(registrations.map((registration) => [registration.id, structuredClone(registration)]));
  const requests = [];
  const removals = [];
  const onRemoved = event();

  return {
    storageData,
    scripts,
    requests,
    removals,
    permissions: {
      onRemoved,
      async getAll() { return { origins: [...origins], permissions: [] }; },
      async contains(request) {
        return (request.origins || []).every((origin) =>
          origins.has(origin) || (origin !== '<all_urls>' && origins.has('<all_urls>')));
      },
      async request(request) {
        requests.push(structuredClone(request));
        const allowed = typeof grantRequests === 'function' ? grantRequests(request) : grantRequests;
        if (allowed) for (const origin of request.origins || []) origins.add(origin);
        return allowed;
      },
      async remove(request) {
        removals.push(structuredClone(request));
        let removed = false;
        for (const origin of request.origins || []) {
          if (origin === '<all_urls>' && origins.delete(origin)) {
            removed = true;
            for (const grantedOrigin of [...origins]) {
              if (grantedOrigin !== 'http://127.0.0.1:7878/*') origins.delete(grantedOrigin);
            }
          } else {
            removed = origins.delete(origin) || removed;
          }
        }
        return removed;
      },
    },
    scripting: {
      async getRegisteredContentScripts() {
        return [...scripts.values()].map((item) => structuredClone(item));
      },
      async registerContentScripts(items) {
        for (const item of items) {
          if (scripts.has(item.id)) throw new Error(`duplicate registration ${item.id}`);
          scripts.set(item.id, structuredClone(item));
        }
      },
      async unregisterContentScripts({ ids } = {}) {
        for (const id of ids || [...scripts.keys()]) scripts.delete(id);
      },
    },
    storage: {
      async get(key) {
        return Object.hasOwn(storageData, key) ? { [key]: structuredClone(storageData[key]) } : {};
      },
      async set(values) { Object.assign(storageData, structuredClone(values)); },
      async remove(key) { delete storageData[key]; },
    },
  };
}

function controller(options = {}) {
  const api = loadPermissions();
  const fakes = chromeFakes(options);
  return {
    api,
    fakes,
    instance: api.createPermissionController({
      permissions: fakes.permissions,
      scripting: fakes.scripting,
      storage: fakes.storage,
    }),
  };
}

test('origin patterns retain explicit ports and reject restricted browser URLs', () => {
  const { originPattern, PermissionError } = loadPermissions();

  assert.equal(originPattern('https://example.test:8443/review?q=1'), 'https://example.test:8443/*');
  assert.equal(originPattern('http://localhost:3000/path'), 'http://localhost:3000/*');
  assert.throws(
    () => originPattern('chrome://settings/privacy'),
    (error) => error instanceof PermissionError && error.code === 'restricted_url' &&
      /Chrome pages cannot be enabled/i.test(error.message)
  );
});

test('an existing one-site grant persists an exact origin and a persistent dynamic registration', async () => {
  const { instance, fakes } = controller({ granted: ['https://example.test:8443/*'] });

  const result = await instance.enableSite('https://example.test:8443/review');

  assert.equal(result.origin, 'https://example.test:8443');
  assert.deepEqual(fakes.requests, []);
  assert.deepEqual(fakes.storageData.redline_enabled_origins, ['https://example.test:8443']);
  assert.equal(fakes.scripts.size, 1);
  const [registration] = [...fakes.scripts.values()];
  assert.match(registration.id, /^redline-site-/);
  assert.deepEqual(registration.matches, ['https://example.test:8443/*']);
  assert.deepEqual(registration.js, ['content.js']);
  assert.deepEqual(registration.css, ['content.css']);
  assert.equal(registration.persistAcrossSessions, true);
  assert.equal(registration.runAt, 'document_idle');
  assert.equal(registration.allFrames, false);
});

test('an absent site grant changes neither preferences nor registrations', async () => {
  const { instance, fakes, api } = controller();

  await assert.rejects(
    instance.enableSite('https://denied.test/page'),
    (error) => error instanceof api.PermissionError && error.code === 'permission_denied'
  );
  assert.deepEqual(fakes.storageData.redline_enabled_origins, []);
  assert.equal(fakes.scripts.size, 0);
});

test('restart reconciliation restores granted sites and removes revoked preferences and stale registrations', async () => {
  const staleRegistration = {
    id: 'redline-site-stale', matches: ['https://revoked.test/*'], js: ['content.js'], css: ['content.css'],
  };
  const { instance, fakes } = controller({
    granted: ['http://127.0.0.1:7878/*', 'https://enabled.test/*'],
    storedOrigins: ['https://enabled.test', 'https://revoked.test'],
    registrations: [staleRegistration],
  });

  await instance.start();

  assert.deepEqual(fakes.storageData.redline_enabled_origins, ['https://enabled.test']);
  assert.equal(fakes.scripts.has('redline-site-stale'), false);
  const registrations = [...fakes.scripts.values()];
  assert.equal(registrations.length, 1);
  assert.deepEqual(registrations[0].matches, ['https://enabled.test/*']);
});

test('external permission revocation removes the matching registration and preference', async () => {
  const { instance, fakes } = controller({
    granted: ['https://enabled.test/*'],
    storedOrigins: ['https://enabled.test'],
  });
  await instance.start();
  await fakes.permissions.remove({ origins: ['https://enabled.test/*'] });

  await fakes.permissions.onRemoved.emit({ origins: ['https://enabled.test/*'] });

  assert.deepEqual(fakes.storageData.redline_enabled_origins, []);
  assert.equal(fakes.scripts.size, 0);
});

test('disable site unregisters its script and removes only its exact grant', async () => {
  const { instance, fakes } = controller({
    granted: ['https://one.test/*', 'https://two.test/*'],
    storedOrigins: ['https://one.test', 'https://two.test'],
  });
  await instance.start();

  await instance.disableSite('https://one.test/page');

  assert.deepEqual(fakes.removals.at(-1), { origins: ['https://one.test/*'] });
  assert.deepEqual(fakes.storageData.redline_enabled_origins, ['https://two.test']);
  assert.deepEqual([...fakes.scripts.values()].map((item) => item.matches), [['https://two.test/*']]);
});

test('disable everywhere removes every optional grant and Redline registration', async () => {
  const { instance, fakes } = controller({
    granted: [
      'http://127.0.0.1:7878/*',
      'https://one.test/*',
      'http://localhost:3000/*',
      '<all_urls>',
    ],
    storedOrigins: ['https://one.test', 'http://localhost:3000'],
  });
  await instance.start();

  await instance.disableEverywhere();

  assert.equal(fakes.scripts.size, 0);
  assert.deepEqual(fakes.storageData.redline_enabled_origins, []);
  assert.deepEqual(fakes.removals.at(-1), {
    origins: ['<all_urls>', 'http://localhost:3000/*', 'https://one.test/*'],
  });
  assert.deepEqual((await fakes.permissions.getAll()).origins, ['http://127.0.0.1:7878/*']);
});

test('full visual mode requests broad access without registering all-sites content scripts', async () => {
  const { instance, fakes } = controller({
    granted: ['<all_urls>', 'https://enabled.test/*'],
    storedOrigins: ['https://enabled.test'],
  });
  await instance.start();

  await instance.enableFullVisual();

  assert.deepEqual(fakes.requests, []);
  assert.equal([...fakes.scripts.values()].some((item) => item.matches.includes('<all_urls>')), false);
  assert.equal(await instance.canCaptureScreenshot('https://enabled.test/page'), true);
  assert.equal(await instance.canCaptureScreenshot('https://not-enabled.test/page'), false);
});

test('disabling broad access reconciles site registrations against Chrome containment', async () => {
  const { instance, fakes } = controller({
    granted: ['<all_urls>'],
    storedOrigins: ['https://enabled.test'],
  });
  await instance.start();
  assert.deepEqual([...fakes.scripts.values()].map((item) => item.matches), [['https://enabled.test/*']]);

  await instance.disableFullVisual();

  assert.deepEqual(fakes.removals.at(-1), { origins: ['<all_urls>'] });
  assert.deepEqual(fakes.storageData.redline_enabled_origins, []);
  assert.equal(fakes.scripts.size, 0);
  assert.equal(await instance.canCaptureScreenshot('https://enabled.test/page'), false);
});

test('the service worker delegates screenshot consent and permission operations to the controller', () => {
  const background = fs.readFileSync(path.resolve(__dirname, '../extension/background.js'), 'utf8');

  assert.match(background, /importScripts\('permissions\.js', 'revocations\.js'\)/);
  assert.match(background, /canCaptureScreenshot/);
  assert.match(background, /enable-site/);
  assert.match(background, /disable-everywhere/);
  assert.match(background, /enable-full-visual/);
  assert.match(background, /msg\.type === 'disable-site'[\s\S]{0,700}screenshotByTab\.delete/);
  assert.match(background, /msg\.type === 'disable-everywhere'[\s\S]{0,350}screenshotByTab\.clear/);
  const clearMaintenance = background.indexOf('async function maintainPendingClear()');
  const sidecarClear = background.indexOf("sidecarJson(`${BASE}/clear`", clearMaintenance);
  const browserCleanup = background.indexOf('await clearPendingDrafts()', clearMaintenance);
  const connectionRemoval = background.indexOf('chrome.storage.local.remove(CONNECTION_KEY)', clearMaintenance);
  assert.ok(clearMaintenance >= 0 && sidecarClear > clearMaintenance && browserCleanup > sidecarClear &&
    connectionRemoval > browserCleanup);
});
