# Redline Chrome Web Store Release Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Redline 0.3.0 as a secure, local-first npm package and submission-ready Chrome Web Store extension with one-command automatic pairing.

**Architecture:** The standard-skill/runtime consolidation is merged. Next, reserve a stable Web Store extension ID. The fixed MV3 extension pairs to a detached loopback sidecar on port 7878 through a one-time fragment credential, stores a profile-specific capability token, and grants page access per site. The sidecar remains a zero-runtime-dependency CommonJS service with explicit protocol, auth, persistence, and idempotency modules.

**Tech Stack:** Node.js 18+ CommonJS, Manifest V3 Chrome APIs, `node:test`, Playwright for packaged-extension E2E, npm/Changesets, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-08-06-chrome-web-store-release-design.md`

---

## File Map

PR #16 and the release-branch baseline rebase are completed historical work.
PR #16 was rebase-merged as `77fc36c` through `07fc7d8`; this plan is based on
`07fc7d8`. Workers start at Task 3 and must not redo, push, or merge PR #16.
The paths below describe the merged runtime/skill layout plus files owned by
the remaining marketplace tasks.

- `runtime/server.js`: HTTP routing and process startup only.
- `runtime/lib/protocol.js`: health schema, protocol compatibility, typed errors.
- `runtime/lib/auth.js`: pure credential hashing and verification helpers.
- `runtime/lib/state-store.js`: sole owner of pairing, clients, clear generation, redlines, idempotency, screenshot journal, migration, and every state mutation.
- `config/extension-identity.json`: one public source of truth for the production extension ID and contributor-build public key.
- `runtime/bin/redline-sidecar`: fixed-port startup, collision detection, and lifecycle.
- `runtime/bin/redline-clear`: authenticated sidecar clear operation.
- `setup/redline-agent-setup.js`: setup orchestration, sidecar start, pairing window, browser launch.
- `setup/open-browser.js`: platform-specific URL opening with test injection points.
- `skills/redline/SKILL.md`: canonical portable skill with
  `metadata.source: https://github.com/ArchAstro/redline` provenance.
- `extension/manifest.json`: production, store-safe MV3 manifest.
- `extension/manifest.dev.json`: explicit unpacked/contributor manifest.
- `extension/background.js`: service-worker event routing.
- `extension/connection.js`: health, pairing, token persistence, compatibility state.
- `extension/permissions.js`: per-site grants, dynamic registrations, full visual mode.
- `extension/drafts.js`: seven-day draft/operation persistence and clear-generation binding.
- `extension/connect.js`: narrowly scoped loopback fragment reader.
- `extension/onboarding.html`, `extension/onboarding.js`, `extension/onboarding.css`: setup flow.
- `extension/popup.html`, `extension/popup.js`, `extension/popup.css`: connection/site/data controls.
- `extension/content.js`, `extension/content.css`: selection, comments, highlights, submission UI.
- `scripts/build-store-extension.js`: deterministic allowlisted ZIP build.
- `scripts/validate-store-extension.js`: manifest, secret, version, asset, and policy checks.
- `store/bootstrap/`: honest unpublished 0.0.1 ID-reservation extension.
- `store/listing/`: listing copy, privacy answers, test instructions, and asset checklist.
- `store/assets/`: source and exported store artwork.
- `tests/`: focused unit/integration tests matching each module.
- `tests/e2e/onboarding.test.js`: clean-profile extension-first and CLI-first onboarding.
- `tests/e2e/redline-loop.test.js`: packaged MV3 submission, pull, ack, edit, and refresh loop.
- `tests/e2e/recovery.test.js`: packaged MV3 permission, pairing, update, and recovery cases.
- `.github/workflows/ci.yml`: Node 18/current and Linux Playwright Chromium extension E2E gates.

### TDD Execution Rule

Every behavior named in a "Cover" or "Require" sentence is its own red/green
microcycle, not a batch implementation. For each behavior:

1. Add one descriptively named `node:test` case.
2. Run only that case with
   `node --test --test-name-pattern='<exact test name>' <test-file>` and observe
   the expected failure caused by missing behavior, not a syntax/setup error.
3. Implement the smallest production change that passes it.
4. Run the exact case again, then the full test file.
5. Continue to the next behavior; commit at the explicit task checkpoint.

For E2E work, each named journey is a separate test with its own clean profile.
Never write all tests in a task before beginning the first implementation.

## Chunk 1: Prerequisite And Store Identity

### Task 1 (Completed): Rebase and harden PR #16

Historical evidence only. PR #16 is merged; no worker should rerun these steps,
push its branch, or attempt to merge it again.

**Historical files already merged:**
- `skills/redline/SKILL.md`
- `README.md`
- `setup/redline-agent-setup.js`
- `package.json`
- `tests/setup-extension-status.test.js`
- `tests/public-release.test.js`
- `package-lock.json`

Historical review covered every path in the former PR branch diff.

- [x] **Step 1: Fetch and rebase the PR branch**

Historical command retained as evidence:

```bash
git fetch origin
git rebase origin/main
```

