const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const nodeTest = require("node:test");
const vm = require("node:vm");
const { randomFillSync, webcrypto } = require("node:crypto");
const { PNG } = require("pngjs");

const VALID_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const TEST_TIMEOUT_MS = 5000;

function test(name, fn) {
  return nodeTest(name, { timeout: TEST_TIMEOUT_MS }, fn);
}

async function waitUntil(predicate, message, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const backgroundSource = fs.readFileSync(
  path.join(__dirname, "../extension/background.js"),
  "utf8"
);

function pairedStorage(overrides = {}) {
  const local = localStorageArea({
      redline_connection: {
        client_id: "rlc_0123456789abcdef0123456789abcdef",
        token: "t".repeat(43),
        clear_generation: 0,
        port: 7878,
        ...overrides,
      },
    });
  const session = localStorageArea();
  local.setAccessLevel = async () => {};
  session.setAccessLevel = async () => {};
  return { local, session };
}

function alarmApi() {
  const alarms = new Map();
  return {
    async create(name, details) { alarms.set(name, { name, scheduledTime: details.when }); },
    async get(name) { return alarms.get(name); },
    async clear(name) { return alarms.delete(name); },
    onAlarm: { addListener() {} },
  };
}

function localStorageArea(initial = {}, { quotaBytes = Infinity, failSet = false, failRemove = false } = {}) {
  const data = structuredClone(initial);
  if (data.redline_connection && !data.redline_connection.setup) {
    data.redline_connection.setup = {
      consent: "accepted",
      consented_at: "2026-08-07T19:00:00.000Z",
    };
  }
  if (data.redline_connection && data.redline_connection.consent_version === undefined) {
    data.redline_connection.consent_version = 1;
  }
  const failures = { set: failSet, remove: failRemove };
  return {
    data,
    failures,
    async get(keys) {
      if (keys === null || keys === undefined) return structuredClone(data);
      const names = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(names.filter((name) => Object.hasOwn(data, name))
        .map((name) => [name, structuredClone(data[name])]));
    },
    async set(values) {
      if (failures.set) throw new Error("storage set failed");
      const next = { ...data, ...structuredClone(values) };
      if (Buffer.byteLength(JSON.stringify(next)) > quotaBytes) {
        throw new Error("QUOTA_BYTES quota exceeded");
      }
      Object.assign(data, structuredClone(values));
    },
    async remove(keys) {
      if (failures.remove) throw new Error("storage remove failed");
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    },
  };
}

function indexedDbArea({ failOpen = false, failPut = false, failDelete = false } = {}) {
  const records = new Map();
  const failures = { open: failOpen, put: failPut, delete: failDelete };
  let created = false;
  const api = {
    records,
    failures,
    open() {
      const request = {};
      queueMicrotask(() => {
        if (failures.open) {
          request.error = new Error("indexedDB open failed");
          request.onerror?.();
          return;
        }
        const database = {
          objectStoreNames: { contains(name) { return created && name === "submissions"; } },
          createObjectStore(name) {
            if (name !== "submissions") throw new Error("unexpected object store");
            created = true;
          },
          close() {},
          transaction(name) {
            if (!created || name !== "submissions") throw new Error("missing object store");
            const transaction = {
              objectStore() {
                const operation = (kind, key, value) => {
                  const result = {};
                  queueMicrotask(() => {
                    const failure = (kind === "put" && failures.put) ||
                      (kind === "delete" && failures.delete);
                    if (failure) {
                      result.error = new Error(`indexedDB ${kind} failed`);
                      transaction.error = result.error;
                      result.onerror?.();
                      transaction.onerror?.();
                      return;
                    }
                    if (kind === "get") result.result = records.has(key) ? structuredClone(records.get(key)) : undefined;
                    if (kind === "getAllKeys") result.result = [...records.keys()];
                    if (kind === "put") records.set(key, structuredClone(value));
                    if (kind === "delete") records.delete(key);
                    result.onsuccess?.();
                    queueMicrotask(() => transaction.oncomplete?.());
                  });
                  return result;
                };
                return {
                  get(key) { return operation("get", key); },
                  getAllKeys() { return operation("getAllKeys"); },
                  put(value, key) { return operation("put", key, value); },
                  delete(key) { return operation("delete", key); },
                };
              },
            };
            return transaction;
          },
        };
        request.result = database;
        if (!created) request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  };
  return api;
}

function generationResponse(clearGeneration = 0) {
  return {
    ok: true,
    status: 200,
    async json() { return { clear_generation: clearGeneration }; },
  };
}

async function sha256Hex(value) {
  const digest = new Uint8Array(await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Buffer.from(digest).toString("hex");
}

function productionBackground({
  connection, fetch, captureVisibleTab, storageArea = null, indexedDb = null, decodeBase64 = atob,
  getTab = async () => ({ id: 7, windowId: 3, active: true, url: "https://example.test/page" }),
  permissionControllerFactory = null,
  config = { token: "must-not-be-used-in-production", port: 7878 },
}) {
  let messageHandler;
  let captures = 0;
  let tabUpdatedHandler = () => {};
  let tabActivatedHandler = () => {};
  const effectiveStorage = storageArea || localStorageArea(
    connection ? { redline_connection: connection } : {}
  );
  const effectiveIndexedDb = indexedDb || indexedDbArea();
  let alarmHandler;
  const alarms = new Map();
  const sessionStorage = localStorageArea();
  effectiveStorage.setAccessLevel = async () => {};
  sessionStorage.setAccessLevel = async () => {};
  const context = {
    AbortController,
    URL,
    URLSearchParams,
    atob: decodeBase64,
    btoa,
    console,
    crypto: webcrypto,
    TextEncoder,
    setTimeout,
    clearTimeout,
    REDLINE_CONFIG: config,
    importScripts() {},
    indexedDB: effectiveIndexedDb,
    fetch,
    chrome: {
      storage: {
        local: effectiveStorage,
        session: sessionStorage,
      },
      alarms: {
        async create(name, details) { alarms.set(name, { name, scheduledTime: details.when }); },
        async get(name) { return alarms.get(name); },
        async clear(name) { return alarms.delete(name); },
        onAlarm: { addListener(handler) { alarmHandler = handler; } },
      },
      tabs: {
        get: getTab,
        async captureVisibleTab(...args) {
          captures += 1;
          return captureVisibleTab(...args);
        },
        onUpdated: { addListener(handler) { tabUpdatedHandler = handler; } },
        onActivated: { addListener(handler) { tabActivatedHandler = handler; } },
        onRemoved: { addListener() {} },
      },
      runtime: {
        id: "redline-test-extension",
        onMessage: { addListener(handler) { messageHandler = handler; } },
      },
    },
  };
  if (permissionControllerFactory) {
    context.RedlinePermissions = { createPermissionController: permissionControllerFactory };
    context.chrome.permissions = {};
    context.chrome.scripting = {};
  }
  context.RedlineRevocations = require("../extension/revocations");
  vm.runInNewContext(backgroundSource, context);
  return {
    captures: () => captures,
    indexedDb: effectiveIndexedDb,
    local: effectiveStorage,
    session: sessionStorage,
    alarms,
    async fireAlarm(name) { await alarmHandler({ name }); },
    fireTabUpdated(tabId, info) { tabUpdatedHandler(tabId, info); },
    fireTabActivated(info) { tabActivatedHandler(info); },
    send(message, sender = {
      id: "redline-test-extension",
      frameId: 0,
      url: "https://example.test/page",
      tab: { id: 7, url: "https://example.test/page" },
    }) {
      return new Promise((resolve) => messageHandler(message, sender, resolve));
    },
  };
}

test("the service worker retries a durable browser credential revocation", async () => {
  const connection = {
    client_id: "rlc_0123456789abcdef0123456789abcdef",
    token: "t".repeat(43),
    clear_generation: 0,
    consent_version: 1,
    port: 7878,
  };
  const storage = localStorageArea({ redline_connection: connection });
  let deletes = 0;
  const background = productionBackground({
    connection,
    storageArea: storage,
    fetch: async (url, options) => {
      assert.equal(url.endsWith("/clients/current"), true);
      assert.equal(options.method, "DELETE");
      assert.equal(options.headers.authorization, `Bearer ${connection.token}`);
      deletes += 1;
      return { ok: true, status: 204, async json() { throw new Error("no body"); } };
    },
  });
  background.local.data[`redline_pending_revocation::${connection.client_id}`] = {
    client_id: connection.client_id,
    token: connection.token,
  };

  await background.fireAlarm("redline-revocation-retry");

  assert.equal(deletes, 1);
  assert.equal(Object.hasOwn(background.local.data, "redline_connection"), false);
  assert.equal(Object.keys(background.local.data).some((key) => key.startsWith("redline_pending_revocation::")), false);
});

test("finishing one revocation cannot erase a newer queued browser token", async () => {
  const first = {
    client_id: "rlc_0123456789abcdef0123456789abcdef",
    token: "a".repeat(43),
  };
  const second = {
    client_id: "rlc_fedcba9876543210fedcba9876543210",
    token: "b".repeat(43),
  };
  let releaseFirst;
  const firstDelete = new Promise((resolve) => { releaseFirst = resolve; });
  const deleted = [];
  const firstKey = `redline_pending_revocation::${first.client_id}`;
  const secondKey = `redline_pending_revocation::${second.client_id}`;
  const storage = localStorageArea({ [firstKey]: first });
  const background = productionBackground({
    storageArea: storage,
    fetch: async (_url, options) => {
      const token = options.headers.authorization.replace(/^Bearer /, "");
      deleted.push(token);
      if (token === first.token) await firstDelete;
      return { ok: true, status: 204 };
    },
  });

  const maintaining = background.fireAlarm("redline-revocation-retry");
  await waitUntil(() => deleted.includes(first.token), "first revocation did not start");
  await storage.set({ [secondKey]: second });
  releaseFirst();
  await maintaining;

  assert.deepEqual(storage.data[secondKey], second);
  assert.equal(Object.hasOwn(storage.data, firstKey), false);
  await background.fireAlarm("redline-revocation-retry");
  assert.equal(Object.keys(storage.data).some((key) => key.startsWith("redline_pending_revocation::")), false);
  assert.deepEqual(deleted, [first.token, second.token]);
});

test("popup disconnect persists revocation and removes this profile's pending drafts", async () => {
  const connection = {
    client_id: "rlc_0123456789abcdef0123456789abcdef",
    token: "t".repeat(43),
    clear_generation: 0,
    consent_version: 1,
    port: 7878,
  };
  const key = "redline_pending::draft_disconnect_012345";
  const createdAt = new Date(Date.now() - 1000).toISOString();
  const expiresAt = new Date(Date.parse(createdAt) + 7 * 24 * 60 * 60 * 1000).toISOString();
  const locator = { version: 3, created_at: createdAt, expires_at: expiresAt };
  const storage = localStorageArea({ redline_connection: connection, [key]: locator });
  const indexedDb = indexedDbArea();
  indexedDb.records.set(key, locator);
  const background = productionBackground({
    connection,
    storageArea: storage,
    indexedDb,
    fetch: async (url, options) => {
      assert.equal(url.endsWith("/clients/current"), true);
      assert.equal(options.method, "DELETE");
      return { ok: true, status: 204 };
    },
  });

  assert.deepEqual(structuredClone(await background.send({ type: "disconnect" })), {
    ok: true, disconnected: true,
  });
  assert.equal(Object.hasOwn(background.local.data, "redline_connection"), false);
  assert.equal(Object.hasOwn(background.local.data, "redline_pending_revocation"), false);
  assert.equal(Object.hasOwn(storage.data, key), false);
  assert.equal(indexedDb.records.size, 0);
});

test("popup clear removes sidecar data, pending drafts, and the local connection", async () => {
  const connection = {
    client_id: "rlc_0123456789abcdef0123456789abcdef",
    token: "t".repeat(43),
    clear_generation: 0,
    consent_version: 1,
    port: 7878,
  };
  const key = "redline_pending::draft_clear_popup_012345";
  const storage = localStorageArea({
    redline_connection: connection,
    [key]: { version: 1 },
    "rl_items::https://example.test/page": [{ item: { id: "rl_marker" }, ser: { text: "copy" } }],
    rl_last_project: "website",
  });
  const indexedDb = indexedDbArea();
  indexedDb.records.set(key, { version: 2 });
  const background = productionBackground({
    connection,
    storageArea: storage,
    indexedDb,
    fetch: async (url, options) => {
      assert.equal(url.endsWith("/clear"), true);
      assert.equal(options.method, "POST");
      return {
        ok: true,
        status: 200,
        async json() { return { clear_generation: 1 }; },
      };
    },
  });
  background.session.data.redline_pairing_secret = {
    secret: "s".repeat(43),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
  background.alarms.set("redline-pairing-secret-expiry", {
    name: "redline-pairing-secret-expiry",
    scheduledTime: Date.now() + 60_000,
  });

  assert.deepEqual(structuredClone(await background.send({ type: "clear-data" })), {
    ok: true, clear_generation: 1,
  });
  assert.deepEqual(storage.data, {});
  assert.deepEqual(background.session.data, {});
  assert.equal(background.alarms.has("redline-pairing-secret-expiry"), false);
  assert.equal(indexedDb.records.size, 0);
});

test("expired browser markers are deleted without revisiting their pages", async () => {
  const expiredAt = new Date(Date.now() - 1_000).toISOString();
  const futureAt = new Date(Date.now() + 60_000).toISOString();
  const storage = localStorageArea({
    "rl_items::https://expired.test/page": [{
      item: { id: "rl_expired" }, ser: { text: "old" }, expires_at: expiredAt,
    }],
    "rl_items::https://future.test/page": [{
      item: { id: "rl_future" }, ser: { text: "new" }, expires_at: futureAt,
    }],
  });
  const background = productionBackground({ storageArea: storage });

  await background.fireAlarm("redline-pending-cleanup");

  assert.equal(Object.hasOwn(storage.data, "rl_items::https://expired.test/page"), false);
  assert.deepEqual(storage.data["rl_items::https://future.test/page"], [{
    item: { id: "rl_future" }, ser: { text: "new" }, expires_at: futureAt,
  }]);
  assert.equal(background.alarms.get("redline-pending-cleanup").scheduledTime, Date.parse(futureAt));
});

test("a stale content script cannot handle page data after its site is disabled", async () => {
  let requests = 0;
  const background = productionBackground({
    fetch: async () => { requests += 1; throw new Error("must not fetch"); },
    permissionControllerFactory: () => ({
      async start() {},
      async getState() {
        return { supported: true, siteEnabled: false, fullVisualEnabled: false };
      },
    }),
  });
  const sender = {
    id: "redline-test-extension",
    frameId: 0,
    url: "https://example.test/page",
    tab: { id: 7, url: "https://example.test/page" },
  };

  for (const message of [
    { type: "marker-storage-get", keys: ["rl_items::https://example.test/page"] },
    { type: "submit-redline", payload: { selected_text: "secret" } },
    { type: "list-redlines", status: "pending", origin: "https://example.test" },
    { type: "update-redline", id: "rl_1", payload: { comment: "secret" } },
    { type: "delete-redline", id: "rl_1" },
  ]) {
    const response = await background.send(message, sender);
    assert.equal(response.ok, false, message.type);
    assert.equal(response.error_code, "site_not_enabled", message.type);
  }
  assert.equal(requests, 0);
});

test("popup clear durably retries browser cleanup after the sidecar commits", async () => {
  const connection = {
    client_id: "rlc_0123456789abcdef0123456789abcdef",
    token: "t".repeat(43),
    clear_generation: 0,
    consent_version: 1,
    port: 7878,
  };
  const key = "redline_pending::draft_clear_failure_012345";
  const storage = localStorageArea({ redline_connection: connection, [key]: { version: 1 } });
  const indexedDb = indexedDbArea({ failDelete: true });
  indexedDb.records.set(key, { version: 2 });
  let sidecarClears = 0;
  const background = productionBackground({
    connection,
    storageArea: storage,
    indexedDb,
    fetch: async () => {
      sidecarClears += 1;
      return { ok: true, status: 200, async json() { return { clear_generation: 1 }; } };
    },
  });

  const response = structuredClone(await background.send({ type: "clear-data" }));

  assert.equal(response.ok, false);
  assert.equal(sidecarClears, 1);
  assert.equal(Object.hasOwn(storage.data, "redline_connection"), true);
  assert.equal(storage.data.redline_pending_clear.state, "committed");

  indexedDb.failures.delete = false;
  await background.fireAlarm("redline-clear-cleanup-retry");
  assert.equal(Object.hasOwn(storage.data, "redline_connection"), false);
  assert.equal(Object.hasOwn(storage.data, "redline_pending_clear"), false);
});

test("popup clear does not erase browser data when the sidecar rejects its token", async () => {
  const connection = {
    client_id: "rlc_0123456789abcdef0123456789abcdef",
    token: "t".repeat(43),
    clear_generation: 0,
    consent_version: 1,
    port: 7878,
  };
  const key = "rl_items::https://example.test/page";
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const storage = localStorageArea({
    redline_connection: connection,
    [key]: [{ item: { id: "rl_keep" }, ser: { text: "keep" }, expires_at: expiresAt }],
  });
  const background = productionBackground({
    connection,
    storageArea: storage,
    fetch: async () => ({
      ok: false,
      status: 401,
      async json() { return { error: { code: "unauthorized" } }; },
    }),
  });

  const response = structuredClone(await background.send({ type: "clear-data" }));

  assert.equal(response.ok, false);
  assert.equal(Object.hasOwn(storage.data, "redline_connection"), true);
  assert.equal(Object.hasOwn(storage.data, key), true);
  assert.equal(storage.data.redline_pending_clear.state, "requested");
});

test("content scripts can persist only marker data for their own top-level page", async () => {
  const connection = {
    client_id: "rlc_0123456789abcdef0123456789abcdef",
    token: "t".repeat(43),
    clear_generation: 0,
    consent_version: 1,
    port: 7878,
  };
  const background = productionBackground({ connection, fetch: async () => generationResponse() });
  const sender = {
    id: "redline-test-extension",
    frameId: 0,
    url: "https://example.test/page?draft=1",
    tab: { id: 7, url: "https://example.test/page?draft=1" },
  };
  const pageKey = "rl_items::https://example.test/page";
  const markers = [{
    item: { id: "rl_marker" },
    ser: { text: "copy" },
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  }];

  assert.deepEqual(structuredClone(await background.send({
    type: "marker-storage-set", values: { [pageKey]: markers, rl_last_project: "website" },
  }, sender)), { ok: true });
  assert.deepEqual(structuredClone(await background.send({
    type: "marker-storage-get", keys: [pageKey, "rl_last_project"],
  }, sender)), { ok: true, values: { [pageKey]: markers, rl_last_project: "website" } });

  const rejected = structuredClone(await background.send({
    type: "marker-storage-get", keys: ["redline_connection"],
  }, sender));
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error_code, "invalid_marker_storage");
});

test("disconnect waits for an in-flight submission before revoking the profile", async (t) => {
  const connection = {
    client_id: "rlc_0123456789abcdef0123456789abcdef",
    token: "t".repeat(43),
    clear_generation: 0,
    consent_version: 1,
    port: 7878,
  };
  let releaseCapture;
  const capture = new Promise((resolve) => { releaseCapture = resolve; });
  t.after(() => releaseCapture());
  const events = [];
  const background = productionBackground({
    connection,
    captureVisibleTab: async () => {
      events.push("capture-start");
      await capture;
      events.push("capture-done");
      return `data:image/png;base64,${VALID_PNG_BASE64}`;
    },
    fetch: async (url, options = {}) => {
      if (url.endsWith("/generation")) return generationResponse();
      if (url.endsWith("/redlines") && options.method === "POST") {
        events.push("submitted");
        return { ok: true, status: 201, async json() { return { id: "rl_before_disconnect" }; } };
      }
      if (url.endsWith("/clients/current") && options.method === "DELETE") {
        events.push("revoked");
        return { ok: true, status: 204 };
      }
      throw new Error(`unexpected request: ${url}`);
    },
  });

  const submitting = background.send({ type: "submit-redline", payload: { comment: "finish me" } });
  await waitUntil(() => events.includes("capture-start"), "capture did not start");
  const disconnecting = background.send({ type: "disconnect" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["capture-start"]);

  releaseCapture();
  assert.equal((await submitting).ok, true);
  assert.equal((await disconnecting).ok, true);
  assert.deepEqual(events, ["capture-start", "capture-done", "submitted", "revoked"]);
});

test("clear waits for an in-flight submission before clearing sidecar data", async (t) => {
  const connection = {
    client_id: "rlc_0123456789abcdef0123456789abcdef",
    token: "t".repeat(43),
    clear_generation: 0,
    consent_version: 1,
    port: 7878,
  };
  let releaseCapture;
  const capture = new Promise((resolve) => { releaseCapture = resolve; });
  t.after(() => releaseCapture());
  const events = [];
  const background = productionBackground({
    connection,
    captureVisibleTab: async () => {
      events.push("capture-start");
      await capture;
      events.push("capture-done");
      return `data:image/png;base64,${VALID_PNG_BASE64}`;
    },
    fetch: async (url, options = {}) => {
      if (url.endsWith("/generation")) return generationResponse();
      if (url.endsWith("/redlines") && options.method === "POST") {
        events.push("submitted");
        return { ok: true, status: 201, async json() { return { id: "rl_before_clear" }; } };
      }
      if (url.endsWith("/clear") && options.method === "POST") {
        events.push("cleared");
        return { ok: true, status: 200, async json() { return { clear_generation: 1 }; } };
      }
      throw new Error(`unexpected request: ${url}`);
    },
  });

  const submitting = background.send({ type: "submit-redline", payload: { comment: "finish me" } });
  await waitUntil(() => events.includes("capture-start"), "capture did not start");
  const clearing = background.send({ type: "clear-data" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["capture-start"]);

  releaseCapture();
  assert.equal((await submitting).ok, true);
  assert.equal((await clearing).ok, true);
  assert.deepEqual(events, ["capture-start", "capture-done", "submitted", "cleared"]);
});

test("a tab switch during capture cannot attach another tab's screenshot", async () => {
  const connection = {
    client_id: "rlc_0123456789abcdef0123456789abcdef",
    token: "t".repeat(43),
    clear_generation: 0,
    consent_version: 1,
    port: 7878,
  };
  let active = true;
  let submitted;
  const background = productionBackground({
    connection,
    getTab: async () => ({
      id: 7, windowId: 3, active, url: "https://enabled.test/page",
    }),
    captureVisibleTab: async () => {
      active = false;
      return `data:image/png;base64,${VALID_PNG_BASE64}`;
    },
    fetch: async (url, options = {}) => {
      if (url.endsWith("/generation")) return generationResponse();
      if (url.endsWith("/redlines") && options.method === "POST") {
        submitted = JSON.parse(options.body);
        return { ok: true, status: 201, async json() { return { id: "rl_without_wrong_shot" }; } };
      }
      throw new Error(`unexpected request: ${url}`);
    },
  });

  assert.equal((await background.send({
    type: "submit-redline", payload: { comment: "do not leak another tab" },
  })).ok, true);
  assert.equal(Object.hasOwn(submitted, "screenshot_png"), false);
});

test("an inactive submitting tab is never captured", async () => {
  const connection = {
    client_id: "rlc_0123456789abcdef0123456789abcdef",
    token: "t".repeat(43),
    clear_generation: 0,
    consent_version: 1,
    port: 7878,
  };
  let captures = 0;
  let submitted;
  const background = productionBackground({
    connection,
    getTab: async () => ({
      id: 7, windowId: 3, active: false, url: "https://enabled.test/page",
    }),
    captureVisibleTab: async () => {
      captures += 1;
      return `data:image/png;base64,${VALID_PNG_BASE64}`;
    },
    fetch: async (url, options = {}) => {
      if (url.endsWith("/generation")) return generationResponse();
      if (url.endsWith("/redlines") && options.method === "POST") {
        submitted = JSON.parse(options.body);
        return { ok: true, status: 201, async json() { return { id: "rl_inactive" }; } };
      }
      throw new Error(`unexpected request: ${url}`);
    },
  });

  assert.equal((await background.send({
    type: "submit-redline", payload: { comment: "inactive" },
  })).ok, true);
  assert.equal(captures, 0);
  assert.equal(Object.hasOwn(submitted, "screenshot_png"), false);
});

test("navigation before capture cannot attach a screenshot from an unenabled page", async () => {
  const connection = {
    client_id: "rlc_0123456789abcdef0123456789abcdef",
    token: "t".repeat(43),
    clear_generation: 0,
    consent_version: 1,
    port: 7878,
  };
  let captures = 0;
  let submitted;
  const background = productionBackground({
    connection,
    getTab: async () => ({
      id: 7, windowId: 3, active: true, url: "https://other.test/page",
    }),
    captureVisibleTab: async () => {
      captures += 1;
      return `data:image/png;base64,${VALID_PNG_BASE64}`;
    },
    fetch: async (url, options = {}) => {
      if (url.endsWith("/generation")) return generationResponse();
      if (url.endsWith("/redlines") && options.method === "POST") {
        submitted = JSON.parse(options.body);
        return { ok: true, status: 201, async json() { return { id: "rl_navigated" }; } };
      }
      throw new Error(`unexpected request: ${url}`);
    },
  });

  assert.equal((await background.send(
    { type: "submit-redline", payload: { comment: "navigated" } },
    { tab: { id: 7, url: "https://enabled.test/page" } }
  )).ok, true);
  assert.equal(captures, 0);
  assert.equal(Object.hasOwn(submitted, "screenshot_png"), false);
});

test("switching away and back during capture invalidates the screenshot", async () => {
  const connection = {
    client_id: "rlc_0123456789abcdef0123456789abcdef",
    token: "t".repeat(43),
    clear_generation: 0,
    consent_version: 1,
    port: 7878,
  };
  let submitted;
  let background;
  background = productionBackground({
    connection,
    getTab: async () => ({
      id: 7, windowId: 3, active: true, url: "https://enabled.test/page",
    }),
    captureVisibleTab: async () => {
      background.fireTabActivated({ tabId: 8, windowId: 3 });
      background.fireTabActivated({ tabId: 7, windowId: 3 });
      return `data:image/png;base64,${VALID_PNG_BASE64}`;
    },
    fetch: async (url, options = {}) => {
      if (url.endsWith("/generation")) return generationResponse();
      if (url.endsWith("/redlines") && options.method === "POST") {
        submitted = JSON.parse(options.body);
        return { ok: true, status: 201, async json() { return { id: "rl_aba" }; } };
      }
      throw new Error(`unexpected request: ${url}`);
    },
  });

  assert.equal((await background.send(
    { type: "submit-redline", payload: { comment: "aba" } },
    { tab: { id: 7, url: "https://enabled.test/page" } }
  )).ok, true);
  assert.equal(Object.hasOwn(submitted, "screenshot_png"), false);
});

test("revoking screenshot access during capture prevents the PNG from being submitted", async (t) => {
  const connection = {
    client_id: "rlc_0123456789abcdef0123456789abcdef",
    token: "t".repeat(43),
    clear_generation: 0,
    consent_version: 1,
    port: 7878,
  };
  let releaseCapture;
  const capture = new Promise((resolve) => { releaseCapture = resolve; });
  t.after(() => releaseCapture(`data:image/png;base64,${VALID_PNG_BASE64}`));
  let revokePermission;
  let allowed = true;
  let submitted;
  const controller = {
    async start() {},
    async reconcile() {},
    async getState() { return { supported: true, siteEnabled: true, fullVisualEnabled: true }; },
    async canCaptureScreenshot() { return allowed; },
  };
  const background = productionBackground({
    connection,
    permissionControllerFactory: ({ onPermissionsChanged }) => {
      revokePermission = onPermissionsChanged;
      return controller;
    },
    captureVisibleTab: async () => await capture,
    fetch: async (url, options = {}) => {
      if (url.endsWith("/generation")) return generationResponse();
      submitted = JSON.parse(options.body);
      return { ok: true, status: 201, async json() { return { id: "rl_without_revoked_shot" }; } };
    },
  });

  const submission = background.send({ type: "submit-redline", payload: { comment: "No revoked PNG" } });
  await new Promise((resolve) => setImmediate(resolve));
  allowed = false;
  revokePermission();
  releaseCapture(`data:image/png;base64,${VALID_PNG_BASE64}`);

  assert.equal((await submission).ok, true);
  assert.equal(Object.hasOwn(submitted, "screenshot_png"), false);
});

test("a cached screenshot is revalidated before it can be reused", async () => {
  const connection = {
    client_id: "rlc_0123456789abcdef0123456789abcdef",
    token: "t".repeat(43),
    clear_generation: 0,
    consent_version: 1,
    port: 7878,
  };
  let permissionChecks = 0;
  const bodies = [];
  const controller = {
    async start() {},
    async reconcile() {},
    async getState() { return { supported: true, siteEnabled: true, fullVisualEnabled: true }; },
    async canCaptureScreenshot() {
      permissionChecks += 1;
      return permissionChecks < 4;
    },
  };
  const background = productionBackground({
    connection,
    permissionControllerFactory: () => controller,
    captureVisibleTab: async () => `data:image/png;base64,${VALID_PNG_BASE64}`,
    fetch: async (url, options = {}) => {
      if (url.endsWith("/generation")) return generationResponse();
      bodies.push(JSON.parse(options.body));
      return { ok: true, status: 201, async json() { return { id: `rl_cached_${bodies.length}` }; } };
    },
  });

  assert.equal((await background.send({ type: "submit-redline", payload: { comment: "first" } })).ok, true);
  assert.equal((await background.send({ type: "submit-redline", payload: { comment: "second" } })).ok, true);

  assert.equal(Object.hasOwn(bodies[0], "screenshot_png"), true);
  assert.equal(Object.hasOwn(bodies[1], "screenshot_png"), false);
  assert.equal(background.captures(), 1);
});

test("the service worker removes failed drafts when their seven-day retention expires", async () => {
  const connection = {
    client_id: "rlc_0123456789abcdef0123456789abcdef",
    token: "t".repeat(43),
    clear_generation: 0,
    port: 7878,
  };
  const storage = localStorageArea({ redline_connection: connection });
  const indexedDb = indexedDbArea();
  const background = productionBackground({
    connection,
    storageArea: storage,
    indexedDb,
    captureVisibleTab: async () => { throw new Error("no screenshot"); },
    fetch: async (url) => {
      if (url.endsWith("/generation")) return generationResponse();
      throw new TypeError("keep draft pending");
    },
  });
  await background.send({
    type: "submit-redline",
    submission_key: "draft_retention_expiry_012345",
    payload: { selected_text: "delete after retention" },
  });
  const [key, record] = [...indexedDb.records.entries()][0];
  record.created_at = "2020-01-01T00:00:00.000Z";
  record.expires_at = "2020-01-08T00:00:00.000Z";
  indexedDb.records.set(key, record);
  storage.data[key].created_at = record.created_at;
  storage.data[key].expires_at = record.expires_at;

  await background.fireAlarm("redline-pending-cleanup");

  assert.equal(indexedDb.records.size, 0);
  assert.deepEqual(Object.keys(storage.data), ["redline_connection"]);
});

test("startup deletes legacy pending drafts whose age cannot be proven", async () => {
  const connection = {
    client_id: "rlc_0123456789abcdef0123456789abcdef",
    token: "t".repeat(43),
    clear_generation: 0,
    consent_version: 1,
    port: 7878,
  };
  const key = "redline_pending::draft_legacy_cleanup_012345";
  const storage = localStorageArea({
    redline_connection: connection,
    [key]: {
      version: 2,
      client_id: connection.client_id,
      source_hash: "a".repeat(64),
      operation_id: "legacy_cleanup_012345",
      payload_hash: "b".repeat(64),
    },
  });
  const indexedDb = indexedDbArea();
  indexedDb.records.set(key, {
    version: 2,
    client_id: connection.client_id,
    source_hash: "a".repeat(64),
    operation_id: "legacy_cleanup_012345",
    payload: { operation_id: "legacy_cleanup_012345", clear_generation: 0 },
    payload_hash: "b".repeat(64),
  });

  productionBackground({ connection, storageArea: storage, indexedDb });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(indexedDb.records.size, 0);
  assert.equal(Object.hasOwn(storage.data, key), false);
});

test("editing local storage cannot forge consent or persist selected content", async () => {
  const storage = localStorageArea({
    redline_connection: {
      client_id: "rlc_0123456789abcdef0123456789abcdef",
      token: "t".repeat(43),
      clear_generation: 0,
      consent_version: 1,
      port: 7878,
      setup: { consent: "accepted", consented_at: "2026-08-07T19:00:00.000Z" },
    },
  });
  const indexedDb = indexedDbArea();
  const background = productionBackground({
    connection: storage.data.redline_connection,
    storageArea: storage,
    indexedDb,
    captureVisibleTab: async () => { throw new Error("must not capture"); },
    fetch: async () => ({
      ok: false,
      status: 401,
      async json() { return { error: { code: "unauthorized" } }; },
    }),
  });

  const result = await background.send({
    type: "submit-redline",
    submission_key: "draft_forged_consent_012345",
    payload: { selected_text: "must not persist", comment: "private feedback" },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error_code, "connection_required");
  assert.equal(indexedDb.records.size, 0);
  assert.equal(JSON.stringify(storage.data).includes("must not persist"), false);
});

test("large pending PNGs bypass storage.local quota and remain durable in IndexedDB", async () => {
  const png = new PNG({ width: 1450, height: 1450 });
  randomFillSync(png.data);
  const screenshot = PNG.sync.write(png);
  assert.ok(screenshot.length > 8 * 1024 * 1024 && screenshot.length < 10 * 1024 * 1024);
  const screenshotBase64 = screenshot.toString("base64");
  const storage = localStorageArea({
    redline_connection: {
      client_id: "rlc_0123456789abcdef0123456789abcdef",
      token: "t".repeat(43),
      clear_generation: 0,
      port: 7878,
    },
  }, { quotaBytes: 10 * 1024 * 1024 });
  const indexedDb = indexedDbArea();
  let postCount = 0;
  const background = productionBackground({
    connection: storage.data.redline_connection,
    storageArea: storage,
    indexedDb,
    decodeBase64(value) { return Buffer.from(value, "base64").toString("binary"); },
    captureVisibleTab: async () => `data:image/png;base64,${screenshotBase64}`,
    fetch: async (url) => {
      if (url.endsWith("/generation")) {
        return { ok: true, status: 200, async json() { return { clear_generation: 3 }; } };
      }
      postCount += 1;
      throw new TypeError("response lost after commit");
    },
  });

  const result = await background.send({
    type: "submit-redline",
    submission_key: "draft_large_quota_012345",
    payload: { comment: "Keep the full screenshot" },
  });

  assert.equal(result.ok, false);
  assert.equal(postCount, 2);
  assert.ok(Buffer.byteLength(JSON.stringify(storage.data)) < 4096);
  assert.doesNotMatch(JSON.stringify(storage.data), new RegExp(screenshotBase64.slice(0, 64)));
  assert.equal(indexedDb.records.size, 1);
  assert.equal([...indexedDb.records.values()][0].payload.screenshot_png, screenshotBase64);
});

test("IndexedDB write failure prevents submission and preserves bounded local storage", async () => {
  const storage = localStorageArea({
    redline_connection: {
      client_id: "rlc_0123456789abcdef0123456789abcdef",
      token: "t".repeat(43),
      clear_generation: 0,
      port: 7878,
    },
  });
  const indexedDb = indexedDbArea({ failPut: true });
  let fetches = 0;
  const background = productionBackground({
    connection: storage.data.redline_connection,
    storageArea: storage,
    indexedDb,
    captureVisibleTab: async () => `data:image/png;base64,${VALID_PNG_BASE64}`,
    fetch: async (url) => {
      if (url.endsWith("/generation")) return generationResponse();
      fetches += 1;
      throw new Error("must not submit");
    },
  });

  const result = await background.send({
    type: "submit-redline", payload: { comment: "Persist before sending" },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error_code, "pending_storage_unavailable");
  assert.equal(fetches, 0);
  assert.equal(indexedDb.records.size, 0);
  assert.deepEqual(Object.keys(storage.data), ["redline_connection"]);
});

test("cleanup failure retains the immutable IndexedDB draft for deterministic retry", async () => {
  const connection = {
    client_id: "rlc_0123456789abcdef0123456789abcdef",
    token: "t".repeat(43),
    clear_generation: 0,
    port: 7878,
  };
  const storage = localStorageArea({ redline_connection: connection });
  const indexedDb = indexedDbArea({ failDelete: true });
  const bodies = [];
  const firstWorker = productionBackground({
    connection, storageArea: storage, indexedDb,
    captureVisibleTab: async () => `data:image/png;base64,${VALID_PNG_BASE64}`,
    fetch: async (url, options) => {
      if (url.endsWith("/generation")) return generationResponse();
      bodies.push(options.body);
      return { ok: true, status: 201, async json() { return { id: "rl_cleanup" }; } };
    },
  });
  const message = {
    type: "submit-redline", submission_key: "draft_cleanup_0123456789",
    payload: { comment: "Retry cleanup safely" },
  };

  const incomplete = await firstWorker.send(message);
  assert.equal(incomplete.ok, false);
  assert.equal(incomplete.error_code, "pending_storage_unavailable");
  assert.equal(indexedDb.records.size, 1);
  assert.deepEqual(Object.keys(storage.data), ["redline_connection"]);

  indexedDb.failures.delete = false;
  const secondWorker = productionBackground({
    connection, storageArea: storage, indexedDb,
    captureVisibleTab: async () => { throw new Error("must not recapture"); },
    fetch: async (_url, options) => {
      bodies.push(options.body);
      return { ok: true, status: 200, async json() { return { id: "rl_cleanup" }; } };
    },
  });
  const retried = await secondWorker.send(message);

  assert.equal(retried.ok, true);
  assert.equal(secondWorker.captures(), 0);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1], bodies[0]);
  assert.equal(indexedDb.records.size, 0);
  assert.deepEqual(Object.keys(storage.data), ["redline_connection"]);
});

test("locator write failure leaves the IndexedDB operation recoverable without submitting", async () => {
  const connection = {
    client_id: "rlc_0123456789abcdef0123456789abcdef",
    token: "t".repeat(43),
    clear_generation: 0,
    port: 7878,
  };
  const storage = localStorageArea({ redline_connection: connection }, { failSet: true });
  const indexedDb = indexedDbArea();
  let posts = 0;
  const firstWorker = productionBackground({
    connection, storageArea: storage, indexedDb,
    captureVisibleTab: async () => `data:image/png;base64,${VALID_PNG_BASE64}`,
    fetch: async (url) => {
      if (url.endsWith("/generation")) return generationResponse();
      posts += 1;
      throw new Error("must not submit before locator commit");
    },
  });
  const message = {
    type: "submit-redline", submission_key: "draft_locator_failure_012345",
    payload: { comment: "Recover from the durable record" },
  };

  const failed = await firstWorker.send(message);
  assert.equal(failed.ok, false);
  assert.equal(failed.error_code, "pending_storage_unavailable");
  assert.equal(posts, 0);
  assert.equal(indexedDb.records.size, 1);
  assert.deepEqual(Object.keys(storage.data), ["redline_connection"]);

  storage.failures.set = false;
  const bodies = [];
  const secondWorker = productionBackground({
    connection, storageArea: storage, indexedDb,
    captureVisibleTab: async () => { throw new Error("must not recapture"); },
    fetch: async (url, options) => {
      assert.equal(url.endsWith("/generation"), false);
      bodies.push(options.body);
      return { ok: true, status: 201, async json() { return { id: "rl_locator" }; } };
    },
  });
  const recovered = await secondWorker.send(message);
  assert.equal(recovered.ok, true);
  assert.equal(secondWorker.captures(), 0);
  assert.equal(bodies.length, 1);
  assert.equal(indexedDb.records.size, 0);
  assert.deepEqual(Object.keys(storage.data), ["redline_connection"]);
});

test("a corrupted IndexedDB screenshot fails closed before retry network activity", async () => {
  const connection = {
    client_id: "rlc_0123456789abcdef0123456789abcdef",
    token: "t".repeat(43),
    clear_generation: 0,
    port: 7878,
  };
  const storage = localStorageArea({ redline_connection: connection });
  const indexedDb = indexedDbArea();
  const message = {
    type: "submit-redline", submission_key: "draft_corrupt_blob_012345",
    payload: { comment: "Keep screenshot integrity" },
  };
  const firstWorker = productionBackground({
    connection, storageArea: storage, indexedDb,
    captureVisibleTab: async () => `data:image/png;base64,${VALID_PNG_BASE64}`,
    fetch: async (url) => {
      if (url.endsWith("/generation")) return generationResponse();
      throw new TypeError("response lost");
    },
  });
  assert.equal((await firstWorker.send(message)).ok, false);
  const [key, record] = [...indexedDb.records.entries()][0];
  record.payload.screenshot_png = "corrupt-base64";
  indexedDb.records.set(key, record);

  let fetches = 0;
  const secondWorker = productionBackground({
    connection, storageArea: storage, indexedDb,
    captureVisibleTab: async () => { throw new Error("must not recapture"); },
    fetch: async () => {
      fetches += 1;
      return { ok: true, status: 200, async json() { return { id: "rl_corrupt" }; } };
    },
  });
  const result = await secondWorker.send(message);

  assert.equal(result.ok, false);
  assert.equal(result.error_code, "pending_submission_invalid");
  assert.equal(fetches, 0);
  assert.equal(indexedDb.records.size, 1);
  assert.equal(storage.data[key].operation_id, record.operation_id);
});

test("startup discards a legacy local draft before creating a fresh retry", async () => {
  const connection = {
    client_id: "rlc_0123456789abcdef0123456789abcdef",
    token: "t".repeat(43),
    clear_generation: 0,
    port: 7878,
  };
  const messagePayload = { comment: "Migrate this draft" };
  const sourceHash = await sha256Hex(JSON.stringify(messagePayload));
  const key = "redline_pending::draft_legacy_pending_012345";
  const payload = {
    ...messagePayload,
    operation_id: "op_legacy_pending_012345",
    clear_generation: 0,
    screenshot_png: VALID_PNG_BASE64,
  };
  const storage = localStorageArea({
    redline_connection: connection,
    [key]: {
      version: 1,
      client_id: connection.client_id,
      source_hash: sourceHash,
      operation_id: payload.operation_id,
      payload,
    },
  });
  const indexedDb = indexedDbArea();
  const bodies = [];
  const firstWorker = productionBackground({
    connection, storageArea: storage, indexedDb,
    captureVisibleTab: async () => `data:image/png;base64,${VALID_PNG_BASE64}`,
    fetch: async (url, options) => {
      if (url.endsWith("/generation")) return generationResponse();
      bodies.push(options.body);
      throw new TypeError("keep migrated retry pending");
    },
  });
  const message = {
    type: "submit-redline", submission_key: "draft_legacy_pending_012345", payload: messagePayload,
  };
  assert.equal((await firstWorker.send(message)).ok, false);
  assert.equal(firstWorker.captures(), 1);
  assert.equal(storage.data[key].version, 3);
  assert.equal(Object.hasOwn(storage.data[key], "payload"), false);
  assert.equal(indexedDb.records.get(key).version, 3);
  assert.equal(indexedDb.records.get(key).payload_hash, storage.data[key].payload_hash);

  const secondWorker = productionBackground({
    connection, storageArea: storage, indexedDb,
    captureVisibleTab: async () => { throw new Error("must not recapture"); },
    fetch: async (_url, options) => {
      bodies.push(options.body);
      return { ok: true, status: 200, async json() { return { id: "rl_legacy" }; } };
    },
  });
  assert.equal((await secondWorker.send(message)).ok, true);
  assert.equal(bodies[2], bodies[0]);
  assert.equal(indexedDb.records.size, 0);
  assert.deepEqual(Object.keys(storage.data), ["redline_connection"]);
});

test("startup discards a legacy locator without its IndexedDB record", async () => {
  const connection = {
    client_id: "rlc_0123456789abcdef0123456789abcdef",
    token: "t".repeat(43),
    clear_generation: 0,
    port: 7878,
  };
  const messagePayload = { comment: "Missing durable record" };
  const sourceHash = await sha256Hex(JSON.stringify(messagePayload));
  const payload = {
    ...messagePayload,
    operation_id: "op_missing_record_012345",
    clear_generation: 0,
  };
  const payloadHash = await sha256Hex(JSON.stringify({
    clear_generation: 0,
    comment: "Missing durable record",
    operation_id: "op_missing_record_012345",
  }));
  const key = "redline_pending::draft_missing_record_012345";
  const storage = localStorageArea({
    redline_connection: connection,
    [key]: {
      version: 2,
      client_id: connection.client_id,
      source_hash: sourceHash,
      operation_id: payload.operation_id,
      payload_hash: payloadHash,
    },
  });
  let fetches = 0;
  const background = productionBackground({
    connection, storageArea: storage, indexedDb: indexedDbArea(),
    captureVisibleTab: async () => { throw new Error("no screenshot"); },
    fetch: async (url) => {
      fetches += 1;
      if (url.endsWith("/generation")) return generationResponse();
      return { ok: true, status: 200, async json() { return { id: "rl_replaced" }; } };
    },
  });

  const result = await background.send({
    type: "submit-redline", submission_key: "draft_missing_record_012345", payload: messagePayload,
  });
  assert.equal(result.ok, true);
  assert.equal(fetches, 2);
  assert.equal(Object.hasOwn(storage.data, key), false);
});

test("a new custom-port draft fetches the post-clear generation before submission", async () => {
  const requests = [];
  const background = productionBackground({
    connection: null,
    config: { token: "custom-port-dev-token", port: 17891 },
    captureVisibleTab: async () => `data:image/png;base64,${VALID_PNG_BASE64}`,
    fetch: async (url, options = {}) => {
      requests.push({ url, options });
      if (url.endsWith("/generation")) {
        return { ok: true, status: 200, async json() { return { clear_generation: 1 }; } };
      }
      return { ok: true, status: 201, async json() { return { id: "rl_after_clear" }; } };
    },
  });

  const result = await background.send({
    type: "submit-redline", payload: { comment: "Created after clear" },
  });

  assert.equal(result.ok, true);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, "http://127.0.0.1:17891/generation");
  assert.equal(requests[0].options.headers["x-redline-token"], "custom-port-dev-token");
  const submitted = JSON.parse(requests[1].options.body);
  assert.equal(submitted.clear_generation, 1);
  assert.equal(requests[1].options.headers["x-redline-token"], "custom-port-dev-token");
  assert.equal(Object.hasOwn(requests[1].options.headers, "authorization"), false);
});

test("a retained pre-clear draft never refreshes generation on worker restart", async () => {
  const storage = localStorageArea();
  const indexedDb = indexedDbArea();
  const message = {
    type: "submit-redline", submission_key: "draft_before_clear_012345",
    payload: { comment: "Keep the old generation" },
  };
  let generationReads = 0;
  const firstBodies = [];
  const firstWorker = productionBackground({
    connection: null,
    storageArea: storage,
    indexedDb,
    config: { token: "custom-port-dev-token", port: 17892 },
    captureVisibleTab: async () => `data:image/png;base64,${VALID_PNG_BASE64}`,
    fetch: async (url, options = {}) => {
      if (url.endsWith("/generation")) {
        generationReads += 1;
        return { ok: true, status: 200, async json() { return { clear_generation: 0 }; } };
      }
      firstBodies.push(options.body);
      throw new TypeError("response lost before clear");
    },
  });
  const uncertain = await firstWorker.send(message);
  assert.equal(uncertain.ok, false);
  assert.equal(generationReads, 1);
  assert.equal(JSON.parse(firstBodies[0]).clear_generation, 0);

  const secondBodies = [];
  const secondWorker = productionBackground({
    connection: null,
    storageArea: storage,
    indexedDb,
    config: { token: "custom-port-dev-token", port: 17892 },
    captureVisibleTab: async () => { throw new Error("must not recapture"); },
    fetch: async (url, options = {}) => {
      if (url.endsWith("/generation")) {
        generationReads += 1;
        throw new Error("must not refresh a retained draft");
      }
      secondBodies.push(options.body);
      return {
        ok: false,
        status: 410,
        async json() { return { error: { code: "data_cleared" } }; },
      };
    },
  });
  const stale = await secondWorker.send(message);

  assert.equal(stale.ok, false);
  assert.equal(stale.error_code, "data_cleared");
  assert.equal(secondWorker.captures(), 0);
  assert.equal(generationReads, 1);
  assert.equal(secondBodies.length, 1);
  assert.equal(secondBodies[0], firstBodies[0]);
});

test("production uses paired bearer auth and reserves the legacy header for custom-port dev mode", () => {
  assert.match(backgroundSource, /const DEV_MODE = PORT !== 7878/);
  assert.match(backgroundSource, /headers:\s*\{ authorization: `Bearer \$\{connection\.token\}` \}/);
  assert.match(backgroundSource, /if \(DEV_MODE\)[\s\S]*'x-redline-token': token/);
  assert.doesNotMatch(backgroundSource, /REDLINE_AUTH_HEADERS/);
  assert.match(backgroundSource, /\/screenshots\/\$\{msg\.id\}/);
});

test("popup retrieves screenshots only through the authenticated trusted worker", async () => {
  const connection = {
    client_id: "rlc_0123456789abcdef0123456789abcdef",
    token: "t".repeat(43),
    clear_generation: 0,
    consent_version: 1,
    port: 7878,
  };
  let request;
  const png = Buffer.from(VALID_PNG_BASE64, "base64");
  const background = productionBackground({
    connection,
    fetch: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        status: 200,
        async arrayBuffer() {
          return png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength);
        },
      };
    },
  });

  const response = await background.send(
    { type: "get-screenshot", id: "ss_0123456789abcdef0123456789abcdef" },
    {
      id: "redline-test-extension",
      frameId: 0,
      url: "chrome-extension://redline-test-extension/popup.html",
    },
  );

  assert.deepEqual(structuredClone(response), { ok: true, screenshot_png: VALID_PNG_BASE64 });
  assert.equal(request.url.endsWith("/screenshots/ss_0123456789abcdef0123456789abcdef"), true);
  assert.equal(request.options.headers.authorization, `Bearer ${connection.token}`);
});

test("popup connection status verifies the stored capability with the authenticated generation endpoint", async () => {
  const connection = {
    client_id: "rlc_0123456789abcdef0123456789abcdef",
    token: "t".repeat(43),
    clear_generation: 0,
    consent_version: 1,
    port: 7878,
  };
  let request;
  const background = productionBackground({
    connection,
    fetch: async (url, options) => {
      request = { url, options };
      return generationResponse();
    },
  });

  assert.deepEqual(structuredClone(await background.send({ type: "connection-status" })), {
    ok: true, connected: true, protocol_version: 1,
  });
  assert.equal(request.url.endsWith("/generation"), true);
  assert.equal(request.options.headers.authorization, `Bearer ${connection.token}`);
});

test("a sidecar 401 explains how to refresh the stale extension context", async () => {
  let messageHandler;
  const context = {
    AbortController,
    URLSearchParams,
    atob,
    crypto: webcrypto,
    TextEncoder,
    console,
    setTimeout,
    clearTimeout,
    importScripts() {
      context.REDLINE_CONFIG = { token: "stale-capability-token", port: 7878 };
    },
    fetch: async () => ({ ok: false, status: 401 }),
    chrome: {
      alarms: alarmApi(),
      storage: pairedStorage(),
      tabs: {
        onUpdated: { addListener() {} },
        onRemoved: { addListener() {} },
      },
      runtime: {
        onMessage: {
          addListener(handler) {
            messageHandler = handler;
          },
        },
      },
    },
  };
  context.RedlineRevocations = require("../extension/revocations");
  vm.runInNewContext(backgroundSource, context);

  const response = await new Promise((resolve) => {
    messageHandler({ type: "list-redlines" }, {}, resolve);
  });

  assert.equal(response.ok, false);
  assert.match(response.error, /Reload Redline in chrome:\/\/extensions/i);
  assert.match(response.error, /refresh this page/i);
});

test("a stalled screenshot capture cannot block redline submission", async () => {
  let messageHandler;
  const requests = [];
  const context = {
    AbortController,
    URLSearchParams,
    atob,
    crypto: webcrypto,
    TextEncoder,
    console,
    setTimeout(callback) {
      queueMicrotask(callback);
      return 1;
    },
    clearTimeout() {},
    indexedDB: indexedDbArea(),
    importScripts() {
      context.REDLINE_CONFIG = { token: "test-capability-token", port: 7878 };
    },
    fetch: async (url, options = {}) => {
      requests.push({ url, options });
      if (url.endsWith("/generation")) return generationResponse();
      if (url.endsWith("/redlines")) {
        return {
          ok: true,
          async json() {
            return { id: "rl_test" };
          },
        };
      }
      throw new Error(`unexpected request: ${url}`);
    },
    chrome: {
      alarms: alarmApi(),
      storage: pairedStorage(),
      tabs: {
        async get() {
          return { id: 7, windowId: 3, active: true, url: "http://localhost:3404/" };
        },
        captureVisibleTab() {
          return new Promise(() => {});
        },
        onUpdated: { addListener() {} },
        onRemoved: { addListener() {} },
      },
      runtime: {
        onMessage: {
          addListener(handler) {
            messageHandler = handler;
          },
        },
      },
    },
  };
  context.RedlineRevocations = require("../extension/revocations");
  vm.runInNewContext(
    backgroundSource,
    context
  );

  const response = await new Promise((resolve, reject) => {
    messageHandler(
      {
        type: "submit-redline",
        payload: { comment: "install what?", screenshot_png: VALID_PNG_BASE64 },
      },
      { tab: { id: 7 } },
      resolve
    );
    setTimeout(() => reject(new Error("redline submission remained blocked")), 50);
  });

  assert.equal(response.ok, true);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, "http://127.0.0.1:7878/generation");
  assert.equal(requests[1].url, "http://127.0.0.1:7878/redlines");
  assert.equal(Object.hasOwn(JSON.parse(requests[1].options.body), "screenshot_png"), false);
});

test("deleting a redline invalidates cached screenshot IDs", async () => {
  let messageHandler;
  let captures = 0;
  const redlineBodies = [];
  const context = {
    AbortController,
    URLSearchParams,
    atob,
    crypto: webcrypto,
    TextEncoder,
    console,
    setTimeout,
    clearTimeout,
    indexedDB: indexedDbArea(),
    importScripts() {
      context.REDLINE_CONFIG = { token: "test-capability-token", port: 7878 };
    },
    fetch: async (url, options = {}) => {
      if (url.endsWith("/generation")) return generationResponse();
      if (url.endsWith("/redlines") && options.method === "POST") {
        redlineBodies.push(JSON.parse(options.body));
        return { ok: true, async json() { return { id: `rl_${redlineBodies.length}` }; } };
      }
      if (url.includes("/redlines/rl_1") && options.method === "DELETE") {
        return { ok: true, status: 204 };
      }
      throw new Error(`unexpected request: ${url}`);
    },
    chrome: {
      alarms: alarmApi(),
      storage: pairedStorage(),
      tabs: {
        async get() {
          return { id: 7, windowId: 3, active: true, url: "https://example.test/" };
        },
        async captureVisibleTab() {
          captures += 1;
          return `data:image/png;base64,${VALID_PNG_BASE64}`;
        },
        onUpdated: { addListener() {} },
        onRemoved: { addListener() {} },
      },
      runtime: {
        onMessage: {
          addListener(handler) {
            messageHandler = handler;
          },
        },
      },
    },
  };
  context.RedlineRevocations = require("../extension/revocations");
  vm.runInNewContext(backgroundSource, context);

  const send = (message) => new Promise((resolve) => {
    messageHandler(message, { tab: { id: 7, url: "https://example.test/" } }, resolve);
  });

  assert.equal((await send({ type: "submit-redline", payload: { comment: "first" } })).ok, true);
  assert.equal((await send({ type: "delete-redline", id: "rl_1" })).ok, true);
  assert.equal((await send({ type: "submit-redline", payload: { comment: "second" } })).ok, true);

  assert.equal(captures, 2);
  assert.deepEqual(redlineBodies.map((body) => body.screenshot_png), [VALID_PNG_BASE64, VALID_PNG_BASE64]);
  assert.equal(redlineBodies.some((body) => Object.hasOwn(body, "screenshot_id")), false);
});

test("delete waits for an in-flight screenshot and redline creation", async (t) => {
  let messageHandler;
  let resolveCapture;
  const events = [];
  const capture = new Promise((resolve) => { resolveCapture = resolve; });
  t.after(() => resolveCapture());
  const context = {
    AbortController,
    URLSearchParams,
    atob,
    crypto: webcrypto,
    TextEncoder,
    console,
    setTimeout,
    clearTimeout,
    indexedDB: indexedDbArea(),
    importScripts() {
      context.REDLINE_CONFIG = { token: "test-capability-token", port: 7878 };
    },
    fetch: async (url, options = {}) => {
      if (url.endsWith("/generation")) return generationResponse();
      if (url.endsWith("/redlines") && options.method === "POST") {
        events.push("redline-created");
        return { ok: true, async json() { return { id: "rl_race" }; } };
      }
      if (url.endsWith("/redlines/rl-old") && options.method === "DELETE") {
        events.push("redline-deleted");
        return { ok: true, status: 204 };
      }
      throw new Error(`unexpected request: ${url}`);
    },
    chrome: {
      alarms: alarmApi(),
      storage: pairedStorage(),
      tabs: {
        async get() {
          return { id: 7, windowId: 3, active: true, url: "https://example.test/" };
        },
        async captureVisibleTab() {
          events.push("screenshot-start");
          await capture;
          events.push("screenshot-done");
          return `data:image/png;base64,${VALID_PNG_BASE64}`;
        },
        onUpdated: { addListener() {} },
        onRemoved: { addListener() {} },
      },
      runtime: {
        onMessage: {
          addListener(handler) {
            messageHandler = handler;
          },
        },
      },
    },
  };
  context.RedlineRevocations = require("../extension/revocations");
  vm.runInNewContext(backgroundSource, context);

  const send = (message) => new Promise((resolve) => {
    messageHandler(message, { tab: { id: 7, url: "https://example.test/" } }, resolve);
  });
  const submitting = send({ type: "submit-redline", payload: { comment: "new" } });
  await waitUntil(() => events.includes("screenshot-start"), "screenshot capture did not start");
  const deleting = send({ type: "delete-redline", id: "rl-old" });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["screenshot-start"]);
  resolveCapture();
  assert.equal((await submitting).ok, true);
  assert.equal((await deleting).ok, true);
  assert.deepEqual(events, [
    "screenshot-start",
    "screenshot-done",
    "redline-created",
    "redline-deleted",
  ]);
});

test("refresh waits for an in-flight submission before invalidating its screenshot", async (t) => {
  let messageHandler;
  let resolveCapture;
  let captures = 0;
  const events = [];
  const capture = new Promise((resolve) => { resolveCapture = resolve; });
  t.after(() => resolveCapture());
  const context = {
    AbortController,
    URLSearchParams,
    atob,
    crypto: webcrypto,
    TextEncoder,
    console,
    setTimeout,
    clearTimeout,
    indexedDB: indexedDbArea(),
    importScripts() {
      context.REDLINE_CONFIG = { token: "test-capability-token", port: 7878 };
    },
    fetch: async (url, options = {}) => {
      if (url.endsWith("/generation")) return generationResponse();
      if (url.endsWith("/redlines") && options.method === "POST") {
        events.push("redline-created");
        return { ok: true, async json() { return { id: `rl_${captures}` }; } };
      }
      throw new Error(`unexpected request: ${url}`);
    },
    chrome: {
      alarms: alarmApi(),
      storage: pairedStorage(),
      tabs: {
        async get() {
          return { id: 7, windowId: 3, active: true, url: "https://example.test/" };
        },
        async captureVisibleTab() {
          captures += 1;
          events.push("screenshot-start");
          if (captures === 1) await capture;
          events.push("screenshot-done");
          return `data:image/png;base64,${VALID_PNG_BASE64}`;
        },
        onUpdated: { addListener() {} },
        onRemoved: { addListener() {} },
      },
      runtime: {
        onMessage: {
          addListener(handler) {
            messageHandler = handler;
          },
        },
      },
    },
  };
  context.RedlineRevocations = require("../extension/revocations");
  vm.runInNewContext(backgroundSource, context);

  const send = (message) => new Promise((resolve) => {
    messageHandler(message, { tab: { id: 7, url: "https://example.test/" } }, resolve);
  });
  const submitting = send({ type: "submit-redline", payload: { comment: "first" } });
  await waitUntil(() => events.includes("screenshot-start"), "screenshot capture did not start");
  const refreshing = send({ type: "refresh-screenshot", tabId: 7 });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["screenshot-start"]);
  resolveCapture();
  assert.equal((await submitting).ok, true);
  assert.equal((await refreshing).ok, true);
  assert.equal((await send({ type: "submit-redline", payload: { comment: "second" } })).ok, true);
  assert.equal(captures, 2);
});

