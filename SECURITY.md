# Security Policy

## Reporting a Vulnerability

Use [GitHub private vulnerability reporting](https://github.com/ArchAstro/redline/security/advisories/new)
or email security@archastro.ai. Include the affected version or commit,
operating system and browser, reproduction steps, impact, and any proof of
concept. Please do not open a public issue until we have had a chance to
investigate.

## Local Data Model

Redline runs a helper on `127.0.0.1` and stores local state under `~/.redline`
by default. Redlines may include selected text, comments, page URLs, page
titles, DOM snippets, element geometry, project tags, and optional screenshots.

The credential model below applies to npm 0.3 and newer. npm 0.2.x is the
legacy unpacked release: setup stores an owner-only `auth-token`, embeds that
credential in the generated extension, and accepts local CLI requests without
a credential. Upgrade to npm 0.3+ when it is available.

The Chrome Web Store flow starts a short-lived pairing window when you run
`redline setup`. The extension displays the data disclosure and requires
affirmative consent before pairing. Each Chrome profile receives a unique,
revocable paired-browser credential; Redline stores only its verifier in local
helper state. CLI operations use a separate owner-only CLI credential stored at
`~/.redline/cli-credential`.

Protected helper endpoints require either a valid paired-browser credential or
the CLI credential. Public loopback endpoints are limited to health,
compatibility, and the short-lived pairing handshake. The unpacked contributor
workflow stores an owner-only `auth-token` and embeds it in the generated
extension only when `REDLINE_DEV_MODE=1` is explicitly enabled.

ArchAstro does not receive Redline data. Data leaves your machine only when you
explicitly pass it to a coding agent or model provider. Review that provider's
data policy as well as the [Redline privacy policy](https://oss.archastro.ai/redline/privacy).

Keep `~/.redline` private to your user account. Do not post `state.json`,
`cli-credential`, `auth-token`, generated `auth.js`, screenshots, logs, or
diagnostic output without reviewing them for private page content and
credentials.
