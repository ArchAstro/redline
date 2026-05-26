# Redline

Highlight live web UI, leave redlines, pipe them into Claude Code.

Three pieces: a Chrome extension for capturing redlines, a tiny local HTTP
sidecar that stores them, and a Claude Code plugin that pulls them into your
session so Claude can act on the feedback.

```
[ Chrome extension ]  --POST-->  [ Sidecar @ 127.0.0.1:7878 ]  --GET-->  [ Claude Code ]
   select + comment                 ~/.redline/redlines.json              /redline:pull
```

---

## Install

### npm package (sidecar CLI globally on PATH)

The package is published to GitHub Packages under the `@archastro` scope, so
you need a `~/.npmrc` that maps that scope to the registry and provides a
GitHub token with `read:packages` scope.

```bash
echo "@archastro:registry=https://npm.pkg.github.com" >> ~/.npmrc
echo "//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}" >> ~/.npmrc

npm install -g @archastro/redline
```

This puts the four CLIs on your `$PATH`:
- `redline-sidecar` — start/stop/restart/status/logs the local daemon
- `redline-pull` — fetch pending redlines as markdown and ack them
- `redline-tail` — dump everything in the store (debug)
- `redline-clear` — wipe the local store

### Claude Code plugin

Add the repo as a Claude Code marketplace, then install:

```
/plugin marketplace add ~/archastro/redline
/plugin install redline@redline
```

If you `npm install -g` instead, point the marketplace at the global modules
dir:

```
/plugin marketplace add $(npm root -g)/@archastro/redline
```

The plugin auto-extends `$PATH` with `plugin/bin/`, so the same `redline-*`
commands work inside any Claude session that has it enabled. It also
registers the `redline:pull` skill, which Claude invokes automatically when
you ask things like "pull my redlines" or "fix the things I marked up on the
page".

### Chrome extension

Loaded the standard way:

1. Open `chrome://extensions`
2. Toggle on **Developer mode** (top right)
3. Click **Load unpacked**
4. Pick the `extension/` directory in this repo

---

## Use

1. **Start the sidecar** (idempotent, detaches in the background, exits
   immediately once `/health` responds):

   ```bash
   redline-sidecar start
   ```

   PID lives at `~/.redline/sidecar.pid` and survives across sessions.

2. **On any web page**: select some text. A small **Redline** button appears
   near the selection. Click it, write your comment, optionally tag the
   project (e.g. `firstlanding`), submit. The selection turns yellow (CSS
   Custom Highlight API — no DOM mutation). Click an existing highlight to
   edit or delete.

   A screenshot of the visible page is captured on the **first** submit per
   page-load and reused for all subsequent redlines on that page. Use the
   **Refresh shot** button in the toolbar popup to force a new snapshot if
   the page state changes.

3. **From any Claude Code session**, ask "pull my redlines" — the
   `redline:pull` skill runs `redline-pull --no-ack`, finds the source code
   for each item by grepping for the literal selected text, presents a plan,
   and (once you approve) applies the edits and acks the items.

   Or run it directly:

   ```bash
   redline-pull                       # all pending, all origins, acks each
   redline-pull https://localhost:5173 # filter by origin
   redline-pull --project firstlanding
   redline-pull --no-ack              # peek without consuming
   ```

---

## Configuration

| Env var          | Default          | What it sets                       |
| ---------------- | ---------------- | ---------------------------------- |
| `REDLINE_PORT`   | `7878`           | Sidecar HTTP port                  |
| `REDLINE_DIR`    | `~/.redline`     | Sidecar data dir (DB + screenshots) |

Data layout in `$REDLINE_DIR`:

```
~/.redline/
├── redlines.json          # the full store (pending + acked)
├── screenshots/<id>.png   # per-page screenshots
├── sidecar.pid            # daemon PID
└── sidecar.log            # daemon log
```

---

## Architecture

### Sidecar API