Historical result: the rebase retained main's release state and only the
remaining migration behavior.

- [x] **Step 2: Write ownership and preservation assertions**

Tests prove the Redline setup never invokes a skill manager, never writes under
`.agents/skills`, and preserves unrelated `redline` skill/plugin files
byte-for-byte on setup and uninstall. The shipped skill uses the merged
frontmatter format:

```yaml
metadata:
  author: ArchAstro
  source: https://github.com/ArchAstro/redline
```

- [x] **Step 3: Run the focused tests and verify failure**

Historical command retained as red/green evidence:

```bash
node --test tests/setup-extension-status.test.js tests/public-release.test.js
```

Historical red state: the focused tests failed until provenance and lifecycle
preservation were corrected.

- [x] **Step 4: Make the minimal PR #16 correction**

Merged result: skill installation is user-invoked and interactive. Redline
setup manages only Redline's local runtime/extension files; it does not call
`npx skills`, overwrite a same-name skill, or remove agent/plugin state. README
preserves the standard command without a forced/noninteractive overwrite flag.

- [x] **Step 5: Resolve the development advisory**

The merged package pins the development-only `js-yaml` resolutions to patched
releases accepted by `@changesets/cli`, adds no runtime dependency, and audits
cleanly. This advisory is resolved, not remaining release work.

- [x] **Step 6: Verify PR #16 completely**

Historical verification command retained as evidence:

```bash
npm ci
npm run check:syntax
npm run check:versions
npm test
npm audit
npm pack --dry-run
npx --yes --package=node@18 --call 'node --version && npm test'
```

Historical result: all checks passed, audit had zero known vulnerabilities,
the Node command reported `v18.x`, and the tarball contained one `runtime/`
plus one `skills/redline/` tree with no legacy plugin duplication.

- [x] **Step 7: Push, verify, and merge PR #16**

PR #16 was rebase-merged into `origin/main`. Its merged commits are `77fc36c`,
`b97ce58`, `7c99fd1`, and `07fc7d8`; `07fc7d8` is the baseline for subsequent
tasks.

### Task 2 (Completed): Rebase this release branch onto the merged runtime

Historical evidence only. The approved spec and plan were rebased without
conflicts; their blobs were unchanged by the rebase.

**Files:**
- No product files

- [x] **Step 1: Rebase**

Historical command retained as evidence:

```bash
git fetch origin
git rebase origin/main
```

Result: the approved spec/plan commits sit directly on merged baseline
`07fc7d831cacaa487e11e0f25e8d62afe3b600b7`.

- [x] **Step 2: Re-run baseline verification**

Historical verification command retained as evidence:

```bash
npm ci && npm run check:syntax && npm run check:versions && npm test && npm audit
```

Result on merged baseline `07fc7d8`: syntax and version checks passed, 69 tests
passed with zero failures/skips, and `npm audit` reported 0 vulnerabilities.

### Task 3: Build the unpublished ID-reservation ZIP

**Files:**
- Create: `store/bootstrap/manifest.json`
- Create: `store/bootstrap/index.html`
- Create: `store/assets/icons/icon-128.png`
- Create: `scripts/build-bootstrap-extension.js`
- Create: `config/extension-identity.json`
- Create: `runtime/lib/extension-identity.js`
- Create: `tests/bootstrap-package.test.js`
- Create: `tests/extension-identity.test.js`
- Modify: `tests/public-release.test.js`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Write the failing package test**

Assert that the bootstrap archive contains only `manifest.json`, `index.html`, and `icon-128.png`; uses manifest version 3 and extension version `0.0.1`; contains no permissions, host access, scripts, tokens, remote code, or claim of functionality.

- [ ] **Step 2: Run the test and verify failure**

```bash
node --test tests/bootstrap-package.test.js
```

Expected: FAIL because the builder and bootstrap source do not exist.

- [ ] **Step 3: Implement the deterministic bootstrap builder**

Add `npm run build:chrome-bootstrap`. The placeholder page must say that the item only reserves Redline's store identity and is not a functional release. The builder writes `dist/redline-chrome-bootstrap-0.0.1.zip` with stable ordering/timestamps and rejects extra files.

- [ ] **Step 4: Verify and commit**

```bash
npm run build:chrome-bootstrap
node --test tests/bootstrap-package.test.js
unzip -l dist/redline-chrome-bootstrap-0.0.1.zip
```

Expected: three allowlisted files and no secrets.

- [ ] **Step 5: Human dashboard checkpoint**

Upload the bootstrap ZIP as a new Chrome Web Store item without submitting it for review. Record the assigned item ID and public key. Never store dashboard credentials or private account data.

- [ ] **Step 6: Write the failing identity handoff test**

Require `config/extension-identity.json` to contain one non-placeholder 32-character Chrome extension ID and public key. Assert `runtime/lib/extension-identity.js` exposes only that ID to the production pairing allowlist, contributor manifest generation uses the matching public key, and the store manifest/package never embeds a private credential. Require `package.json.files` and `npm pack --dry-run --json` to include the public identity config, and run an installed-tarball smoke test proving `runtime/lib/extension-identity.js` resolves it outside the repository.

