const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('public guidance uses public examples and current ArchAstro contacts', () => {
  const publicGuidance = [
    'README.md',
    'SECURITY.md',
    'extension/content.js',
    '.claude-plugins/redline/bin/redline-pull',
    '.claude-plugins/redline/bin/redline-watch',
    '.claude-plugins/redline/skills/pull/SKILL.md',
    'plugins/redline/bin/redline-pull',
    'plugins/redline/bin/redline-watch',
    'plugins/redline/skills/pull/SKILL.md',
  ].map(read).join('\n');

  assert.doesNotMatch(publicGuidance, /firstlanding|security@archastro\.com|~\/archastro\/redline/i);
  assert.match(read('SECURITY.md'), /security@archastro\.ai/);
});

test('maintainer guidance matches the actual CI-gated merge policy', () => {
  const contributing = read('CONTRIBUTING.md');
  assert.match(contributing, /pull requests and the `Test` CI check/i);
  assert.match(contributing, /no mandatory approval/i);
  assert.doesNotMatch(contributing, /required PR review/i);
  assert.match(read('.github/CODEOWNERS'), /@ArchAstro\/core/);
});

test('release automation uses the tested Node version and lockfile installs', () => {
  const release = read('.github/workflows/release.yml');
  const ci = read('.github/workflows/ci.yml');
  assert.match(release, /node-version:\s*['"]24['"]/);
  assert.match(release, /run:\s*npm ci --no-audit --no-fund/);
  assert.match(ci, /run:\s*npm ci --no-audit --no-fund/);
  assert.match(ci, /git diff --check/);
  assert.match(release, /npm test[\s\S]*npm run check:syntax[\s\S]*npm run check:versions[\s\S]*npm pack --dry-run[\s\S]*changesets\/action/);
});

test('GitHub Actions dependencies are pinned to immutable commits', () => {
  const workflows = fs.readdirSync(path.join(root, '.github/workflows'))
    .filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
    .map((file) => read(path.join('.github/workflows', file)))
    .join('\n');
  const refs = [...workflows.matchAll(/uses:\s*[^\s@]+@([^\s#]+)/g)].map((match) => match[1]);
  assert.ok(refs.length > 0);
  assert.ok(refs.every((ref) => /^[0-9a-f]{40}$/.test(ref)), `mutable action refs: ${refs.join(', ')}`);
});

test('package and docs state the supported Unix prerequisites', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.deepEqual(pkg.os, ['darwin', 'linux']);
  assert.match(read('README.md'), /macOS or Linux/i);
  assert.match(read('README.md'), /Bash, curl, and jq/i);
  assert.doesNotMatch(read('.claude-plugins/redline/bin/redline-sidecar'), /\bseq\b/);
});

test('pull skill applies straightforward redlines without confirmation and keeps safety gates', () => {
  const claudeSkill = read('.claude-plugins/redline/skills/pull/SKILL.md');
  const codexSkill = read('plugins/redline/skills/pull/SKILL.md');

  assert.equal(codexSkill, claudeSkill);
  assert.match(codexSkill, /apply straightforward, low-risk redlines without asking for confirmation/i);
  assert.match(codexSkill, /show, list, or review[^.]+inspection-only/i);
  assert.match(codexSkill, /ask before editing/i);
  assert.match(codexSkill, /ambiguous|destructive|broad/i);
  assert.match(codexSkill, /inspect the final diff[^.]+relevant checks[^.]+before ack/i);
  assert.doesNotMatch(codexSkill, /Wait for the user to confirm before editing/);
});
