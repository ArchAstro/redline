const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createHash, createHmac } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const root = path.join(__dirname, "..");
const workerDirectory = path.join(root, "docs", "oss", "worker");
const workerPath = path.join(workerDirectory, "index.js");
const migrationsDirectory = path.join(workerDirectory, "migrations");

async function loadWorker() {
  const source = fs.readFileSync(workerPath, "utf8");
  const url = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
  return import(url);
}

class SqliteD1Statement {
  constructor(database, sql, values = []) {
    this.database = database;
    this.sql = sql;
    this.values = values;
  }

  bind(...values) {
    return new SqliteD1Statement(this.database, this.sql, values);
  }

  async first() {
    return this.database.prepare(this.sql).get(...this.values) || null;
  }

  async run() {
    return executeStatement(this.database, this);
  }

  async all() {
    return {
      success: true,
      results: this.database.prepare(this.sql).all(...this.values),
    };
  }
}

function executeStatement(database, statement) {
  const prepared = database.prepare(statement.sql);
  if (/\bRETURNING\b/i.test(statement.sql)) {
    const results = prepared.all(...statement.values);
    return { success: true, results, meta: { changes: results.length } };
  }
  const result = prepared.run(...statement.values);
  return {
    success: true,
    results: [],
    meta: {
      changes: Number(result.changes),
      last_row_id: Number(result.lastInsertRowid),
    },
  };
}

class SqliteD1 {
  constructor() {
    this.sqlite = new DatabaseSync(":memory:");
    this.sqlite.exec("PRAGMA foreign_keys = ON");
    const migrations = fs
      .readdirSync(migrationsDirectory)
      .filter((name) => name.endsWith(".sql"))
      .sort();
    for (const migration of migrations) {
      this.sqlite.exec(fs.readFileSync(path.join(migrationsDirectory, migration), "utf8"));
    }
  }

  prepare(sql) {
    return new SqliteD1Statement(this.sqlite, sql);
  }

  async batch(statements) {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => executeStatement(this.sqlite, statement));
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  rows(sql, ...values) {
    return this.sqlite.prepare(sql).all(...values);
  }

  row(sql, ...values) {
    return this.sqlite.prepare(sql).get(...values) || null;
  }

  close() {
    this.sqlite.close();
  }
}

class FakeRateLimiter {
  constructor(success = true) {
    this.success = success;
    this.calls = [];
  }

  async limit(input) {
    this.calls.push(input);
    return { success: this.success };
  }
}

function webRequest(url, options = {}) {
  const headers = new Headers({
    origin: "https://oss.archastro.ai",
    "cf-connecting-ip": "203.0.113.8",
    ...options.headers,
  });
  return new Request(url, {
    method: options.method || "GET",
    headers,
    body: options.body,
  });
}

function jsonRequest(body, options = {}) {
  return webRequest(options.url || "https://oss.archastro.ai/api/oss/lab-interest", {
    method: "POST",
    headers: { "content-type": "application/json", ...options.headers },
    body: options.rawBody ?? JSON.stringify(body),
  });
}

function formRequest(url, token, options = {}) {
  return webRequest(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...options.headers,
    },
    body: new URLSearchParams({ token }).toString(),
  });
}

function makeEnv(database = new SqliteD1(), overrides = {}) {
  return {
    DB: database,
    RATE_LIMITER: new FakeRateLimiter(),
    ALLOWED_ORIGINS: "https://oss.archastro.ai,https://www.oss.archastro.ai",
    RESEND_API_KEY: "re_test_key",
    MAIL_FROM: "ArchAstro OSS <oss@archastro.ai>",
    PUBLIC_BASE_URL: "https://oss.archastro.ai",
    CONSENT_POLICY_VERSION: "2026-07-17",
    CONFIRMATION_SIGNING_SECRET: "test-signing-secret-with-sufficient-entropy",
    IDENTITY_HASH_SECRET: "test-identity-secret-with-separate-entropy",
    CONFIRMATION_TOKEN_TTL_SECONDS: "86400",
    PENDING_REQUEST_GRACE_DAYS: "7",
    VOTE_RETENTION_DAYS: "365",
    UNSUBSCRIBED_EMAIL_RETENTION_DAYS: "30",
    CONFIRMED_REQUEST_RETENTION_DAYS: "30",
    CONSENT_EVENT_RETENTION_DAYS: "730",
    ERASED_IDENTITY_RETENTION_DAYS: "30",
    OUTBOX_MAX_ATTEMPTS: "5",
    OUTBOX_BACKOFF_BASE_SECONDS: "60",
    ...overrides,
  };
}

