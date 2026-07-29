const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const backgroundSource = fs.readFileSync(
  path.join(__dirname, "../extension/background.js"),
  "utf8"
);

test("extension sidecar requests carry the injected capability token", () => {
  assert.match(backgroundSource, /REDLINE_AUTH_HEADERS/);
  assert.match(backgroundSource, /x-redline-token/);
  assert.match(backgroundSource, /headers:\s*\{[^}]*\.\.\.REDLINE_AUTH_HEADERS/s);
});

test("a sidecar 401 explains how to refresh the stale extension context", async () => {
  let messageHandler;
  const context = {
    AbortController,
    URLSearchParams,
    console,
    setTimeout,
    clearTimeout,
    importScripts() {
      context.REDLINE_CONFIG = { token: "stale-capability-token", port: 7878 };
    },
    fetch: async () => ({ ok: false, status: 401 }),
    chrome: {
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
    console,
    setTimeout(callback) {
      queueMicrotask(callback);
      return 1;
    },
    clearTimeout() {},
    importScripts() {
      context.REDLINE_CONFIG = { token: "test-capability-token", port: 7878 };
    },
    fetch: async (url, options = {}) => {
      requests.push({ url, options });
      if (url.endsWith("/redlines")) {
        return {
          ok: true,
          async json() {
            return { id: "rl-test" };
          },
        };
      }
      throw new Error(`unexpected request: ${url}`);
    },
    chrome: {
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
      { type: "submit-redline", payload: { comment: "install what?" } },
      { tab: { id: 7 } },
      resolve
    );
    setTimeout(() => reject(new Error("redline submission remained blocked")), 50);
  });

  assert.equal(response.ok, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "http://127.0.0.1:7878/redlines");
  assert.equal(JSON.parse(requests[0].options.body).screenshot_id, null);
});

