-- Mirror of migrations/0001_initial.sql for one-step local D1 initialization.
CREATE TABLE IF NOT EXISTS interest_votes (
  event_id TEXT PRIMARY KEY,
  item TEXT NOT NULL CHECK (item IN ('aster', 'astrodev')),
  source TEXT NOT NULL CHECK (source = 'oss_catalog_lab'),
  request_marker TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS interest_votes_item_created_idx
  ON interest_votes (item, created_at);

CREATE TABLE IF NOT EXISTS confirmation_requests (
  request_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  item TEXT NOT NULL CHECK (item IN ('aster', 'astrodev')),
  email_normalized TEXT,
  email_hash TEXT NOT NULL CHECK (length(email_hash) = 64),
  project_updates INTEGER NOT NULL CHECK (project_updates = 1),
  broader_updates INTEGER NOT NULL CHECK (broader_updates IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed')),
  delivery_status TEXT NOT NULL CHECK (delivery_status IN ('queued', 'sent', 'failed')),
  delivery_attempts INTEGER NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
  next_attempt_at TEXT,
  last_delivery_attempt_at TEXT,
  provider_message_id TEXT,
  policy_version TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  confirmed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (status = 'pending' AND email_normalized IS NOT NULL AND confirmed_at IS NULL)
    OR
    (status = 'confirmed' AND email_normalized IS NULL AND confirmed_at IS NOT NULL)
  ),
  CHECK (
    (delivery_status = 'queued' AND next_attempt_at IS NOT NULL)
    OR
    (delivery_status IN ('sent', 'failed') AND next_attempt_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS confirmation_requests_delivery_idx
  ON confirmation_requests (delivery_status, next_attempt_at, expires_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS confirmation_requests_retention_idx
  ON confirmation_requests (status, expires_at);

CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item TEXT NOT NULL CHECK (item IN ('aster', 'astrodev')),
  email_normalized TEXT,
  email_hash TEXT NOT NULL CHECK (length(email_hash) = 64),
  project_updates INTEGER NOT NULL CHECK (project_updates = 1),
  broader_updates INTEGER NOT NULL CHECK (broader_updates IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('active', 'unsubscribed', 'erased')),
  policy_version TEXT NOT NULL,
  subscribed_at TEXT NOT NULL,
  unsubscribed_at TEXT,
  erased_at TEXT,
  last_request_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (item, email_hash),
  CHECK (
    (status = 'active' AND email_normalized IS NOT NULL AND unsubscribed_at IS NULL AND erased_at IS NULL)
    OR
    (status = 'unsubscribed' AND erased_at IS NULL)
    OR
    (status = 'erased' AND email_normalized IS NULL AND erased_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS subscriptions_mail_eligible_idx
  ON subscriptions (item, broader_updates, subscribed_at)
  WHERE status = 'active' AND email_normalized IS NOT NULL;

CREATE INDEX IF NOT EXISTS subscriptions_unsubscribed_retention_idx
  ON subscriptions (unsubscribed_at)
  WHERE status = 'unsubscribed' AND email_normalized IS NOT NULL;

CREATE TABLE IF NOT EXISTS consent_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id INTEGER,
  confirmation_request_id TEXT,
  item TEXT NOT NULL CHECK (item IN ('aster', 'astrodev')),
  email_hash TEXT NOT NULL CHECK (length(email_hash) = 64),
  project_updates INTEGER NOT NULL CHECK (project_updates = 1),
  broader_updates INTEGER NOT NULL CHECK (broader_updates IN (0, 1)),
  policy_version TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('requested', 'confirmed', 'unsubscribed', 'erased')),
  request_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  UNIQUE (confirmation_request_id, action)
);

CREATE INDEX IF NOT EXISTS consent_events_email_hash_idx
  ON consent_events (email_hash, occurred_at);

CREATE TRIGGER IF NOT EXISTS confirmation_requests_record_request
AFTER INSERT ON confirmation_requests
BEGIN
  INSERT INTO consent_events (
    subscription_id, confirmation_request_id, item, email_hash,
    project_updates, broader_updates, policy_version, action,
    request_id, occurred_at
  ) VALUES (
    NULL, NEW.request_id, NEW.item, NEW.email_hash,
    NEW.project_updates, NEW.broader_updates, NEW.policy_version, 'requested',
    NEW.request_id, NEW.created_at
  );
END;

CREATE TRIGGER IF NOT EXISTS consent_events_no_update
BEFORE UPDATE ON consent_events
BEGIN
  SELECT RAISE(ABORT, 'consent_events are append-only');
END;