function dependencies(overrides = {}) {
  let requestNumber = 0;
  return {
    fetch: async () => new Response(JSON.stringify({ id: "email_123" }), { status: 200 }),
    now: () => new Date("2026-07-17T18:00:00.000Z"),
    randomUUID: () => `server-request-${++requestNumber}`,
    logger: { error() {} },
    ...overrides,
  };
}

function confirmationDelivery(calls, index = 0) {
  const [url, options] = calls[index];
  const message = JSON.parse(options.body);
  const match = message.text.match(/https:\/\/oss\.archastro\.ai\/api\/oss\/lab-interest\/confirm\?token=([^\s]+)/);
  assert.ok(match, "confirmation email contains a signed link");
  return {
    apiUrl: url,
    options,
    message,
    link: match[0],
    token: decodeURIComponent(match[1]),
  };
}

const vote = {
  item: "aster",
  action: "thumbs_up",
  event_id: "evt-vote-123",
  source: "oss_catalog_lab",
};

const removeVote = {
  ...vote,
  action: "remove_interest",
};

const signup = {
  item: "astrodev",
  action: "email_signup",
  event_id: "evt-email-456",
  source: "oss_catalog_lab",
  email: " Engineer@Example.COM ",
  project_updates: true,
  broader_updates: false,
};

async function submitSignup(worker, database, overrides = {}) {
  const calls = [];
  const fetch = overrides.fetch || (async (...args) => {
    calls.push(args);
    return new Response(JSON.stringify({ id: "email_123" }), { status: 200 });
  });
  const deps = dependencies({ ...overrides, fetch });
  const env = makeEnv(database, overrides.env);
  const response = await worker.handleRequest(jsonRequest(overrides.payload || signup), env, deps);
  return { response, calls, deps, env };
}

async function confirmSignup(worker, database, options = {}) {
  const submitted = await submitSignup(worker, database, options);
  const delivery = confirmationDelivery(submitted.calls);
  const get = await worker.handleRequest(webRequest(delivery.link), submitted.env, submitted.deps);
  const post = await worker.handleRequest(
    formRequest("https://oss.archastro.ai/api/oss/lab-interest/confirm", delivery.token),
    submitted.env,
    submitted.deps
  );
  return { ...submitted, delivery, get, post };
}

test("migration separates votes, confirmation outbox, active subscriptions, and hash-only consent events", () => {
  const database = new SqliteD1();
  const tables = database.rows("SELECT name FROM sqlite_master WHERE type = 'table'").map(({ name }) => name);
  const consentColumns = database.rows("PRAGMA table_info(consent_events)").map(({ name }) => name);
  const requestColumns = database.rows("PRAGMA table_info(confirmation_requests)").map(({ name }) => name);
  const consentForeignKeys = database.rows("PRAGMA foreign_key_list(consent_events)");

  assert.ok(tables.includes("interest_votes"));
  assert.ok(tables.includes("confirmation_requests"));
  assert.ok(tables.includes("subscriptions"));
  assert.ok(tables.includes("consent_events"));
  assert.ok(consentColumns.includes("email_hash"));
  assert.ok(consentColumns.includes("action"));
  assert.ok(consentColumns.includes("policy_version"));
  assert.ok(consentColumns.includes("occurred_at"));
  assert.ok(!consentColumns.some((name) => /email_normalized|email_address/.test(name)));
  assert.ok(!requestColumns.some((name) => /token/.test(name)));
  assert.ok(requestColumns.includes("next_attempt_at"));
  assert.deepEqual(consentForeignKeys, []);
  database.sqlite.prepare(
    `INSERT INTO consent_events (
       subscription_id, confirmation_request_id, item, email_hash,
       project_updates, broader_updates, policy_version, action,
       request_id, occurred_at
     ) VALUES (NULL, 'audit-seed', 'aster', ?, 1, 0, 'test', 'requested', 'audit-seed', ?)`
  ).run("a".repeat(64), "2026-07-17T18:00:00.000Z");
  assert.throws(
    () => database.sqlite.prepare("UPDATE consent_events SET action = 'erased'").run(),
    /append-only/
  );
  database.close();
});

test("atomically inserts votes and rejects concurrent cross-item event reuse", async () => {
  const worker = await loadWorker();
  const database = new SqliteD1();
  const env = makeEnv(database);
  const deps = dependencies();
  const eventId = "evt-concurrent";

  const responses = await Promise.all([
    worker.handleRequest(jsonRequest({ ...vote, item: "aster", event_id: eventId }), env, deps),
    worker.handleRequest(jsonRequest({ ...vote, item: "astrodev", event_id: eventId }), env, deps),
  ]);
  const replay = await worker.handleRequest(
    jsonRequest({ ...vote, item: database.row("SELECT item FROM interest_votes").item, event_id: eventId }),
    env,
    deps
  );

  assert.deepEqual(responses.map(({ status }) => status).sort(), [201, 409]);
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).idempotent, true);
  assert.equal(database.rows("SELECT * FROM interest_votes").length, 1);
  database.close();
});

