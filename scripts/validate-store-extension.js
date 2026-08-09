#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadExtensionIdentity } = require('../runtime/lib/extension-identity');

const STORE_FILES = [
  'manifest.json',
  'background.js',
  'permissions.js',
  'revocations.js',
  'connect.js',
  'connection.js',
  'content.js',
  'content.css',
  'onboarding.html',
  'onboarding.css',
  'onboarding.js',
  'popup.html',
  'popup.css',
  'popup.js',
  'icon-128.png',
];

function readRegularFileNoFollow(file, label) {
  const before = fs.lstatSync(file);
  if (before.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
  if (!before.isFile()) throw new Error(`${label} is not a regular file`);
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`${label} changed while it was being read`);
    }
    return fs.readFileSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function validateStoreExtension(root = path.resolve(__dirname, '..')) {
  const pkg = JSON.parse(readRegularFileNoFollow(path.join(root, 'package.json'), 'package.json'));
  const identity = loadExtensionIdentity(path.join(root, 'config/extension-identity.json'));
  const entries = STORE_FILES.map((name) => [
    name,
    readRegularFileNoFollow(path.join(root, 'extension', name), `extension/${name}`),
  ]);
  const manifest = JSON.parse(entries[0][1].toString('utf8'));

  if (manifest.manifest_version !== 3) throw new Error('Store manifest must use Manifest V3');
  if (manifest.version !== pkg.version) throw new Error('Store manifest version must match package.json');
  if (manifest.key !== undefined) throw new Error('Store manifest must not embed a development key');
  if (JSON.stringify(manifest.host_permissions) !== JSON.stringify(['http://127.0.0.1:7878/*'])) {
    throw new Error('Store manifest must use the exact loopback host permission');
  }
  if (JSON.stringify(manifest.optional_host_permissions) !== JSON.stringify(['<all_urls>'])) {
    throw new Error('Store manifest must keep broad page access optional');
  }
  if (!manifest.icons || manifest.icons['128'] !== 'icon-128.png' ||
      manifest.action?.default_icon?.['128'] !== 'icon-128.png') {
    throw new Error('Store manifest must reference the reviewed product icon');
  }

  const text = entries
    .filter(([name]) => !name.endsWith('.png'))
    .map(([, contents]) => contents.toString('utf8'))
    .join('\n');
  if (/__REDLINE_AUTH_TOKEN__|BEGIN (?:RSA )?PRIVATE KEY|REDLINE_DEV_MODE|sourceMappingURL=/.test(text)) {
    throw new Error('Store package contains development or private material');
  }
  if (/\b(?:eval|Function)\s*\(/.test(text)) throw new Error('Store package contains dynamic code execution');

  return { entries, extensionId: identity.extensionId, version: pkg.version };
}

if (require.main === module) {
  try {
    const result = validateStoreExtension();
    process.stdout.write(`Chrome Store package ${result.version} validated for ${result.extensionId}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { STORE_FILES, readRegularFileNoFollow, validateStoreExtension };
