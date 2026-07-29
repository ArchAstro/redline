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
  redline setup      Sync local Chrome extension files
  redline setup --with-screenshots
                     Enable full visual redlines on normal websites
  redline start      Start the local sidecar
  redline status     Check extension files, Chrome reload state, and sidecar
  redline pull       Print pending redlines for your agent

Common commands:
  setup [flags]      Configure the extension. Example: redline setup --dry-run
                     Use --with-screenshots for screenshots and all http/https pages
                     Use --local-only to switch back to low-permission local pages
  status             Run Chrome extension and sidecar diagnostics
  start              Start the sidecar in the background
  stop               Stop the sidecar
  restart            Restart the sidecar
  logs [-f]          Show sidecar logs
  pull [filters]     Fetch pending redlines
  watch              Poll for new pending redlines
  tail               Dump local redline store for debugging
  clear              Wipe the local redline store

Chrome extension:
  Open chrome://extensions, enable Developer mode, click Load unpacked,
  and choose ~/.redline/extension after running "redline setup".

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