test("removes an anonymous vote idempotently with the same item and event id", async () => {
  const worker = await loadWorker();
  const database = new SqliteD1();
  const env = makeEnv(database);
  const deps = dependencies();

  const created = await worker.handleRequest(jsonRequest(vote), env, deps);
  const removed = await worker.handleRequest(jsonRequest(removeVote), env, deps);
  const repeated = await worker.handleRequest(jsonRequest(removeVote), env, deps);

  assert.equal(created.status, 201);
  assert.equal(removed.status, 200);
  assert.deepEqual(await removed.json(), {
    ok: true,
    event_id: vote.event_id,
    item: vote.item,
    action: "remove_interest",
    idempotent: false,
    project_updates: false,
    broader_updates: false,
    request_id: "server-request-2",
  });
  assert.equal(repeated.status, 200);
  assert.equal((await repeated.json()).idempotent, true);
  assert.equal(database.rows("SELECT * FROM interest_votes").length, 0);
  database.close();
});

test("does not remove a vote when the event id belongs to another item", async () => {
  const worker = await loadWorker();
  const database = new SqliteD1();
  const env = makeEnv(database);
  const deps = dependencies();

  await worker.handleRequest(jsonRequest(vote), env, deps);
  const response = await worker.handleRequest(
    jsonRequest({ ...removeVote, item: "astrodev" }),
    env,
    deps
  );

  assert.equal(response.status, 409);
  assert.equal(database.rows("SELECT * FROM interest_votes").length, 1);
  assert.equal(database.row("SELECT item FROM interest_votes").item, "aster");
  database.close();
});

test("signup creates an isolated pending request without creating or changing an active subscription", async () => {
  const worker = await loadWorker();
  const database = new SqliteD1();
  const { response } = await submitSignup(worker, database);
  const responseBody = await response.json();
  const pending = database.row("SELECT * FROM confirmation_requests");
  const requested = database.row("SELECT * FROM consent_events WHERE action = 'requested'");

  assert.equal(response.status, 202);
  assert.equal(responseBody.status, "pending_confirmation");
  assert.equal(responseBody.delivery_status, "sent");
  assert.equal(database.rows("SELECT * FROM subscriptions").length, 0);
  assert.equal(pending.email_normalized, "engineer@example.com");
  const expectedIdentity = createHmac("sha256", makeEnv(database).IDENTITY_HASH_SECRET)
    .update("engineer@example.com")
    .digest("hex");
  const plainHash = createHash("sha256").update("engineer@example.com").digest("hex");
  assert.equal(pending.email_hash, expectedIdentity);
  assert.notEqual(pending.email_hash, plainHash);
  assert.equal(pending.delivery_status, "sent");
  assert.equal(pending.delivery_attempts, 1);
  assert.equal(requested.email_hash, pending.email_hash);
  assert.equal(requested.policy_version, "2026-07-17");
  database.close();
});

test("signup rejects a missing or undersized identity hashing secret", async () => {
  const worker = await loadWorker();
  for (const identitySecret of [undefined, "too-short"]) {
    const database = new SqliteD1();
    const response = await worker.handleRequest(
      jsonRequest(signup),
      makeEnv(database, { IDENTITY_HASH_SECRET: identitySecret }),
      dependencies()
    );

    assert.equal(response.status, 500);
    assert.equal(database.rows("SELECT * FROM confirmation_requests").length, 0);
    database.close();
  }
});

test("scanner GET renders an accessible confirmation form and cannot confirm", async () => {
  const worker = await loadWorker();
  const database = new SqliteD1();
  const { calls, env, deps } = await submitSignup(worker, database);
  const delivery = confirmationDelivery(calls);

  const response = await worker.handleRequest(webRequest(delivery.link), env, deps);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  assert.match(html, /<main/);
  assert.match(html, /<form[^>]+method="post"/i);
  assert.match(html, /<button[^>]*>Confirm updates<\/button>/i);
  assert.equal(database.rows("SELECT * FROM subscriptions").length, 0);
  assert.equal(database.row("SELECT status FROM confirmation_requests").status, "pending");
  database.close();
});

