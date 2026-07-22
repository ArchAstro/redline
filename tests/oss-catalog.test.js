const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..", "docs", "oss");
const repositoryRoot = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const css = fs.readFileSync(path.join(root, "styles.css"), "utf8");

function trackedCatalogTextFiles() {
  const tracked = execFileSync("git", ["ls-files", "-z", "--", "docs/oss", "tests"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).split("\0").filter(Boolean);
  const textExtensions = new Set([".css", ".html", ".js", ".md", ".sql", ".toml"]);

  return tracked.filter((file) => {
    const intended = file.startsWith("docs/oss/") || /^tests\/oss-[^/]+\.test\.js$/.test(file);
    return intended && textExtensions.has(path.extname(file)) &&
      fs.existsSync(path.join(repositoryRoot, file));
  });
}

test("removed OSS Worker infrastructure and confirmation lifecycle stay absent", () => {
  assert.equal(fs.existsSync(path.join(root, "worker")), false);
  assert.equal(fs.existsSync(path.join(repositoryRoot, "tests", "oss-interest-worker.test.js")), false);

  const files = trackedCatalogTextFiles();
  assert.ok(files.includes("docs/oss/app.js"));
  assert.ok(files.includes("docs/oss/index.html"));
  assert.ok(files.includes("tests/oss-catalog-behavior.test.js"));
  assert.ok(files.includes("tests/oss-media.test.js"));
  assert.ok(files.every((file) => !file.startsWith("docs/oss/worker/")));

  const staleTerms = [
    "/api/" + "oss/lab-interest",
    "pending_" + "confirmation",
    "confirmation" + "Pending",
    "delivery" + "Status",
  ];
  const stalePattern = new RegExp(staleTerms.join("|"));
  for (const file of files) {
    assert.doesNotMatch(fs.readFileSync(path.join(repositoryRoot, file), "utf8"), stalePattern, file);
  }
});

test("browser chrome identifies the OSS catalog as ArchAstro", () => {
  assert.match(html, /<title>Open Source &middot; ArchAstro<\/title>/);
  assert.match(html, /rel="icon" href="\.\/assets\/favicon\.png"/);
  assert.match(html, /rel="apple-touch-icon" href="\.\/assets\/favicon\.png"/);
  assert.ok(fs.statSync(path.join(root, "assets", "favicon.png")).size > 0);
});

test("OSS home is a compact repository index", () => {
  assert.match(html, /class="catalog-intro"/);
  assert.match(html, /class="repository-list"/);
  assert.match(html, /class="repository-entry"/);
  assert.match(html, /class="lab-entry"/);
  assert.match(html, /Open source tools from ArchAstro/);
  assert.match(html, /Developer tools extracted from how we build ArchAgents<\/h1>/);
  assert.match(html, /Redline sends precise webpage feedback to coding agents\./);
  assert.doesNotMatch(html, /class="hero"|class="oss-proof"|class="start-path"|class="directory"/);
});

test("catalog intro is centered as a block with left-aligned text", () => {
  assert.match(
    css,
    /\.catalog-intro\s*{[^}]*max-width:\s*720px;[^}]*margin-inline:\s*auto;[^}]*text-align:\s*left;/s
  );
  assert.match(css, /\.catalog-intro h1\s*{[^}]*margin-inline:\s*0;/s);
  assert.match(css, /\.catalog-intro > p:last-child\s*{[^}]*margin-inline:\s*0;/s);
});

test("Redline entry is factual and scan-friendly", () => {
  assert.match(html, /<h2[^>]*>Redline<\/h2>/);
  assert.match(html, /Maintained/);
  assert.match(html, /v0\.2\.3/);
  assert.match(html, /JavaScript/);
  assert.match(html, /Apache-2\.0/);
  assert.match(html, /Chrome/);
  assert.match(html, /Codex \+ Claude Code/);
  assert.match(html, /Select text on a webpage, leave a precise fix, and pull it directly into your coding agent\./);
});

