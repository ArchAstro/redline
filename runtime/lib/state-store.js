'use strict';

const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { hashSecret, randomSecret, verifySecret } = require('./auth');

const STATE_VERSION = 1;
const PAIRING_TTL_MS = 10 * 60 * 1000;
const SECRET_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const LOCK_STALE_MS = 100;

function defaultState() {
  return { version: STATE_VERSION, cli_hash: null, pairing: null, clients: {}, clear_generation: 0 };
}

function validateState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== STATE_VERSION ||
      !Number.isSafeInteger(value.clear_generation) || value.clear_generation < 0 ||
      !value.clients || typeof value.clients !== 'object' || Array.isArray(value.clients)) {
    throw new Error('Redline state has an invalid schema; refusing to overwrite it');
  }
  if (value.cli_hash !== null && (typeof value.cli_hash !== 'string' || !SECRET_HASH_PATTERN.test(value.cli_hash))) {
    throw new Error('Redline state has an invalid CLI credential hash; refusing to overwrite it');
  }
  if (value.pairing !== null && (!value.pairing || typeof value.pairing !== 'object' ||
      typeof value.pairing.hash !== 'string' || !SECRET_HASH_PATTERN.test(value.pairing.hash) ||
      typeof value.pairing.expires_at !== 'string' || !Number.isFinite(Date.parse(value.pairing.expires_at)))) {
    throw new Error('Redline state has invalid pairing state; refusing to overwrite it');
  }
  for (const [id, client] of Object.entries(value.clients)) {
    if (!/^rlc_[0-9a-f]{32}$/.test(id) || !client || typeof client !== 'object' ||
        typeof client.token_hash !== 'string' || !SECRET_HASH_PATTERN.test(client.token_hash) ||
        typeof client.created_at !== 'string' || !Number.isFinite(Date.parse(client.created_at))) {
      throw new Error('Redline state has invalid browser client state; refusing to overwrite it');
    }
  }
  return value;
}

function inspectRegular(file, label) {
  let before;
  try { before = fs.lstatSync(file); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`${label} must be a regular file; symlinks are refused`);
  if (before.nlink !== 1) throw new Error(`${label} has multiple links; refusing hard-linked state`);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`${label} changed while opening`);
    }
    fs.fchmodSync(fd, 0o600);
    return fs.readFileSync(fd, 'utf8');
  } finally { fs.closeSync(fd); }
}

