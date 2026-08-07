# Redline Chrome Web Store Release Design

**Date:** 2026-08-06
**Target:** Redline 0.3.0
**Status:** Approved

## Goal

Make the Chrome Web Store extension the normal Redline installation path while preserving Redline's local-first privacy model. A new user should install the extension, run one terminal command, and begin leaving redlines without loading an unpacked extension, copying a token, selecting an extension directory, or manually configuring a port.

The npm and GitHub release can launch on schedule while Chrome review is pending. The Web Store submission will use deferred publishing so approval does not publish unexpectedly.

## User Journey

The primary journey is:

1. Install Redline from the Chrome Web Store.
2. The extension opens its setup page.
3. Run `npx --yes @archastro/redline setup`.
4. The extension detects the local sidecar and shows the data-handling disclosure.
5. Accept the disclosure; pairing then completes automatically.
6. Click **Enable Redline on this site**.
7. Select page text, submit feedback, and pull it into a coding agent.

Per-site mode captures selected text, comments, URL/title, and nearby DOM context. Screenshots are off in this mode. A separately disclosed **Enable full visual mode** action requests broad optional website access and enables visible-tab screenshots.

Both installation orders must work:

- Extension first: the setup page waits for the local helper and displays the one command to run.
- CLI first: setup starts a bounded pairing window and opens the Web Store listing; installing the extension stages the secret, shows the disclosure, and completes pairing automatically after consent.

The unpacked extension remains available only as a contributor and development fallback.

## Architecture

### Store Extension

The published extension is a fixed Manifest V3 package. It contains no machine-specific port, capability token, generated authentication file, remote executable code, or developer-only instructions.

The extension stores these values in `chrome.storage.local` after pairing:

- sidecar loopback port
- sidecar capability token
- pairing and protocol version metadata
- enabled site origins

The extension treats missing, stopped, stale, or incompatible sidecars as recoverable states. It shows one exact repair command instead of generic fetch errors or `chrome://extensions` guidance.

### Local Pairing

`redline setup` starts a detached sidecar, creates an unguessable one-time pairing secret and a pairing window that expires after ten minutes, opens the browser flow, and returns after the sidecar health check passes. The sidecar stores only a hash of the secret in owner-only pairing state under `~/.redline`, so the window survives the `npx` process exiting but not its expiry or successful use.

The store workflow uses fixed loopback port `7878`. Setup fails with an exact diagnostic if the port is occupied by anything whose health response does not identify itself as a compatible Redline sidecar. `REDLINE_PORT` remains available for contributor and unpacked workflows, but custom ports are not auto-discovered by the 0.3 store extension.

The secret is delivered without copying or typing. The CLI opens
`http://127.0.0.1:7878/connect#pair=<secret>` directly, so the fragment is
retained by Chrome but is never sent in an HTTP request or written to sidecar
logs. The loopback page contains no script that can read the fragment. The
official extension's narrowly matched connect-page content script reads the
fragment, removes it from the address bar with `history.replaceState`, and
immediately hands it to the service worker.

- If the extension is already installed, the declared connect-page content script discovers and stages the secret in ephemeral `chrome.storage.session` as soon as the CLI opens the URL. The onboarding disclosure is shown before any request to `POST /pair`; affirmative consent completes pairing, while decline or expiry deletes the staged secret.
- If the CLI runs first, setup opens both the connect page and the Web Store listing. On installation, the extension scans for the exact loopback connect-page URL and injects its packaged fragment reader using its fixed loopback permission. It stages the secret, shows the same disclosure, and completes pairing only after affirmative consent. If the tab was closed, rerunning setup creates a fresh secret and reopens the flow.

The service worker accepts that message only when `sender.id` equals
`chrome.runtime.id`, the sender is the top frame, and the parsed sender URL has
the exact scheme, host, port, and path
`http://127.0.0.1:7878/connect`. The manifest declares no
`externally_connectable` webpage access. These checks prevent another page or
extension from invoking the internal pairing message handler; the one-time
secret remains the credential presented to the sidecar.

During the pairing window, `POST /pair` may mint a distinct capability token
and stable client identity for that Chrome profile only when all of these
conditions hold:

- the request presents the unguessable one-time secret
- the request originates from the official Chrome Web Store extension ID
- the request has an exact `Origin: chrome-extension://<official-id>` header
- the request uses JSON and a Redline-specific custom request header, forcing a CORS preflight
- the request uses an allowed loopback host
- the pairing window has not expired
- the pairing window has not already been consumed
- the requested protocol major version matches

The pairing secret, extension origin, loopback host, custom header, expiry, and atomic one-time consume are independent checks. Requests with a missing, opaque, or different origin fail even with the secret. The loopback connect page never returns the capability token and does not include executable remote code.

