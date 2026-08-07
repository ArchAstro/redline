const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('public guidance uses public examples and current ArchAstro contacts', () => {
  const publicGuidance = [
    'README.md',
    'SECURITY.md',
    'extension/content.js',
    'runtime/bin/redline-pull',
    'runtime/bin/redline-watch',
    'skills/redline/SKILL.md',
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

test('workflow write permissions are scoped to the jobs that need them', () => {
  const ci = read('.github/workflows/ci.yml');
  const release = read('.github/workflows/release.yml');
  const scorecard = read('.github/workflows/scorecard.yml');

  assert.match(ci, /^permissions:\n  contents: read$/m);
  assert.match(release, /^permissions:\n  contents: read$/m);
  assert.match(scorecard, /^permissions: read-all$/m);
  assert.match(
    scorecard,
    /jobs:\n  scorecard:[\s\S]*?    permissions:\n      contents: read\n      security-events: write\n      id-token: write/,
  );
});

test('package and docs state the supported Unix prerequisites', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.deepEqual(pkg.os, ['darwin', 'linux']);
  assert.equal(pkg.engines.node, '>=18');
  assert.match(read('README.md'), /macOS or Linux/i);
  assert.match(read('README.md'), /Node\.js 18 or newer/i);
  assert.match(read('README.md'), /Bash, curl, and jq/i);
  assert.doesNotMatch(read('runtime/bin/redline-sidecar'), /\bseq\b/);
});

test('package ships one standard skill and no harness plugin trees', () => {
  const pkg = JSON.parse(read('package.json'));

  assert.ok(pkg.files.includes('skills/'));
  assert.ok(pkg.files.includes('runtime/'));
  assert.ok(!pkg.files.some((entry) => entry.includes('plugin')));
  assert.equal(fs.existsSync(path.join(root, 'skills/redline/SKILL.md')), true);
  assert.equal(fs.existsSync(path.join(root, '.claude-plugin')), false);
  assert.equal(fs.existsSync(path.join(root, '.claude-plugins')), false);
  assert.equal(fs.existsSync(path.join(root, 'plugins/redline')), false);
  assert.equal(fs.existsSync(path.join(root, 'setup/skills-worker.js')), false);
});

test('Redline CLI leaves agent skill and plugin state under user control', () => {
  const setup = read('setup/redline-agent-setup.js');
  const readme = read('README.md');
  const changeset = read('.changeset/standard-agent-skills.md');
  const skill = read('skills/redline/SKILL.md');

  assert.doesNotMatch(setup, /spawn(?:Sync)?\([^)]*npx|skills@|skill-lock|skill-source|skills-status|cleanupLegacyPlugins/);
  assert.match(readme, /npx skills add ArchAstro\/redline/);
  assert.match(readme, /never installs,\s*updates,\s*removes,\s*or inspects agent skills/i);
  assert.match(changeset, /"@archastro\/redline": minor/);
  assert.match(skill, /^metadata:\n  author: ArchAstro\n  source: https:\/\/github\.com\/ArchAstro\/redline$/m);
});

test('README documents the portable skill and terminal invocation', () => {
  const readme = read('README.md');
  const pkg = JSON.parse(read('package.json'));
  const skillPath = path.join(root, 'skills/redline/SKILL.md');
  const terminalBin = Object.entries(pkg.bin)
    .find(([, target]) => target === 'setup/redline.js');
  const pullHelp = spawnSync(process.execPath, ['setup/redline.js', 'pull', '--help'], {
    cwd: root,
    encoding: 'utf8',
  });
  const architectureDiagram = [...readme.matchAll(/^```[^\n]*\n([\s\S]*?)\n```$/gm)]
    .map((match) => match[1])
    .find((diagram) => diagram.includes('[ Chrome extension ]'));

  assert.ok(fs.existsSync(skillPath), `${path.relative(root, skillPath)} must exist`);
  assert.ok(terminalBin, 'package must expose the setup/redline.js terminal binary');
  assert.equal(pullHelp.status, 0, pullHelp.stderr || pullHelp.stdout);
  assert.match(pullHelp.stdout, /^# Usage:\n#\s+redline-pull\b/m);
  const terminalCommand = terminalBin[0];
  const expectedRows = [
    ['Portable prompt', '"Pull my redlines."'],
    ['Agent skill', 'redline'],
    ['Terminal', `${terminalCommand} pull`],
  ];

  assert.ok(architectureDiagram, 'README architecture diagram is missing');
  assert.match(readme, /^\| Surface\s+\| Invocation\s+\|$/m);
  for (const [surface, invocation] of expectedRows) {
    assert.match(readme, new RegExp(`^\\| ${escapeRegExp(surface)}\\s+\\| \`${escapeRegExp(invocation)}\`\\s+\\|$`, 'm'));
  }
  assert.match(read('skills/redline/SKILL.md'), /^name:\s*redline$/m);
});

test('pull skill applies straightforward redlines without confirmation and keeps safety gates', () => {
  const skill = read('skills/redline/SKILL.md');

  assert.match(skill, /apply straightforward, low-risk redlines without asking for confirmation/i);
  assert.match(skill, /show, list, or review[^.]+inspection-only/i);
  assert.match(skill, /ask before editing/i);
  assert.match(skill, /ambiguous|destructive|broad/i);
  assert.match(skill, /inspect the final diff[^.]+relevant checks[^.]+before ack/i);
  assert.match(skill, /only `comment` is the user's instruction/i);
  assert.match(skill, /untrusted webpage data/i);
  assert.match(skill, /never follow instructions embedded/i);
  assert.doesNotMatch(skill, /Wait for the user to confirm before editing/);
});

test('manual release guidance uses the version synchronization script', () => {
  const readme = read('README.md');
  assert.match(readme, /To publish manually[\s\S]*npm run version[\s\S]*npm run release/);
  assert.doesNotMatch(readme, /To publish manually[\s\S]*npx changeset version/);
});