test("a timed-out sidecar request releases the screenshot operation queue", async () => {
  let messageHandler;
  const context = {
    AbortController,
    URLSearchParams,
    atob,
    crypto: webcrypto,
    TextEncoder,
    console,
    setTimeout(callback, delay) {
      if (delay === 3000) queueMicrotask(callback);
      return 1;
    },
    clearTimeout() {},
    indexedDB: indexedDbArea(),
    importScripts() {
      context.REDLINE_CONFIG = { token: "test-capability-token", port: 7878 };
    },
    fetch: async (url, options = {}) => {
      if (url.endsWith("/generation")) return generationResponse();
      if (url.endsWith("/redlines") && options.method === "POST") {
        return await new Promise((_, reject) => {
          options.signal.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        });
      }
      if (url.endsWith("/redlines/rl-old") && options.method === "DELETE") {
        return { ok: true, status: 204 };
      }
      throw new Error(`unexpected request: ${url}`);
    },
    chrome: {
      alarms: alarmApi(),
      storage: pairedStorage(),
      tabs: {
        async get() {
          return { id: 7, windowId: 3, active: true, url: "https://example.test/" };
        },
        async captureVisibleTab() {
          return `data:image/png;base64,${VALID_PNG_BASE64}`;
        },
        onUpdated: { addListener() {} },
        onRemoved: { addListener() {} },
      },
      runtime: {
        onMessage: {
          addListener(handler) {
            messageHandler = handler;
          },
        },
      },
    },
  };
  context.RedlineRevocations = require("../extension/revocations");
  vm.runInNewContext(backgroundSource, context);

  const send = (message) => new Promise((resolve) => {
    messageHandler(message, { tab: { id: 7, url: "https://example.test/" } }, resolve);
  });
  const submitted = await send({ type: "submit-redline", payload: { comment: "stalls" } });
  assert.equal(submitted.ok, false);
  assert.match(submitted.error, /sidecar request timed out/i);

  const deleted = await send({ type: "delete-redline", id: "rl-old" });
  assert.equal(deleted.ok, true);
});