Pairing CORS is a fixed allowlist: only the production extension origin,
`POST`, `Content-Type`, and the named Redline header are allowed. The sidecar
never reflects request origins and never returns wildcard CORS headers. It
also validates the exact `Host: 127.0.0.1:7878` value for store pairing.

A malicious process already running as the same local user is outside this boundary: it can read Redline's owner-only auth-token file directly and is not defended against by browser pairing. Tests still cover spoofed browser origins, missing secrets, guessed secrets, replay, and races from untrusted webpages or other extensions.

Every non-health, non-pairing sidecar endpoint requires a capability token, including CLI calls. The CLI retains a separate owner-only administrative credential; browser pairing never exposes or reuses it. Each paired Chrome profile receives its own revocable token and stable client ID, and operation IDs are scoped to that client ID. Pairing does not create an ArchAstro account, contact an ArchAstro service, or send page data off the machine.

The setup page polls the fixed health endpoint while visible. If no pairing window appears within ten minutes, it stops polling and shows the same `npx --yes @archastro/redline setup` repair command. Running setup again invalidates any prior unused secret and creates a new one. A consumed secret is not reusable. Each additional Chrome profile must run setup again and consumes its own pairing window; simultaneous requests race atomically and only one succeeds.

Extension-ID bootstrapping uses two unpublished packages:

1. Upload a valid bootstrap ZIP at manifest version `0.0.1`. It contains only an honest setup placeholder and is never submitted for review or published.
2. Read the assigned item ID and public key from the Developer Dashboard.
3. Add the exact production ID to the sidecar pairing allowlist and the manifest public `key` to contributor builds for stable-ID testing.
4. Build and upload the functional 0.3.0 package as a higher version.

Development builds continue to use the existing injected-token path or an explicit development pairing flag, never the production pairing endpoint.

### Protocol Compatibility

`GET /health` returns no secret and uses this minimum shape:

```json
{
  "product": "redline",
  "package_version": "0.3.0",
  "protocol": { "major": 1, "minor": 0 },
  "capabilities": ["pairing-v1", "idempotent-redlines-v1"],
  "pairing": { "available": true, "expires_at": "2026-08-06T20:10:00Z" }
}
```

Protocol major versions must match. Unknown fields and higher minor versions are ignored. The extension declares the capabilities required by each operation and fails closed when one is missing. If the extension requires a newer helper, it displays `npx --yes @archastro/redline setup`. If the helper requires a newer extension, it requests a Web Store update check and tells the user to update Redline in Chrome. Store and npm releases may arrive at different times without producing silent authentication failures.

`pairing` is non-secret status. It reports `available: false` without an expiry
when no window exists. Health responses use `Cache-Control: no-store`; the
extension polls only while onboarding is visible, stops at the reported expiry
or after ten minutes, and treats absent, malformed, or regressing expiry data
as unavailable. Public health CORS uses the same fixed production-extension
origin and never permits arbitrary websites to read pairing status.

### Idempotent Submission

The content script assigns every draft a cryptographically random operation ID before the first submission attempt. The complete text-and-optional-screenshot submission uses that one operation ID. Sidecar mutations are serialized, and the stored operation record is unique within the authenticated browser client. It binds the ID to a canonical payload hash, including the screenshot digest when present. An exact retry returns the original result; reuse with changed content returns a typed `409 operation_conflict` and never changes the original record or screenshot.

Screenshot files are staged under the operation ID and promoted atomically
with the redline record, so concurrent first submissions, lost responses, and
retries cannot create duplicate or orphaned files. Deleting a redline leaves a
minimal operation tombstone for 30 days and returns typed `410
operation_deleted` to a late retry. The tombstone contains no page content.
Each submission also carries the sidecar's current clear generation, issued at
pairing. The confirmed clear-data action removes redlines, screenshots,
tombstones, and pairing state; revokes every browser client token; and
atomically advances that generation. Re-pairing cannot submit a retained draft
from an older generation, which receives typed `410 data_cleared`. Generation
rejection records contain no page content and are retained longer than the
seven-day maximum draft lifetime. The draft, operation ID, generation, and any
temporary screenshot remain in extension storage until a definitive success
response or explicit discard, and expire automatically after seven days.

## Permissions

The initial store package requests only permissions needed for the visible user workflow:

- `storage` for local connection and site preferences
- `activeTab` and `scripting` for user-initiated activation
- host access to `http://127.0.0.1:7878/*` for the local sidecar
- optional HTTP/HTTPS host access, granted at runtime