test("explicit same-origin POST atomically confirms and applies requested consent", async () => {
  const worker = await loadWorker();
  const database = new SqliteD1();
  const result = await confirmSignup(worker, database);
  const subscription = database.row("SELECT * FROM subscriptions");
  const pending = database.row("SELECT * FROM confirmation_requests");
  const audit = database.rows("SELECT action, email_hash FROM consent_events ORDER BY id");

  assert.equal(result.post.status, 200);
  assert.match(result.post.headers.get("content-type"), /text\/html/);
  const resultHtml = await result.post.text();
  assert.match(resultHtml, /Updates confirmed/);
  assert.match(resultHtml, /<a href="https:\/\/oss\.archastro\.ai\/">Back to ArchAstro OSS<\/a>/);
  assert.doesNotMatch(resultHtml, /<form|<script/i);
  assert.ok(!resultHtml.includes(result.delivery.token));
  assert.equal(subscription.status, "active");
  assert.equal(subscription.email_normalized, "engineer@example.com");
  assert.equal(subscription.project_updates, 1);
  assert.equal(subscription.broader_updates, 0);
  assert.equal(pending.status, "confirmed");
  assert.equal(pending.email_normalized, null);
  assert.deepEqual(audit.map(({ action }) => action), ["requested", "confirmed"]);
  assert.ok(audit.every(({ email_hash }) => email_hash === subscription.email_hash));
  database.close();
});

test("confirmation POST requires exact origin and a valid untampered signature", async () => {
  const worker = await loadWorker();
  const database = new SqliteD1();
  const { calls, env, deps } = await submitSignup(worker, database);
  const delivery = confirmationDelivery(calls);

  const forged = await worker.handleRequest(
    formRequest("https://oss.archastro.ai/api/oss/lab-interest/confirm", `${delivery.token}x`),
    env,
    deps
  );
  const crossSite = await worker.handleRequest(
    formRequest("https://oss.archastro.ai/api/oss/lab-interest/confirm", delivery.token, {
      headers: { origin: "https://evil.example" },
    }),
    env,
    deps
  );

  assert.equal(forged.status, 400);
  assert.match(forged.headers.get("content-type"), /text\/html/);
  assert.match(await forged.text(), /This link is invalid or expired/);
  assert.equal(crossSite.status, 403);
  assert.equal(database.rows("SELECT * FROM subscriptions").length, 0);
  database.close();
});

test("invalid lifecycle GET renders a safe catalog link without a fallback POST form", async () => {
  const worker = await loadWorker();
  const database = new SqliteD1();
  const response = await worker.handleRequest(
    webRequest("https://oss.archastro.ai/api/oss/lab-interest/confirm?token=invalid"),
    makeEnv(database),
    dependencies()
  );
  const html = await response.text();

  assert.equal(response.status, 400);
  assert.match(response.headers.get("content-type"), /text\/html/);
  assert.match(html, /<a href="https:\/\/oss\.archastro\.ai\/">Back to ArchAstro OSS<\/a>/);
  assert.doesNotMatch(html, /<form|method="post"|action="\/"/i);
  assert.doesNotMatch(html, /<script/i);
  database.close();
});

test("replayed lifecycle POST renders a safe HTML result", async () => {
  const worker = await loadWorker();
  const database = new SqliteD1();
  const result = await confirmSignup(worker, database);
  const replay = await worker.handleRequest(
    formRequest("https://oss.archastro.ai/api/oss/lab-interest/confirm", result.delivery.token),
    result.env,
    result.deps
  );
  const html = await replay.text();

  assert.equal(replay.status, 400);
  assert.match(replay.headers.get("content-type"), /text\/html/);
  assert.match(html, /Action unavailable/);
  assert.match(html, /Back to ArchAstro OSS/);
  assert.doesNotMatch(html, /<script|request_id|token/i);
  database.close();
});

test("active consent is not demoted or changed by a new unconfirmed request or delivery failure", async () => {
  const worker = await loadWorker();
  const database = new SqliteD1();
  await confirmSignup(worker, database);
  const before = database.row("SELECT * FROM subscriptions");

  const failed = await submitSignup(worker, database, {
    payload: { ...signup, event_id: "evt-reconfirm", broader_updates: true },
    fetch: async () => { throw new Error("ambiguous timeout"); },
    randomUUID: () => "server-request-reconfirm",
  });
  const after = database.row("SELECT * FROM subscriptions");

  assert.equal(failed.response.status, 202);
  const failedBody = await failed.response.json();
  assert.equal(failedBody.status, "queued");
  assert.equal(failedBody.delivery_status, "queued");
  assert.equal(after.status, "active");
  assert.equal(after.broader_updates, before.broader_updates);
  assert.equal(after.updated_at, before.updated_at);
  assert.equal(database.row("SELECT delivery_status FROM confirmation_requests WHERE event_id = 'evt-reconfirm'").delivery_status, "queued");
  database.close();
});