test("deleting a redline invalidates cached screenshot IDs", async () => {
  let messageHandler;
  let captures = 0;
  let uploads = 0;
  const redlineBodies = [];
  const context = {
    AbortController,
    URLSearchParams,
    console,
    setTimeout,
    clearTimeout,
    importScripts() {
      context.REDLINE_CONFIG = { token: "test-capability-token", port: 7878 };
    },
    fetch: async (url, options = {}) => {
      if (url.endsWith("/screenshots")) {
        uploads += 1;
        return { ok: true, async json() { return { id: `ss-${uploads}` }; } };
      }
      if (url.endsWith("/redlines") && options.method === "POST") {
        redlineBodies.push(JSON.parse(options.body));
        return { ok: true, async json() { return { id: `rl-${redlineBodies.length}` }; } };
      }
      if (url.includes("/redlines/rl-1") && options.method === "DELETE") {
        return { ok: true, status: 204 };
      }
      throw new Error(`unexpected request: ${url}`);
    },
    chrome: {
      tabs: {
        async get() {
          return { id: 7, windowId: 3, url: "https://example.test/" };
        },
        async captureVisibleTab() {
          captures += 1;
          return "data:image/png;base64,cG5n";
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
  assert.equal((await send({ type: "delete-redline", id: "rl-1" })).ok, true);
  assert.equal((await send({ type: "submit-redline", payload: { comment: "second" } })).ok, true);

  assert.equal(captures, 2);
  assert.equal(uploads, 2);
  assert.deepEqual(redlineBodies.map((body) => body.screenshot_id), ["ss-1", "ss-2"]);
});

test("delete waits for an in-flight screenshot and redline creation", async () => {
  let messageHandler;
  let resolveUpload;
  const events = [];
  const upload = new Promise((resolve) => { resolveUpload = resolve; });
  const context = {
    AbortController,
    URLSearchParams,
    console,
    setTimeout,
    clearTimeout,
    importScripts() {
      context.REDLINE_CONFIG = { token: "test-capability-token", port: 7878 };
    },
    fetch: async (url, options = {}) => {
      if (url.endsWith("/screenshots")) {
        events.push("screenshot-start");
        await upload;
        events.push("screenshot-done");
        return { ok: true, async json() { return { id: "ss-race" }; } };
      }
      if (url.endsWith("/redlines") && options.method === "POST") {
        events.push("redline-created");
        return { ok: true, async json() { return { id: "rl-race" }; } };
      }
      if (url.endsWith("/redlines/rl-old") && options.method === "DELETE") {
        events.push("redline-deleted");
        return { ok: true, status: 204 };
      }
      throw new Error(`unexpected request: ${url}`);
    },
    chrome: {
      tabs: {
        async get() {
          return { id: 7, windowId: 3, url: "https://example.test/" };
        },
        async captureVisibleTab() {
          return "data:image/png;base64,cG5n";
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
  while (!events.includes("screenshot-start")) await new Promise((resolve) => setImmediate(resolve));
  const deleting = send({ type: "delete-redline", id: "rl-old" });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["screenshot-start"]);
  resolveUpload();
  assert.equal((await submitting).ok, true);
  assert.equal((await deleting).ok, true);
  assert.deepEqual(events, [
    "screenshot-start",
    "screenshot-done",
    "redline-created",
    "redline-deleted",
  ]);
});

test("refresh waits for an in-flight submission before invalidating its screenshot", async () => {
  let messageHandler;
  let resolveUpload;
  let captures = 0;
  const events = [];
  const upload = new Promise((resolve) => { resolveUpload = resolve; });
  const context = {
    AbortController,
    URLSearchParams,
    console,
    setTimeout,
    clearTimeout,
    importScripts() {
      context.REDLINE_CONFIG = { token: "test-capability-token", port: 7878 };
    },
    fetch: async (url, options = {}) => {
      if (url.endsWith("/screenshots")) {
        events.push("screenshot-start");
        if (captures === 1) await upload;
        events.push("screenshot-done");
        return { ok: true, async json() { return { id: `ss-${captures}` }; } };
      }
      if (url.endsWith("/redlines") && options.method === "POST") {
        events.push("redline-created");
        return { ok: true, async json() { return { id: `rl-${captures}` }; } };
      }
      throw new Error(`unexpected request: ${url}`);
    },
    chrome: {
      tabs: {
        async get() {
          return { id: 7, windowId: 3, url: "https://example.test/" };
        },
        async captureVisibleTab() {
          captures += 1;
          return "data:image/png;base64,cG5n";
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
  while (!events.includes("screenshot-start")) await new Promise((resolve) => setImmediate(resolve));
  const refreshing = send({ type: "refresh-screenshot", tabId: 7 });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["screenshot-start"]);
  resolveUpload();
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
    console,
    setTimeout(callback, delay) {
      if (delay === 3000) queueMicrotask(callback);
      return 1;
    },
    clearTimeout() {},
    importScripts() {
      context.REDLINE_CONFIG = { token: "test-capability-token", port: 7878 };
    },
    fetch: async (url, options = {}) => {
      if (
        url.endsWith("/screenshots")
        || (url.endsWith("/redlines") && options.method === "POST")
      ) {
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
      tabs: {
        async get() {
          return { id: 7, windowId: 3, url: "https://example.test/" };
        },
        async captureVisibleTab() {
          return "data:image/png;base64,cG5n";
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
    console,
    setTimeout(callback, delay) {
      if (delay === 3000) queueMicrotask(callback);
      return 1;
    },
    clearTimeout() {},
    importScripts() {
      context.REDLINE_CONFIG = { token: "test-capability-token", port: 7878 };
    },
    fetch: async (url, options = {}) => {
      if (url.endsWith("/screenshots")) {
        return { ok: true, async json() { return { id: "ss-body" }; } };
      }
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
      tabs: {
        async get() {
          return { id: 7, windowId: 3, url: "https://example.test/" };
        },
        async captureVisibleTab() {
          return "data:image/png;base64,cG5n";
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