Run:

```bash
node --test tests/extension-identity.test.js tests/bootstrap-package.test.js tests/public-release.test.js
```

Expected: FAIL while the identity file still contains reservation placeholders.

- [ ] **Step 7: Insert and verify the public identity**

Put the dashboard's public ID/key in `config/extension-identity.json`, wire the runtime allowlist and contributor manifest generator to that single file, then run:

```bash
node --test tests/extension-identity.test.js tests/bootstrap-package.test.js tests/manifest.test.js tests/public-release.test.js
npm pack --dry-run --json
```

Expected: PASS; the runtime and contributor build agree on one stable ID.

- [ ] **Step 8: Commit the identity handoff**

```bash
git add -- config/extension-identity.json runtime/lib/extension-identity.js store/bootstrap/manifest.json store/bootstrap/index.html store/assets/icons/icon-128.png scripts/build-bootstrap-extension.js tests/bootstrap-package.test.js tests/extension-identity.test.js tests/public-release.test.js package.json package-lock.json
git commit -m "build: reserve Redline Chrome extension identity"
```

## Chunk 2: Sidecar Protocol, Pairing, And Persistence

### Task 4: Add protocol and fixed-port identity

**Files:**
- Create: `runtime/lib/protocol.js`
- Modify: `runtime/server.js`
- Modify: `runtime/bin/redline-sidecar`
- Create: `tests/protocol.test.js`
- Modify: `tests/sidecar-cli.test.js`
- Modify: `tests/sidecar.test.js`

- [ ] **Step 1: Write failing protocol and collision tests**

Cover the exact health shape, `Cache-Control: no-store`, product identity, package/protocol versions, capabilities, pairing status parsing, custom-port developer mode, fixed-port store mode, a non-Redline process on 7878, and a Redline helper with an incompatible protocol.

- [ ] **Step 2: Verify failure**

```bash
node --test tests/protocol.test.js tests/sidecar-cli.test.js tests/sidecar.test.js
```

Expected: FAIL on the current `{ok, port, db, screenshots}` health response and permissive collision detection.

- [ ] **Step 3: Implement the minimal protocol module**

Export immutable protocol constants, `healthPayload()`, and compatibility helpers. Health reveals no paths, tokens, or secrets. The sidecar launcher accepts an existing process only when product, protocol, and required capabilities identify compatible Redline.

- [ ] **Step 4: Verify and commit**

```bash
node --test tests/protocol.test.js tests/sidecar-cli.test.js tests/sidecar.test.js
git add -- runtime/lib/protocol.js runtime/server.js runtime/bin/redline-sidecar tests/protocol.test.js tests/sidecar-cli.test.js tests/sidecar.test.js
git commit -m "feat: version the local sidecar protocol"
```

Expected: PASS.

### Task 5: Implement one-time pairing and per-profile credentials

**Files:**
- Create: `runtime/lib/auth.js`
- Create: `runtime/lib/state-store.js`
- Modify: `runtime/server.js`
- Modify: `setup/redline-agent-setup.js`
- Create: `setup/open-browser.js`
- Create: `tests/auth-store.test.js`
- Create: `tests/pairing.test.js`
- Modify: `tests/sidecar.test.js`
- Modify: `tests/setup-extension-status.test.js`

- [ ] **Step 1: Write failing auth-store tests**

Cover owner-only files/directories, separate CLI credential, hashed ten-minute pairing secret, replacement invalidation, atomic one-time consume, distinct profile client IDs/tokens, timing-safe token checks, per-client revocation, all-browser revocation, and monotonically increasing clear generation. `state-store.js` is the only module allowed to write `state.json`, pairing state, or screenshot staging metadata.

- [ ] **Step 2: Write failing HTTP-boundary tests**

Cover exact `Host`, exact production extension `Origin`, `POST`, JSON content type, required Redline header, fixed non-reflective CORS, OPTIONS behavior, missing/opaque/other origins, guessed/replayed secrets, competing requests, CLI auth on every non-public endpoint, and rejection from non-target ports.

- [ ] **Step 3: Verify failure**

```bash
node --test tests/auth-store.test.js tests/pairing.test.js tests/sidecar.test.js
```

Expected: FAIL because pairing and client credentials do not exist and current CORS reflects any extension origin.

- [ ] **Step 4: Implement pairing state and routes**

Use `crypto.randomBytes(32)`, SHA-256 secret hashes, `crypto.timingSafeEqual`, one serialized mutation queue, atomic temp-file renames, `0700` directories, and `0600` files. Add typed `/pair` responses without logging request bodies or fragments. Production pairing accepts only the ID from `config/extension-identity.json`; contributor auth requires an explicit development mode.

- [ ] **Step 5: Implement setup browser flow**

`redline setup` starts/verifies the helper, creates a new pairing window, opens `http://127.0.0.1:7878/connect#pair=<secret>`, and opens the Web Store listing when the extension is absent. Browser opening is injected/stubbed in tests and uses `open` on macOS and `xdg-open` on Linux. Unsupported systems fail before collection begins.