test("ambiguous delivery retries regenerate the same signed link and idempotency key", async () => {
  const worker = await loadWorker();
  const database = new SqliteD1();
  const firstCalls = [];
  const first = await submitSignup(worker, database, {
    fetch: async (...args) => {
      firstCalls.push(args);
      throw new Error("connection closed after send");
    },
  });
  const firstDelivery = confirmationDelivery(firstCalls);
  const retryCalls = [];
  const queued = database.row("SELECT * FROM confirmation_requests");

  await worker.runScheduled(first.env, dependencies({
    now: () => new Date("2026-07-17T18:01:00.000Z"),
    fetch: async (...args) => {
      retryCalls.push(args);
      return new Response(JSON.stringify({ id: "email_retry" }), { status: 200 });
    },
  }));
  const retryDelivery = confirmationDelivery(retryCalls);
  const pending = database.row("SELECT * FROM confirmation_requests");

  assert.equal(first.response.status, 202);
  assert.equal((await first.response.json()).status, "queued");
  assert.equal(queued.next_attempt_at, "2026-07-17T18:01:00.000Z");
  assert.equal(retryDelivery.link, firstDelivery.link);
  assert.equal(retryDelivery.options.headers["idempotency-key"], firstDelivery.options.headers["idempotency-key"]);
  assert.equal(pending.delivery_status, "sent");
  assert.equal(pending.delivery_attempts, 2);
  database.close();
});

test("permanent Resend 400 terminalizes delivery and returns a retryable API error", async () => {
  const worker = await loadWorker();
  const database = new SqliteD1();
  const response = await worker.handleRequest(
    jsonRequest(signup),
    makeEnv(database),
    dependencies({ fetch: async () => new Response("invalid sender", { status: 400 }) })
  );
  const body = await response.json();
  const pending = database.row("SELECT * FROM confirmation_requests");
  let scheduledCalls = 0;

  await worker.runScheduled(
    makeEnv(database),
    dependencies({
      now: () => new Date("2026-07-18T18:00:00.000Z"),
      fetch: async () => {
        scheduledCalls += 1;
        return new Response(null, { status: 200 });
      },
    })
  );

  assert.equal(response.status, 502);
  assert.equal(body.error.code, "confirmation_delivery_failed");
  assert.equal(body.delivery_status, "failed");
  assert.equal(pending.delivery_status, "failed");
  assert.equal(pending.delivery_attempts, 1);
  assert.equal(pending.next_attempt_at, null);
  assert.equal(scheduledCalls, 0);
  database.close();
});

test("Resend 500 queues exponential backoff and cron waits until eligible", async () => {
  const worker = await loadWorker();
  const database = new SqliteD1();
  const env = makeEnv(database, { OUTBOX_BACKOFF_BASE_SECONDS: "60" });
  const initial = await worker.handleRequest(
    jsonRequest(signup),
    env,
    dependencies({ fetch: async () => new Response("unavailable", { status: 500 }) })
  );
  let retryCalls = 0;
  const retryFetch = async () => {
    retryCalls += 1;
    return new Response(JSON.stringify({ id: "recovered" }), { status: 200 });
  };

  await worker.runScheduled(
    env,
    dependencies({ now: () => new Date("2026-07-17T18:00:59.000Z"), fetch: retryFetch })
  );
  assert.equal(retryCalls, 0);
  assert.equal(database.row("SELECT next_attempt_at FROM confirmation_requests").next_attempt_at, "2026-07-17T18:01:00.000Z");

  await worker.runScheduled(
    env,
    dependencies({ now: () => new Date("2026-07-17T18:01:00.000Z"), fetch: retryFetch })
  );
  assert.equal(initial.status, 202);
  assert.equal((await initial.json()).status, "queued");
  assert.equal(retryCalls, 1);
  assert.equal(database.row("SELECT delivery_status FROM confirmation_requests").delivery_status, "sent");
  database.close();
});

test("retryable delivery stops permanently at the configured maximum attempts", async () => {
  const worker = await loadWorker();
  const database = new SqliteD1();
  const env = makeEnv(database, {
    OUTBOX_MAX_ATTEMPTS: "2",
    OUTBOX_BACKOFF_BASE_SECONDS: "60",
  });
  let calls = 0;
  const unavailable = async () => {
    calls += 1;
    return new Response("unavailable", { status: 500 });
  };

  await worker.handleRequest(jsonRequest(signup), env, dependencies({ fetch: unavailable }));
  await worker.runScheduled(
    env,
    dependencies({ now: () => new Date("2026-07-17T18:01:00.000Z"), fetch: unavailable })
  );
  const exhausted = database.row("SELECT * FROM confirmation_requests");
  await worker.runScheduled(
    env,
    dependencies({ now: () => new Date("2026-07-18T18:00:00.000Z"), fetch: unavailable })
  );

  assert.equal(calls, 2);
  assert.equal(exhausted.delivery_status, "failed");
  assert.equal(exhausted.delivery_attempts, 2);
  assert.equal(exhausted.next_attempt_at, null);
  database.close();
});

