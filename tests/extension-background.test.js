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

test("a stalled screenshot capture cannot block redline submission", async () => {
  let messageHandler;
  const requests = [];
  const context = {
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