- [ ] **Step 6: Verify and commit**

```bash
node --test tests/auth-store.test.js tests/pairing.test.js tests/sidecar.test.js tests/setup-extension-status.test.js
npm run check:syntax
git add -- runtime/lib/auth.js runtime/lib/state-store.js runtime/server.js setup/open-browser.js setup/redline-agent-setup.js tests/auth-store.test.js tests/pairing.test.js tests/sidecar.test.js tests/setup-extension-status.test.js
git commit -m "feat: pair Chrome profiles to the local sidecar"
```

Expected: PASS with no secret printed or persisted in plaintext.

### Task 6: Add atomic idempotent submissions and clear generations

**Files:**
- Modify: `runtime/lib/state-store.js`
- Modify: `runtime/server.js`
- Modify: `runtime/bin/redline-clear`
- Modify: `tests/sidecar.test.js`
- Modify: `tests/clear.test.js`
- Create: `tests/idempotency.test.js`
- Modify: `tests/extension-background.test.js`

- [ ] **Step 1: Write failing storage tests**

Cover serialized concurrent creates, `(client_id, operation_id)` uniqueness, canonical payload hashing, exact retry, typed `409 operation_conflict`, screenshot digest binding, atomic screenshot promotion, rollback cleanup, individual deletion, 30-day content-free tombstones, typed `410 operation_deleted`, clear-generation rejection, legacy `redlines.json` migration, and corrupt-store fail-closed behavior.

- [ ] **Step 2: Write failing clear tests**

Verify clear removes content/screenshots/tombstones/pairing state, revokes browser clients, advances generation, preserves the CLI administrative credential, and rejects a retained draft after re-pairing from another profile. Add races for clear versus pair/create/delete. A durable clear intent records the target generation and exact screenshot/staging deletion set before metadata changes; add crash injection before intent write, after intent fsync, after `state.json` replacement, during each deletion, and before intent removal.

- [ ] **Step 3: Verify failure**

```bash
node --test tests/idempotency.test.js tests/clear.test.js tests/sidecar.test.js
```

Expected: FAIL because current screenshot upload and redline creation are separate non-idempotent operations.

- [ ] **Step 4: Implement one submission transaction**

Replace separate browser screenshot upload with one authenticated `POST /redlines` payload containing optional PNG data plus operation ID/generation. Validate size/type before staging. Route pairing, create, update, delete, clear, and client revocation through the one `state-store.js` mutation queue. Persist a transaction intent, stage the screenshot, atomically replace `state.json`, promote the screenshot, and clear the intent. Clear writes and fsyncs its own intent with generation and deletion targets, atomically commits the empty next-generation metadata, deletes every target idempotently, fsyncs the containing directories, then removes the intent. Startup recovery completes any committed clear and resumes partial deletion before accepting requests; a pre-commit clear intent rolls back without reporting success. The clear operation takes the same queue, so no pairing or content mutation can interleave with it.

- [ ] **Step 5: Verify and commit**

```bash
node --test tests/idempotency.test.js tests/clear.test.js tests/sidecar.test.js tests/extension-background.test.js
git add -- runtime/lib/state-store.js runtime/server.js runtime/bin/redline-clear tests/idempotency.test.js tests/clear.test.js tests/sidecar.test.js tests/extension-background.test.js
git commit -m "feat: make Redline submissions idempotent"
```

Expected: PASS, including every crash/race injection.

## Chunk 3: Store Extension Experience

### Task 7: Create store-safe connection and onboarding

**Files:**
- Create: `extension/connection.js`
- Create: `extension/connect.js`
- Create: `extension/onboarding.html`
- Create: `extension/onboarding.js`
- Create: `extension/onboarding.css`
- Modify: `extension/background.js`
- Modify: `extension/manifest.json`
- Create: `extension/manifest.dev.json`
- Modify: `setup/redline-agent-setup.js`
- Create: `tests/extension-connection.test.js`
- Create: `tests/onboarding.test.js`
- Modify: `tests/manifest.test.js`

- [ ] **Step 1: Write failing manifest and connection tests**

Assert a valid MV3 manifest with `storage`, `activeTab`, `scripting`, fixed `http://127.0.0.1:7878/*`, optional HTTP/HTTPS host patterns, no static general-page content script, no `auth.js`, no remote code, no `externally_connectable`, and an exact connect-page script. Cover missing helper, active window, expiry, malformed health, protocol mismatch, successful pair, stale token, and repair copy.

- [ ] **Step 2: Write failing fragment-boundary tests**

Require top-frame sender, `sender.id === chrome.runtime.id`, exact parsed connect URL, packaged script identity, immediate `history.replaceState`, one message only, and rejection from other tabs/frames/extensions.

- [ ] **Step 3: Write failing disclosure and consent tests**

Require onboarding, before `POST /pair` or any site-enable action, to name selected text/comments, URL/title/DOM context, optional screenshots, local sidecar and Chrome draft retention, seven-day draft expiry, deletion controls, no ArchAstro telemetry, and possible transfer to the user's configured coding-model provider. Assert fragment discovery may retain the one-time secret only in `chrome.storage.session`, never calls `/pair` before consent, and discards the secret on decline/expiry. Pairing, site enablement, and content handling all remain blocked until affirmative consent; enabling a site alone creates no draft.

