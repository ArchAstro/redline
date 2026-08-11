# Redline

[![npm version](https://img.shields.io/npm/v/%40archastro%2Fredline)](https://www.npmjs.com/package/@archastro/redline)
[![CI](https://github.com/ArchAstro/redline/actions/workflows/ci.yml/badge.svg)](https://github.com/ArchAstro/redline/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/ArchAstro/redline)](LICENSE)

Turn precise webpage feedback into changes a coding agent can make.

Redline combines a Chrome extension, a local helper, and an open agent skill.
Select text on a page, leave the requested change in context, and ask your
agent to pull it. Built by [ArchAstro](https://archastro.ai).

```
[ Chrome extension ]  --local-->  [ Helper @ 127.0.0.1:7878 ]  --local-->  [ Coding agent ]
  select + comment                   private local state                    pull + act
```

## See the loop

Leave the change where you see it:

![New redline popover](docs/assets/redline-popover.png)

Then pull the structured feedback into your coding workflow:

![Redline pull terminal output](docs/assets/redline-pull-terminal.png)

## Quickstart

Prerequisites: macOS or Linux, Node.js 18 or newer, Bash, curl, and jq, plus
Chrome or another Chromium-based browser. Windows and Safari are not currently
supported.

1. [Install Redline from the Chrome Web Store](https://chromewebstore.google.com/detail/redline/bbllmeihbcmemadgmongicpklkjjgoaf).
2. Install the CLI and portable agent skill:

   ```bash
   npm install -g @archastro/redline
   npx skills add ArchAstro/redline
   ```

3. Start the local helper and pair the extension:

   ```bash
   redline setup
   ```

The standard skills CLI owns skill installation and updates. Redline's CLI
never installs, updates, removes, or inspects agent skills or legacy plugin
state.

`redline setup` starts the local helper and opens a short-lived consent page.
Approve it to pair the extension with the local helper. No ArchAstro account
or hosted service is required.

## Verify the loop

1. Open a webpage where Redline is enabled.
2. Select text, click **Redline**, add a concrete change, and submit it.
3. Ask your agent **"Pull my redlines."** or preview from the terminal:

   ```bash
   redline pull --no-ack
   ```

4. Confirm the pending item appears, let the agent make and verify the change,
   then pull with acknowledgement or delete the item. Resolved highlights are
   removed from the page.

Run `redline status` if the extension or local helper appears unavailable. The
CLI can verify the Store extension and helper, but the extension popup is the
source of truth for whether the active Chrome profile is paired. Use
`redline logs -f` for helper diagnostics.

## Agent invocation

| Surface | Invocation |
| ------- | ---------- |
| Portable prompt | `"Pull my redlines."` |
| Agent skill | `redline` |
| Terminal | `redline pull` |

The skill inspects each item, finds the corresponding source, applies focused
changes, runs relevant checks, and only then acknowledges completed feedback.
Ambiguous or risky requests still require clarification.

## Commands

| Command | Purpose |
| ------- | ------- |
| `redline setup` | Configure or pair the Chrome extension |
| `redline status` | Diagnose extension and helper state |
| `redline start` | Start the local helper |
| `redline stop` | Stop the local helper |
| `redline restart` | Restart the local helper |
| `redline logs -f` | Follow helper logs |
| `redline pull` | Fetch and acknowledge pending feedback |
| `redline pull --no-ack` | Preview without consuming feedback |
| `redline watch` | Poll for new feedback |
| `redline clear` | Delete helper-side redlines/screenshots and revoke every paired browser |

Filter pulls by origin or project:

```bash
redline pull http://localhost:5173
redline pull --project my-app
```

`redline clear` does not delete browser-local retry drafts. Use **Clear all
data** in the extension popup when you also need to remove that profile's local
browser data.

For a one-off setup without a global install:

```bash
npx --yes --package @archastro/redline redline setup
```

## Local-first data model

Redline listens only on `127.0.0.1` and stores its state under `~/.redline` by
default. Redlines can contain selected text, comments, page URLs, page titles,
DOM context, element geometry, and optional screenshots.

The Store flow gives each paired Chrome profile its own revocable browser
credential. CLI requests use a separate owner-only credential. The current
unpacked development flow uses an owner-only local browser credential.

ArchAstro does not receive this data. It leaves your machine only when you
explicitly provide it to a coding agent or model provider. See the
[Redline privacy policy](https://oss.archastro.ai/redline/privacy) and
[security policy](SECURITY.md).

## Permissions and limitations

- Screenshots and non-local pages require broader Chrome site access.
- Chrome internal pages, the Chrome Web Store, and other protected pages cannot
  run content-script extensions.
- Text matching can be ambiguous when the same phrase appears multiple times;
  Redline also records selectors and surrounding context to improve location.
- Content-heavy single-page apps may replace selected DOM nodes. Redline
  re-renders pending markers when it can and keeps the item in local state.
- Chrome/Chromium is supported today. Safari and Firefox are not.

## Architecture

The extension sends authenticated requests to the loopback-only helper. The
helper persists state atomically and exposes it to authenticated CLI commands.
Public endpoints are limited to health, compatibility, and the short-lived
pairing handshake.

Default data layout:

```text
~/.redline/
|-- state.json          # redlines, paired clients, and pairing state
|-- cli-credential      # owner-only CLI credential
|-- screenshots/        # optional captured images
|-- sidecar.pid
`-- sidecar.log
```

Set `REDLINE_DIR` to move local data. Set `REDLINE_PORT` only for explicit
development mode; the Store extension pairs on port `7878`.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for the isolated unpacked-extension
workflow and pull request checklist. The core verification commands are:

```bash
npm install
npm test
npm run check:syntax
npm run check:versions
npm pack --dry-run
```

## Releases

Changesets drive package versions and GitHub Actions publishes npm releases
with provenance. Add a changeset for user-visible changes:

```bash
npx changeset
```

To publish manually, first run `npm run version`, commit the synchronized
version files, run the full verification suite, and then run `npm run release`.

## Community

- [Discussions](https://github.com/ArchAstro/redline/discussions) for questions,
  workflows, and ideas
- [Issues](https://github.com/ArchAstro/redline/issues) for reproducible bugs and
  scoped feature requests
- [Contributing guide](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Code of conduct](CODE_OF_CONDUCT.md)

Redline is licensed under [Apache-2.0](LICENSE).