The default action is **Enable Redline on this site**, which requests only the current scheme, host, and explicit port using Chrome's match-pattern syntax. On grant, the service worker creates a persistent dynamic content-script registration for that origin with `chrome.scripting.registerContentScripts`. Chrome's granted permissions are authoritative; startup reconciles registrations against `chrome.permissions`, and revocation unregisters scripts and removes stale preferences.

**Disable Redline on this site** unregisters that origin and removes its permission. **Disable everywhere** removes every Redline dynamic registration and optional host grant. Granted origins are reactivated after refresh without requesting access again. Restricted Chrome pages and unsupported URLs receive a clear explanation.

**Enable full visual mode** is an explicit advanced action. It shows Chrome's broad-access warning, explains why screenshots need it, and requests `<all_urls>` optional access. Broad access permits visible-tab screenshot capture only when the user submits from a separately enabled site; it does not register content scripts on every site. Per-site registrations remain authoritative and least-privilege by default. Startup reconciles a revoked broad grant by disabling screenshots without changing per-site registrations. Per-site mode never promises or silently attempts screenshots. Disabling full visual mode removes broad access, preserves separately granted per-site registrations, and stops screenshot capture.

## Privacy And Disclosure

Redline may handle selected text, comments, page URL and title, nearby DOM context, and, only in full visual mode, a visible-tab screenshot. Website-content handling begins when the user invokes Redline on an enabled site; persistence begins when the draft is created or submitted. Submitted data is stored under `~/.redline` on the user's computer. In-progress drafts and temporary screenshots are stored in `chrome.storage.local` for at most seven days. Neither is sent to ArchAstro. Submitted data remains until the user deletes individual feedback or runs the explicit clear-data action. The initial store release includes no ArchAstro analytics or telemetry.

Before pairing and collection, the extension UI prominently explains what Redline handles, where it is stored, and that coding agents may read it when the user invokes the Redline skill. A configured coding agent may transmit that selected data to its own model provider under that tool's terms. The user takes an affirmative action to connect and enable a site. Full visual mode has a separate affirmative disclosure for screenshots and broad website access.

The Web Store Privacy tab conservatively declares handling of website content, user-provided content, and the URL/title metadata necessary for redlined pages. It certifies limited use, no advertising, no sale or unrelated transfer, and no human access by ArchAstro. Pairing credentials remain local and are never disclosed publicly.

The following surfaces must remain consistent:

- extension onboarding and popup
- Chrome Web Store description and Privacy tab
- public privacy policy and Limited Use disclosure
- README and security documentation
- actual extension and sidecar behavior

## Release Packaging

A deterministic build command creates a ZIP containing only the store extension's required files. The build fails when:

- placeholders or machine secrets remain
- the manifest version disagrees with the package version
- required icons or pages are missing
- unexpected files enter the archive
- syntax or policy-oriented static checks fail

The release workflow retains npm provenance and existing package validation. Chrome publishing is initially manual and deferred. API-based publishing can follow after the first item is approved and ownership is shared with additional ArchAstro publisher admins.

## Store Listing

The listing presents one purpose: turn precise webpage feedback into actionable coding-agent input.

Required materials:

- 128x128 store icon plus manifest icon sizes
- at least three real 1280x800 screenshots showing activation, a submitted redline, and the agent pull loop
- 440x280 small promotional tile
- short real product video hosted on YouTube if required by the dashboard
- detailed description, support URL, repository URL, homepage, category, language, and test instructions
- extension-specific privacy policy URL

Assets must show real product behavior. They must not contain internal repository paths, customer data, credentials, fabricated terminal output, or unreadably scaled UI.

## Prerequisite Work

PR #16, the standard agent-skill migration, was rebase-merged as `77fc36c`
through `07fc7d8` before marketplace implementation. It removed duplicated
plugin packages and made the portable skill explicitly user-managed through
the standard interactive skills CLI. The canonical skill carries
`metadata.source: https://github.com/ArchAstro/redline` provenance, while
Redline setup never invokes a skill manager or reads, writes, migrates, or
removes global skill/plugin state. Tests preserve an unrelated same-name skill
and legacy plugin files byte-for-byte across setup and uninstall.
Redline-managed runtime and extension artifacts remain confined to the npm
package and `~/.redline`; their setup, update, and removal paths operate only
inside those owned roots and preserve submitted feedback by default. The
release planning branch is based on merged commit `07fc7d8`; its baseline has
69 passing tests, zero failures/skips, and `npm audit` reports 0
vulnerabilities. The prior development-only `js-yaml` advisory is resolved.

## Failure Handling