- [ ] **Step 4: Verify failure**

```bash
node --test tests/manifest.test.js tests/extension-connection.test.js tests/onboarding.test.js
```

Expected: FAIL against injected global config, static localhost scripts, and the missing pre-enable disclosure gate.

- [ ] **Step 5: Implement connection state machine**

Store only sidecar port, profile client ID/token, clear generation, protocol metadata, and setup state. Poll only while onboarding is visible, use `Cache-Control: no-store` responses, clear the fragment immediately, retain an unconsumed secret only in `chrome.storage.session`, and preserve drafts on recoverable connection errors.

- [ ] **Step 6: Implement both install orders and consent gate**

On `runtime.onInstalled`, query exact open connect tabs and inject the packaged fragment reader. When extension-first, show one copyable command. When CLI-first, stage the secret from the existing fragment tab without calling `/pair`. Show the prominent disclosure first; affirmative consent triggers `/pair` and then transitions to the site-enable action. Decline deletes the session secret, leaves Redline unpaired and disconnected from page content, and provides uninstall/clear guidance.

- [ ] **Step 7: Preserve explicit contributor mode**

Generate unpacked development output only from `manifest.dev.json` plus injected `auth.js`. The store ZIP must never include either. Existing contributors retain custom `REDLINE_PORT`; store pairing remains fixed at 7878.

- [ ] **Step 8: Verify and commit**

```bash
node --test tests/manifest.test.js tests/extension-connection.test.js tests/onboarding.test.js
npm run check:syntax
git add -- extension/connection.js extension/connect.js extension/onboarding.html extension/onboarding.js extension/onboarding.css extension/background.js extension/manifest.json extension/manifest.dev.json setup/redline-agent-setup.js tests/extension-connection.test.js tests/onboarding.test.js tests/manifest.test.js
git commit -m "feat: pair the store extension locally"
```

Expected: PASS, including proof that no draft/content collection occurs before consent.

### Task 8: Implement per-site permissions and full visual mode

**Files:**
- Create: `extension/permissions.js`
- Modify: `extension/background.js`
- Modify: `extension/popup.html`
- Modify: `extension/popup.js`
- Create: `extension/popup.css`
- Modify: `extension/content.js`
- Create: `tests/extension-permissions.test.js`
- Modify: `tests/popup.test.js`
- Modify: `tests/content-reconciliation.test.js`

- [ ] **Step 1: Write failing permission tests**

Cover explicit-port origin patterns, one-site grant, persistent dynamic registration, restart reconciliation, denied/revoked permission, disable-site, disable-everywhere, restricted URL messaging, full visual warning/grant, no all-sites content registration, broad-grant revocation, and preservation of per-site registrations.

- [ ] **Step 2: Verify failure**

```bash
node --test tests/extension-permissions.test.js tests/popup.test.js tests/content-reconciliation.test.js
```

Expected: FAIL because current manifest statically injects localhost and setup rewrites broad access.

- [ ] **Step 3: Implement permission controller**

Treat `chrome.permissions` as authoritative. Persist exact enabled origins, register scripts only for enabled origins, reconcile on service-worker startup, and remove stale registrations/preferences on revocation. Full visual mode grants `<all_urls>` for screenshot capture only.

- [ ] **Step 4: Implement compact popup states**

Provide connected/disconnected status, **Enable Redline on this site**, **Disable on this site**, full visual toggle with disclosure, pending list, disconnect, and clear-data controls. Keep existing delete/refresh behavior and use clear typed errors instead of `Failed to fetch`.

- [ ] **Step 5: Verify and commit**

```bash
node --test tests/extension-permissions.test.js tests/popup.test.js tests/content-reconciliation.test.js tests/extension-background.test.js
git add -- extension/permissions.js extension/background.js extension/popup.html extension/popup.js extension/popup.css extension/content.js tests/extension-permissions.test.js tests/popup.test.js tests/content-reconciliation.test.js
git commit -m "feat: grant Redline access per site"
```

Expected: PASS.

### Task 9: Persist drafts and submit complete operations

**Files:**
- Create: `extension/drafts.js`
- Modify: `extension/content.js`
- Modify: `extension/background.js`
- Modify: `tests/extension-background.test.js`
- Create: `tests/extension-drafts.test.js`

- [ ] **Step 1: Write failing draft tests**

Cover random operation ID creation before first attempt, same-ID retry, optional screenshot in the same operation, definitive-success deletion, seven-day expiry, extension update/restart, explicit discard, operation conflict, data-cleared response, and no duplicate redline after a lost response.

- [ ] **Step 2: Verify failure**

```bash
node --test tests/extension-drafts.test.js tests/extension-background.test.js
```

Expected: FAIL because current drafts are not durable and screenshots upload separately.

- [ ] **Step 3: Implement draft store and submission queue**