Loopback-only HTTP, no auth (localhost can't be reached off-host).

| Method | Path                       | What it does                            |
| ------ | -------------------------- | --------------------------------------- |
| GET    | `/health`                  | server up check                         |
| POST   | `/redlines`                | create a redline                        |
| GET    | `/redlines`                | list, filterable by `status`, `origin`, `project` |
| POST   | `/redlines/:id/ack`        | mark as consumed                        |
| DELETE | `/redlines/:id`            | hard-delete                             |
| POST   | `/screenshots`             | upload a screenshot (JSON `data_url`)   |
| GET    | `/screenshots/:id`         | fetch as raw PNG                        |

Items survive after ack with `status=acked` for audit. The `redline-pull`
flow explicitly acks after delivering — if your Claude session dies
mid-pull, the items stay pending.

### Redline shape

```json
{
  "id": "rl_01HX...",
  "created_at": "2026-05-26T18:32:11Z",
  "status": "pending",
  "url": "http://localhost:5173/dashboard",
  "origin": "http://localhost:5173",
  "title": "Dashboard · MyApp",
  "project": "firstlanding",
  "selected_text": "Get started with your first agent",
  "comment": "should say 'Deploy your first agent'",
  "context": {
    "selector": "main > section.hero > h1",
    "surrounding_text": "...header... Get started with your first agent ...subheader...",
    "html_snippet": "<h1>Get started with your first agent</h1>",
    "viewport": { "w": 1440, "h": 900 },
    "range_ref": { "startSelector": "...", "startOffset": 0, "endSelector": "...", "endOffset": 33, "text": "Get started with your first agent" }
  },
  "rect": { "x": 240, "y": 180, "w": 520, "h": 48 },
  "screenshot_id": "ss_01HABC..."
}
```

The `selected_text` literal is the most reliable locator — Claude greps the
repo for it and uses `surrounding_text` to disambiguate. CSS selectors are
included but best-effort and brittle across SPA renders.

### Known v1 limits

- **Localhost-scoped.** The content script only auto-injects on `localhost`,
  `127.0.0.1`, and `*.localhost` (both `http` and `https`). Add more match
  patterns to `extension/manifest.json` if you want it on staging/prod
  domains.
- Top-frame only — no iframe or shadow-DOM support.
- Highlight restoration on reload is best-effort (CSS path + offsets); pages
  whose markup shifts between loads will drop stale ones silently.
- Screenshot cache is keyed `(tabId, url)`; changing route in the same tab
  invalidates.
- Pull-only — Claude polls; no push/SSE.

---

## Development

```bash
git clone git@github.com:ArchAstro/redline.git
cd redline
npm install
```

### Releasing

This repo uses [changesets](https://github.com/changesets/changesets)
matching the firstlanding pattern. To ship a release:

```bash
npx changeset            # interactive: pick bump type, write the changelog line
git add .changeset/*.md
git commit -m "feat: ..."
git push                 # opens a 'chore: version packages' PR via CI
```

When the version-packages PR merges to `main`, the
[`release.yml`](.github/workflows/release.yml) workflow runs
`npx changeset publish` and pushes the new version to GitHub Packages.

To publish manually without the PR dance (needs `NODE_AUTH_TOKEN`):

```bash
npx changeset
npx changeset version
npm run release
```

### Layout

```
redline/
├── .changeset/{config.json, README.md}
├── .claude-plugin/marketplace.json
├── .github/workflows/release.yml
├── .npmrc                            # @archastro -> npm.pkg.github.com
├── package.json                      # @archastro/redline
├── extension/                        # Chrome MV3 extension
│   ├── manifest.json
│   ├── content.{js,css}              # selection UI, highlight rendering
│   ├── background.js                 # screenshot cache + HTTP client
│   └── popup.{html,js}               # toolbar list view
└── plugin/                           # Claude Code plugin
    ├── .claude-plugin/plugin.json
    ├── bin/                          # on PATH inside Claude sessions
    │   ├── redline-sidecar
    │   ├── redline-pull
    │   ├── redline-tail
    │   └── redline-clear
    ├── server.js                     # Node stdlib HTTP sidecar
    └── skills/pull/SKILL.md          # /redline:pull
```