function readProcessIdentity(pid) {
  try {
    if (process.platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const close = stat.lastIndexOf(')');
      if (close < 0) return null;
      const fields = stat.slice(close + 2).split(' ');
      return fields[19] || null;
    }
    return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch { return null; }
}

function inspectLock(directory) {
  let before;
  try { before = fs.lstatSync(directory); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error('Redline state lock must be a real directory; symlinks are refused');
  }
  let fd;
  try { fd = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isDirectory() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error('Redline state lock changed while opening');
    }
  } finally { fs.closeSync(fd); }

  try {
    const names = fs.readdirSync(directory).sort();
    if (names.length > 2 || names.some((name) => !['owner.json', 'owner.tmp'].includes(name))) {
      throw new Error('Redline state lock contains unexpected entries');
    }
    const entries = [];
    for (const name of names) {
      const file = path.join(directory, name);
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Redline state lock owner must be a regular file; symlinks are refused');
      if (stat.nlink !== 1) throw new Error('Redline state lock owner has multiple links; refusing hard link');
      if (stat.size > 2048) throw new Error('Redline state lock owner is oversized');
      const contents = inspectRegular(file, 'Redline state lock owner');
      entries.push({ name, dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs, size: stat.size, contents });
    }
    let owner = null;
    const published = entries.find((entry) => entry.name === 'owner.json');
    if (published) {
      try { owner = JSON.parse(published.contents); } catch {}
      if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid < 1 ||
          !/^[0-9a-f]{32}$/.test(owner.nonce || '') || typeof owner.process_start !== 'string' || !owner.process_start) owner = null;
    }
    const newestMtime = Math.max(before.mtimeMs, ...entries.map((entry) => entry.mtimeMs));
    const snapshot = JSON.stringify({
      dev: before.dev, ino: before.ino, mtimeMs: before.mtimeMs,
      entries: entries.map(({ name, dev, ino, mtimeMs, size, contents }) => ({ name, dev, ino, mtimeMs, size, contents })),
    });
    return { before, entries, newestMtime, owner, snapshot };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function removeInspectedLock(directory, inspected) {
  const current = inspectLock(directory);
  if (!current || current.snapshot !== inspected.snapshot) throw new Error('Redline state lock changed before removal');
  for (const entry of current.entries) fs.unlinkSync(path.join(directory, entry.name));
  const final = fs.lstatSync(directory);
  if (!final.isDirectory() || final.isSymbolicLink() || final.dev !== inspected.before.dev || final.ino !== inspected.before.ino) {
    throw new Error('Redline state lock changed before removal');
  }
  fs.rmdirSync(directory);
}

function fsyncDirectory(dir) {
  const fd = fs.openSync(dir, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function atomicWrite(file, contents) {
  const dir = path.dirname(file);
  const tmp = `${file}.tmp.${process.pid}.${crypto.randomBytes(8).toString('hex')}`;
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL |
    (fs.constants.O_NOFOLLOW || 0), 0o600);
  try {
    fs.writeFileSync(fd, contents);
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1) throw new Error('temporary Redline state is not privately owned');
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  try {
    const existing = inspectRegular(file, path.basename(file));
    void existing;
    fs.renameSync(tmp, file);
    fs.chmodSync(file, 0o600);
    fsyncDirectory(dir);
  } finally { fs.rmSync(tmp, { force: true }); }
}

class StateStore {
  constructor(root, {
    now = () => Date.now(), secretFactory = randomSecret, processIdentity = readProcessIdentity,
    lockFault = () => {}, lockNow = () => Date.now(), lockStaleMs = LOCK_STALE_MS,
  } = {}) {
    this.root = path.resolve(root);
    this.stateFile = path.join(this.root, 'state.json');
    this.cliFile = path.join(this.root, 'cli-credential');
    this.lockFile = path.join(this.root, 'state.lock');
    this.now = now;
    this.secretFactory = secretFactory;
    this.processIdentity = processIdentity;
    this.lockFault = lockFault;
    this.lockNow = lockNow;
    this.lockStaleMs = lockStaleMs;
    this.queue = Promise.resolve();
  }

  _serialized(operation) {
    const run = async () => {
      this._ensureRoot();
      const release = await this._acquireLock();
      try { return operation(); } finally { release(); }
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }

  async _acquireLock() {
    const owner = {
      pid: process.pid,
      nonce: crypto.randomBytes(16).toString('hex'),
      process_start: this.processIdentity(process.pid),
    };
    if (!owner.process_start) throw new Error('cannot establish Redline state lock process identity');
    const ownerContents = `${JSON.stringify(owner)}\n`;
    let priorStableSnapshot = null;
    for (let attempt = 0; attempt < 500; attempt += 1) {
      try {
        this.lockFault('before-create');
        fs.mkdirSync(this.lockFile, { mode: 0o700 });
        this.lockFault('after-create');
        const temporaryOwner = path.join(this.lockFile, 'owner.tmp');
        const fd = fs.openSync(temporaryOwner, fs.constants.O_WRONLY | fs.constants.O_CREAT |
          fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
        try {
          fs.writeFileSync(fd, ownerContents);
          this.lockFault('after-write');
          fs.fsyncSync(fd);
          this.lockFault('after-fsync');
        } finally { fs.closeSync(fd); }
        fs.renameSync(temporaryOwner, path.join(this.lockFile, 'owner.json'));
        fsyncDirectory(this.lockFile);
        fsyncDirectory(this.root);
        return () => {
          const inspected = inspectLock(this.lockFile);
          if (!inspected) throw new Error('Redline state lock disappeared before release');
          if (!inspected.owner || inspected.owner.nonce !== owner.nonce ||
              inspected.owner.pid !== owner.pid || inspected.owner.process_start !== owner.process_start) {
            throw new Error('Redline state lock ownership changed');
          }
          removeInspectedLock(this.lockFile, inspected);
          fsyncDirectory(this.root);
        };
      } catch (error) {
        if (error.code !== 'EEXIST') {
          try {
            const partial = inspectLock(this.lockFile);
            if (partial?.owner?.nonce === owner.nonce) removeInspectedLock(this.lockFile, partial);
          } catch {}
          throw error;
        }
      }

      const inspected = inspectLock(this.lockFile);
      if (!inspected) continue;
      const active = inspected.owner && this.processIdentity(inspected.owner.pid) === inspected.owner.process_start;
      const oldEnough = this.lockNow() - inspected.newestMtime >= this.lockStaleMs;
      if (!active && oldEnough && priorStableSnapshot === inspected.snapshot) {
        removeInspectedLock(this.lockFile, inspected);
        fsyncDirectory(this.root);
        priorStableSnapshot = null;
        continue;
      }
      priorStableSnapshot = !active && oldEnough ? inspected.snapshot : null;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('timed out waiting for the Redline state lock');
  }

  _ensureRoot() {
    let before;
    try { before = fs.lstatSync(this.root); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
      before = fs.lstatSync(this.root);
    }
    if (!before.isDirectory() || before.isSymbolicLink()) throw new Error('REDLINE_DIR must be a real directory; symlinks are refused');
    const fd = fs.openSync(this.root, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const opened = fs.fstatSync(fd);
      if (!opened.isDirectory() || opened.dev !== before.dev || opened.ino !== before.ino) {
        throw new Error('REDLINE_DIR changed while opening');
      }
      fs.fchmodSync(fd, 0o700);
    } finally { fs.closeSync(fd); }
  }

  _read() {
    this._ensureRoot();
    const raw = inspectRegular(this.stateFile, 'state.json');
    if (raw === null) return defaultState();
    let value;
    try { value = JSON.parse(raw); } catch { throw new Error('state.json contains invalid JSON; refusing to overwrite it'); }
    return validateState(value);
  }

  _write(state) {
    validateState(state);
    atomicWrite(this.stateFile, `${JSON.stringify(state, null, 2)}\n`);
  }

  ensureCliCredential() {
    return this._serialized(() => {
      const state = this._read();
      const existing = inspectRegular(this.cliFile, 'CLI credential');
      if (existing !== null) {
        const token = existing.trim();
        if (!verifySecret(token, state.cli_hash)) throw new Error('CLI credential does not match Redline state');
        return token;
      }
      const token = this.secretFactory(32);
      state.cli_hash = hashSecret(token);
      this._write(state);
      atomicWrite(this.cliFile, `${token}\n`);
      return token;
    });
  }

  verifyCliToken(token) {
    return this._serialized(() => verifySecret(token, this._read().cli_hash));
  }

  createPairingWindow() {
    return this._serialized(() => {
      const state = this._read();
      const secret = this.secretFactory(32);
      const expiresAt = new Date(this.now() + PAIRING_TTL_MS).toISOString();
      state.pairing = { hash: hashSecret(secret), expires_at: expiresAt };
      this._write(state);
      return { secret, expiresAt };
    });
  }

  pairingStatus() {
    return this._serialized(() => {
      const state = this._read();
      if (!state.pairing || Date.parse(state.pairing.expires_at) <= this.now()) return { available: false };
      return { available: true, expiresAt: state.pairing.expires_at };
    });
  }

  invalidatePairingWindow(secret) {
    return this._serialized(() => {
      const state = this._read();
      if (!state.pairing || !verifySecret(secret, state.pairing.hash)) return false;
      state.pairing = null;
      this._write(state);
      return true;
    });
  }

  consumePairingSecret(secret) {
    return this._serialized(() => {
      const state = this._read();
      if (!state.pairing || Date.parse(state.pairing.expires_at) <= this.now() ||
          !verifySecret(secret, state.pairing.hash)) return null;
      state.pairing = null;
      const clientId = `rlc_${crypto.randomBytes(16).toString('hex')}`;
      const token = this.secretFactory(32);
      state.clients[clientId] = { token_hash: hashSecret(token), created_at: new Date(this.now()).toISOString() };
      this._write(state);
      return { clientId, token, clearGeneration: state.clear_generation };
    });
  }

  verifyClientToken(token) {
    return this._serialized(() => {
      const state = this._read();
      for (const [clientId, client] of Object.entries(state.clients)) {
        if (verifySecret(token, client.token_hash)) return clientId;
      }
      return null;
    });
  }

  revokeClient(clientId) {
    return this._serialized(() => {
      const state = this._read();
      if (!Object.hasOwn(state.clients, clientId)) return false;
      delete state.clients[clientId];
      this._write(state);
      return true;
    });
  }

  revokeAllBrowsers() {
    return this._serialized(() => {
      const state = this._read();
      const count = Object.keys(state.clients).length;
      state.clients = {};
      this._write(state);
      return count;
    });
  }

  clearGeneration() { return this._serialized(() => this._read().clear_generation); }

  incrementClearGeneration() {
    return this._serialized(() => {
      const state = this._read();
      if (state.clear_generation >= Number.MAX_SAFE_INTEGER) throw new Error('clear generation is exhausted');
      state.clear_generation += 1;
      this._write(state);
      return state.clear_generation;
    });
  }
}

module.exports = { PAIRING_TTL_MS, StateStore };
