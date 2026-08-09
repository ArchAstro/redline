#!/usr/bin/env node
// Friendly top-level CLI for people installing @archastro/redline.

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SETUP = path.join(ROOT, 'setup/redline-agent-setup.js');
const BIN_DIR = path.join(ROOT, 'runtime/bin');

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
