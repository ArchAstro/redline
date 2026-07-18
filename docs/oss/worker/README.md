# OSS interest Worker

Cloudflare Worker and D1 storage for anonymous lab votes and confirmed update subscriptions at `oss.archastro.ai/api/oss/lab-interest*`.

## Data lifecycle

- Votes contain no email, can be retracted with the same item and event ID, and expire after `VOTE_RETENTION_DAYS`.
- Confirmation requests hold email addresses separately from active subscriptions. Expired pending requests are deleted after `PENDING_REQUEST_GRACE_DAYS`; confirmed requests are deleted after `CONFIRMED_REQUEST_RETENTION_DAYS`.
- Only an explicit confirmation form POST creates or updates an active subscription.
- Unsubscribed addresses lose their raw email after `UNSUBSCRIBED_EMAIL_RETENTION_DAYS`. The remaining keyed suppression identity is deleted after `UNSUBSCRIBED_IDENTITY_RETENTION_DAYS`; erasure removes the raw address immediately.
- Email identity uses HMAC-SHA256 with the separate `IDENTITY_HASH_SECRET`; plain SHA-256 email hashes are never stored.
- Consent events are immutable until `CONSENT_EVENT_RETENTION_DAYS`, then scheduled retention deletes the keyed hash evidence.
- Erased subscription identity rows are deleted after `ERASED_IDENTITY_RETENTION_DAYS`.
- The outbox retries network errors, HTTP 429, and HTTP 5xx with bounded exponential backoff. Other HTTP 4xx responses and requests that reach `OUTBOX_MAX_ATTEMPTS` become terminal failures.
- The scheduled Worker retries only queued mail whose `next_attempt_at` has arrived and performs retention maintenance every 15 minutes.

## Configure

Wrangler 4.36 or newer is required for the rate-limit binding.

```sh
cd docs/oss/worker
cp wrangler.toml.example wrangler.toml
npx wrangler d1 create archastro-oss-interest
```

Put the returned D1 `database_id` in `wrangler.toml`. Set a unique numeric rate-limit `namespace_id`, verify the production route and retention variables, then apply the versioned migration:

```sh
npx wrangler d1 migrations apply archastro-oss-interest --local
npx wrangler d1 migrations apply archastro-oss-interest --remote
```

Store all secrets through Wrangler. `CONFIRMATION_SIGNING_SECRET` and `IDENTITY_HASH_SECRET` must be independent randomly generated values of at least 32 characters and must not be committed. Changing `IDENTITY_HASH_SECRET` changes identity linkage, so rotate it only with a deliberate data migration or after retained identity data has expired.

```sh
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put CONFIRMATION_SIGNING_SECRET
npx wrangler secret put IDENTITY_HASH_SECRET
```

Deploy the route and scheduled trigger:

```sh
npx wrangler deploy
```

Inspect structured, non-PII Worker telemetry with:

```sh
npx wrangler tail
```

For local development, add exact local origins such as `http://localhost:3404` to `ALLOWED_ORIGINS`; localhost is never trusted implicitly. Put local secret values in an untracked `.dev.vars` file.
