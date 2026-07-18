const assert = require("node:assert/strict");
const test = require("node:test");

const catalog = require("../docs/oss/app.js");

function createEventTarget(properties = {}) {
  const listeners = new Map();
  return Object.assign(
    {
      addEventListener(type, listener) {
        const handlers = listeners.get(type) || [];
        handlers.push(listener);
        listeners.set(type, handlers);
      },
      removeAttribute(name) {
        if (this.attributes) delete this.attributes[name];
      },
      async emit(type, event = {}) {
        for (const listener of listeners.get(type) || []) {
          await listener(event);
        }
      },
    },
    properties
  );
}

function createInterestElements() {
  const label = { textContent: "Useful" };
  const button = createEventTarget({
    disabled: false,
    attributes: { "aria-pressed": "false" },
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    querySelector(selector) {
      return selector === "[data-interest-label]" ? label : null;
    },
  });
  const form = createEventTarget({ hidden: true });
  const note = { hidden: false, textContent: "", dataset: {} };
  return { button, form, note };
}

function addEmailControls(elements, email) {
  const emailInput = {
    value: email,
    disabled: false,
    checkValidity: () => true,
    reportValidity() {},
  };
  const submitButton = { disabled: false, textContent: "Notify me" };
  const broaderUpdates = { checked: false, disabled: false };
  elements.form.querySelector = (selector) => {
    if (selector === '[name="email"]') return emailInput;
    if (selector === 'button[type="submit"]') return submitButton;
    if (selector === '[name="broader_updates"]') return broaderUpdates;
    return null;
  };
  return { emailInput, submitButton, broaderUpdates };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createDialogElements() {
  const dialogMedia = createEventTarget({
    src: "",
    poster: "",
    currentTime: 0,
    playCalls: 0,
    pauseCalls: 0,
    async play() {
      this.playCalls += 1;
    },
    pause() {
      this.pauseCalls += 1;
    },
    removeAttribute(name) {
      if (name === "src") this.src = "";
      if (name === "poster") this.poster = "";
    },
    loadCalls: 0,
    load() {
      this.loadCalls += 1;
    },
  });
  const closeButton = createEventTarget();
  const dialog = createEventTarget({
    open: false,
    showModalCalls: 0,
    closeCalls: 0,
    showModal() {
      this.open = true;
      this.showModalCalls += 1;
    },
    close() {
      this.open = false;
      this.closeCalls += 1;
      return this.emit("close");
    },
    querySelector(selector) {
      if (selector === "[data-recording-dialog-media]") return dialogMedia;
      if (selector === "[data-recording-dialog-title]") return this.title;
      if (selector === "[data-recording-dialog-caption]") return this.caption;
      if (selector === "[data-recording-dialog-close]") return closeButton;
      return null;
    },
    title: { textContent: "" },
    caption: { textContent: "" },
  });
  return { dialog, dialogMedia, closeButton };
}

test("production thumbs-up reveals the form immediately and reports save rejection", async () => {
  const elements = createInterestElements();
  const { emailInput, submitButton, broaderUpdates } = addEmailControls(elements, "");
  catalog.bindInterestItem({
    item: "aster",
    ...elements,
    isLocalPreview: false,
    fetchImpl: async () => ({ ok: false, status: 503 }),
  });

  await elements.button.emit("click");

  assert.equal(elements.form.hidden, false);
  assert.equal(elements.button.attributes["aria-pressed"], "false");
  assert.equal(elements.note.hidden, false);
  assert.equal(elements.note.dataset.state, "error");
  assert.match(elements.note.textContent, /Could not save your feedback/);
  assert.equal(emailInput.disabled, true);
  assert.equal(submitButton.disabled, true);
  assert.equal(broaderUpdates.disabled, true);
});

test("local interest state remains independent for Aster and Astrodev", async () => {
  const records = new Map();
  const storage = {
    getItem(key) {
      return records.get(key) || null;
    },
    setItem(key, value) {
      records.set(key, value);
    },
  };
  const aster = createInterestElements();
  const astrodev = createInterestElements();
  const now = () => new Date("2026-07-16T12:00:00.000Z");

  catalog.bindInterestItem({
    item: "aster",
    ...aster,
    isLocalPreview: true,
    storage,
    now,
    createEventId: () => "evt-aster",
  });
  catalog.bindInterestItem({
    item: "astrodev",
    ...astrodev,
    isLocalPreview: true,
    storage,
    now,
    createEventId: () => "evt-astrodev",
  });

  await astrodev.button.emit("click");

  const saved = catalog.readLocalInterest(storage);
  assert.equal(saved.astrodev.interested, true);
  assert.equal(saved.astrodev.eventId, "evt-astrodev");
  assert.equal(saved.aster.interested, false);
  assert.equal(saved.aster.eventId, "evt-aster");
  assert.equal(astrodev.form.hidden, false);
  assert.equal(aster.form.hidden, true);
});

test("production interest button reuses one event id and retracts on the second click", async () => {
  const records = new Map();
  const storage = {
    getItem(key) {
      return records.get(key) || null;
    },
    setItem(key, value) {
      records.set(key, value);
    },
  };
  const elements = createInterestElements();
  const payloads = [];
  catalog.bindInterestItem({
    item: "aster",
    ...elements,
    isLocalPreview: false,
    storage,
    createEventId: () => "evt-123",
    fetchImpl: async (_url, request) => {
      payloads.push(JSON.parse(request.body));
      return { ok: true, status: 201 };
    },
  });

  await elements.button.emit("click");
  await elements.button.emit("click");

  assert.equal(payloads.length, 2);
  assert.equal(payloads[0].event_id, "evt-123");
  assert.equal(payloads[0].action, "thumbs_up");
  assert.equal(payloads[1].event_id, "evt-123");
  assert.equal(payloads[1].action, "remove_interest");
  assert.equal(catalog.readLocalInterest(storage).aster.eventId, "evt-123");
  assert.equal(catalog.readLocalInterest(storage).aster.interested, false);
  assert.equal(elements.button.attributes["aria-pressed"], "false");
  assert.equal(elements.form.hidden, true);
  assert.equal(elements.button.disabled, false);

  const reloaded = createInterestElements();
  catalog.bindInterestItem({
    item: "aster",
    ...reloaded,
    isLocalPreview: false,
    storage,
    createEventId: () => {
      throw new Error("saved event id should be reused");
    },
    fetchImpl: async () => {
      throw new Error("reloaded retracted state must not submit");
    },
  });
  assert.equal(reloaded.form.hidden, true);
  assert.equal(reloaded.button.attributes["aria-pressed"], "false");
  assert.equal(reloaded.button.disabled, false);
});

test("failed interest retraction keeps the saved vote and form visible", async () => {
  const records = new Map();
  const storage = {
    getItem: (key) => records.get(key) || null,
    setItem: (key, value) => records.set(key, value),
  };
  const elements = createInterestElements();
  addEmailControls(elements, "");
  let requests = 0;
  catalog.bindInterestItem({
    item: "aster",
    ...elements,
    isLocalPreview: false,
    storage,
    createEventId: () => "evt-remove-failure",
    fetchImpl: async () => {
      requests += 1;
      return { ok: requests === 1, status: requests === 1 ? 201 : 503 };
    },
  });

  await elements.button.emit("click");
  await elements.button.emit("click");

  assert.equal(catalog.readLocalInterest(storage).aster.interested, true);
  assert.equal(elements.button.attributes["aria-pressed"], "true");
  assert.equal(elements.form.hidden, false);
  assert.equal(elements.note.dataset.state, "error");
  assert.match(elements.note.textContent, /Could not remove your feedback/);
});

test("email 202 reports confirmation pending without persisting email or consent", async () => {
  const records = new Map();
  const storage = {
    getItem: (key) => records.get(key) || null,
    setItem: (key, value) => records.set(key, value),
  };
  const elements = createInterestElements();
  addEmailControls(elements, "dev@example.com");
  const payloads = [];
  let scheduledCooldown;
  catalog.bindInterestItem({
    item: "astrodev",
    ...elements,
    isLocalPreview: false,
    storage,
    createEventId: () => "evt-email",
    fetchImpl: async (_url, request) => {
      const payload = JSON.parse(request.body);
      payloads.push(payload);
      return {
        ok: true,
        status: payload.action === "email_signup" ? 202 : 201,
        async json() {
          return payload.action === "email_signup"
            ? { status: "pending_confirmation" }
            : { status: "recorded" };
        },
      };
    },
    setTimeoutImpl(callback, delay) {
      scheduledCooldown = { callback, delay };
      return 1;
    },
  });

  await elements.button.emit("click");
  await elements.form.emit("submit", { preventDefault() {} });

  assert.equal(payloads[1].action, "email_signup");
  assert.equal(payloads[1].event_id, "evt-email");
  assert.equal(payloads[1].email, "dev@example.com");
  assert.equal(payloads[1].project_updates, true);
  assert.equal(payloads[1].broader_updates, false);
  const saved = catalog.readLocalInterest(storage).astrodev;
  assert.deepEqual(Object.keys(saved).sort(), ["confirmationPending", "deliveryStatus", "eventId", "interested", "updatedAt"]);
  assert.equal(saved.confirmationPending, true);
  assert.equal(saved.deliveryStatus, "pending-confirmation");
  assert.doesNotMatch(records.get("archastro-oss-interest"), /dev@example\.com|projectUpdates|broaderUpdates|"email"\s*:/);
  assert.equal(elements.note.dataset.state, "pending-confirmation");
  assert.match(elements.note.textContent, /^Check your inbox to confirm AstroDev updates\./);
  assert.doesNotMatch(elements.note.textContent, /We will email you/i);
  assert.equal(scheduledCooldown.delay, 60_000);
});

test("retracting a vote keeps pending email confirmation explicit across reload", async () => {
  const records = new Map();
  const storage = {
    getItem: (key) => records.get(key) || null,
    setItem: (key, value) => records.set(key, value),
  };
  const elements = createInterestElements();
  addEmailControls(elements, "dev@example.com");
  const payloads = [];
  catalog.bindInterestItem({
    item: "aster",
    ...elements,
    isLocalPreview: false,
    storage,
    createEventId: () => "evt-email-retract",
    setTimeoutImpl() { return 1; },
    fetchImpl: async (_url, request) => {
      const payload = JSON.parse(request.body);
      payloads.push(payload);
      return {
        ok: true,
        status: payload.action === "email_signup" ? 202 : 200,
        async json() {
          return payload.action === "email_signup" ? { status: "pending_confirmation" } : {};
        },
      };
    },
  });

  await elements.button.emit("click");
  await elements.form.emit("submit", { preventDefault() {} });
  await elements.button.emit("click");

  assert.deepEqual(payloads.map(({ action }) => action), ["thumbs_up", "email_signup", "remove_interest"]);
  const saved = catalog.readLocalInterest(storage).aster;
  assert.equal(saved.interested, false);
  assert.equal(saved.confirmationPending, true);
  assert.equal(elements.form.hidden, true);
  assert.equal(elements.note.dataset.state, "pending-confirmation");
  assert.match(elements.note.textContent, /feedback was removed/i);
  assert.match(elements.note.textContent, /confirmation.*still pending/i);

  const reloaded = createInterestElements();
  addEmailControls(reloaded, "");
  catalog.bindInterestItem({
    item: "aster",
    ...reloaded,
    isLocalPreview: false,
    storage,
    setTimeoutImpl() { return 1; },
    fetchImpl: async () => { throw new Error("reload must not submit"); },
  });

  assert.equal(reloaded.form.hidden, true);
  assert.equal(reloaded.note.dataset.state, "pending-confirmation");
  assert.match(reloaded.note.textContent, /confirmation.*still pending/i);
});

test("queued email response reports delayed confirmation delivery", async () => {
  const records = new Map();
  const storage = {
    getItem: (key) => records.get(key) || null,
    setItem: (key, value) => records.set(key, value),
  };
  const elements = createInterestElements();
  addEmailControls(elements, "dev@example.com");
  catalog.bindInterestItem({
    item: "aster",
    ...elements,
    isLocalPreview: false,
    storage,
    createEventId: () => "evt-queued",
    setTimeoutImpl() {
      return 1;
    },
    fetchImpl: async (_url, request) => {
      const payload = JSON.parse(request.body);
      return {
        ok: true,
        status: payload.action === "email_signup" ? 202 : 201,
        async json() {
          return payload.action === "email_signup"
            ? { status: "queued" }
            : { status: "recorded" };
        },
      };
    },
  });

  await elements.button.emit("click");
  await elements.form.emit("submit", { preventDefault() {} });

  assert.equal(elements.note.dataset.state, "queued");
  assert.equal(
    elements.note.textContent,
    "Confirmation delivery is delayed; we will retry shortly. You can send again in a minute."
  );
  assert.equal(catalog.readLocalInterest(storage).aster.deliveryStatus, "queued");

  const reloaded = createInterestElements();
  addEmailControls(reloaded, "");
  catalog.bindInterestItem({
    item: "aster",
    ...reloaded,
    isLocalPreview: false,
    storage,
    setTimeoutImpl() {
      return 1;
    },
    fetchImpl: async () => {
      throw new Error("reload must not submit");
    },
  });
  assert.equal(reloaded.note.dataset.state, "queued");
  assert.equal(reloaded.note.textContent, elements.note.textContent);
});

test("terminal email failure rotates the event id so the browser can retry", async () => {
  const records = new Map();
  const storage = {
    getItem: (key) => records.get(key) || null,
    setItem: (key, value) => records.set(key, value),
  };
  const elements = createInterestElements();
  addEmailControls(elements, "dev@example.com");
  const ids = ["evt-original", "evt-retry"];
  const signupEventIds = [];
  let signupAttempts = 0;
  catalog.bindInterestItem({
    item: "aster",
    ...elements,
    isLocalPreview: false,
    storage,
    createEventId: () => ids.shift(),
    setTimeoutImpl() {
      return 1;
    },
    fetchImpl: async (_url, request) => {
      const payload = JSON.parse(request.body);
      if (payload.action === "thumbs_up") return { ok: true, status: 201 };
      signupEventIds.push(payload.event_id);
      signupAttempts += 1;
      return signupAttempts === 1
        ? {
            ok: false,
            status: 502,
            async json() {
              return { error: { code: "confirmation_delivery_failed" } };
            },
          }
        : {
            ok: true,
            status: 202,
            async json() {
              return { status: "pending_confirmation" };
            },
          };
    },
  });

  await elements.button.emit("click");
  await elements.form.emit("submit", { preventDefault() {} });
  assert.equal(catalog.readLocalInterest(storage).aster.eventId, "evt-retry");
  assert.equal(elements.note.dataset.state, "error");

  await elements.form.emit("submit", { preventDefault() {} });
  assert.deepEqual(signupEventIds, ["evt-original", "evt-retry"]);
  assert.equal(elements.note.dataset.state, "pending-confirmation");
});

test("successful interest response returns its server status", async () => {
  const result = await catalog.submitInterest(
    { item: "aster", action: "email_signup" },
    {
      isLocalPreview: false,
      fetchImpl: async () => ({
        ok: true,
        status: 202,
        async json() {
          return { status: "queued" };
        },
      }),
    }
  );

  assert.equal(result.status, "queued");
});

test("successful response without usable JSON falls back without crashing", async (t) => {
  const responses = [
    {
      name: "no body reader",
      response: { ok: true, status: 202 },
    },
    {
      name: "malformed body",
      response: {
        ok: true,
        status: 202,
        async json() {
          throw new SyntaxError("Unexpected end of JSON input");
        },
      },
    },
  ];

  for (const { name, response } of responses) {
    await t.test(name, async () => {
      const result = await catalog.submitInterest(
        { item: "aster", action: "email_signup" },
        { isLocalPreview: false, fetchImpl: async () => response }
      );

      assert.equal(result.status, null);
      assert.equal(result.confirmationPending, true);
    });
  }
});

test("email success without a usable response status reports an honest fallback", async () => {
  const elements = createInterestElements();
  addEmailControls(elements, "dev@example.com");
  catalog.bindInterestItem({
    item: "aster",
    ...elements,
    isLocalPreview: false,
    storage: null,
    createEventId: () => "evt-fallback",
    setTimeoutImpl() {
      return 1;
    },
    fetchImpl: async (_url, request) => {
      const payload = JSON.parse(request.body);
      if (payload.action === "thumbs_up") return { ok: true, status: 201 };
      return {
        ok: true,
        status: 202,
        async json() {
          throw new SyntaxError("Malformed JSON");
        },
      };
    },
  });

  await elements.button.emit("click");
  await elements.form.emit("submit", { preventDefault() {} });

  assert.equal(elements.note.dataset.state, "pending-confirmation");
  assert.equal(
    elements.note.textContent,
    "Confirmation request accepted. Delivery status is unavailable; you can send again in a minute."
  );
});

test("local preview never persists raw email or consent values", async () => {
  const records = new Map();
  const storage = {
    getItem: (key) => records.get(key) || null,
    setItem: (key, value) => records.set(key, value),
  };
  const elements = createInterestElements();
  const { broaderUpdates } = addEmailControls(elements, "private@example.com");
  broaderUpdates.checked = true;
  catalog.bindInterestItem({
    item: "aster",
    ...elements,
    isLocalPreview: true,
    storage,
    createEventId: () => "evt-preview",
    setTimeoutImpl() {
      return 1;
    },
  });

  await elements.button.emit("click");
  await elements.form.emit("submit", { preventDefault() {} });

  const raw = records.get("archastro-oss-interest");
  const saved = catalog.readLocalInterest(storage).aster;
  assert.deepEqual(Object.keys(saved).sort(), ["confirmationPending", "deliveryStatus", "eventId", "interested", "updatedAt"]);
  assert.equal(saved.confirmationPending, true);
  assert.doesNotMatch(raw, /private@example\.com|projectUpdates|broaderUpdates|"email"\s*:/);
});

test("reading legacy interest state purges previously stored personal data", () => {
  const records = new Map([
    [
      "archastro-oss-interest",
      JSON.stringify({
        aster: {
          eventId: "evt-legacy",
          interested: true,
          email: "legacy@example.com",
          emailSubmitted: true,
          projectUpdates: true,
          broaderUpdates: true,
          updatedAt: "2026-07-17T12:00:00.000Z",
        },
      }),
    ],
  ]);
  const storage = {
    getItem: (key) => records.get(key) || null,
    setItem: (key, value) => records.set(key, value),
  };

  const saved = catalog.readLocalInterest(storage).aster;

  assert.deepEqual(saved, {
    eventId: "evt-legacy",
    interested: true,
    confirmationPending: true,
    deliveryStatus: "",
    updatedAt: "2026-07-17T12:00:00.000Z",
  });
  assert.doesNotMatch(records.get("archastro-oss-interest"), /legacy@example\.com|projectUpdates|broaderUpdates|"email"\s*:/);
});

test("email signup sends broader updates only when independently selected", async () => {
  const elements = createInterestElements();
  const { broaderUpdates } = addEmailControls(elements, "dev@example.com");
  broaderUpdates.checked = true;
  const payloads = [];
  catalog.bindInterestItem({
    item: "aster",
    ...elements,
    isLocalPreview: false,
    storage: null,
    createEventId: () => "evt-consent",
    fetchImpl: async (_url, request) => {
      payloads.push(JSON.parse(request.body));
      return { ok: true, status: 201 };
    },
  });

  await elements.button.emit("click");
  await elements.form.emit("submit", { preventDefault() {} });

  assert.equal(payloads[1].project_updates, true);
  assert.equal(payloads[1].broader_updates, true);
});

test("confirmation cooldown re-enables resend with the current email and consent", async () => {
  const records = new Map();
  const storage = {
    getItem: (key) => records.get(key) || null,
    setItem: (key, value) => records.set(key, value),
  };
  const elements = createInterestElements();
  const { emailInput, submitButton, broaderUpdates } = addEmailControls(elements, "dev@example.com");
  broaderUpdates.checked = true;
  const payloads = [];
  const timers = [];
  catalog.bindInterestItem({
    item: "aster",
    ...elements,
    isLocalPreview: false,
    storage,
    createEventId: () => "evt-resend",
    cooldownMs: 5_000,
    setTimeoutImpl(callback, delay) {
      timers.push({ callback, delay });
      return timers.length;
    },
    fetchImpl: async (_url, request) => {
      const payload = JSON.parse(request.body);
      payloads.push(payload);
      return {
        ok: true,
        status: payload.action === "email_signup" ? 202 : 201,
        async json() {
          return payload.action === "email_signup"
            ? { status: "pending_confirmation" }
            : { status: "recorded" };
        },
      };
    },
  });

  await elements.button.emit("click");
  await elements.form.emit("submit", { preventDefault() {} });

  assert.equal(timers[0].delay, 5_000);
  assert.equal(emailInput.disabled, true);
  assert.equal(submitButton.disabled, true);
  assert.equal(broaderUpdates.disabled, true);
  assert.equal(submitButton.textContent, "Notify me");
  assert.match(elements.note.textContent, /^Check your inbox to confirm Aster and broader ArchAstro updates\./);
  assert.equal(catalog.readLocalInterest(storage).aster.confirmationPending, true);

  timers[0].callback();
  assert.equal(emailInput.disabled, false);
  assert.equal(submitButton.disabled, false);
  assert.equal(broaderUpdates.disabled, false);
  assert.equal(submitButton.textContent, "Send again");
  assert.match(elements.note.textContent, /send the confirmation again/i);
  assert.equal(emailInput.value, "dev@example.com");
  assert.equal(catalog.readLocalInterest(storage).aster.confirmationPending, false);

  await elements.form.emit("submit", { preventDefault() {} });
  assert.equal(payloads.length, 3);
  assert.equal(payloads[2].email, "dev@example.com");
  assert.equal(payloads[2].project_updates, true);
  assert.equal(payloads[2].broader_updates, true);
  assert.equal(submitButton.disabled, true);
  assert.doesNotMatch(records.get("archastro-oss-interest"), /dev@example\.com|"email"\s*:/);
});

test("vote pending disables the revealed email form until success", async () => {
  const elements = createInterestElements();
  const { emailInput, submitButton, broaderUpdates } = addEmailControls(elements, "dev@example.com");
  const vote = deferred();
  const payloads = [];
  catalog.bindInterestItem({
    item: "aster",
    ...elements,
    isLocalPreview: false,
    storage: null,
    createEventId: () => "evt-race",
    fetchImpl: async (_url, request) => {
      payloads.push(JSON.parse(request.body));
      return vote.promise;
    },
  });

  const voteClick = elements.button.emit("click");
  await Promise.resolve();

  assert.equal(elements.form.hidden, false);
  assert.equal(emailInput.disabled, true);
  assert.equal(submitButton.disabled, true);
  assert.equal(broaderUpdates.disabled, true);
  assert.equal(elements.note.dataset.state, "pending");

  void elements.form.emit("submit", { preventDefault() {} });
  await Promise.resolve();
  assert.equal(payloads.length, 1);

  vote.resolve({ ok: true, status: 201 });
  await voteClick;
  assert.equal(emailInput.disabled, false);
  assert.equal(submitButton.disabled, false);
  assert.equal(broaderUpdates.disabled, false);
});

test("deferred vote ordering cannot overwrite email submission status", async () => {
  const elements = createInterestElements();
  const { submitButton } = addEmailControls(elements, "dev@example.com");
  const vote = deferred();
  const email = deferred();
  const payloads = [];
  catalog.bindInterestItem({
    item: "astrodev",
    ...elements,
    isLocalPreview: false,
    storage: null,
    createEventId: () => "evt-order",
    fetchImpl: async (_url, request) => {
      const payload = JSON.parse(request.body);
      payloads.push(payload);
      return payload.action === "thumbs_up" ? vote.promise : email.promise;
    },
  });

  const voteClick = elements.button.emit("click");
  await Promise.resolve();
  void elements.form.emit("submit", { preventDefault() {} });
  await Promise.resolve();
  assert.equal(payloads.length, 1);

  vote.resolve({ ok: true, status: 201 });
  await voteClick;
  const emailSubmit = elements.form.emit("submit", { preventDefault() {} });
  await Promise.resolve();
  assert.equal(elements.note.dataset.state, "pending");
  assert.match(elements.note.textContent, /Saving/);

  await elements.button.emit("click");
  assert.equal(payloads.length, 2);
  assert.equal(elements.note.dataset.state, "pending");

  email.resolve({
    ok: true,
    status: 202,
    async json() {
      return { status: "pending_confirmation" };
    },
  });
  await emailSubmit;
  assert.equal(elements.note.dataset.state, "pending-confirmation");
  assert.match(elements.note.textContent, /Check your inbox to confirm AstroDev updates/);
  assert.equal(submitButton.disabled, true);
});

test("recording dialog opens from a trigger and returns focus after close", async () => {
  const { dialog, dialogMedia, closeButton } = createDialogElements();
  dialog.close = function closeWithoutEvent() {
    this.open = false;
    this.closeCalls += 1;
  };
  const trigger = createEventTarget({
    dataset: {
      recordingSrc: "./assets/aster-real.mp4",
      recordingPoster: "./assets/aster-real.png",
      recordingTitle: "Aster",
      recordingCaption: "Affected targets run in dependency order.",
    },
    focusCalls: 0,
    focus() {
      this.focusCalls += 1;
    },
  });

  catalog.bindRecordingDialog({
    dialog,
    triggers: [trigger],
    reduceMotion: { matches: false },
  });
  await trigger.emit("click");

  assert.equal(dialog.showModalCalls, 1);
  assert.equal(dialog.title.textContent, "Aster recording");
  assert.equal(dialog.caption.textContent, "Affected targets run in dependency order.");
  assert.equal(dialogMedia.src, "./assets/aster-real.mp4");
  assert.equal(dialogMedia.poster, "./assets/aster-real.png");
  assert.equal(dialogMedia.playCalls, 1);

  await closeButton.emit("click");
  assert.equal(dialog.closeCalls, 1);
  assert.equal(dialogMedia.pauseCalls, 1);
  assert.equal(dialogMedia.currentTime, 0);
  assert.equal(dialogMedia.src, "");
  assert.equal(dialogMedia.loadCalls, 1);
  assert.equal(trigger.focusCalls, 1);
});

test("recording dialog closes on Escape and backdrop click", async () => {
  const { dialog } = createDialogElements();
  const trigger = createEventTarget({
    dataset: { recordingSrc: "proof.mp4", recordingTitle: "Proof", recordingCaption: "Caption" },
    focus() {},
  });
  catalog.bindRecordingDialog({ dialog, triggers: [trigger], reduceMotion: { matches: false } });

  await trigger.emit("click");
  let prevented = false;
  await dialog.emit("cancel", { preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(dialog.closeCalls, 1);

  await trigger.emit("click");
  await dialog.emit("click", { target: dialog });
  assert.equal(dialog.closeCalls, 2);
});

test("recording dialog does not autoplay with reduced motion", async () => {
  const { dialog, dialogMedia } = createDialogElements();
  const trigger = createEventTarget({
    dataset: { recordingSrc: "proof.mp4", recordingTitle: "Proof", recordingCaption: "Caption" },
    focus() {},
  });
  catalog.bindRecordingDialog({ dialog, triggers: [trigger], reduceMotion: { matches: true } });

  await trigger.emit("click");

  assert.equal(dialogMedia.playCalls, 0);
});

test("email signup failure is visible and leaves the form usable", async () => {
  const elements = createInterestElements();
  const { submitButton } = addEmailControls(elements, "dev@example.com");
  catalog.bindInterestItem({
    item: "aster",
    ...elements,
    isLocalPreview: false,
    storage: null,
    createEventId: () => "evt-fail",
    fetchImpl: async (_url, request) => {
      const payload = JSON.parse(request.body);
      return payload.action === "thumbs_up"
        ? { ok: true, status: 201 }
        : { ok: false, status: 503 };
    },
  });

  await elements.button.emit("click");
  await elements.form.emit("submit", { preventDefault() {} });

  assert.equal(elements.note.dataset.state, "error");
  assert.match(elements.note.textContent, /Request could not be completed.*try again/i);
  assert.doesNotMatch(elements.note.textContent, /nothing was (?:stored|submitted)/i);
  assert.equal(submitButton.disabled, false);
  assert.equal(elements.form.hidden, false);
});

test("motion autoplay follows viewport visibility", async () => {
  const media = createEventTarget({
    currentTime: 0,
    paused: true,
    playCalls: 0,
    pauseCalls: 0,
    async play() {
      this.paused = false;
      this.playCalls += 1;
    },
    pause() {
      this.paused = true;
      this.pauseCalls += 1;
    },
  });
  const status = { textContent: "" };
  const reduceMotion = createEventTarget({ matches: false });
  let visibilityCallback;

  catalog.bindMotion({
    media,
    status,
    reduceMotion,
    observeVisibility(callback) {
      visibilityCallback = callback;
    },
  });
  await Promise.resolve();
  assert.equal(media.playCalls, 1);

  visibilityCallback(false);
  assert.equal(media.pauseCalls, 1);

  visibilityCallback(true);
  await Promise.resolve();
  assert.equal(media.playCalls, 2);

  await media.emit("error");
  assert.equal(media.paused, true);
  assert.match(status.textContent, /unavailable/);
});

test("reduced motion prevents autoplay and rewinds when enabled", async () => {
  const media = createEventTarget({
    currentTime: 0,
    playCalls: 0,
    async play() {
      this.playCalls += 1;
    },
    pauseCalls: 0,
    pause() {
      this.pauseCalls += 1;
    },
  });
  const reduceMotion = createEventTarget({ matches: true });

  catalog.bindMotion({
    media,
    status: { textContent: "" },
    reduceMotion,
    observeVisibility() {},
  });

  assert.equal(media.playCalls, 0);
  assert.equal(media.pauseCalls, 1);

  reduceMotion.matches = false;
  await reduceMotion.emit("change");
  await Promise.resolve();
  assert.equal(media.playCalls, 1);

  media.currentTime = 3;
  reduceMotion.matches = true;
  await reduceMotion.emit("change");
  assert.equal(media.currentTime, 0);
});

test("clipboard fallback copies, cleans up, clears selection, and reports success", async () => {
  let execCalls = 0;
  let selectionClears = 0;
  let textareaRemoved = false;
  let appendedTextarea;
  const textarea = {
    style: {},
    value: "",
    setAttribute() {},
    select() {},
    setSelectionRange() {},
    remove() {
      textareaRemoved = true;
    },
  };
  const document = {
    body: {
      appendChild(element) {
        appendedTextarea = element;
      },
    },
    createElement(tagName) {
      assert.equal(tagName, "textarea");
      return textarea;
    },
    execCommand(command) {
      assert.equal(command, "copy");
      execCalls += 1;
      return true;
    },
  };
  const window = {
    getSelection() {
      return {
        removeAllRanges() {
          selectionClears += 1;
        },
      };
    },
  };
  const button = createEventTarget({ textContent: "Copy" });
  const status = { textContent: "" };

  catalog.bindClipboard({
    button,
    status,
    commandElement: { textContent: "npm install -g @archastro/redline" },
    document,
    window,
    navigator: {},
    setTimeoutImpl() {},
  });

  await button.emit("click");

  assert.equal(execCalls, 1);
  assert.equal(appendedTextarea, textarea);
  assert.equal(textareaRemoved, true);
  assert.equal(selectionClears, 1);
  assert.equal(button.textContent, "Copied");
  assert.equal(status.textContent, "Install command copied.");
});