Persist drafts in `chrome.storage.local`, bind generation/client identity, capture screenshots only after full visual consent, submit one idempotent payload, and remove only on definitive success/discard. Keep visible highlight reconciliation tied to pending server IDs so acknowledged or edited feedback disappears correctly.

- [ ] **Step 4: Implement disconnect and clear**

Disconnect revokes the current browser token and clears current-profile drafts/connection state. Clear confirms, calls the authenticated all-data endpoint, clears current-profile storage and permissions, and explains the multi-profile boundary.

- [ ] **Step 5: Verify and commit**

```bash
node --test tests/extension-drafts.test.js tests/extension-background.test.js tests/content-reconciliation.test.js tests/idempotency.test.js tests/clear.test.js
git add -- extension/drafts.js extension/content.js extension/background.js tests/extension-drafts.test.js tests/extension-background.test.js
git commit -m "feat: preserve and retry Redline drafts"
```

Expected: PASS.

## Chunk 4: Packaging, Policy, Assets, And Release Proof

### Task 10: Build and validate the production ZIP

**Files:**
- Create: `scripts/build-store-extension.js`
- Create: `scripts/validate-store-extension.js`
- Create: `tests/store-package.test.js`
- Modify: `setup/sync-versions.js`
- Modify: `tests/version-sync.test.js`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Write failing package-contract tests**

Assert deterministic file order/timestamps, exact allowlist, version sync, icon/page existence, valid explicit-port match pattern, no placeholders/secrets/dev manifest/auth file/internal paths/source maps/remote code, and no localhost or broad permission outside optional permissions.

- [ ] **Step 2: Verify failure**

```bash
node --test tests/store-package.test.js tests/version-sync.test.js
```

Expected: FAIL because no production builder exists.

- [ ] **Step 3: Implement build and validation scripts**

Add `npm run check:chrome-store` and `npm run build:chrome-store`. Derive both manifest and archive versions from `package.json`, producing `dist/redline-chrome-${npm_package_version}.zip`; fail closed on any unexpected file, version disagreement, or public-ID mismatch. Do not hard-code 0.3.0 before the Changesets version PR materializes it.

- [ ] **Step 4: Verify and commit**

```bash
npm run check:chrome-store
npm run build:chrome-store
artifact="dist/redline-chrome-$(node -p "require('./package.json').version").zip"
shasum -a 256 "$artifact"
unzip -l "$artifact"
git add -- scripts/build-store-extension.js scripts/validate-store-extension.js tests/store-package.test.js setup/sync-versions.js tests/version-sync.test.js package.json package-lock.json
git commit -m "build: produce a deterministic store extension"
```

Expected: stable checksum across two clean builds and an allowlisted archive.

### Task 11: Produce truthful listing and privacy materials

**Files:**
- Create: `store/listing/description.md`
- Create: `store/listing/privacy.md`
- Create: `store/listing/privacy-dashboard.md`
- Create: `store/listing/reviewer-instructions.md`
- Create: `store/listing/release-checklist.md`
- Modify: `README.md`
- Modify: `SECURITY.md`
- Modify: `CONTRIBUTING.md`
- Create: `tests/store-listing.test.js`
- Create: `scripts/validate-privacy-url.js`
- Create in a separate `firstlanding` worktree/PR: `services/archastro_website/app/oss/redline/privacy/page.tsx`
- Modify in that PR: `services/archastro_website/__tests__/app/legal-pages.test.tsx`
- Modify in that PR: `services/archastro_website/__tests__/app/sitemap.test.ts`

- [ ] **Step 1: Write failing consistency tests**

Require one purpose, exact handled-data categories, local-only/no-telemetry statement, coding-provider disclosure, per-site/full-visual distinction, macOS/Linux support, support/repository/homepage URLs, setup command, deletion behavior, and no unpacked-install directions in end-user quickstart.

- [ ] **Step 2: Verify failure**

```bash
node --test tests/store-listing.test.js tests/public-release.test.js
```

Expected: FAIL against current unpacked-extension guidance.

- [ ] **Step 3: Write concise public copy**

Keep the primary message: select webpage text, leave a precise fix, pull it into a coding agent. State exactly what is local, when a model provider may receive selected content, and what broad access enables. Avoid marketing claims not demonstrated by the product.

- [ ] **Step 4: Add maintainer submission instructions**

Document dashboard fields, deferred publishing, privacy declarations, reviewer test steps, ownership sharing, artifact checksum recording, and the rule that approval does not automatically promote to production.

- [ ] **Step 5: Publish the extension-specific privacy route separately**

Create a small `firstlanding` PR for `https://oss.archastro.ai/redline/privacy`, reusing the existing ArchAstro legal-page layout and the reviewed Redline privacy copy. Add route rendering, metadata, sitemap, and agent-readable structured-content tests. Merge only after that repository's CI is green; do not trigger or approve a production promotion automatically.

- [ ] **Step 6: Verify the public policy is deployed**

After the approved ArchAstro website production deployment, run the same validator used by the final submission gate:

```bash
node scripts/validate-privacy-url.js https://oss.archastro.ai/redline/privacy
```

