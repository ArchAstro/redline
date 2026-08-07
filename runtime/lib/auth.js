'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function randomSecret(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function hashSecret(secret) {
  if (typeof secret !== 'string' || secret.length === 0) return null;
  return `sha256:${crypto.createHash('sha256').update(secret, 'utf8').digest('hex')}`;
}

function verifySecret(secret, expectedHash) {
  const actualHash = hashSecret(secret);
  if (!actualHash || typeof expectedHash !== 'string') return false;
  const actual = Buffer.from(actualHash, 'utf8');
  const expected = Buffer.from(expectedHash, 'utf8');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function bearerToken(header) {
  if (typeof header !== 'string') return null;
  const match = /^Bearer ([A-Za-z0-9_-]{32,})$/.exec(header);
  return match ? match[1] : null;
}

function readPrivateCredential(file) {
  const directory = path.dirname(file);
  const directoryBefore = fs.lstatSync(directory);
  if (!directoryBefore.isDirectory() || directoryBefore.isSymbolicLink() || (directoryBefore.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' && directoryBefore.uid !== process.getuid())) {
    throw new Error('credential directory is not private');
  }
  const directoryFd = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(directoryFd);
    if (!opened.isDirectory() || opened.dev !== directoryBefore.dev || opened.ino !== directoryBefore.ino) {
      throw new Error('credential directory changed while opening');
    }
  } finally { fs.closeSync(directoryFd); }
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || (before.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' && before.uid !== process.getuid())) {
    throw new Error('credential file is not a private regular file');
  }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error('credential file changed while opening');
    }
    const token = fs.readFileSync(fd, 'utf8').trim();
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(token)) throw new Error('credential file is invalid');
    return token;
  } finally { fs.closeSync(fd); }
}

module.exports = { bearerToken, hashSecret, randomSecret, readPrivateCredential, verifySecret };
