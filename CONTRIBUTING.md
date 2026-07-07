# Contributing to Redline

Redline is an ArchAstro-maintained open-source tool for leaving browser UI feedback that coding agents can pull into their local workflow.

## Development Setup

```bash
npm install
npm test
npm run check:syntax
```

The Chrome extension can be loaded unpacked from `extension/`.

## Pull Requests

- Keep changes focused and explain the user-visible behavior being changed.
- Add or update focused tests for sidecar, setup, or CLI behavior when possible.
- Run `npm test` and `npm run check:syntax` before opening a PR.
- Document new limitations or privacy/security behavior in `README.md`.

## Scope

The current public target is Chrome/Chromium plus a local sidecar. Safari, Firefox, hosted sync, and team workflows are welcome topics for issues, but should be handled as separate design discussions before implementation.
