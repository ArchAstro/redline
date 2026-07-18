const MAX_REQUEST_BYTES = 8 * 1024;
const INTEREST_PATH = "/api/oss/lab-interest";
const CONFIRM_PATH = `${INTEREST_PATH}/confirm`;
const UNSUBSCRIBE_PATH = `${INTEREST_PATH}/unsubscribe`;
const ERASE_PATH = `${INTEREST_PATH}/erase`;
const RESEND_ENDPOINT = "https://api.resend.com/emails";
const DEFAULT_CONFIRMATION_TTL_SECONDS = 24 * 60 * 60;
const DEFAULT_PENDING_REQUEST_GRACE_DAYS = 7;
const DEFAULT_VOTE_RETENTION_DAYS = 365;
const DEFAULT_UNSUBSCRIBED_EMAIL_RETENTION_DAYS = 30;
const DEFAULT_UNSUBSCRIBED_IDENTITY_RETENTION_DAYS = 365;
const DEFAULT_CONFIRMED_REQUEST_RETENTION_DAYS = 30;
const DEFAULT_CONSENT_EVENT_RETENTION_DAYS = 730;
const DEFAULT_ERASED_IDENTITY_RETENTION_DAYS = 30;
const DEFAULT_OUTBOX_MAX_ATTEMPTS = 5;
const DEFAULT_OUTBOX_BACKOFF_BASE_SECONDS = 60;
const ALLOWED_ITEMS = new Set(["aster", "astrodev"]);
const ALLOWED_ACTIONS = new Set(["thumbs_up", "remove_interest", "email_signup"]);
const ALLOWED_FIELDS = new Set([
  "item",
  "action",
  "event_id",
  "email",
  "source",
  "project_updates",
  "broader_updates",
]);
const SOURCE = "oss_catalog_lab";

function runtimeDependencies(overrides = {}) {
  return {
    fetch: globalThis.fetch.bind(globalThis),
    now: () => new Date(),
    randomUUID: () => globalThis.crypto.randomUUID(),
    logger: console,
    ...overrides,
  };
}

function jsonResponse(status, body, requestId, headers = {}) {
  return new Response(JSON.stringify({ ...body, request_id: requestId }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-request-id": requestId,
      ...headers,
    },
  });
}

function errorResponse(status, code, message, requestId, headers) {
  return jsonResponse(status, { ok: false, error: { code, message } }, requestId, headers);
}

function htmlResponse(status, html, requestId) {
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "x-request-id": requestId,
    },
  });
}

function emitError(dependencies, requestId, code, status, context = {}) {
  dependencies.logger.error({
    event: "oss_interest_error",
    request_id: requestId,
    code,
    status,
    ...context,
  });
}

function configuredOrigins(env) {
  return new Set(
    String(env.ALLOWED_ORIGINS || "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean)
  );
}

function isAllowedOrigin(origin, env) {
  return Boolean(origin) && configuredOrigins(env).has(origin);
}

async function readLimitedBody(request) {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    throw new RangeError("request_too_large");
  }
  if (!request.body) return "";

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let body = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytesRead += value.byteLength;
    if (bytesRead > MAX_REQUEST_BYTES) {
      await reader.cancel();
      throw new RangeError("request_too_large");
    }
    body += decoder.decode(value, { stream: true });
  }
  return body + decoder.decode();
}

function isValidEmail(email) {
  if (email.length > 254 || /[\r\n]/.test(email)) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validatePayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: "Request body must be a JSON object." };
  }
  if (Object.keys(value).some((key) => !ALLOWED_FIELDS.has(key))) {
    return { error: "Request contains unsupported fields." };
  }
  if (!ALLOWED_ITEMS.has(value.item) || !ALLOWED_ACTIONS.has(value.action)) {
    return { error: "Unknown item or action." };
  }
  if (value.source !== SOURCE) {
    return { error: "Unknown request source." };
  }
  if (
    typeof value.event_id !== "string" ||
    value.event_id.length < 1 ||
    value.event_id.length > 128 ||
    !/^[A-Za-z0-9._:-]+$/.test(value.event_id)
  ) {
    return { error: "event_id is invalid." };
  }
  if (value.broader_updates !== undefined && typeof value.broader_updates !== "boolean") {
    return { error: "broader_updates must be a boolean." };
  }

  if (value.action === "thumbs_up" || value.action === "remove_interest") {
    if (value.email !== undefined || value.project_updates === true || value.broader_updates === true) {
      return { error: "A vote cannot include email consent." };
    }
    return {
      item: value.item,
      action: value.action,
      eventId: value.event_id,
      source: SOURCE,
      projectUpdates: false,
      broaderUpdates: false,
    };
  }

  if (typeof value.email !== "string" || !isValidEmail(value.email.trim())) {
    return { error: "A valid email is required for email_signup." };
  }
  if (value.project_updates !== true) {
    return { error: "project_updates must be true for email_signup." };
  }
  return {
    item: value.item,
    action: value.action,
    eventId: value.event_id,
    source: SOURCE,
    email: value.email.trim().toLowerCase(),
    projectUpdates: true,
    broaderUpdates: value.broader_updates === true,
  };
}

