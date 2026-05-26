---
description: Pull and act on UI redlines captured by the Redline Chrome extension. Use when the user asks to pull redlines, show pending redlines, fetch comments left on a page, review browser highlights, apply UI feedback, fix the things they flagged on the site, or "what did I redline on the page".
---

# Pull Redlines

Bridge between the Redline Chrome extension and this Claude session. Redlines are stored by a local sidecar at `http://127.0.0.1:7878` and pulled with the `redline-pull` CLI (on PATH while this plugin is enabled).

## Available commands

The plugin's `bin/` is on PATH for the session:

- `redline-sidecar start|stop|status|restart|logs` — manage the local HTTP sidecar daemon (default `start`, detaches and returns when /health is up)
- `redline-pull [origin] [--project NAME] [--no-ack]` — fetch pending items as markdown; acks each unless `--no-ack`
- `redline-tail` — dump all stored items (debug)
- `redline-clear` — wipe the local redline store

## Workflow

1. **Ensure the sidecar is running, and keep it running.** Check first with `redline-sidecar status`. If down, start it **as a long-running background process for the whole session** rather than as a detached daemon — some harnesses (Claude Code's Bash tool included) can reap detached children. The reliable pattern:

   - **In Claude Code / Codex CLI**: launch `redline-sidecar foreground` with the Bash tool's `run_in_background: true`. That keeps the server tied to the session and surviving across subsequent tool calls. Do **not** use `redline-sidecar start` from inside an agent — the double-forked daemon can still get killed by the harness, leaving the queue unreachable mid-pull.
   - **Outside an agent (manual terminal use)**: `redline-sidecar start` is fine and idempotent. PID lives at `$REDLINE_DIR/sidecar.pid` (default `~/.redline/sidecar.pid`).

   After starting, poll `redline-sidecar status` (or `curl -sf http://127.0.0.1:${REDLINE_PORT:-7878}/health`) until it reports `up` before issuing any `redline-pull`. If it never comes up, dump `redline-sidecar logs` and surface the error — don't keep retrying blind.

   **Throughout the session**: before each `redline-pull`, re-check `redline-sidecar status`. If it dropped, restart it the same way (background foreground process). The sidecar must be continuously available for the duration of the redline work.

2. **Decide filters from the user's ask.**
   - Mentioned a project tag ("the firstlanding redlines") → `--project firstlanding`
   - Mentioned a specific site/origin → pass it as the first positional arg, e.g. `redline-pull https://localhost:5173`
   - Otherwise pull everything pending

3. **Peek without acking first.** Always use `--no-ack` on the initial read so nothing is lost if the user interrupts:
   ```bash
   redline-pull --no-ack [origin] [--project NAME]
   ```

4. **Read the items.** Each one has:
   - `selected_text` — the literal string highlighted on the page (your best locator)
   - `comment` — the user's redline (what they want changed)
   - `context.selector` — CSS path on the page (best-effort, fragile)
   - `context.surrounding_text` — ~300 chars around the selection (disambiguates duplicate matches)
   - `screenshot:` URL — pull with `curl <url> -o /tmp/rl-<id>.png` then Read it if the comment is ambiguous

5. **Find the source code.** For each item, grep the repo for the exact `selected_text`. If multiple hits, use `surrounding_text` to disambiguate. If you can't locate the source, say so and skip that item — do not guess at random files.

6. **Show the plan; do not edit yet.** Present a punch list: `<item id> — <file>:<line> — change "X" → "Y"`. Wait for the user to confirm before editing. They may want to triage, skip some, or reword.

7. **After edits land and the user confirms, ack the consumed items** so they don't re-appear:
   ```bash
   curl -s -X POST "http://127.0.0.1:${REDLINE_PORT:-7878}/redlines/<id>/ack" >/dev/null
   ```

## Heuristics

- The `selected_text` literal grep is almost always the right locator. CSS selectors are best-effort and break across SPA renders.
- A single page-load reuses one `screenshot_id` across many redlines left on that page. Pull each screenshot at most once per page.
- Items with `status=acked` are kept for audit — never re-process them.
- Per-page screenshots reflect the page state at first-submit on that load, not at every comment. Don't trust them as exact "after typing this comment" snapshots.

## Environment variables

- `REDLINE_PORT` — sidecar port (default `7878`)
- `REDLINE_DIR` — sidecar data dir (default `~/.redline`)
