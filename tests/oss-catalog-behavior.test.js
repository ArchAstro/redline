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
    createEventId: () => "11111111-1111-4111-8111-111111111111",
  });
  catalog.bindInterestItem({
    item: "astrodev",
    ...astrodev,
    isLocalPreview: true,
    storage,
    now,
    createEventId: () => "22222222-2222-4222-8222-222222222222",
  });

  await astrodev.button.emit("click");

  const saved = catalog.readLocalInterest(storage);
  assert.equal(saved.astrodev.interested, true);
  assert.equal(saved.astrodev.eventId, "22222222-2222-4222-8222-222222222222");
  assert.equal(saved.aster.interested, false);
  assert.equal(saved.aster.eventId, "11111111-1111-4111-8111-111111111111");
  assert.equal(astrodev.form.hidden, false);
  assert.equal(aster.form.hidden, true);
});

test("invalid stored event ids rotate without changing saved interest", () => {
  const records = new Map([
    [
      "archastro-oss-interest",
      JSON.stringify({
        aster: {
          eventId: "legacy-invalid-id",
          interested: true,
          emailSaved: false,
          emailLocalOnly: false,
          updatedAt: "2026-07-16T12:00:00.000Z",
        },
      }),
    ],
  ]);
  const storage = {
    getItem: (key) => records.get(key) || null,
    setItem: (key, value) => records.set(key, value),
  };
  const replacement = "33333333-3333-4333-8333-333333333333";

  const eventId = catalog.getOrCreateEventId(
    storage,
    "aster",
    () => replacement,
    () => new Date("2026-07-22T12:00:00.000Z")
  );

  assert.equal(eventId, replacement);
  assert.equal(catalog.readLocalInterest(storage).aster.eventId, replacement);
  assert.equal(catalog.readLocalInterest(storage).aster.interested, true);
});

test("event id fallback creates an RFC 4122 version 4 UUID", () => {
  const eventId = catalog.createEventId({}, () => 0);

  assert.match(
    eventId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  );
  assert.equal(eventId, "00000000-0000-4000-8000-000000000000");
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
    createEventId: () => "33333333-3333-4333-8333-333333333333",
    fetchImpl: async (_url, request) => {
      payloads.push(JSON.parse(request.body));
      return { ok: true, status: 201 };
    },
  });

  await elements.button.emit("click");
  await elements.button.emit("click");

  assert.equal(payloads.length, 2);
  assert.equal(payloads[0].event_id, "33333333-3333-4333-8333-333333333333");
  assert.equal(payloads[0].action, "thumbs_up");
  assert.equal(payloads[1].event_id, "33333333-3333-4333-8333-333333333333");
  assert.equal(payloads[1].action, "remove_interest");
  assert.equal(catalog.readLocalInterest(storage).aster.eventId, "33333333-3333-4333-8333-333333333333");
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
    createEventId: () => "44444444-4444-4444-8444-444444444444",
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

test("re-adding email-backed feedback replaces the removed note with saved state", async () => {
  const eventId = "99999999-9999-4999-8999-999999999999";
  const records = new Map([
    [
      "archastro-oss-interest",
      JSON.stringify({
        aster: {
          eventId,
          interested: true,
          emailSaved: true,
          emailLocalOnly: false,
          updatedAt: "2026-07-22T12:00:00.000Z",
        },
      }),
    ],
  ]);
  const storage = {
    getItem: (key) => records.get(key) || null,
    setItem: (key, value) => records.set(key, value),
  };
  const elements = createInterestElements();
  addEmailControls(elements, "");
  const actions = [];
  catalog.bindInterestItem({
    item: "aster",
    ...elements,
    isLocalPreview: false,
    storage,
    fetchImpl: async (_url, request) => {
      actions.push(JSON.parse(request.body).action);
      return { ok: true, status: 201 };
    },
  });

  await elements.button.emit("click");
  assert.equal(elements.note.dataset.state, "removed");
  await elements.button.emit("click");

  assert.deepEqual(actions, ["remove_interest", "thumbs_up"]);
  assert.equal(elements.note.dataset.state, "saved");
  assert.equal(elements.note.textContent, "Feedback saved. Email updates remain saved.");
});

test("production interest journey saves a thumb, retracts it, and records email through the platform waitlist", async () => {
  const records = new Map();
  const storage = {
    getItem: (key) => records.get(key) || null,
    setItem: (key, value) => records.set(key, value),
  };
  const elements = createInterestElements();
  const { broaderUpdates } = addEmailControls(elements, "dev@example.com");
  broaderUpdates.checked = true;
  const requests = [];
  catalog.bindInterestItem({
    item: "aster",
    ...elements,
    isLocalPreview: false,
    storage,
    createEventId: () => "55555555-5555-4555-8555-555555555555",
    fetchImpl: async (url, request) => {
      requests.push({ url, request, payload: JSON.parse(request.body) });
      return { ok: true, status: 201 };
    },
  });

  await elements.button.emit("click");
  assert.equal(elements.note.dataset.state, "saved");
  await elements.button.emit("click");
  assert.equal(elements.note.dataset.state, "removed");
  await elements.button.emit("click");
  await elements.form.emit("submit", { preventDefault() {} });

  assert.equal(requests.length, 4);
  assert.ok(requests.every(({ url }) => url === "https://platform.archastro.ai/api/v1/developer/waitlist"));
  assert.ok(requests.every(({ request }) => request.method === "POST"));
  assert.deepEqual(requests.map(({ payload }) => payload), [
    {
      source: "oss_catalog_lab",
      interest: "aster",
      action: "thumbs_up",
      event_id: "55555555-5555-4555-8555-555555555555",
    },
    {
      source: "oss_catalog_lab",
      interest: "aster",
      action: "remove_interest",
      event_id: "55555555-5555-4555-8555-555555555555",
    },
    {
      source: "oss_catalog_lab",
      interest: "aster",
      action: "thumbs_up",
      event_id: "55555555-5555-4555-8555-555555555555",
    },
    {
      source: "oss_catalog_lab",
      interest: "aster",
      action: "email_signup",
      event_id: "55555555-5555-4555-8555-555555555555",
      email: "dev@example.com",
      project_updates: true,
      broader_updates: true,
    },
  ]);
  assert.deepEqual(catalog.readLocalInterest(storage).aster.emailSaved, true);
  assert.doesNotMatch(records.get("archastro-oss-interest"), /dev@example\.com|projectUpdates|broaderUpdates|"email"\s*:/);
  assert.equal(elements.note.dataset.state, "saved");
  assert.equal(elements.note.textContent, "Email saved for Aster and broader ArchAstro updates.");
});