| Failure | Detection | User action | Data behavior |
| --- | --- | --- | --- |
| Sidecar missing or stopped | Fixed-port health request fails | Run the displayed setup command | Drafts and stored feedback survive |
| Port occupied by another process | Health response is missing Redline identity or protocol | Stop the conflicting process or use unpacked developer mode | No pairing or page collection begins |
| Pairing window expired | Pair endpoint returns a typed expiry response | Run setup again | Existing local feedback survives |
| Pairing race or replay | Atomic consume reports already used | Run setup separately in the intended Chrome profile | Only the first profile receives a token |
| Token stale or revoked | Authenticated endpoint returns typed 401 | Disconnect locally, rerun setup, and pair again | Feedback and drafts survive |
| Extension newer than helper | Required capability absent | Run the displayed npm setup command | Operation remains a draft |
| Helper newer than extension | Protocol major is unsupported | Update Redline from Chrome | Operation remains a draft |
| Permission denied or revoked | `chrome.permissions` lacks the origin | Enable the site again | Draft survives; no page collection continues |
| Unsupported browser page or OS | URL scheme or platform check fails | Use a normal HTTP(S) page on macOS or Linux | No page collection begins |
| Corrupt local store | Sidecar startup validation fails closed | Follow the preservation and recovery diagnostic | Corrupt data is never overwritten |
| Lost submission response | Retry uses the same operation ID | Retry automatically or manually | Server returns the original result without duplication |
| Extension update in flight | Draft has no definitive success receipt | Reopen Redline; retry resumes | Draft and operation ID survive |
| Offline setup | Store extension cannot reach sidecar and docs are unavailable | Run the bundled command shown in the extension | No page collection begins |

The popup provides **Disconnect this browser**, which revokes only the current profile's client token and removes that profile's drafts, temporary screenshots, and connection metadata without deleting submitted feedback. Individual deletion removes one redline and its screenshot while retaining the content-free idempotency tombstone described above. A confirmed **Clear all local Redline data** action in the extension clears the current profile's drafts, temporary screenshots, connection metadata, enabled-origin preferences, and browser host grants; it also clears every sidecar redline, screenshot, tombstone, and pairing record, revokes all browser client tokens, and advances the clear generation. Chrome does not permit one profile to erase storage or grants in another, so the UI states that other profiles retain their browser-local drafts and permissions even though those old drafts can no longer be accepted by the sidecar. Store-extension uninstall leaves the sidecar and submitted feedback intact. CLI uninstall stops and removes runtime integration but preserves feedback by default and never attempts to remove a Chrome Web Store extension. A separate CLI clear command clears sidecar data, revokes browser clients, advances the generation, and states that browser drafts and grants must be cleared separately in each Chrome profile.

The initial listing and onboarding state support macOS and Linux only. Windows and ChromeOS users see the requirement before pairing and cannot enable page collection.

## Verification

Automated coverage includes:

- pairing origin, expiry, one-time use, replay, and authentication boundaries
- connect-page sender validation, fragment removal, and fixed CORS allowlists
- extension-first and CLI-first onboarding state machines
- per-origin and all-sites permission choices
- dynamic registration persistence, disable flows, and external permission revocation
- runtime configuration persistence and migration from unpacked installs
- fixed-port collision and malformed health responses
- manifest validation and rejection of sidecar requests on non-target ports
- protocol major/minor and required-capability compatibility
- idempotent retries after lost responses and extension updates
- payload conflicts, concurrent submissions, screenshot atomicity, deletion tombstones, expiry, and clear-data behavior
- multiple Chrome profiles and competing pairing requests
- multi-profile clear, revocation, re-pair, and old-generation retry rejection
- store ZIP contents, manifest, icons, placeholders, and version synchronization
- privacy and listing contract checks
- Node 18 and current Node test suites, syntax checks, package dry run, and audit

Automated clean-profile extension E2E runs on Linux with Playwright's bundled
Chromium. Branded stable Chrome is a separate manual release gate on both
macOS and Linux because its extension side-loading behavior is not the
automated runner. Together these gates cover:

- fresh install through both orders
- localhost and a normal HTTPS website
- text-only and screenshot redlines
- pull, acknowledge, edit, refresh, reconnect, update, and reinstall loops
- denied permissions, stopped sidecar, stale token, and version mismatch
- no unexpected console or extension errors

The automated browser tests load the actual built Manifest V3 package into a
clean bundled-Chromium profile and communicate with a real spawned sidecar
process. The manual gates repeat the journeys in current branded stable Chrome
on macOS and Linux. Unit-only mocks are not accepted as evidence for either
onboarding order.

The first Web Store upload is the unpublished `0.0.1` bootstrap used only to reserve the extension ID. It is not represented as functional and is never submitted for review. Final submission occurs only after the higher-version functional package passes the complete clean-install loop and all listing disclosures match the shipped package.
