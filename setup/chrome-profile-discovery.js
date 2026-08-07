'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validExtensionId } = require('../runtime/lib/extension-identity');

const MAX_PROFILE_ROOTS = 4;
const MAX_VERSION_ENTRIES = 64;
const MAX_PROFILE_JSON_BYTES = 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;

function defaultProfileRoots(platform = process.platform, home = os.homedir()) {
  if (platform === 'darwin') return [
    path.join(home, 'Library/Application Support/Google/Chrome'),
    path.join(home, 'Library/Application Support/Chromium'),
  ];
  if (platform === 'linux') return [
    path.join(home, '.config/google-chrome'),
    path.join(home, '.config/chromium'),
  ];
  return [];
}

function realDirectory(file, label, fsImpl) {
  const stat = fsImpl.lstatSync(file);
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
  if (!stat.isDirectory()) throw new Error(`${label} must be a directory`);
}

function readRealJson(file, label, fsImpl, maxBytes = MAX_PROFILE_JSON_BYTES) {
  const before = fsImpl.lstatSync(file);
  if (before.isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
  if (!before.isFile() || before.nlink !== 1) throw new Error(`${label} must be a regular file`);
  if (before.size > maxBytes) throw new Error(`${label} is oversized; Chrome profile scan limit exceeded`);
  const fd = fsImpl.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fsImpl.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`${label} changed while opening`);
    }
    const chunks = [];
    let total = 0;
    while (total <= maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
      const bytesRead = fsImpl.readSync(fd, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      chunks.push(chunk.subarray(0, bytesRead));
    }
    if (total > maxBytes) throw new Error(`${label} is oversized; Chrome profile scan limit exceeded`);
    const after = fsImpl.fstatSync(fd);
    if (!after.isFile() || after.nlink !== 1 || after.dev !== opened.dev || after.ino !== opened.ino ||
        after.size !== opened.size) {
      throw new Error(`${label} changed while reading`);
    }
    return JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`malformed Chrome profile ${label}`);
    throw error;
  } finally { fsImpl.closeSync(fd); }
}

function versionDirectoryMatchesManifest(directoryName, manifestVersion) {
  if (typeof directoryName !== 'string' || typeof manifestVersion !== 'string' ||
      !/^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){0,3}$/.test(manifestVersion)) return false;
  if (directoryName === manifestVersion) return true;
  const prefix = `${manifestVersion}_`;
  return directoryName.startsWith(prefix) && /^(?:0|[1-9]\d*)$/.test(directoryName.slice(prefix.length));
}

function findInstalledExtension({ extensionId, profileRoots, platform, home, fsImpl = fs } = {}) {
  if (!validExtensionId(extensionId)) throw new Error('Chrome Web Store identity configuration is invalid');
  const roots = profileRoots || defaultProfileRoots(platform, home);
  if (!Array.isArray(roots) || roots.length > MAX_PROFILE_ROOTS) throw new Error('Chrome profile root scan limit exceeded');
  for (const root of roots) {
    if (!fsImpl.existsSync(root)) continue;
    realDirectory(root, 'Chrome profile root', fsImpl);
    const localStateFile = path.join(root, 'Local State');
    if (!fsImpl.existsSync(localStateFile)) continue;
    const localState = readRealJson(localStateFile, 'Chrome Local State', fsImpl);
    const activeProfile = localState?.profile?.last_used;
    if (activeProfile !== 'Default' && !/^Profile [1-9]\d*$/.test(activeProfile || '')) continue;
    const profile = path.join(root, activeProfile);
    if (!fsImpl.existsSync(profile)) continue;
    realDirectory(profile, 'Chrome profile directory', fsImpl);
    const preferencesFile = path.join(profile, 'Preferences');
    if (!fsImpl.existsSync(preferencesFile)) continue;
    const preferences = readRealJson(preferencesFile, 'Preferences', fsImpl);
    if (preferences?.extensions?.settings?.[extensionId]?.state !== 1) continue;
    const extensionRoot = path.join(profile, 'Extensions', extensionId);
    if (!fsImpl.existsSync(extensionRoot)) continue;
    realDirectory(path.join(profile, 'Extensions'), 'Chrome Extensions directory', fsImpl);
    realDirectory(extensionRoot, 'Chrome extension directory', fsImpl);
    const versionEntries = fsImpl.readdirSync(extensionRoot, { withFileTypes: true });
    if (versionEntries.length > MAX_VERSION_ENTRIES) throw new Error('Chrome extension version scan limit exceeded');
    for (const versionEntry of versionEntries) {
      if (!/^\d+(?:\.\d+){0,3}(?:_\d+)?$/.test(versionEntry.name)) continue;
      const versionRoot = path.join(extensionRoot, versionEntry.name);
      realDirectory(versionRoot, 'Chrome extension version directory', fsImpl);
      const manifestFile = path.join(versionRoot, 'manifest.json');
      if (!fsImpl.existsSync(manifestFile)) continue;
      const manifest = readRealJson(manifestFile, 'extension manifest', fsImpl, MAX_MANIFEST_BYTES);
      if (manifest?.manifest_version === 3 && manifest.name === 'Redline' &&
          versionDirectoryMatchesManifest(versionEntry.name, manifest.version)) return true;
    }
  }
  return false;
}

module.exports = { defaultProfileRoots, findInstalledExtension };