test("repeat signup with the same event resends the same deterministic confirmation", async () => {
  const worker = await loadWorker();
  const database = new SqliteD1();
  const calls = [];
  const deps = dependencies({
    fetch: async (...args) => {
      calls.push(args);
      return new Response(JSON.stringify({ id: "email" }), { status: 200 });
    },
  });
  const env = makeEnv(database);

  await worker.handleRequest(jsonRequest(signup), env, deps);
  await worker.handleRequest(jsonRequest(signup), env, deps);

  assert.equal(calls.length, 2);
  assert.equal(confirmationDelivery(calls, 0).link, confirmationDelivery(calls, 1).link);
  assert.equal(database.rows("SELECT * FROM confirmation_requests").length, 1);
  assert.equal(database.rows("SELECT * FROM consent_events WHERE action = 'requested'").length, 1);
  database.close();
});

test("signed unsubscribe GET is read-only and same-origin POST stops mail eligibility", async () => {
  const worker = await loadWorker();
  const database = new SqliteD1();
  await confirmSignup(worker, database);
  const subscription = database.row("SELECT * FROM subscriptions");
  await submitSignup(worker, database, {
    payload: { ...signup, event_id: "evt-pending-before-unsubscribe", broader_updates: true },
    randomUUID: () => "server-request-pending-unsubscribe",
  });
  const expiry = Math.floor(new Date("2026-08-17T18:00:00.000Z").getTime() / 1000);
  const token = await worker.createSignedToken("unsubscribe", String(subscription.id), expiry, makeEnv(database).CONFIRMATION_SIGNING_SECRET);
  const url = `https://oss.archastro.ai/api/oss/lab-interest/unsubscribe?token=${encodeURIComponent(token)}`;

  const get = await worker.handleRequest(webRequest(url), makeEnv(database), dependencies());
  assert.equal(get.status, 200);
  assert.match(await get.text(), /<button[^>]*>Unsubscribe<\/button>/i);
  assert.equal(database.row("SELECT status FROM subscriptions").status, "active");

  const post = await worker.handleRequest(
    formRequest("https://oss.archastro.ai/api/oss/lab-interest/unsubscribe", token),
    makeEnv(database),
    dependencies()
  );
  assert.equal(post.status, 200);
  assert.match(post.headers.get("content-type"), /text\/html/);
  const postHtml = await post.text();
  assert.match(postHtml, /Unsubscribed/);
  assert.match(postHtml, /<a href="https:\/\/oss\.archastro\.ai\/">Back to ArchAstro OSS<\/a>/);
  assert.doesNotMatch(postHtml, /<form|<script/i);
  assert.ok(!postHtml.includes(token));
  assert.equal(database.row("SELECT status FROM subscriptions").status, "unsubscribed");
  assert.equal(database.rows("SELECT * FROM consent_events WHERE action = 'unsubscribed'").length, 1);
  assert.equal(
    database.rows("SELECT * FROM confirmation_requests WHERE email_hash = ? AND status = 'pending'", subscription.email_hash).length,
    0
  );
  database.close();
});