test("a stalled response body times out and releases the screenshot operation queue", async () => {
  let messageHandler;
  const context = {
    AbortController,
    URLSearchParams,
    atob,
    crypto: webcrypto,
    TextEncoder,
    console,
    setTimeout(callback, delay) {
      if (delay === 3000) queueMicrotask(callback);
      return 1;
    },
    clearTimeout() {},
    indexedDB: indexedDbArea(),
    importScripts() {
      context.REDLINE_CONFIG = { token: "test-capability-token", port: 7878 };
    },
    fetch: async (url, options = {}) => {
      if (url.endsWith("/generation")) return generationResponse();
      if (url.endsWith("/redlines") && options.method === "POST") {
        return {
          ok: true,
          async json() {
            return await new Promise((_, reject) => {
              const abort = () => {
                const error = new Error("body aborted");
                error.name = "AbortError";
                reject(error);
              };
              if (options.signal.aborted) abort();
              else options.signal.addEventListener("abort", abort);
            });
          },
        };
      }
      if (url.endsWith("/redlines/rl-old") && options.method === "DELETE") {
        return { ok: true, status: 204 };
      }
      throw new Error(`unexpected request: ${url}`);
    },
    chrome: {
      alarms: alarmApi(),
      storage: pairedStorage(),
      tabs: {
        async get() {
          return { id: 7, windowId: 3, active: true, url: "https://example.test/" };
        },
        async captureVisibleTab() {
          return `data:image/png;base64,${VALID_PNG_BASE64}`;
        },
        onUpdated: { addListener() {} },
        onRemoved: { addListener() {} },
      },
      runtime: {
        onMessage: {
          addListener(handler) {
            messageHandler = handler;
          },
        },
      },
    },
  };
  context.RedlineRevocations = require("../extension/revocations");
  vm.runInNewContext(backgroundSource, context);

  const send = (message) => new Promise((resolve) => {
    messageHandler(message, { tab: { id: 7, url: "https://example.test/" } }, resolve);
  });
  const submitted = await send({ type: "submit-redline", payload: { comment: "stalls" } });
  assert.equal(submitted.ok, false);
  assert.match(submitted.error, /sidecar request timed out/i);

  const deleted = await send({ type: "delete-redline", id: "rl-old" });
  assert.equal(deleted.ok, true);
});