test("local preview reload preserves only local-only email state and never claims email was saved", async () => {
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
    createEventId: () => "22222222-2222-4222-8222-222222222222",
    fetchImpl: async () => {
      throw new Error("private preview must not transmit");
    },
  });

  await elements.button.emit("click");
  await elements.form.emit("submit", { preventDefault() {} });

  const raw = records.get("archastro-oss-interest");
  const saved = catalog.readLocalInterest(storage).aster;
  assert.deepEqual(Object.keys(saved).sort(), ["emailLocalOnly", "emailSaved", "eventId", "interested", "updatedAt"]);
  assert.equal(saved.emailSaved, false);
  assert.equal(saved.emailLocalOnly, true);
  assert.doesNotMatch(raw, /private@example\.com|projectUpdates|broaderUpdates|"email"\s*:/);
  assert.equal(elements.note.dataset.state, "local-only");
  assert.equal(elements.note.textContent, "Local preview only: email address was not sent or stored.");

  const reloaded = createInterestElements();
  addEmailControls(reloaded, "");
  catalog.bindInterestItem({
    item: "aster",
    ...reloaded,
    isLocalPreview: true,
    storage,
    createEventId: () => {
      throw new Error("valid saved event id should be reused");
    },
  });

  assert.equal(reloaded.note.dataset.state, "local-only");
  assert.equal(reloaded.note.textContent, "Local preview only: email address was not sent or stored.");
  assert.doesNotMatch(reloaded.note.textContent, /email saved/i);
});

test("local preview migrates prior email-saved state to local-only state", () => {
  const records = new Map([
    [
      "archastro-oss-interest",
      JSON.stringify({
        aster: {
          eventId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          interested: true,
          emailSaved: true,
          updatedAt: "2026-07-22T12:00:00.000Z",
        },
      }),
    ],
  ]);
  const storage = {
    getItem: (key) => records.get(key) || null,
    setItem: (key, value) => records.set(key, value),
  };
  const elements = createInterestElements();
  addEmailControls(elements, "");

  catalog.bindInterestItem({
    item: "aster",
    ...elements,
    isLocalPreview: true,
    storage,
  });

  const saved = catalog.readLocalInterest(storage).aster;
  assert.equal(saved.emailSaved, false);
  assert.equal(saved.emailLocalOnly, true);
  assert.equal(elements.note.dataset.state, "local-only");
  assert.equal(elements.note.textContent, "Local preview only: email address was not sent or stored.");
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
    emailSaved: true,
    emailLocalOnly: false,
    updatedAt: "2026-07-17T12:00:00.000Z",
  });
  assert.doesNotMatch(records.get("archastro-oss-interest"), /legacy@example\.com|projectUpdates|broaderUpdates|"email"\s*:/);
});

test("submission routing is fixed in production and permits only explicit loopback E2E URLs", () => {
  assert.deepEqual(
    catalog.resolveInterestSubmission({
      hostname: "oss.archastro.ai",
      search: "?oss_e2e=1&waitlist_endpoint=http%3A%2F%2Flocalhost%3A4000%2Foverride",
    }),
    {
      isLocalPreview: false,
      endpoint: "https://platform.archastro.ai/api/v1/developer/waitlist",
    }
  );

  for (const location of [
    { hostname: "", search: "" },
    { hostname: "localhost", search: "" },
    { hostname: "127.0.0.1", search: "?oss_e2e=1&waitlist_endpoint=https%3A%2F%2Fexample.com%2Fcollect" },
    { hostname: "localhost", search: "?waitlist_endpoint=http%3A%2F%2Flocalhost%3A4000%2Fapi%2Fv1%2Fdeveloper%2Fwaitlist" },
  ]) {
    assert.deepEqual(catalog.resolveInterestSubmission(location), {
      isLocalPreview: true,
      endpoint: null,
    });
  }

  assert.deepEqual(
    catalog.resolveInterestSubmission({
      hostname: "127.0.0.1",
      search: "?oss_e2e=1&waitlist_endpoint=http%3A%2F%2Flocalhost%3A4000%2Fapi%2Fv1%2Fdeveloper%2Fwaitlist",
    }),
    {
      isLocalPreview: false,
      endpoint: "http://localhost:4000/api/v1/developer/waitlist",
    }
  );
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
    createEventId: () => "66666666-6666-4666-8666-666666666666",
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

test("deferred vote ordering cannot overwrite saved email status", async () => {
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
    createEventId: () => "77777777-7777-4777-8777-777777777777",
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

  email.resolve({ ok: true, status: 201 });
  await emailSubmit;
  assert.equal(elements.note.dataset.state, "saved");
  assert.equal(elements.note.textContent, "Email saved for AstroDev updates.");
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
    createEventId: () => "88888888-8888-4888-8888-888888888888",
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
