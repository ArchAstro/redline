# @archastro/redline

## 0.3.3

### Patch Changes

- 0c25fae: Detect the Chrome Web Store extension from Secure Preferences, add `redline version`, and keep one consent tab for both Chrome-first and CLI-first setup.

## 0.3.2

### Patch Changes

- 0a591ff: Let the Chrome extension detect and restart a stale background worker after an upgrade.

## 0.3.1

### Patch Changes

- 8e00a21: Update the public setup flow for the live Chrome Web Store and default npm
  registry, and close the local pairing bridge automatically so Chrome-first
  onboarding continues in its original tab.

## 0.3.0

### Minor Changes

- 77fc36c: Replace the duplicated Claude and Codex plugins with one portable agent skill that users install, update, and remove directly through the standard `skills` CLI. Redline's CLI no longer manages agent skill or plugin state.
- 26f3a91: Install and pair the Chrome Web Store extension through a short-lived local
  consent flow. Keep unpacked extension setup available for contributors, update
  public docs and CLI guidance, and align extension branding.

## 0.2.6

### Patch Changes

- fa1f5ef: Preserve corrupt local stores instead of overwriting them, isolate untrusted
  webpage text in agent output, invalidate deleted screenshot references, make
  scoped uninstall safe, tighten GitHub workflow permissions, and harden public
  release and contributor guidance.

## 0.2.5

### Patch Changes

- a5d0b9b: Apply clear, low-risk redlines without an extra confirmation step, keep ambiguous or broad feedback pending for clarification, and stop reporting correctly secured extension files as out of sync.

## 0.2.4

### Patch Changes

- be3bbd2: Publish the corrected Apache-2.0 license metadata in the npm package.
- 9d266cd: Harden local sidecar authentication and private data storage, clean up screenshots with their redlines, preserve existing harness configuration during idempotent setup, reconcile stale page highlights, improve extension diagnostics and deletion errors, add an explicit screenshot-enabled install mode, and prepare public Apache-2.0 npm packaging.

## 0.2.3

### Patch Changes

- **setup:** write the current Claude marketplace shape (`source: "directory"`) into `known_marketplaces.json`. Claude Code 2.1.x renamed the local-filesystem source from `"local"` → `"directory"`, and the old value now fails schema validation with `Marketplace configuration file is corrupted: redline.source.source: Invalid input`, taking down the entire `/plugin` command (not just redline). Re-running `redline-agent-setup` overwrites the bad entry and restores `/plugin`.

## 0.2.2

### Patch Changes

- Add `redline-watch`, a long-running poller that emits one stdout line per newly observed pending redline id. Designed to be consumed by `Monitor` so an agent can stay paired with the page and auto-pull as the user leaves new comments, instead of waiting to be asked. The pull skill now instructs agents to start `redline-watch` in the background after the first pull cycle and run the full review/ack loop on each emitted id (same filters as `redline-pull`).

## 0.2.1

### Patch Changes

- Two install/runtime bug fixes.

  - **sidecar:** the `redline-sidecar` shim now resolves symlinks when computing its install root, so the launcher works through `/opt/homebrew/bin/redline-sidecar` (and any other PATH symlink) instead of looking for `/opt/homebrew/server.js`. `start` also double-forks so the daemon survives harnesses (like Claude Code's Bash tool) that reap their tool subprocess group.
  - **setup:** `installClaude` now materializes a marketplace at `~/.claude/plugins/marketplaces/redline/` and registers it in `known_marketplaces.json`. Without this, `/plugin` showed redline as installed but errored with `Plugin "redline" not found in marketplace "redline"`. `uninstallClaude` tears the new files down.
  - **skill:** the pull workflow now tells agents to keep the sidecar continuously available (prefer `redline-sidecar foreground` via `run_in_background` inside an agent) and re-check status before every pull.

## 0.2.0

### Minor Changes

- Add Codex plugin alongside the existing Claude plugin, and ship a `redline-agent-setup` CLI that installs both into the user's local Claude / Codex config in one command.

  - New `plugins/redline/` directory carries the Codex variant with a `.codex-plugin/plugin.json` manifest (includes the Codex `interface` block).
  - Existing Claude plugin moved from `plugin/` to `.claude-plugins/redline/` to match the archagents convention; `.claude-plugin/marketplace.json` now points at `./.claude-plugins/redline` with the marketplace `pluginRoot` set.
  - New `setup/redline-agent-setup.js` (zero deps, Node stdlib) syncs both plugins into `~/.claude/plugins/cache/redline/redline/<version>/` and `~/.codex/plugins/cache/redline/redline/<version>/`, writes `~/.agents/plugins/marketplace.json` for Codex, and patches `~/.claude/settings.json`, `~/.claude/plugins/installed_plugins.json`, and `~/.codex/config.toml`. Supports `--claude-only`, `--codex-only`, `--uninstall`, `--dry-run`.

  Run via `npx -p @archastro/redline redline-agent-setup`.

## 0.1.1

### Patch Changes

- Restrict the Chrome extension content script to localhost / 127.0.0.1 / \*.localhost (http + https) instead of injecting on every page. Add more match patterns to `extension/manifest.json` if you need it on staging or prod hosts.
