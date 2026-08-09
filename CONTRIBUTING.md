# Contributing to Redline

Redline is an ArchAstro-maintained open-source tool for sending browser UI
feedback to coding agents.

## Development Setup

```bash
npm install
npm test
npm run check:syntax
npm run check:versions
```

### Isolated unpacked extension

Use an isolated home, data directory, and Chrome profile so development never
overwrites your normal Redline installation. The Store and unpacked builds use
the same extension ID and cannot coexist in one Chrome profile.

```bash
export REDLINE_DEV_HOME="$PWD/.redline-dev/home"
export REDLINE_DIR="$PWD/.redline-dev/data"
export REDLINE_PORT=7879
export REDLINE_DEV_MODE=1
export REDLINE_EXTENSION_ID=bbllmeihbcmemadgmongicpklkjjgoaf
mkdir -p "$REDLINE_DEV_HOME" "$REDLINE_DIR"

HOME="$REDLINE_DEV_HOME" node setup/redline.js setup --source "$PWD"
HOME="$REDLINE_DEV_HOME" node setup/redline.js start
```

Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**,
and select `$REDLINE_DEV_HOME/.redline/extension`. The generated manifest uses
the checked-in Store identity so the extension ID remains stable. Reload the
extension and the page under test after each setup run. Always do this in the
separate Chrome profile reserved for Redline development.

Keep the same environment variables for setup, status, helper, and pull
commands. Stop the isolated helper with:

```bash
HOME="$REDLINE_DEV_HOME" node setup/redline.js stop
```

## Pull Requests

- Keep changes focused and explain the user-visible behavior.
- Add focused tests for extension, helper, setup, or CLI behavior.
- Update `README.md` and `SECURITY.md` when behavior, permissions, or data use
  changes.
- Run `npm test`, `npm run check:syntax`, `npm run check:versions`,
  `npm pack --dry-run`, and `git diff --check` before opening a PR.
- Add a changeset for user-visible changes with `npx changeset`.

## Maintainer Checklist

- Keep `main` protected with pull requests and the `Test` CI check. ArchAstro
  maintainers have no mandatory approval requirement.
- Require conversation resolution before merge.
- Block force-pushes and branch deletion on `main`.
- Publish npm releases through GitHub Actions with provenance enabled.

## Scope

The current public target is Chrome/Chromium plus a local helper. Safari,
Firefox, hosted sync, and team workflows should begin as separate design
discussions before implementation.