test("Redline exposes the complete project action set", () => {
  assert.match(html, /href="https:\/\/github\.com\/ArchAstro\/redline"[^>]*>\s*GitHub/);
  assert.match(html, /href="https:\/\/github\.com\/ArchAstro\/redline\/blob\/main\/README\.md"[^>]*>\s*Docs/);
  assert.match(html, /href="https:\/\/github\.com\/ArchAstro\/redline\/issues"[^>]*>\s*Issues/);
  assert.match(html, /href="https:\/\/github\.com\/ArchAstro\/redline\/blob\/main\/SECURITY\.md"[^>]*>\s*Security/);
  assert.match(html, /href="https:\/\/github\.com\/ArchAstro\/redline\/blob\/main\/CONTRIBUTING\.md"[^>]*>\s*Contribute/);
});

test("Redline has one copyable install command", () => {
  assert.equal((html.match(/data-copy-command/g) || []).length, 1);
  assert.match(html, /<code data-install-command>npm install -g @archastro\/redline<\/code>/);
  assert.doesNotMatch(html, /redline setup\s+redline status/);
});

test("Redline presents the complete three-step setup honestly", () => {
  assert.match(html, /class="redline-quickstart"/);
  assert.match(html, /Install the CLI package/);
  assert.match(html, /redline setup --with-screenshots/);
  assert.match(html, /redline start/);
  assert.match(html, /class="quickstart-commands"/);
  assert.match(html, /~\/\.redline\/extension\//);
  assert.match(html, /Chrome cannot auto-install an unpacked extension/);
});

test("Redline discloses its local data and optional screenshot permissions", () => {
  assert.match(html, /class="redline-disclosure"/);
  assert.match(html, /loopback/);
  assert.match(html, /~\/\.redline/);
  assert.match(html, /Local-only mode/);
  assert.match(html, /least privilege/);
  assert.match(html, /Screenshot mode/);
  assert.match(html, /page access/);
  assert.match(html, /visible-page screenshots/);
  assert.match(html, /href="https:\/\/github\.com\/ArchAstro\/redline\/blob\/main\/SECURITY\.md"/);
});

test("Redline leads with an accessible motion proof", () => {
  assert.match(html, /data-motion-proof/);
  assert.match(html, /src="\.\/assets\/redline-real\.mp4"/);
  assert.match(html, /poster="\.\/assets\/redline-real\.png"/);
  assert.ok(fs.existsSync(path.join(root, "assets", "redline-real.mp4")));
  assert.ok(fs.existsSync(path.join(root, "assets", "redline-real.png")));
});

test("Redline keeps identity and actions together before proof", () => {
  const entry = html.slice(
    html.indexOf('<article class="repository-entry"'),
    html.indexOf("</article>", html.indexOf('<article class="repository-entry"'))
  );
  const contentIndex = entry.indexOf('class="repository-content"');
  const proofIndex = entry.indexOf('class="workflow-proof"');

  assert.ok(contentIndex >= 0 && contentIndex < proofIndex);
  assert.match(
    entry,
    /class="repository-content"[\s\S]*class="repository-heading"[\s\S]*class="repository-details"[\s\S]*class="workflow-proof"/
  );
});

test("workflow ships in its available state", () => {
  assert.match(html, /data-workflow-state="available"/);
  assert.match(html, /data-workflow-caption[^>]*>Leave the fix in the browser\. Watch the agent pull it, edit source, and resolve it\./);
});

test("workflow proof resets browser figure margins", () => {
  assert.match(css, /\.workflow-proof\s*{[^}]*margin:\s*0;/);
  assert.doesNotMatch(css, /\.workflow-proof\s*{[^}]*margin-bottom:\s*0;/);
});

test("mobile catalog heading wraps without growing", () => {
  assert.match(
    css,
    /@media\s*\(max-width:\s*560px\)[\s\S]*?\.catalog-intro h1\s*{[\s\S]*?font-size:\s*1\.55rem;[\s\S]*?max-width:\s*100%;[\s\S]*?overflow-wrap:\s*anywhere;/
  );
  assert.doesNotMatch(
    css,
    /@media\s*\(max-width:\s*560px\)[\s\S]*?\.catalog-intro h1\s*{[\s\S]*?font-size:\s*(?:1\.[89]|[2-9])rem;/
  );
});

test("inline motion proofs let JavaScript honor reduced motion before playback", () => {
  assert.equal((html.match(/data-motion-proof/g) || []).length, 3);
  assert.equal((html.match(/data-motion-media/g) || []).length, 3);
  assert.equal((html.match(/class="motion-media"/g) || []).length, 3);
  assert.equal((html.match(/class="motion-open"/g) || []).length, 2);
  assert.match(html, /class="motion-open" href="\.\/assets\/aster-real\.mp4"/);
  assert.match(html, /class="motion-open" href="\.\/assets\/astrodev-real\.mp4"/);
  assert.equal((html.match(/\bmuted\b/g) || []).length, 3);
  assert.doesNotMatch(html, /\bautoplay\b/);
  assert.equal((html.match(/\n\s+loop\b/g) || []).length, 3);
  assert.equal((html.match(/\bplaysinline\b/g) || []).length, 4);
  assert.doesNotMatch(html, /class="motion-animation"/);
  assert.doesNotMatch(html, /data-motion-toggle|data-motion-label/);
  assert.doesNotMatch(css, /\.motion-toggle/);
  assert.match(css, /\.motion-media\s*{[^}]*object-fit:\s*contain;/);
});

test("keyboard users can skip the sticky navigation", () => {
  assert.match(html, /<a class="skip-link" href="#main-content">Skip to main content<\/a>/);
  assert.match(html, /<main id="main-content" class="catalog-shell">/);
  assert.match(css, /\.skip-link:focus-visible\s*{/);
});

test("each recording has an accessible expand trigger and one shared dialog", () => {
  assert.equal((html.match(/data-recording-trigger/g) || []).length, 3);
  assert.equal((html.match(/class="recording-trigger"/g) || []).length, 3);
  assert.equal((html.match(/aria-haspopup="dialog"/g) || []).length, 3);
  assert.match(html, /aria-label="Expand Redline recording"/);
  assert.match(html, /aria-label="Expand Aster recording"/);
  assert.match(html, /aria-label="Expand AstroDev recording"/);

  assert.equal((html.match(/<dialog/g) || []).length, 1);
  assert.match(html, /<dialog[^>]*data-recording-dialog[^>]*aria-labelledby="recording-dialog-title"/);
  assert.match(html, /data-recording-dialog-close[^>]*aria-label="Close recording"/);
  assert.match(html, /data-recording-dialog-title/);
  assert.match(html, /data-recording-dialog-caption/);
  assert.match(html, /<video[^>]*data-recording-dialog-media[^>]*controls/);
});

test("projects use split desktop rows and identity-first mobile rows", () => {
  assert.match(
    css,
    /\.repository-entry,\s*\.lab-entry\s*{[^}]*grid-template-areas:\s*"content proof";[^}]*grid-template-columns:\s*minmax\(280px,\s*0\.82fr\)\s+minmax\(0,\s*1\.18fr\);[^}]*border-bottom:\s*1px solid var\(--line\);/
  );
  assert.match(css, /\.workflow-frame\s*{[^}]*aspect-ratio:\s*16\s*\/\s*9;/);
  assert.match(css, /\.lab-proof__frame\s*{[^}]*aspect-ratio:\s*16\s*\/\s*9;/);
  assert.match(
    css,
    /@media\s*\(max-width:\s*800px\)[\s\S]*?\.repository-entry,\s*\.lab-entry\s*{[^}]*grid-template-areas:\s*"content"\s*"proof";/
  );
});

test("Redline desktop details stay compact without changing mobile order", () => {
  assert.match(css, /\.repository-meta\s*{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);[^}]*margin-bottom:\s*16px;/);
  assert.match(css, /\.repository-meta li\s*{[^}]*grid-template-columns:\s*68px\s+minmax\(0,\s*1fr\);[^}]*gap:\s*8px;[^}]*padding:\s*6px 0;/);
  assert.match(css, /\.repository-heading\s*{[^}]*padding-bottom:\s*18px;/);
  assert.match(css, /\.repository-links\s*{[^}]*margin-bottom:\s*18px;/);
  assert.match(css, /\.redline-quickstart\s*{[^}]*gap:\s*8px;/);
  assert.match(css, /@media\s*\(max-width:\s*560px\)[\s\S]*?\.repository-meta\s*{[^}]*grid-template-columns:\s*1fr;/);
});