function bytesToBase64Url(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function base64UrlToBytes(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new TypeError("invalid base64url");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

async function hmacKey(secret) {
  return globalThis.crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

async function hmacHex(secret, value) {
  const signature = await globalThis.crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    new TextEncoder().encode(value)
  );
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function createSignedToken(purpose, subject, expiryEpoch, secret) {
  const encodedSubject = bytesToBase64Url(new TextEncoder().encode(subject));
  const payload = `${encodedSubject}.${expiryEpoch}`;
  const signature = await globalThis.crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    new TextEncoder().encode(`${purpose}.${payload}`)
  );
  return `${payload}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

async function verifySignedToken(token, purpose, secret, now) {
  try {
    const [encodedSubject, expiryText, encodedSignature, extra] = token.split(".");
    if (extra !== undefined || !encodedSubject || !encodedSignature || !/^\d+$/.test(expiryText)) return null;
    const expiryEpoch = Number(expiryText);
    if (!Number.isSafeInteger(expiryEpoch) || expiryEpoch <= Math.floor(now.getTime() / 1000)) return null;
    const payload = `${encodedSubject}.${expiryText}`;
    const valid = await globalThis.crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret),
      base64UrlToBytes(encodedSignature),
      new TextEncoder().encode(`${purpose}.${payload}`)
    );
    if (!valid) return null;
    return {
      subject: new TextDecoder().decode(base64UrlToBytes(encodedSubject)),
      expiryEpoch,
    };
  } catch (_error) {
    return null;
  }
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function confirmationTtlSeconds(env) {
  return boundedInteger(
    env.CONFIRMATION_TOKEN_TTL_SECONDS,
    DEFAULT_CONFIRMATION_TTL_SECONDS,
    60,
    7 * 24 * 60 * 60
  );
}

function retentionDays(env, name, fallback) {
  return boundedInteger(env[name], fallback, 1, 3650);
}

function hasDatabaseConfiguration(env) {
  return Boolean(env.DB?.prepare && env.DB?.batch && env.RATE_LIMITER?.limit);
}

function hasSigningConfiguration(env) {
  return typeof env.CONFIRMATION_SIGNING_SECRET === "string" && env.CONFIRMATION_SIGNING_SECRET.length >= 32;
}

function hasIdentityConfiguration(env) {
  return typeof env.IDENTITY_HASH_SECRET === "string" && env.IDENTITY_HASH_SECRET.length >= 32;
}

function hasMailConfiguration(env) {
  return Boolean(
    env.RESEND_API_KEY &&
      env.MAIL_FROM &&
      env.PUBLIC_BASE_URL &&
      env.CONSENT_POLICY_VERSION &&
      hasSigningConfiguration(env) &&
      hasIdentityConfiguration(env)
  );
}

function outboxMaxAttempts(env) {
  return boundedInteger(env.OUTBOX_MAX_ATTEMPTS, DEFAULT_OUTBOX_MAX_ATTEMPTS, 1, 20);
}

function outboxBackoffBaseSeconds(env) {
  return boundedInteger(
    env.OUTBOX_BACKOFF_BASE_SECONDS,
    DEFAULT_OUTBOX_BACKOFF_BASE_SECONDS,
    1,
    24 * 60 * 60
  );
}

async function applyRateLimit(request, env) {
  const clientAddress = request.headers.get("cf-connecting-ip") || "unknown";
  return env.RATE_LIMITER.limit({ key: `oss-interest:${clientAddress}` });
}

async function storeVote(database, payload, requestId, now) {
  return database
    .prepare(
      `INSERT INTO interest_votes (event_id, item, source, request_marker, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(event_id) DO UPDATE SET event_id = excluded.event_id
       RETURNING event_id, item, source, request_marker`
    )
    .bind(payload.eventId, payload.item, payload.source, requestId, now)
    .first();
}

async function storeConfirmationRequest(database, payload, requestId, emailHash, expiresAt, now, policyVersion) {
  return database
    .prepare(
      `INSERT INTO confirmation_requests (
         request_id, event_id, item, email_normalized, email_hash,
         project_updates, broader_updates, status, delivery_status,
         delivery_attempts, next_attempt_at, policy_version, expires_at, created_at, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, 'pending', 'queued', 0, ?9, ?7, ?8, ?9, ?9)
       ON CONFLICT(event_id) DO UPDATE SET event_id = excluded.event_id
       RETURNING request_id, event_id, item, email_normalized, email_hash,
                 project_updates, broader_updates, status, delivery_status,
                 delivery_attempts, next_attempt_at, policy_version, expires_at`
    )
    .bind(
      requestId,
      payload.eventId,
      payload.item,
      payload.email,
      emailHash,
      payload.broaderUpdates ? 1 : 0,
      policyVersion,
      expiresAt,
      now
    )
    .first();
}

async function deliveryMessage(pending, env) {
  const expiryEpoch = Math.floor(new Date(pending.expires_at).getTime() / 1000);
  const token = await createSignedToken(
    "confirm",
    pending.request_id,
    expiryEpoch,
    env.CONFIRMATION_SIGNING_SECRET
  );
  const confirmationUrl = new URL(CONFIRM_PATH, env.PUBLIC_BASE_URL);
  confirmationUrl.searchParams.set("token", token);
  const projectName = pending.item === "aster" ? "Aster" : "AstroDev";
  return {
    token,
    idempotencyKey: `oss-interest:${pending.request_id}`,
    body: {
      from: env.MAIL_FROM,
      to: [pending.email_normalized],
      subject: `Confirm ${projectName} updates`,
      text: `Confirm that you want ${projectName} updates: ${confirmationUrl.toString()}\n\nThe link expires and confirmation requires an explicit button press.`,
    },
  };
}

async function recordDeliveryAttempt(database, pending, now, deliveryStatus, nextAttemptAt, providerMessageId) {
  await database
    .prepare(
      `UPDATE confirmation_requests
          SET delivery_status = ?2,
              delivery_attempts = delivery_attempts + 1,
              last_delivery_attempt_at = ?3,
              provider_message_id = ?4,
              next_attempt_at = ?5,
              updated_at = ?3
        WHERE request_id = ?1 AND status = 'pending'`
    )
    .bind(pending.request_id, deliveryStatus, now, providerMessageId || null, nextAttemptAt)
    .run();
}

function failedDeliveryState(pending, env, now, retryable) {
  const attemptNumber = Number(pending.delivery_attempts) + 1;
  if (!retryable || attemptNumber >= outboxMaxAttempts(env)) {
    return { status: "failed", nextAttemptAt: null };
  }
  const delaySeconds = outboxBackoffBaseSeconds(env) * (2 ** (attemptNumber - 1));
  return {
    status: "queued",
    nextAttemptAt: new Date(now.getTime() + delaySeconds * 1000).toISOString(),
  };
}

async function deliverConfirmation(pending, env, dependencies, operationRequestId) {
  const message = await deliveryMessage(pending, env);
  let response;
  try {
    response = await dependencies.fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        "content-type": "application/json",
        "idempotency-key": message.idempotencyKey,
      },
      body: JSON.stringify(message.body),
    });
  } catch (_error) {
    const now = dependencies.now();
    const state = failedDeliveryState(pending, env, now, true);
    await recordDeliveryAttempt(env.DB, pending, now.toISOString(), state.status, state.nextAttemptAt, null);
    emitError(dependencies, operationRequestId, "resend_ambiguous_failure", 202, {
      item: pending.item,
      operation: "confirmation_delivery",
    });
    return state.status;
  }

  if (!response.ok) {
    const retryable = response.status === 429 || response.status >= 500;
    const now = dependencies.now();
    const state = failedDeliveryState(pending, env, now, retryable);
    await recordDeliveryAttempt(env.DB, pending, now.toISOString(), state.status, state.nextAttemptAt, null);
    emitError(dependencies, operationRequestId, "resend_rejected_or_unavailable", state.status === "failed" ? 502 : 202, {
      item: pending.item,
      operation: "confirmation_delivery",
      upstream_status: response.status,
    });
    return state.status;
  }

  let providerMessageId = null;
  try {
    providerMessageId = (await response.json()).id || null;
  } catch (_error) {
    // A successful provider status is sufficient; the message id is optional metadata.
  }
  await recordDeliveryAttempt(env.DB, pending, dependencies.now().toISOString(), "sent", null, providerMessageId);
  return "sent";
}

function lifecyclePage(title, description, buttonLabel, action, token) {
  const safeToken = token.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} | ArchAstro OSS</title>
  <style>body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1.25rem;color:#171717}button{font:inherit;font-weight:650;padding:.65rem 1rem;border:1px solid #171717;background:#171717;color:#fff;cursor:pointer}p{color:#555}</style>
</head>
<body>
  <main>
    <h1>${title}</h1>
    <p>${description}</p>
    <form method="post" action="${action}">
      <input type="hidden" name="token" value="${safeToken}">
      <button type="submit">${buttonLabel}</button>
    </form>
  </main>
</body>
</html>`;
}

function lifecycleResultPage(title, description, publicBaseUrl) {
  const catalogUrl = new URL("/", publicBaseUrl).toString()
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} | ArchAstro OSS</title>
  <style>body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1.25rem;color:#171717}p{color:#555}a{color:#171717;font-weight:650}</style>
</head>
<body>
  <main>
    <h1>${title}</h1>
    <p>${description}</p>
    <a href="${catalogUrl}">Back to ArchAstro OSS</a>
  </main>
</body>
</html>`;
}

async function readFormToken(request) {
  const contentType = request.headers.get("content-type") || "";
  if (!/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(contentType)) return null;
  const raw = await readLimitedBody(request);
  const token = new URLSearchParams(raw).get("token") || "";
  return token.length <= 1024 ? token : "";
}

async function confirmationRecord(database, requestId) {
  return database
    .prepare(
      `SELECT request_id, item, status, expires_at
         FROM confirmation_requests
        WHERE request_id = ?1`
    )
    .bind(requestId)
    .first();
}

async function renderLifecycleGet(pathname, token, env, dependencies, requestId) {
  if (!hasSigningConfiguration(env)) {
    emitError(dependencies, requestId, "signing_configuration_error", 500, { route: pathname });
    return errorResponse(500, "internal_error", "Service is not configured.", requestId);
  }

  const purpose = pathname === CONFIRM_PATH ? "confirm" : pathname === UNSUBSCRIBE_PATH ? "unsubscribe" : "erase";
  const verified = await verifySignedToken(token, purpose, env.CONFIRMATION_SIGNING_SECRET, dependencies.now());
  if (!verified) {
    return htmlResponse(
      400,
      lifecycleResultPage("Link unavailable", "This link is invalid or expired.", env.PUBLIC_BASE_URL),
      requestId
    );
  }

  if (purpose === "confirm") {
    const pending = await confirmationRecord(env.DB, verified.subject);
    if (!pending || pending.status !== "pending" || pending.expires_at <= dependencies.now().toISOString()) {
      return htmlResponse(
        400,
        lifecycleResultPage("Link unavailable", "This link is invalid or expired.", env.PUBLIC_BASE_URL),
        requestId
      );
    }
    return htmlResponse(
      200,
      lifecyclePage("Confirm updates", "Confirm this request before we add the address to the mailing list.", "Confirm updates", CONFIRM_PATH, token),
      requestId
    );
  }

  const subscription = await env.DB
    .prepare("SELECT id, status FROM subscriptions WHERE id = ?1")
    .bind(verified.subject)
    .first();
  const allowed = purpose === "unsubscribe" ? subscription?.status === "active" : subscription && subscription.status !== "erased";
  if (!allowed) {
    return htmlResponse(
      400,
      lifecycleResultPage("Link unavailable", "This action is no longer available.", env.PUBLIC_BASE_URL),
      requestId
    );
  }
  if (purpose === "unsubscribe") {
    return htmlResponse(200, lifecyclePage("Unsubscribe", "Stop future updates for this project.", "Unsubscribe", UNSUBSCRIBE_PATH, token), requestId);
  }
  return htmlResponse(200, lifecyclePage("Erase email", "Remove the stored email address while retaining minimal consent evidence.", "Erase my email", ERASE_PATH, token), requestId);
}

async function confirmRequest(requestId, env, dependencies, operationRequestId) {
  const now = dependencies.now().toISOString();
  const statements = [
    env.DB.prepare(
      `INSERT INTO subscriptions (
         item, email_normalized, email_hash, project_updates, broader_updates,
         status, policy_version, subscribed_at, unsubscribed_at, erased_at,
         last_request_id, created_at, updated_at
       )
       SELECT item, email_normalized, email_hash, project_updates, broader_updates,
              'active', policy_version, ?2, NULL, NULL, ?3, ?2, ?2
         FROM confirmation_requests
        WHERE request_id = ?1 AND status = 'pending' AND expires_at > ?2
       ON CONFLICT(item, email_hash) DO UPDATE SET
         email_normalized = excluded.email_normalized,
         project_updates = excluded.project_updates,
         broader_updates = excluded.broader_updates,
         status = 'active',
         policy_version = excluded.policy_version,
         subscribed_at = excluded.subscribed_at,
         unsubscribed_at = NULL,
         erased_at = NULL,
         last_request_id = excluded.last_request_id,
         updated_at = excluded.updated_at
       RETURNING id`
    ).bind(requestId, now, operationRequestId),
    env.DB.prepare(
      `UPDATE confirmation_requests
          SET status = 'confirmed', email_normalized = NULL,
              confirmed_at = ?2, updated_at = ?2
        WHERE request_id = ?1 AND status = 'pending' AND expires_at > ?2
       RETURNING request_id`
    ).bind(requestId, now),
    env.DB.prepare(
      `INSERT INTO consent_events (
         subscription_id, confirmation_request_id, item, email_hash,
         project_updates, broader_updates, policy_version, action,
         request_id, occurred_at
       )
       SELECT subscriptions.id, confirmation_requests.request_id,
              confirmation_requests.item, confirmation_requests.email_hash,
              confirmation_requests.project_updates, confirmation_requests.broader_updates,
              confirmation_requests.policy_version, 'confirmed', ?3, ?2
         FROM confirmation_requests
         JOIN subscriptions
           ON subscriptions.item = confirmation_requests.item
          AND subscriptions.email_hash = confirmation_requests.email_hash
        WHERE confirmation_requests.request_id = ?1
          AND confirmation_requests.status = 'confirmed'
          AND confirmation_requests.confirmed_at = ?2
       ON CONFLICT(confirmation_request_id, action) DO NOTHING
       RETURNING id`
    ).bind(requestId, now, operationRequestId),
  ];
  const results = await env.DB.batch(statements);
  return Boolean(results[1]?.results?.length);
}

async function mutateSubscription(purpose, subscriptionId, env, dependencies, operationRequestId) {
  const now = dependencies.now().toISOString();
  const isUnsubscribe = purpose === "unsubscribe";
  const action = isUnsubscribe ? "unsubscribed" : "erased";
  const statusCondition = isUnsubscribe ? "status = 'active'" : "status IN ('active', 'unsubscribed')";
  const targetCondition = isUnsubscribe
    ? "id = ?1"
    : "email_hash = (SELECT email_hash FROM subscriptions WHERE id = ?1)";
  const auditTargetCondition = isUnsubscribe ? "id = ?1 AND " : "";
  const update = isUnsubscribe
    ? `status = 'unsubscribed', unsubscribed_at = ?2, last_request_id = ?3, updated_at = ?2`
    : `status = 'erased', email_normalized = NULL, erased_at = ?2, last_request_id = ?3, updated_at = ?2`;
  const statements = [
    env.DB.prepare(
      `UPDATE subscriptions SET ${update}
        WHERE ${targetCondition} AND ${statusCondition}
       RETURNING id`
    ).bind(subscriptionId, now, operationRequestId),
  ];
  statements.push(
    env.DB.prepare(
      `DELETE FROM confirmation_requests
        WHERE status = 'pending'
          AND email_hash = (SELECT email_hash FROM subscriptions WHERE id = ?1)`
    ).bind(subscriptionId)
  );
  statements.push(
    env.DB.prepare(
      `INSERT INTO consent_events (
         subscription_id, confirmation_request_id, item, email_hash,
         project_updates, broader_updates, policy_version, action,
         request_id, occurred_at
       )
       SELECT id, NULL, item, email_hash, project_updates, broader_updates,
              policy_version, ?4, ?3, ?2
         FROM subscriptions
        WHERE ${auditTargetCondition}last_request_id = ?3 AND status = ?5
       RETURNING id`
    ).bind(subscriptionId, now, operationRequestId, action, isUnsubscribe ? "unsubscribed" : "erased")
  );
  const results = await env.DB.batch(statements);
  return Boolean(results[0]?.results?.length);
}

async function handleLifecyclePost(pathname, token, env, dependencies, requestId) {
  if (!hasSigningConfiguration(env)) {
    emitError(dependencies, requestId, "signing_configuration_error", 500, { route: pathname });
    return errorResponse(500, "internal_error", "Service is not configured.", requestId);
  }
  const purpose = pathname === CONFIRM_PATH ? "confirm" : pathname === UNSUBSCRIBE_PATH ? "unsubscribe" : "erase";
  const verified = await verifySignedToken(token, purpose, env.CONFIRMATION_SIGNING_SECRET, dependencies.now());
  if (!verified) {
    return htmlResponse(
      400,
      lifecycleResultPage("Link unavailable", "This link is invalid or expired.", env.PUBLIC_BASE_URL),
      requestId
    );
  }

  const applied = purpose === "confirm"
    ? await confirmRequest(verified.subject, env, dependencies, requestId)
    : await mutateSubscription(purpose, verified.subject, env, dependencies, requestId);
  if (!applied) {
    return htmlResponse(
      400,
      lifecycleResultPage(
        "Action unavailable",
        "This action is invalid, expired, or already applied.",
        env.PUBLIC_BASE_URL
      ),
      requestId
    );
  }
  const result = purpose === "confirm"
    ? ["Updates confirmed", "Your subscription is active."]
    : purpose === "unsubscribe"
      ? ["Unsubscribed", "You will no longer receive updates for this project."]
      : ["Email erased", "Your stored email address has been removed."];
  return htmlResponse(
    200,
    lifecycleResultPage(result[0], result[1], env.PUBLIC_BASE_URL),
    requestId
  );
}

async function handleVote(payload, env, dependencies, requestId) {
  const stored = await storeVote(env.DB, payload, requestId, dependencies.now().toISOString());
  if (stored.item !== payload.item || stored.source !== payload.source) {
    return errorResponse(409, "event_conflict", "event_id is already used for another item.", requestId);
  }
  const idempotent = stored.request_marker !== requestId;
  return jsonResponse(idempotent ? 200 : 201, {
    ok: true,
    event_id: payload.eventId,
    item: payload.item,
    action: payload.action,
    idempotent,
    project_updates: false,
    broader_updates: false,
  }, requestId);
}

async function handleVoteRemoval(payload, env, requestId) {
  const removed = await env.DB
    .prepare(
      `DELETE FROM interest_votes
       WHERE event_id = ?1 AND item = ?2 AND source = ?3
       RETURNING event_id`
    )
    .bind(payload.eventId, payload.item, payload.source)
    .first();
  if (!removed) {
    const existing = await env.DB
      .prepare("SELECT item, source FROM interest_votes WHERE event_id = ?1")
      .bind(payload.eventId)
      .first();
    if (existing && (existing.item !== payload.item || existing.source !== payload.source)) {
      return errorResponse(409, "event_conflict", "event_id is already used for another item.", requestId);
    }
  }
  return jsonResponse(200, {
    ok: true,
    event_id: payload.eventId,
    item: payload.item,
    action: payload.action,
    idempotent: !removed,
    project_updates: false,
    broader_updates: false,
  }, requestId);
}

async function handleSignup(payload, env, dependencies, requestId) {
  const emailHash = await hmacHex(env.IDENTITY_HASH_SECRET, payload.email);
  const now = dependencies.now();
  const expiresAt = new Date(now.getTime() + confirmationTtlSeconds(env) * 1000).toISOString();
  const pending = await storeConfirmationRequest(
    env.DB,
    payload,
    requestId,
    emailHash,
    expiresAt,
    now.toISOString(),
    env.CONSENT_POLICY_VERSION
  );
  if (
    pending.item !== payload.item ||
    pending.email_hash !== emailHash ||
    Boolean(pending.project_updates) !== payload.projectUpdates ||
    Boolean(pending.broader_updates) !== payload.broaderUpdates
  ) {
    return errorResponse(409, "event_conflict", "event_id is already used for another signup.", requestId);
  }
  if (pending.status === "confirmed") {
    return jsonResponse(200, { ok: true, status: "already_confirmed", item: payload.item }, requestId);
  }

  let deliveryStatus = pending.delivery_status;
  if (deliveryStatus !== "failed") {
    const retryNotReady = deliveryStatus === "queued" &&
      Number(pending.delivery_attempts) > 0 &&
      pending.next_attempt_at > now.toISOString();
    if (!retryNotReady) {
      deliveryStatus = await deliverConfirmation(pending, env, dependencies, requestId);
    }
  }
  if (deliveryStatus === "failed") {
    return jsonResponse(502, {
      ok: false,
      error: {
        code: "confirmation_delivery_failed",
        message: "Unable to send the confirmation email. Please try again.",
      },
      event_id: payload.eventId,
      item: payload.item,
      action: payload.action,
      delivery_status: "failed",
    }, requestId);
  }
  return jsonResponse(202, {
    ok: true,
    event_id: payload.eventId,
    item: payload.item,
    action: payload.action,
    status: deliveryStatus === "sent" ? "pending_confirmation" : "queued",
    delivery_status: deliveryStatus,
    project_updates: true,
    broader_updates: payload.broaderUpdates,
  }, requestId);
}

async function parseInterestRequest(request, requestId) {
  const contentType = request.headers.get("content-type") || "";
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    return { response: errorResponse(415, "unsupported_media_type", "Content-Type must be application/json.", requestId) };
  }
  let rawBody;
  try {
    rawBody = await readLimitedBody(request);
  } catch (error) {
    const oversized = error instanceof RangeError;
    return {
      response: errorResponse(
        oversized ? 413 : 400,
        oversized ? "request_too_large" : "invalid_request",
        oversized ? "Request body exceeds 8192 bytes." : "Unable to read request body.",
        requestId
      ),
    };
  }
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch (_error) {
    return { response: errorResponse(400, "invalid_json", "Request body must contain valid JSON.", requestId) };
  }
  const payload = validatePayload(body);
  return payload.error
    ? { response: errorResponse(400, "invalid_request", payload.error, requestId) }
    : { payload };
}

async function handleRequest(request, env, dependencyOverrides = {}) {
  const dependencies = runtimeDependencies(dependencyOverrides);
  const requestId = dependencies.randomUUID();
  const url = new URL(request.url);
  const lifecyclePaths = new Set([CONFIRM_PATH, UNSUBSCRIBE_PATH, ERASE_PATH]);
  const knownPath = url.pathname === INTEREST_PATH || lifecyclePaths.has(url.pathname);
  if (!knownPath) return errorResponse(404, "not_found", "Endpoint not found.", requestId);

  const allowedMethods = url.pathname === INTEREST_PATH ? new Set(["POST"]) : new Set(["GET", "POST"]);
  if (!allowedMethods.has(request.method)) {
    return errorResponse(405, "method_not_allowed", "Method not allowed.", requestId, {
      allow: [...allowedMethods].join(", "),
    });
  }
  if (!hasDatabaseConfiguration(env)) {
    emitError(dependencies, requestId, "configuration_error", 500, { route: url.pathname });
    return errorResponse(500, "internal_error", "Service is not configured.", requestId);
  }

  if (request.method === "GET") {
    try {
      return await renderLifecycleGet(
        url.pathname,
        url.searchParams.get("token") || "",
        env,
        dependencies,
        requestId
      );
    } catch (_error) {
      emitError(dependencies, requestId, "lifecycle_read_failed", 500, { route: url.pathname });
      return errorResponse(500, "internal_error", "Unable to load this action.", requestId);
    }
  }

  if (!isAllowedOrigin(request.headers.get("origin"), env)) {
    return errorResponse(403, "origin_not_allowed", "Request origin is not allowed.", requestId);
  }
  try {
    const rateLimit = await applyRateLimit(request, env);
    if (!rateLimit.success) {
      return errorResponse(429, "rate_limited", "Too many requests. Please try again later.", requestId, {
        "retry-after": "60",
      });
    }
  } catch (_error) {
    emitError(dependencies, requestId, "rate_limiter_failed", 500, { route: url.pathname });
    return errorResponse(500, "internal_error", "Unable to process this request.", requestId);
  }

  if (lifecyclePaths.has(url.pathname)) {
    let token;
    try {
      token = await readFormToken(request);
    } catch (error) {
      const status = error instanceof RangeError ? 413 : 400;
      return errorResponse(status, status === 413 ? "request_too_large" : "invalid_request", "Unable to read form.", requestId);
    }
    if (!token) return errorResponse(400, "invalid_request", "A form token is required.", requestId);
    try {
      return await handleLifecyclePost(url.pathname, token, env, dependencies, requestId);
    } catch (_error) {
      emitError(dependencies, requestId, "lifecycle_write_failed", 500, { route: url.pathname });
      return errorResponse(500, "internal_error", "Unable to apply this action.", requestId);
    }
  }

  const parsed = await parseInterestRequest(request, requestId);
  if (parsed.response) return parsed.response;
  if (parsed.payload.action === "email_signup" && !hasMailConfiguration(env)) {
    emitError(dependencies, requestId, "mail_configuration_error", 500, { route: url.pathname });
    return errorResponse(500, "internal_error", "Email signup is not configured.", requestId);
  }
  try {
    if (parsed.payload.action === "thumbs_up") {
      return await handleVote(parsed.payload, env, dependencies, requestId);
    }
    if (parsed.payload.action === "remove_interest") {
      return await handleVoteRemoval(parsed.payload, env, requestId);
    }
    return await handleSignup(parsed.payload, env, dependencies, requestId);
  } catch (_error) {
    emitError(dependencies, requestId, "storage_failed", 500, {
      route: url.pathname,
      item: parsed.payload.item,
      action: parsed.payload.action,
    });
    return errorResponse(500, "internal_error", "Unable to save interest.", requestId);
  }
}

function subtractDays(date, days) {
  return new Date(date.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

async function runScheduled(env, dependencyOverrides = {}) {
  const dependencies = runtimeDependencies(dependencyOverrides);
  const requestId = dependencies.randomUUID();
  if (!env.DB?.prepare || !env.DB?.batch) {
    emitError(dependencies, requestId, "scheduled_configuration_error", 500, { operation: "scheduled" });
    return;
  }
  const now = dependencies.now();
  const nowIso = now.toISOString();

  if (hasMailConfiguration(env)) {
    try {
      const queued = await env.DB
        .prepare(
          `SELECT request_id, item, email_normalized, expires_at,
                  delivery_attempts, next_attempt_at
             FROM confirmation_requests
            WHERE status = 'pending' AND delivery_status = 'queued'
              AND email_normalized IS NOT NULL AND expires_at > ?1
              AND next_attempt_at <= ?1
            ORDER BY next_attempt_at, created_at
            LIMIT 50`
        )
        .bind(nowIso)
        .all();
      for (const pending of queued.results || []) {
        await deliverConfirmation(pending, env, dependencies, requestId);
      }
    } catch (_error) {
      emitError(dependencies, requestId, "scheduled_delivery_failed", 500, { operation: "scheduled" });
    }
  }

  const pendingCutoff = subtractDays(
    now,
    retentionDays(env, "PENDING_REQUEST_GRACE_DAYS", DEFAULT_PENDING_REQUEST_GRACE_DAYS)
  );
  const voteCutoff = subtractDays(
    now,
    retentionDays(env, "VOTE_RETENTION_DAYS", DEFAULT_VOTE_RETENTION_DAYS)
  );
  const unsubscribeCutoff = subtractDays(
    now,
    retentionDays(
      env,
      "UNSUBSCRIBED_EMAIL_RETENTION_DAYS",
      DEFAULT_UNSUBSCRIBED_EMAIL_RETENTION_DAYS
    )
  );
  const unsubscribeIdentityCutoff = subtractDays(
    now,
    retentionDays(
      env,
      "UNSUBSCRIBED_IDENTITY_RETENTION_DAYS",
      DEFAULT_UNSUBSCRIBED_IDENTITY_RETENTION_DAYS
    )
  );
  const confirmedRequestCutoff = subtractDays(
    now,
    retentionDays(
      env,
      "CONFIRMED_REQUEST_RETENTION_DAYS",
      DEFAULT_CONFIRMED_REQUEST_RETENTION_DAYS
    )
  );
  const consentEventCutoff = subtractDays(
    now,
    retentionDays(env, "CONSENT_EVENT_RETENTION_DAYS", DEFAULT_CONSENT_EVENT_RETENTION_DAYS)
  );
  const erasedIdentityCutoff = subtractDays(
    now,
    retentionDays(
      env,
      "ERASED_IDENTITY_RETENTION_DAYS",
      DEFAULT_ERASED_IDENTITY_RETENTION_DAYS
    )
  );
  try {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM consent_events WHERE occurred_at < ?1").bind(consentEventCutoff),
      env.DB.prepare(
        `DELETE FROM confirmation_requests
          WHERE status = 'pending' AND expires_at < ?1`
      ).bind(pendingCutoff),
      env.DB.prepare(
        `DELETE FROM confirmation_requests
          WHERE status = 'confirmed' AND confirmed_at < ?1`
      ).bind(confirmedRequestCutoff),
      env.DB.prepare("DELETE FROM interest_votes WHERE created_at < ?1").bind(voteCutoff),
      env.DB.prepare(
        `UPDATE subscriptions
            SET email_normalized = NULL, updated_at = ?2
          WHERE status = 'unsubscribed' AND email_normalized IS NOT NULL
            AND unsubscribed_at < ?1`
      ).bind(unsubscribeCutoff, nowIso),
      env.DB.prepare(
        `DELETE FROM subscriptions
          WHERE status = 'erased' AND erased_at < ?1`
      ).bind(erasedIdentityCutoff),
      env.DB.prepare(
        `DELETE FROM subscriptions
          WHERE status = 'unsubscribed' AND unsubscribed_at < ?1`
      ).bind(unsubscribeIdentityCutoff),
    ]);
  } catch (_error) {
    emitError(dependencies, requestId, "scheduled_retention_failed", 500, { operation: "scheduled" });
  }
}

export { MAX_REQUEST_BYTES, createSignedToken, handleRequest, runScheduled, validatePayload };
export default {
  fetch(request, env) {
    return handleRequest(request, env);
  },
  scheduled(_controller, env, context) {
    context.waitUntil(runScheduled(env));
  },
};