test("signed erasure GET is read-only and POST clears raw PII but retains hash evidence", async () => {
  const worker = await loadWorker();
  const database = new SqliteD1();
  await confirmSignup(worker, database);
  await confirmSignup(worker, database, {
    payload: { ...signup, item: "aster", event_id: "evt-aster-subscription" },
    randomUUID: (() => {
      let number = 0;
      return () => `server-request-aster-${++number}`;
    })(),
  });
  const subscription = database.row("SELECT * FROM subscriptions WHERE item = 'astrodev'");
  assert.equal(database.rows("SELECT * FROM subscriptions").length, 2);
  await submitSignup(worker, database, {
    payload: { ...signup, event_id: "evt-pending-before-erasure", broader_updates: true },
    randomUUID: () => "server-request-pending-erasure",
  });
  const expiry = Math.floor(new Date("2026-08-17T18:00:00.000Z").getTime() / 1000);
  const token = await worker.createSignedToken("erase", String(subscription.id), expiry, makeEnv(database).CONFIRMATION_SIGNING_SECRET);
  const url = `https://oss.archastro.ai/api/oss/lab-interest/erase?token=${encodeURIComponent(token)}`;

  const get = await worker.handleRequest(webRequest(url), makeEnv(database), dependencies());
  assert.equal(get.status, 200);
  assert.match(await get.text(), /<button[^>]*>Erase my email<\/button>/i);
  assert.equal(database.row("SELECT email_normalized FROM subscriptions").email_normalized, "engineer@example.com");

  const post = await worker.handleRequest(
    formRequest("https://oss.archastro.ai/api/oss/lab-interest/erase", token),
    makeEnv(database),
    dependencies()
  );
  const erased = database.row("SELECT * FROM subscriptions WHERE item = 'astrodev'");
  const evidence = database.rows("SELECT * FROM consent_events WHERE action = 'erased'");
  assert.equal(post.status, 200);
  assert.match(post.headers.get("content-type"), /text\/html/);
  const postHtml = await post.text();
  assert.match(postHtml, /Email erased/);
  assert.match(postHtml, /<a href="https:\/\/oss\.archastro\.ai\/">Back to ArchAstro OSS<\/a>/);
  assert.doesNotMatch(postHtml, /<form|<script/i);
  assert.ok(!postHtml.includes(token));
  assert.equal(erased.status, "erased");
  assert.equal(erased.email_normalized, null);
  assert.equal(erased.email_hash, subscription.email_hash);
  assert.equal(database.rows("SELECT * FROM subscriptions WHERE email_normalized IS NOT NULL").length, 0);
  assert.equal(evidence.length, 2);
  assert.ok(evidence.every(({ email_hash }) => email_hash === subscription.email_hash));
  assert.equal(
    database.rows(
      "SELECT * FROM confirmation_requests WHERE email_hash = ? AND email_normalized IS NOT NULL",
      subscription.email_hash
    ).length,
    0
  );
  database.close();
});

test("scheduled retention removes pending and confirmed requests, audit hashes, votes, and erased identities", async () => {
  const worker = await loadWorker();
  const database = new SqliteD1();
  const oldDeps = dependencies({ now: () => new Date("2025-01-01T00:00:00.000Z") });
  const env = makeEnv(database, {
    CONFIRMATION_TOKEN_TTL_SECONDS: "60",
    PENDING_REQUEST_GRACE_DAYS: "1",
    VOTE_RETENTION_DAYS: "10",
    UNSUBSCRIBED_EMAIL_RETENTION_DAYS: "5",
    UNSUBSCRIBED_IDENTITY_RETENTION_DAYS: "5",
    CONFIRMED_REQUEST_RETENTION_DAYS: "5",
    CONSENT_EVENT_RETENTION_DAYS: "5",
    ERASED_IDENTITY_RETENTION_DAYS: "5",
  });
  await worker.handleRequest(jsonRequest(vote), env, oldDeps);
  await worker.handleRequest(jsonRequest(signup), env, oldDeps);

  database.sqlite.prepare(
    `INSERT INTO subscriptions (
       item, email_normalized, email_hash, project_updates, broader_updates,
       status, policy_version, subscribed_at, unsubscribed_at, erased_at,
       last_request_id, created_at, updated_at
     ) VALUES ('aster', 'old@example.com', ?, 1, 0, 'unsubscribed', '2025-01-01', ?, ?, NULL, 'seed', ?, ?)`
  ).run("a".repeat(64), "2025-01-01T00:00:00.000Z", "2025-01-02T00:00:00.000Z", "2025-01-01T00:00:00.000Z", "2025-01-02T00:00:00.000Z");
  database.sqlite.prepare(
    `INSERT INTO subscriptions (
       item, email_normalized, email_hash, project_updates, broader_updates,
       status, policy_version, subscribed_at, unsubscribed_at, erased_at,
       last_request_id, created_at, updated_at
     ) VALUES ('astrodev', NULL, ?, 1, 0, 'erased', '2025-01-01', ?, NULL, ?, 'erased-seed', ?, ?)`
  ).run("b".repeat(64), "2025-01-01T00:00:00.000Z", "2025-01-02T00:00:00.000Z", "2025-01-01T00:00:00.000Z", "2025-01-02T00:00:00.000Z");
  database.sqlite.prepare(
    `INSERT INTO confirmation_requests (
       request_id, event_id, item, email_normalized, email_hash,
       project_updates, broader_updates, status, delivery_status,
       delivery_attempts, next_attempt_at, policy_version, expires_at,
       confirmed_at, created_at, updated_at
     ) VALUES ('confirmed-seed', 'confirmed-event', 'aster', NULL, ?, 1, 0,
       'confirmed', 'sent', 1, NULL, '2025-01-01', ?, ?, ?, ?)`
  ).run("c".repeat(64), "2025-01-01T01:00:00.000Z", "2025-01-01T00:30:00.000Z", "2025-01-01T00:00:00.000Z", "2025-01-01T00:30:00.000Z");

  await worker.runScheduled(env, dependencies({ now: () => new Date("2026-07-17T18:00:00.000Z") }));

  assert.equal(database.rows("SELECT * FROM interest_votes").length, 0);
  assert.equal(database.rows("SELECT * FROM confirmation_requests").length, 0);
  assert.equal(database.rows("SELECT * FROM consent_events").length, 0);
  assert.equal(database.rows("SELECT * FROM subscriptions WHERE status = 'erased'").length, 0);
  assert.equal(database.rows("SELECT * FROM subscriptions WHERE status = 'unsubscribed'").length, 0);
  database.close();
});