The validator fetches HTTP 200 and asserts each disclosure independently: selected text/comments, URL/title/DOM context, optional screenshots, local/Chrome storage, retention, deletion, no ArchAstro telemetry, coding-provider transfer, and contact information. One matching phrase cannot satisfy another. Record this exact URL in the listing and dashboard checklist. Web Store submission is blocked until every assertion passes.

- [ ] **Step 7: Verify and commit Redline copy**

```bash
node --test tests/store-listing.test.js tests/public-release.test.js
node scripts/validate-privacy-url.js https://oss.archastro.ai/redline/privacy
git add -- store/listing/description.md store/listing/privacy.md store/listing/privacy-dashboard.md store/listing/reviewer-instructions.md store/listing/release-checklist.md README.md SECURITY.md CONTRIBUTING.md scripts/validate-privacy-url.js tests/store-listing.test.js
git commit -m "docs: prepare Chrome Web Store disclosures"
```

Expected: PASS with the deployed policy URL referenced consistently.

### Task 12: Create real listing assets

**Files:**
- Create/modify: `store/assets/icons/icon-{16,32,48,128}.png`
- Create: `store/assets/screenshots/*.png`
- Create: `store/assets/promo-small-440x280.png`
- Optional create: `store/assets/promo-marquee-1400x560.png`
- Create: `scripts/validate-store-assets.js`
- Create: `tests/store-assets.test.js`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Add dimension/content validation**

Require PNG dimensions, nonblank pixels, readable contrast, no duplicate screenshots, and no strings matching local usernames, private paths, tokens, customer domains, or internal repository names.

- [ ] **Step 2: Capture actual product states**

Use a clean demo page and clean terminal/profile to capture at least three real 1280x800 states: enable site, submit feedback, and agent pull/ack loop. Do not fabricate terminal output. Export a restrained ArchAstro/Redline icon and 440x280 promo tile from the real visual system.

- [ ] **Step 3: Visually inspect every asset**

Open each exported asset at native resolution. Verify legibility, framing, no accidental desktop bleed, no private data, and consistency with the shipped UI.

- [ ] **Step 4: Verify and commit**

```bash
npm run check:store-assets
node --test tests/store-assets.test.js
git add -- store/assets/icons/icon-16.png store/assets/icons/icon-32.png store/assets/icons/icon-48.png store/assets/icons/icon-128.png store/assets/screenshots/enable-site.png store/assets/screenshots/submit-feedback.png store/assets/screenshots/agent-pull-ack.png store/assets/promo-small-440x280.png scripts/validate-store-assets.js tests/store-assets.test.js package.json package-lock.json
if test -f store/assets/promo-marquee-1400x560.png; then git add -- store/assets/promo-marquee-1400x560.png; fi
git commit -m "docs: add real Chrome Web Store assets"
```

Expected: PASS with at least three compliant real screenshots.

### Task 13: Add packaged-extension E2E and release gates

**Files:**
- Create: `tests/e2e/onboarding.test.js`
- Create: `tests/e2e/redline-loop.test.js`
- Create: `tests/e2e/recovery.test.js`
- Create: `tests/e2e/fixtures/demo-page.html`
- Create: `tests/e2e/helpers.js`
- Create: `tests/workflows.test.js`
- Create: `.changeset/chrome-web-store.md`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Write the failing onboarding E2E**

Launch the actual built extension in a clean persistent profile using
Playwright's bundled Chromium with a real spawned sidecar. Cover extension-first
and CLI-first setup, prominent disclosure/consent, site permission, and proof
that no draft or website content exists before consent.

Run:

```bash
node --test tests/e2e/onboarding.test.js
```

Expected: FAIL because the packaged-extension helper is not wired.

- [ ] **Step 2: Implement hermetic browser helpers and pass onboarding**

Use temporary HOME/REDLINE_DIR/profile directories and allocated demo-page ports while retaining sidecar 7878. Capture browser console, service-worker errors, and screenshots on failure. Always stop spawned processes and delete temporary data.

Run the onboarding test again; expected PASS.

- [ ] **Step 3: Write, fail, and pass the redline-loop E2E**

Cover text-only submission, full-visual screenshot submission, pull, ack, edited-page refresh, and the disappearance of the old highlight. First run must FAIL before the missing behavior is wired; after the smallest implementation correction, rerun until PASS.

```bash
node --test tests/e2e/redline-loop.test.js
```

- [ ] **Step 4: Write, fail, and pass recovery E2E**

Cover denied/revoked permission, stopped helper, stale token, protocol mismatch, disconnect/re-pair, lost submission response, update/restart draft survival, and clear-data rejection of an old draft from a second profile.

```bash
node --test tests/e2e/recovery.test.js
```

Expected: FAIL before recovery wiring; PASS after the minimal fixes.

- [ ] **Step 5: Add and test Linux CI plus npm release gates**