test("production submission sends one bearer-authenticated transaction with the PNG", async () => {
  const requests = [];
  const connection = {
    client_id: "rlc_0123456789abcdef0123456789abcdef",
    token: "t".repeat(43),
    clear_generation: 7,
    port: 7878,
  };
  const background = productionBackground({
    connection,
    captureVisibleTab: async () => `data:image/png;base64,${VALID_PNG_BASE64}`,
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith("/generation")) return generationResponse(7);
      return { ok: true, status: 201, async json() { return { id: "rl_one" }; } };
    },
  });
  const response = await background.send({
    type: "submit-redline",
    payload: {
      operation_id: "op_from_message_1234",
      comment: "Use the clearer label",
      context: { selector: "main > button" },
    },
  });

  assert.equal(response.ok, true);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, "http://127.0.0.1:7878/generation");
  assert.equal(requests[1].url, "http://127.0.0.1:7878/redlines");
  assert.equal(requests[0].options.headers.authorization, `Bearer ${"t".repeat(43)}`);
  assert.equal(requests[1].options.headers.authorization, `Bearer ${"t".repeat(43)}`);
  assert.equal(Object.hasOwn(requests[1].options.headers, "x-redline-token"), false);
  const body = JSON.parse(requests[1].options.body);
  assert.equal(body.operation_id, "op_from_message_1234");
  assert.equal(body.clear_generation, 7);
  assert.equal(body.screenshot_png, VALID_PNG_BASE64);
  assert.equal(body.comment, "Use the clearer label");
  assert.equal(background.captures(), 1);
  assert.equal(requests.some((request) => request.url.endsWith("/screenshots")), false);
});