test("rate limiting gates every POST write while lifecycle GET remains read-only", async () => {
  const worker = await loadWorker();
  const database = new SqliteD1();
  const limiter = new FakeRateLimiter(false);
  const env = makeEnv(database, { RATE_LIMITER: limiter });

  const voteResponse = await worker.handleRequest(jsonRequest(vote), env, dependencies());
  const getResponse = await worker.handleRequest(
    webRequest("https://oss.archastro.ai/api/oss/lab-interest/confirm?token=invalid"),
    env,
    dependencies()
  );

  assert.equal(voteResponse.status, 429);
  assert.notEqual(getResponse.status, 429);
  assert.equal(limiter.calls.length, 1);
  assert.equal(limiter.calls[0].key, "oss-interest:203.0.113.8");
  database.close();
});

test("keeps exact origin, JSON validation, size cap, request IDs, and non-PII telemetry", async () => {
  const worker = await loadWorker();
  const entries = [];
  const database = new SqliteD1();
  database.prepare = () => ({ bind: () => ({ first: async () => { throw new Error("engineer@example.com secret-token"); } }) });

  const crossSite = await worker.handleRequest(
    jsonRequest(vote, { headers: { origin: "https://oss.archastro.ai.evil.example" } }),
    makeEnv(),
    dependencies()
  );
  const malformed = await worker.handleRequest(jsonRequest(null, { rawBody: "{" }), makeEnv(), dependencies());
  const oversized = await worker.handleRequest(
    jsonRequest(null, { rawBody: JSON.stringify({ padding: "x".repeat(worker.MAX_REQUEST_BYTES) }) }),
    makeEnv(),
    dependencies()
  );
  const failed = await worker.handleRequest(
    jsonRequest(vote),
    makeEnv(database),
    dependencies({ logger: { error: (entry) => entries.push(entry) } })
  );
  const failedText = await failed.text();

  assert.equal(crossSite.status, 403);
  assert.equal(malformed.status, 400);
  assert.equal(oversized.status, 413);
  assert.equal(failed.status, 500);
  assert.equal(failed.headers.get("x-request-id"), "server-request-1");
  assert.doesNotMatch(failedText, /engineer|secret-token/);
  assert.equal(entries[0].event, "oss_interest_error");
  assert.doesNotMatch(JSON.stringify(entries), /engineer|secret-token/);
});

test("deployment docs cover routes, migrations, schedule, secrets, and retention commands", () => {
  const config = fs.readFileSync(path.join(workerDirectory, "wrangler.toml.example"), "utf8");
  const readme = fs.readFileSync(path.join(workerDirectory, "README.md"), "utf8");

  assert.match(config, /oss\.archastro\.ai\/api\/oss\/lab-interest\*/);
  assert.match(config, /migrations_dir\s*=\s*"migrations"/);
  assert.match(config, /\[triggers\]/);
  assert.match(config, /crons\s*=/);
  assert.match(config, /PENDING_REQUEST_GRACE_DAYS/);
  assert.match(config, /VOTE_RETENTION_DAYS/);
  assert.match(config, /UNSUBSCRIBED_EMAIL_RETENTION_DAYS/);
  assert.match(config, /UNSUBSCRIBED_IDENTITY_RETENTION_DAYS/);
  assert.match(config, /CONFIRMED_REQUEST_RETENTION_DAYS/);
  assert.match(config, /CONSENT_EVENT_RETENTION_DAYS/);
  assert.match(config, /ERASED_IDENTITY_RETENTION_DAYS/);
  assert.match(config, /OUTBOX_MAX_ATTEMPTS/);
  assert.match(config, /OUTBOX_BACKOFF_BASE_SECONDS/);
  assert.match(readme, /wrangler d1 migrations apply/);
  assert.match(readme, /wrangler secret put RESEND_API_KEY/);
  assert.match(readme, /wrangler secret put CONFIRMATION_SIGNING_SECRET/);
  assert.match(readme, /wrangler secret put IDENTITY_HASH_SECRET/);
  assert.match(readme, /exponential backoff/i);
  assert.match(readme, /wrangler deploy/);
  assert.doesNotMatch(`${config}\n${readme}`, /re_[A-Za-z0-9]{8,}/);
});
