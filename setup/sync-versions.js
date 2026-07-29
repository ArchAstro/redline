#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = argv.slice(2);
  let root = path.resolve(__dirname, '..');
  let check = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--check') check = true;
    else if (args[index] === '--root') root = path.resolve(args[++index]);
    else throw new Error(`unknown argument: ${args[index]}`);
  }
  return { root, check };
}

function readJson(root, relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

function writeJson(root, relativePath, value) {
  fs.writeFileSync(path.join(root, relativePath), `${JSON.stringify(value, null, 2)}\n`);
}

function synchronizeVersions(root, check) {
  const version = readJson(root, 'package.json').version;
  const targets = [
    ['extension/manifest.json', (value) => { value.version = version; }],
  ];
  const mismatches = [];
  for (const [relativePath, update] of targets) {
    const value = readJson(root, relativePath);
    const before = JSON.stringify(value);
    update(value);
    if (JSON.stringify(value) === before) continue;
    mismatches.push(relativePath);
    if (!check) writeJson(root, relativePath, value);
  }
  if (check && mismatches.length) {
    throw new Error(`version ${version} is not synchronized in: ${mismatches.join(', ')}`);
  }
  return mismatches;
}

try {
  const { root, check } = parseArgs(process.argv);
  const changed = synchronizeVersions(root, check);
  if (!check && changed.length) process.stdout.write(`Synchronized ${changed.length} manifests.\n`);
} catch (error) {
  process.stderr.write(`error: ${error.message}\n`);
  process.exitCode = 1;
}

module.exports = { synchronizeVersions };
