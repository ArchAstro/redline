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
  return {
    local: localStorageArea({
      redline_connection: {
        client_id: "rlc_0123456789abcdef0123456789abcdef",
        token: "test-capability-token",
        clear_generation: 0,
        port: 7878,
        ...overrides,
      },
    }),
  };
}

function localStorageArea(initial = {}, { quotaBytes = Infinity, failSet = false, failRemove = false } = {}) {
  const data = structuredClone(initial);
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
                    if (kind === "put") records.set(key, structuredClone(value));
                    if (kind === "delete") records.delete(key);
                    result.onsuccess?.();
                    queueMicrotask(() => transaction.oncomplete?.());
                  });
                  return result;
                };
                return {
                  get(key) { return operation("get", key); },
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
  config = { token: "must-not-be-used-in-production", port: 7878 },
}) {
  let messageHandler;
  let captures = 0;
  const effectiveStorage = storageArea || localStorageArea(
    connection ? { redline_connection: connection } : {}
  );
  const effectiveIndexedDb = indexedDb || indexedDbArea();
  const context = {
    AbortController,
    URLSearchParams,
    atob: decodeBase64,
    console,
    crypto: webcrypto,
    TextEncoder,
    setTimeout,
    clearTimeout,
    importScripts() {
      context.REDLINE_CONFIG = config;
    },
    indexedDB: effectiveIndexedDb,
    fetch,
    chrome: {
      storage: {
        local: effectiveStorage,
      },
      tabs: {
        async get() { return { id: 7, windowId: 3, url: "https://example.test/page" }; },
        async captureVisibleTab(...args) {
          captures += 1;
          return captureVisibleTab(...args);
        },
        onUpdated: { addListener() {} },
        onRemoved: { addListener() {} },
      },
      runtime: {
        onMessage: { addListener(handler) { messageHandler = handler; } },
      },
    },
  };
  vm.runInNewContext(backgroundSource, context);
  return {
    captures: () => captures,
    indexedDb: effectiveIndexedDb,
    send(message) {
      return new Promise((resolve) => messageHandler(message, { tab: { id: 7 } }, resolve));
    },
  };
}

test("large pending PNGs bypass storage.local quota and remain durable in IndexedDB", async () => {
  const png = new PNG({ width: 1450, height: 1450 });
  randomFillSync(png.data);
  const screenshot = PNG.sync.write(png);
  assert.ok(screenshot.length > 8 * 1024 * 1024 && screenshot.length < 10 * 1024 * 1024);
  const screenshotBase64 = screenshot.toString("base64");
  const storage = localStorageArea({
    redline_connection: {
      client_id: "rlc_0123456789abcdef0123456789abcdef",
      token: "paired-browser-token",
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
      token: "paired-browser-token",
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
    token: "paired-browser-token",
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
    token: "paired-browser-token",
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
    token: "paired-browser-token",
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

test("a legacy storage.local pending draft migrates to IndexedDB before retry", async () => {
  const connection = {
    client_id: "rlc_0123456789abcdef0123456789abcdef",
    token: "paired-browser-token",
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
    captureVisibleTab: async () => { throw new Error("must not recapture"); },
    fetch: async (url, options) => {
      assert.equal(url.endsWith("/redlines"), true);
      bodies.push(options.body);
      throw new TypeError("keep migrated retry pending");
    },
  });
  const message = {
    type: "submit-redline", submission_key: "draft_legacy_pending_012345", payload: messagePayload,
  };
  assert.equal((await firstWorker.send(message)).ok, false);
  assert.equal(firstWorker.captures(), 0);
  assert.equal(storage.data[key].version, 2);
  assert.equal(Object.hasOwn(storage.data[key], "payload"), false);
  assert.equal(indexedDb.records.get(key).version, 2);
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

test("a pending locator without its IndexedDB record fails closed", async () => {
  const connection = {
    client_id: "rlc_0123456789abcdef0123456789abcdef",
    token: "paired-browser-token",
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
    captureVisibleTab: async () => { throw new Error("must not recapture"); },
    fetch: async () => { fetches += 1; throw new Error("must not fetch"); },
  });

  const result = await background.send({
    type: "submit-redline", submission_key: "draft_missing_record_012345", payload: messagePayload,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error_code, "pending_submission_invalid");
  assert.equal(fetches, 0);
  assert.equal(background.captures(), 0);
  assert.ok(storage.data[key]);
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
  assert.doesNotMatch(backgroundSource, /\/screenshots/);
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
      storage: pairedStorage(),
      tabs: {
        async get() {
          return { id: 7, windowId: 3, url: "http://localhost:3404/" };
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
      storage: pairedStorage(),
      tabs: {
        async get() {
          return { id: 7, windowId: 3, url: "https://example.test/" };
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
  vm.runInNewContext(backgroundSource, context);

  const send = (message) => new Promise((resolve) => {
    messageHandler(message, { tab: { id: 7 } }, resolve);
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
      storage: pairedStorage(),
      tabs: {
        async get() {
          return { id: 7, windowId: 3, url: "https://example.test/" };
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
  vm.runInNewContext(backgroundSource, context);

  const send = (message) => new Promise((resolve) => {
    messageHandler(message, { tab: { id: 7 } }, resolve);
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
      storage: pairedStorage(),
      tabs: {
        async get() {
          return { id: 7, windowId: 3, url: "https://example.test/" };
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
  vm.runInNewContext(backgroundSource, context);

  const send = (message) => new Promise((resolve) => {
    messageHandler(message, { tab: { id: 7 } }, resolve);
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
      storage: pairedStorage(),
      tabs: {
        async get() {
          return { id: 7, windowId: 3, url: "https://example.test/" };
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
  vm.runInNewContext(backgroundSource, context);

  const send = (message) => new Promise((resolve) => {
    messageHandler(message, { tab: { id: 7 } }, resolve);
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
      storage: pairedStorage(),
      tabs: {
        async get() {
          return { id: 7, windowId: 3, url: "https://example.test/" };
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
  vm.runInNewContext(backgroundSource, context);

  const send = (message) => new Promise((resolve) => {
    messageHandler(message, { tab: { id: 7 } }, resolve);
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
    token: "paired-browser-token",
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
  assert.equal(requests[0].options.headers.authorization, "Bearer paired-browser-token");
  assert.equal(requests[1].options.headers.authorization, "Bearer paired-browser-token");
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
      token: "paired-browser-token",
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
      token: "paired-browser-token",
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
    token: "paired-browser-token",
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
      token: "paired-browser-token",
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
        token: "paired-browser-token",
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
      token: "paired-browser-token",
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