test("an uncertain submission retry reuses its generated operation ID", async () => {
  const bodies = [];
  const background = productionBackground({
    connection: {
      client_id: "rlc_0123456789abcdef0123456789abcdef",
      token: "t".repeat(43),
      clear_generation: 2,
      port: 7878,
    },
    captureVisibleTab: async () => `data:image/png;base64,${VALID_PNG_BASE64}`,
    fetch: async (url, options) => {
      if (url.endsWith("/generation")) return generationResponse(2);
      assert.equal(url.endsWith("/redlines"), true);
      bodies.push(JSON.parse(options.body));
      if (bodies.length === 1) throw new TypeError("connection reset after write");
      return { ok: true, status: 200, async json() { return { id: "rl_replayed" }; } };
    },
  });

  const response = await background.send({ type: "submit-redline", payload: { comment: "Retry me" } });
  assert.equal(response.ok, true);
  assert.equal(bodies.length, 2);
  assert.match(bodies[0].operation_id, /^op_[A-Za-z0-9_-]{20,}$/);
  assert.equal(bodies[1].operation_id, bodies[0].operation_id);
  assert.deepEqual(bodies[1], bodies[0]);
  assert.equal(background.captures(), 1);
});

test("an unreadable success response retries with the same operation instead of claiming success", async () => {
  const bodies = [];
  const background = productionBackground({
    connection: {
      client_id: "rlc_0123456789abcdef0123456789abcdef",
      token: "t".repeat(43),
      clear_generation: 2,
      port: 7878,
    },
    captureVisibleTab: async () => `data:image/png;base64,${VALID_PNG_BASE64}`,
    fetch: async (url, options) => {
      if (url.endsWith("/generation")) return generationResponse(2);
      bodies.push(JSON.parse(options.body));
      if (bodies.length === 1) {
        return { ok: true, status: 201, async json() { throw new SyntaxError("truncated response"); } };
      }
      return { ok: true, status: 200, async json() { return { id: "rl_replayed" }; } };
    },
  });

  const response = await background.send({ type: "submit-redline", payload: { comment: "Retry me" } });
  assert.equal(response.ok, true);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].operation_id, bodies[0].operation_id);
});

