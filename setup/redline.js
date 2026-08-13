#!/usr/bin/env node
// Friendly top-level CLI for people installing @archastro/redline.

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { inspectInstalledExtension } = require('./chrome-profile-discovery');
const { loadExtensionIdentity } = require('../runtime/lib/extension-identity');
const { healthProbe } = require('../runtime/lib/sidecar-lifecycle');

const ROOT = path.resolve(__dirname, '..');
const SETUP = path.join(ROOT, 'setup/redline-agent-setup.js');
const BIN_DIR = path.join(ROOT, 'runtime/bin');
const PACKAGE = require('../package.json');

const COMMANDS = {
  start: ['redline-sidecar', ['start']],
  stop: ['redline-sidecar', ['stop']],
  restart: ['redline-sidecar', ['restart']],
  logs: ['redline-sidecar', ['logs']],
  foreground: ['redline-sidecar', ['foreground']],
  fg: ['redline-sidecar', ['fg']],
  run: ['redline-sidecar', ['run']],
  pull: ['redline-pull', []],
  watch: ['redline-watch', []],
  tail: ['redline-tail', []],
  clear: ['redline-clear', []],
};

function parseCliPort() {
  const port = Number.parseInt(process.env.REDLINE_PORT || '7878', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}

function inspectStoreExtension() {
  try {
    const identity = loadExtensionIdentity(path.join(ROOT, 'config/extension-identity.json'));
    return inspectInstalledExtension({ extensionId: identity.extensionId });
  } catch {
    return { status: 'missing', version: null, profile: null, source: null };
  }
}

function formatExtensionLine(inspection) {
  if (inspection.status === 'enabled') {
    return `extension: ${inspection.version} enabled (${inspection.profile})`;
  }
  if (inspection.status === 'disabled') {
    return `extension: ${inspection.version || 'unknown'} disabled (${inspection.profile})`;
  }
  return 'extension: not found in the active Chrome profile';
}

function formatHelperLine(helper) {
  if (helper?.kind === 'compatible') {
    return `helper: ${helper.packageVersion || 'unknown'} up`;
  }
  if (helper?.kind === 'incompatible') return 'helper: incompatible';
  return 'helper: down';
}

async function printVersion() {
  const port = parseCliPort();
  const helper = port === null ? { kind: 'incompatible' } : await healthProbe(port);
  const inspection = inspectStoreExtension();
  process.stdout.write([
    `@archastro/redline ${PACKAGE.version}`,
    `cli: ${PACKAGE.version}`,
    formatHelperLine(helper),
    formatExtensionLine(inspection),
  ].join('\n') + '\n');
}

function printHelp() {
  process.stdout.write(`Redline

Quick start:
  redline setup      Start the local helper and pair the Chrome extension
  redline status     Check extension presence and helper health
  redline start      Start the local helper
  redline pull       Print pending redlines for your agent

Common commands:
  setup [flags]      Configure or pair the Chrome extension
  status             Check Chrome extension presence and helper health
  version            Print CLI, helper, and extension versions
  start              Start the helper in the background
  stop               Stop the helper
  restart            Restart the helper
  logs [-f]          Show helper logs
  pull [filters]     Fetch pending redlines
  watch              Poll for new pending redlines
  tail               Dump local redline store for debugging
  clear              Wipe the local redline store

Chrome extension:
  Install Redline from the Chrome Web Store, then run "redline setup".
  Setup opens a short-lived local consent page to pair the extension.
  Contributors can use the isolated unpacked workflow in CONTRIBUTING.md.

More help:
  redline setup --help
  redline pull --help
`);
}

function runNode(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], { stdio: 'inherit' });
  if (result.error) {
    process.stderr.write(`failed to run ${script}: ${result.error.message}\n`);
  }
  process.exit(result.status === null ? 1 : result.status);
}

function runScript(name, args) {
  const script = path.join(BIN_DIR, name);
  const result = spawnSync(script, args, { stdio: 'inherit' });
  if (result.error) {
    process.stderr.write(`failed to run ${script}: ${result.error.message}\n`);
  }
  process.exit(result.status === null ? 1 : result.status);
}

function main(argv) {
  const [cmd = 'help', ...args] = argv.slice(2);

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    printHelp();
    return;
  }

  if (cmd === 'version' || cmd === '--version' || cmd === '-V') {
    printVersion().catch((error) => {
      process.stderr.write(`failed to read Redline versions: ${error.message}\n`);
      process.exit(1);
    });
    return;
  }

  if (cmd === 'setup') {
    runNode(SETUP, args);
    return;
  }

  if (cmd === 'status' || cmd === 'doctor') {
    runNode(SETUP, ['--extension-status', ...args]);
    return;
  }

  const delegated = COMMANDS[cmd];
  if (delegated) {
    const [script, defaultArgs] = delegated;
    runScript(script, [...defaultArgs, ...args]);
    return;
  }

  process.stderr.write(`unknown command: ${cmd}\n\n`);
  printHelp();
  process.exit(1);
}

main(process.argv);
