# @archastro/redline

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