test("lab project copy and interest controls stay together before proof", () => {
  for (const item of ["aster", "astrodev"]) {
    const start = html.indexOf(`<article class="lab-entry" data-lab-item="${item}"`);
    const entry = html.slice(start, html.indexOf("</article>", start));
    const contentIndex = entry.indexOf('class="lab-content"');
    const proofIndex = entry.indexOf('class="lab-proof"');

    assert.ok(contentIndex >= 0 && contentIndex < proofIndex);
    assert.match(
      entry,
      /class="lab-content"[\s\S]*class="lab-copy"[\s\S]*class="lab-interest"[\s\S]*class="lab-proof"/
    );
  }
});

test("catalog never references the removed synthetic product media", () => {
  assert.doesNotMatch(html, /redline-workflow|aster-affected|astrodev-harness/);
});

test("composition avoids the removed marketing patterns", () => {
  assert.doesNotMatch(html, /oss-seam|oss-proof|start-path|project-shot|primary-action|secondary-action/);
  assert.doesNotMatch(css, /box-shadow:\s*0 0 0 100vmax|clip-path:\s*inset|font-size:\s*clamp\([^;]*3rem/);
  assert.equal((css.match(/border-radius:\s*999px/g) || []).length, 1);
  assert.doesNotMatch(css, /repeating-linear-gradient|background-size:\s*34px/);
});

test("typography uses only the two imported families", () => {
  assert.match(html, /family=IBM\+Plex\+Mono:wght@400;500&family=Manrope:wght@400;500;600;700/);
  assert.match(css, /--font-sans:\s*"Manrope"/);
  assert.match(css, /--font-mono:\s*"IBM Plex Mono"/);
  assert.doesNotMatch(css, /Fraunces|Inter|Space Grotesk|Georgia|SFMono|Menlo|Consolas/);
  assert.doesNotMatch(css, /font-weight:\s*650/);
});

test("quiet text meets WCAG AA contrast on the canvas", () => {
  const quiet = css.match(/--quiet:\s*(#[0-9a-f]{6})/i)?.[1];
  const canvas = css.match(/--canvas:\s*(#[0-9a-f]{6})/i)?.[1];
  const luminance = (hex) => {
    const channels = hex.match(/[0-9a-f]{2}/gi).map((value) => parseInt(value, 16) / 255);
    const linear = channels.map((value) =>
      value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    );
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  };
  const light = Math.max(luminance(quiet), luminance(canvas));
  const dark = Math.min(luminance(quiet), luminance(canvas));

  assert.ok((light + 0.05) / (dark + 0.05) >= 4.5);
});

test("supporting interface text remains readable", () => {
  assert.doesNotMatch(css, /font-size:\s*0\.6[0-9]rem/);
  assert.doesNotMatch(css, /font-size:\s*0\.7[0-3]rem/);
});

test("Aster is a compact lab entry with literal interest controls", () => {
  assert.match(html, /class="lab-entry" data-lab-item="aster"/);
  assert.match(html, /<h2[^>]*>Aster<\/h2>/);
  assert.match(html, /data-interest-button/);
  assert.match(html, /aria-label="Thumbs up for Aster"/);
  assert.match(html, /data-interest-form[^>]*hidden/);
  assert.match(html, /Get Aster release updates/);
  assert.match(html, /src="\.\/assets\/aster-real\.mp4"/);
  assert.match(html, /poster="\.\/assets\/aster-real\.png"/);
  assert.ok(fs.existsSync(path.join(root, "assets", "aster-real.mp4")));
  assert.ok(fs.existsSync(path.join(root, "assets", "aster-real.png")));
  assert.match(html, /affected targets across a polyglot monorepo/);
  assert.match(html, /automatic\s+dependency order/);
  assert.match(html, /work implied by a change/);
  assert.match(html, /3 projects discovered; 1 changed file; 2 affected projects; 3 passed/);
});

test("Astrodev is a distinct custom harness lab entry grounded in shipped features", () => {
  assert.match(html, /class="lab-entry" data-lab-item="astrodev"/);
  assert.match(html, /<h2[^>]*>AstroDev<\/h2>/);
  assert.match(html, /Bring a deployed ArchAgent's identity and linked skills into your local coding loop/);
  assert.match(html, /2\/2 tests pass; diff inspected; review clean/);
  assert.doesNotMatch(html, /mutation-tests|sampled mutations|4\/4 tests pass/);
  assert.doesNotMatch(html, /permission-gated platform tools|delegation|resumable sessions/);
  assert.match(html, /Shipped with ArchAgent[^<]*open-source candidate/);
  assert.match(html, /aria-label="Thumbs up for AstroDev"/);
  assert.match(html, /id="astrodev-email"/);
  assert.match(html, /src="\.\/assets\/astrodev-real\.mp4"/);
  assert.match(html, /poster="\.\/assets\/astrodev-real\.png"/);
  assert.match(html, /class="lab-product-link" href="https:\/\/archagents\.com"/);
  assert.ok(fs.existsSync(path.join(root, "assets", "astrodev-real.mp4")));
  assert.ok(fs.existsSync(path.join(root, "assets", "astrodev-real.png")));
});

test("each lab item has independent interest controls and email labels", () => {
  assert.equal((html.match(/data-lab-item=/g) || []).length, 2);
  assert.equal((html.match(/data-interest-button/g) || []).length, 2);
  assert.equal((html.match(/data-interest-form/g) || []).length, 2);
  assert.equal((html.match(/id="aster-email"/g) || []).length, 1);
  assert.equal((html.match(/for="aster-email"/g) || []).length, 1);
  assert.equal((html.match(/id="astrodev-email"/g) || []).length, 1);
  assert.equal((html.match(/for="astrodev-email"/g) || []).length, 1);
  assert.equal((html.match(/name="broader_updates"/g) || []).length, 2);
  assert.equal((html.match(/data-broader-updates/g) || []).length, 2);
  assert.doesNotMatch(html, /name="broader_updates"[^>]*checked/);
});

test("lab signup consent is explicit before submission", () => {
  assert.match(html, /Get Aster release updates/);
  assert.match(html, /Get AstroDev release updates/);
  assert.equal((html.match(/Also send me broader ArchAstro updates, including open source/g) || []).length, 2);
  assert.match(html, /href="https:\/\/archastro\.ai\/privacy"/);
  assert.doesNotMatch(html, /Unsubscribe anytime/);
});

test("interest status remains visible independently of the email form", () => {
  const interest = html.slice(
    html.indexOf('<div class="lab-interest">'),
    html.indexOf("</article>", html.indexOf('<div class="lab-interest">'))
  );
  const formEnd = interest.indexOf("</form>");
  const noteIndex = interest.indexOf("data-interest-note");

  assert.ok(formEnd >= 0 && noteIndex > formEnd);
  assert.match(interest, /data-interest-note[^>]*aria-live="polite"/);
});

test("clipboard control has an accessible live status", () => {
  assert.match(html, /data-copy-status[^>]*aria-live="polite"/);
});

test("header reuses the ArchAstro company shell", () => {
  assert.match(html, /<header class="site-header" aria-label="Header">/);
  assert.match(html, /class="site-header__bar"/);
  assert.match(html, /class="site-brand__name">ArchAstro/);
  assert.match(html, /href="https:\/\/archastro\.ai\/team">Team/);
  assert.match(html, /href="https:\/\/archagents\.com\/login">Log in/);
  assert.match(html, /class="site-nav__link site-nav__link--accent"[^>]*>Book a demo/);
  assert.match(css, /\.site-header\s*{[^}]*position:\s*sticky;[^}]*top:\s*0;/);
});

test("footer reuses ArchAstro company and legal links", () => {
  assert.match(html, /<footer class="site-footer" aria-label="Footer">/);
  assert.match(html, /class="site-footer__bar"/);
  assert.match(html, /&copy; 2026 ArchAstro/);
  assert.match(html, /href="https:\/\/developers\.archastro\.ai">Platform/);
  assert.match(html, /href="https:\/\/archastro\.ai\/privacy">Privacy Policy/);
  assert.match(html, /href="https:\/\/archastro\.ai\/terms">Terms of Service/);
});

test("mobile install command remains readable instead of truncating", () => {
  assert.match(css, /@media\s*\(max-width:\s*560px\)[\s\S]*?\.install-command code\s*{[^}]*white-space:\s*normal;[^}]*overflow-wrap:\s*anywhere;/);
});