test("a worker restart reuses the durable byte-identical submission without recapturing", async () => {
  const connection = {
    client_id: "rlc_0123456789abcdef0123456789abcdef",
    token: "t".repeat(43),
    clear_generation: 4,
    port: 7878,
  };
  const storage = localStorageArea({ redline_connection: connection });
  const indexedDb = indexedDbArea();
  const firstBodies = [];
  const firstWorker = productionBackground({
    connection,
    storageArea: storage,
    indexedDb,
    captureVisibleTab: async () => `data:image/png;base64,${VALID_PNG_BASE64}`,
    fetch: async (url, options) => {
      if (url.endsWith("/generation")) return generationResponse(4);
      firstBodies.push(options.body);
      throw new TypeError("response lost after commit");
    },
  });
  const message = {
    type: "submit-redline",
    submission_key: "draft_restart_0123456789",
    payload: { comment: "Keep this exact request", context: { selector: "main" } },
  };

  const uncertain = await firstWorker.send(message);
  assert.equal(uncertain.ok, false);
  assert.equal(firstWorker.captures(), 1);
  const pendingKey = Object.keys(storage.data).find((key) => key.startsWith("redline_pending::"));
  assert.ok(pendingKey);
  assert.equal(storage.data[pendingKey].operation_id, JSON.parse(firstBodies[0]).operation_id);
  assert.equal(indexedDb.records.get(pendingKey).payload.operation_id, JSON.parse(firstBodies[0]).operation_id);

  const retryBodies = [];
  const secondWorker = productionBackground({
    connection,
    storageArea: storage,
    indexedDb,
    captureVisibleTab: async () => { throw new Error("must not recapture"); },
    fetch: async (_url, options) => {
      retryBodies.push(options.body);
      return { ok: true, status: 200, async json() { return { id: "rl_durable" }; } };
    },
  });
  const recovered = await secondWorker.send(message);

  assert.equal(recovered.ok, true);
  assert.equal(secondWorker.captures(), 0);
  assert.equal(retryBodies[0], firstBodies[0]);
  assert.equal(Object.hasOwn(storage.data, pendingKey), false);
});