Make CI run unit/package checks on Node 18 and current Node and packaged-extension E2E under `xvfb-run` with Playwright's bundled Chromium on Ubuntu. Branded stable Chrome no longer accepts Playwright's extension side-loading flags, so it is a separate manual gate. Make `.github/workflows/release.yml` run syntax, versions, store package, assets, listing/policy tests, Chromium E2E, audit, and tarball validation before `changesets/action` can version or publish. Pin Action SHAs, Playwright, and its Chromium revision; keep `npm ci` lockfile-strict.

`tests/workflows.test.js` must fail if the release job omits any gate or can reach `changesets/action` without their success.

```bash
node --test tests/workflows.test.js
```

Expected: FAIL against the old release workflow, then PASS after both workflows are updated.

- [ ] **Step 6: Add the release Changeset**

Add a Changeset for the store-install, pairing, permissions, and reliability work. PR #16 already contributes the minor release classification; together they must resolve to 0.3.0 when the Changesets version PR is materialized.

- [ ] **Step 7: Verify and commit the E2E/release gates**

```bash
npm run build:chrome-store
npm run test:e2e:chrome
node --test tests/workflows.test.js
git add -- tests/e2e/onboarding.test.js tests/e2e/redline-loop.test.js tests/e2e/recovery.test.js tests/e2e/fixtures/demo-page.html tests/e2e/helpers.js tests/workflows.test.js .github/workflows/ci.yml .github/workflows/release.yml .changeset/chrome-web-store.md package.json package-lock.json
git commit -m "test: gate the Redline browser release"
```

Expected: all packaged-extension journeys pass with no browser or service-worker errors.

- [ ] **Step 8: Run the complete implementation matrix**

```bash
npm ci
npm run check:syntax
npm run check:versions
npm run check:chrome-store
npm run check:store-assets
npm test
npm run test:e2e:chrome
npm audit
npm pack --dry-run
npx --yes --package=node@18 --call 'node --version && npm test'
```

Expected: every command passes, the final command reports `v18.x`, and no unexpected tarball/ZIP files exist.

- [ ] **Step 9: Perform macOS and Linux clean-profile verification**

Use current branded stable Chrome manually on macOS and Linux, loading the exact built package through Chrome's developer-mode UI or an unpublished trusted-tester item rather than Playwright flags. Repeat both install orders and the edit/ack/refresh loop on localhost and one normal HTTPS site. Save command output, Chrome version, artifact checksum, and failure screenshots as release evidence. Inspect `chrome://extensions` and service-worker logs for errors.

- [ ] **Step 10: Adversarial review and implementation PR**

Run security/privacy and user-journey reviewers over the full diff and built ZIP. Rebase onto `origin/main`, re-run the complete matrix, push one non-stacked implementation PR, and wait for green CI and approval. Do not publish npm, submit the store item, or promote any website deployment automatically.

### Task 14: Materialize 0.3.0 and submit the verified artifact

**Files:**
- Changesets-generated: `package.json`
- Changesets-generated: `package-lock.json`
- Changesets-generated: `CHANGELOG.md`
- Changesets-generated/removed: `.changeset/*.md`

- [ ] **Step 1: Merge the implementation PR only when green**

Confirm the full release matrix ran on the final rebased commit and the public privacy policy returns HTTP 200. Rebase-merge the implementation PR; do not merge the Changesets version PR yet.

- [ ] **Step 2: Review the Changesets version PR**

Require version `0.3.0` in `package.json`, lockfile, extension manifest, ZIP filename, and changelog. Run the complete matrix on that exact version commit. Reject any version drift or omitted gate.

- [ ] **Step 3: Explicit npm publication checkpoint**

Merging the approved Changesets version PR causes the existing release workflow to publish npm after all gates. Do this only after explicit human approval. Verify npm provenance, public package contents, and the GitHub release before claiming npm 0.3.0 is live.

- [ ] **Step 4: Build the final Chrome artifact from the released commit**

```bash
git fetch origin --tags
: "${RELEASE_COMMIT:?Set RELEASE_COMMIT to the reviewed, non-placeholder 0.3.0 release commit SHA}"
git cat-file -e "${RELEASE_COMMIT}^{commit}"
RELEASE_VERSION="$(git show "${RELEASE_COMMIT}:package.json" | node -e 'let s=""; process.stdin.on("data", c => s += c); process.stdin.on("end", () => process.stdout.write(JSON.parse(s).version))')"
test "$RELEASE_VERSION" = "0.3.0"
git checkout --detach "$RELEASE_COMMIT"
npm ci
npm run check:chrome-store
npm run build:chrome-store
npm run test:e2e:chrome
node scripts/validate-privacy-url.js https://oss.archastro.ai/redline/privacy
shasum -a 256 dist/redline-chrome-0.3.0.zip
```

Expected: the ZIP is version 0.3.0, matches the public extension identity, and passes the same E2E suite as the release commit.

- [ ] **Step 5: Dashboard submission checkpoint**

Upload that exact ZIP, paste the reviewed listing/privacy material, upload validated assets, enter `https://oss.archastro.ai/redline/privacy`, choose deferred publishing, and submit for review. Record the ZIP checksum, dashboard version, submission timestamp, and review status. Do not click publish automatically after approval.