test("missing connection and typed conflict/deletion responses are repair-safe and content-free", async () => {
  let fetches = 0;
  const disconnected = productionBackground({
    connection: null,
    captureVisibleTab: async () => `data:image/png;base64,${VALID_PNG_BASE64}`,
    fetch: async () => { fetches += 1; throw new Error("must not fetch"); },
  });
  const missing = await disconnected.send({
    type: "submit-redline", payload: { comment: "private draft text" },
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.error_code, "connection_required");
  assert.equal(missing.error, "Redline needs to be connected again before submitting.");
  assert.equal(disconnected.captures(), 0);
  assert.equal(fetches, 0);

  const invalid = productionBackground({
    connection: {
      client_id: "rlc_0123456789abcdef0123456789abcdef",
      token: "t".repeat(43),
      clear_generation: 2,
      port: 7878,
    },
    captureVisibleTab: async () => { throw new Error("must not capture"); },
    fetch: async () => { throw new Error("must not fetch"); },
  });
  const invalidOperation = await invalid.send({
    type: "submit-redline",
    payload: { operation_id: "../not-an-operation", comment: "private draft text" },
  });
  assert.equal(invalidOperation.ok, false);
  assert.equal(invalidOperation.error_code, "invalid_operation_id");
  assert.equal(invalid.captures(), 0);

  for (const [status, code] of [[409, "operation_conflict"], [410, "operation_deleted"], [410, "data_cleared"]]) {
    const background = productionBackground({
      connection: {
        client_id: "rlc_0123456789abcdef0123456789abcdef",
        token: "t".repeat(43),
        clear_generation: 2,
        port: 7878,
      },
      captureVisibleTab: async () => { throw new Error("no screenshot permission"); },
      fetch: async (url) => {
        if (url.endsWith("/generation")) return generationResponse(2);
        return {
          ok: false,
          status,
          async json() {
            return { error: { code, message: "private draft text paired-browser-token" } };
          },
        };
      },
    });
    const result = await background.send({
      type: "submit-redline",
      payload: { operation_id: "op_typed_error_1234", comment: "private draft text" },
    });
    assert.equal(result.ok, false, code);
    assert.equal(result.error_code, code, code);
    assert.doesNotMatch(result.error, /private draft text|paired-browser-token/, code);
  }
});

test("a sparse draft is rejected before capture, persistence, or network serialization", async () => {
  let fetches = 0;
  const storage = localStorageArea({
    redline_connection: {
      client_id: "rlc_0123456789abcdef0123456789abcdef",
      token: "t".repeat(43),
      clear_generation: 0,
      port: 7878,
    },
  });
  const background = productionBackground({
    connection: storage.data.redline_connection,
    storageArea: storage,
    captureVisibleTab: async () => { throw new Error("must not capture"); },
    fetch: async () => { fetches += 1; throw new Error("must not fetch"); },
  });
  const sparse = [];
  sparse.length = 1;

  const result = await background.send({
    type: "submit-redline", payload: { comment: "invalid", context: { sparse } },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error_code, "invalid_submission");
  assert.equal(background.captures(), 0);
  assert.equal(fetches, 0);
  assert.deepEqual(Object.keys(storage.data), ["redline_connection"]);
});
