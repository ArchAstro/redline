'use strict';

const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { hashSecret, randomSecret, verifySecret } = require('./auth');

const STATE_VERSION = 2;
const PAIRING_TTL_MS = 10 * 60 * 1000;
const SECRET_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const LOCK_STALE_MS = 100;
const OPERATION_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const DEVELOPMENT_OPERATION_CLIENT_ID = 'development';
const PNG_MAGIC = Buffer.from('89504e470d0a1a0a', 'hex');
const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;
const MAX_SCREENSHOT_DIMENSION = 8192;
const MAX_SCREENSHOT_PIXELS = 16 * 1024 * 1024;
const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CLEAR_RECEIPT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CREATION_RESPONSE_KEYS = 'comment,context,created_at,id,origin,project,rect,screenshot_id,screenshot_sha256,selected_text,status,title,url';
let pngDecoder = null;

function decodePng(buffer) {
  if (pngDecoder === null) pngDecoder = require('pngjs').PNG;
  return pngDecoder.sync.read(buffer, { checkCRC: true, skipRescale: true });
}

class StateStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function defaultState() {
  return {
    version: STATE_VERSION,
    cli_hash: null,
    pairing: null,
    clients: {},
    clear_generation: 0,
    clear_receipts: {},
    redlines: {},
    operations: {},
    legacy_migrated: false,
  };
}

function canonicalTimestamp(value) {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function validOperationClientId(value) {
  return value === DEVELOPMENT_OPERATION_CLIENT_ID || /^rlc_[0-9a-f]{32}$/.test(value);
}

function validRedline(id, item) {
  const nullableStrings = ['url', 'origin', 'title', 'project'];
  const textStrings = ['selected_text', 'comment'];
  const objectFields = ['context', 'rect'];
  const timestamps = ['created_at', 'updated_at', 'acked_at'];
  return /^rl_[A-Za-z0-9_-]+$/.test(id) && item && typeof item === 'object' && !Array.isArray(item) && item.id === id &&
    !nullableStrings.some((field) => item[field] !== undefined && item[field] !== null && typeof item[field] !== 'string') &&
    !textStrings.some((field) => item[field] !== undefined && typeof item[field] !== 'string') &&
    !objectFields.some((field) => item[field] !== undefined && item[field] !== null &&
      (typeof item[field] !== 'object' || Array.isArray(item[field]))) &&
    !timestamps.some((field) => item[field] !== undefined &&
      (typeof item[field] !== 'string' || !Number.isFinite(Date.parse(item[field])))) &&
    (item.status === undefined || ['pending', 'acked'].includes(item.status)) &&
    (item.screenshot_id === undefined || item.screenshot_id === null ||
      (typeof item.screenshot_id === 'string' && /^ss_[A-Za-z0-9_-]+$/.test(item.screenshot_id))) &&
    (item.screenshot_id
      ? typeof item.screenshot_sha256 === 'string' && /^[0-9a-f]{64}$/.test(item.screenshot_sha256)
      : item.screenshot_sha256 === undefined || item.screenshot_sha256 === null);
}

function validatePng(buffer, { submission = false, decode = true } = {}) {
  const fail = (message) => {
    if (submission) throw new StateStoreError('invalid_submission', message);
    throw new Error(`screenshot PNG integrity failure: ${message}`);
  };
  if (!Buffer.isBuffer(buffer) || buffer.length < 33 || buffer.length > MAX_SCREENSHOT_BYTES ||
      !buffer.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) fail('invalid signature or size');
  if (buffer.readUInt32BE(8) !== 13 || buffer.toString('ascii', 12, 16) !== 'IHDR') fail('invalid IHDR');
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width < 1 || height < 1 || width > MAX_SCREENSHOT_DIMENSION || height > MAX_SCREENSHOT_DIMENSION ||
      width * height > MAX_SCREENSHOT_PIXELS) fail('dimensions exceed bounds');
  if (decode) {
    let decoded;
    try { decoded = decodePng(buffer); } catch {
      fail('PNG cannot be decoded');
    }
    if (!decoded || decoded.width !== width || decoded.height !== height || decoded.data.length > MAX_SCREENSHOT_PIXELS * 4) {
      fail('decoded PNG dimensions are inconsistent');
    }
  }
  return {
    width,
    height,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
  };
}

function validateState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== STATE_VERSION ||
      !Number.isSafeInteger(value.clear_generation) || value.clear_generation < 0 ||
      !value.clear_receipts || typeof value.clear_receipts !== 'object' || Array.isArray(value.clear_receipts) ||
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
        typeof client.created_at !== 'string' || !Number.isFinite(Date.parse(client.created_at)) ||
        (client.consent_version !== undefined && client.consent_version !== 1)) {
      throw new Error('Redline state has invalid browser client state; refusing to overwrite it');
    }
  }
  for (const [operationId, receipt] of Object.entries(value.clear_receipts)) {
    if (!OPERATION_ID_PATTERN.test(operationId) || !receipt || typeof receipt !== 'object' || Array.isArray(receipt) ||
        Object.keys(receipt).sort().join(',') !== 'clear_generation,completed_at,expires_at,token_hash' ||
        !Number.isSafeInteger(receipt.clear_generation) || receipt.clear_generation < 0 ||
        typeof receipt.token_hash !== 'string' || !SECRET_HASH_PATTERN.test(receipt.token_hash) ||
        !canonicalTimestamp(receipt.completed_at) || !canonicalTimestamp(receipt.expires_at) ||
        Date.parse(receipt.expires_at) - Date.parse(receipt.completed_at) !== CLEAR_RECEIPT_TTL_MS) {
      throw new Error('Redline state has invalid clear receipt state; refusing to overwrite it');
    }
  }
  if (!value.redlines || typeof value.redlines !== 'object' || Array.isArray(value.redlines) ||
      !value.operations || typeof value.operations !== 'object' || Array.isArray(value.operations) ||
      typeof value.legacy_migrated !== 'boolean') {
    throw new Error('Redline state has invalid feedback state; refusing to overwrite it');
  }
  for (const [id, item] of Object.entries(value.redlines)) {
    if (!validRedline(id, item)) {
      throw new Error('Redline state has invalid redline state; refusing to overwrite it');
    }
  }
  for (const [clientId, operations] of Object.entries(value.operations)) {
    if (!validOperationClientId(clientId) || !operations || typeof operations !== 'object' || Array.isArray(operations)) {
      throw new Error('Redline state has invalid operation state; refusing to overwrite it');
    }
    for (const [operationId, operation] of Object.entries(operations)) {
      if (!OPERATION_ID_PATTERN.test(operationId) || !operation || typeof operation !== 'object' || Array.isArray(operation) ||
          !/^rl_[A-Za-z0-9_-]+$/.test(operation.redline_id || '')) {
        throw new Error('Redline state has invalid operation state; refusing to overwrite it');
      }
      const keys = Object.keys(operation).sort();
      const active = keys.join(',') === 'created_at,payload_hash,redline_id,response' &&
        /^[0-9a-f]{64}$/.test(operation.payload_hash || '') &&
        typeof operation.created_at === 'string' && Number.isFinite(Date.parse(operation.created_at)) &&
        validRedline(operation.redline_id, operation.response) &&
        Object.keys(operation.response).sort().join(',') === CREATION_RESPONSE_KEYS &&
        operation.response.created_at === operation.created_at &&
        operation.response.status === 'pending' &&
        Object.hasOwn(value.redlines, operation.redline_id);
      const tombstone = keys.join(',') === 'deleted_at,expires_at,redline_id' &&
        canonicalTimestamp(operation.deleted_at) && canonicalTimestamp(operation.expires_at) &&
        Date.parse(operation.expires_at) - Date.parse(operation.deleted_at) === TOMBSTONE_TTL_MS &&
        !Object.hasOwn(value.redlines, operation.redline_id);
      if (!active && !tombstone) throw new Error('Redline state has invalid operation state; refusing to overwrite it');
    }
  }
  return value;
}

function canonicalJson(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new StateStoreError('invalid_submission', 'JSON number is invalid');
    return JSON.stringify(value);
  }
  if (!value || typeof value !== 'object') {
    throw new StateStoreError('invalid_submission', 'value is outside the JSON domain');
  }
  if (ancestors.has(value)) throw new StateStoreError('invalid_submission', 'cyclic JSON value is invalid');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) throw new StateStoreError('invalid_submission', 'sparse JSON array is invalid');
        items.push(canonicalJson(value[index], ancestors));
      }
      return `[${items.join(',')}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new StateStoreError('invalid_submission', 'non-plain JSON object is invalid');
    }
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== 'string')) {
      throw new StateStoreError('invalid_submission', 'symbol JSON keys are invalid');
    }
    return `{${ownKeys.filter((key) => Object.prototype.propertyIsEnumerable.call(value, key)).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], ancestors)}`).join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

function optionalString(value, field, maxBytes) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new StateStoreError('invalid_submission', `${field} is invalid`);
  if (Buffer.byteLength(value) > maxBytes) throw new StateStoreError('payload_too_large', `${field} is too large`);
  return value;
}

function jsonValue(value, field, maxBytes) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new StateStoreError('invalid_submission', `${field} is invalid`);
  }
  let encoded;
  try { encoded = canonicalJson(value); } catch {
    throw new StateStoreError('invalid_submission', `${field} is invalid`);
  }
  if (Buffer.byteLength(encoded) > maxBytes) throw new StateStoreError('payload_too_large', `${field} is too large`);
  try { return JSON.parse(encoded); } catch {
    throw new StateStoreError('invalid_submission', `${field} is invalid`);
  }
}

function validBase64(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0) return false;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  for (let index = 0; index < value.length - padding; index += 1) {
    const code = value.charCodeAt(index);
    if (!((code >= 48 && code <= 57) || (code >= 65 && code <= 90) ||
        (code >= 97 && code <= 122) || code === 43 || code === 47)) return false;
  }
  return !value.slice(0, value.length - padding).includes('=');
}

function normalizeSubmission(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      typeof input.operation_id !== 'string' || !OPERATION_ID_PATTERN.test(input.operation_id) ||
      !Number.isSafeInteger(input.clear_generation) || input.clear_generation < 0) {
    throw new StateStoreError('invalid_submission', 'submission identity is invalid');
  }
  const allowed = new Set([
    'operation_id', 'clear_generation', 'url', 'origin', 'title', 'project', 'selected_text',
    'comment', 'context', 'rect', 'screenshot_png',
  ]);
  if (Object.keys(input).some((field) => !allowed.has(field))) {
    throw new StateStoreError('invalid_submission', 'submission has unknown fields');
  }
  let screenshot = null;
  let screenshotSha256 = null;
  if (input.screenshot_png !== undefined && input.screenshot_png !== null) {
    if (typeof input.screenshot_png !== 'string' || input.screenshot_png.length > Math.ceil(MAX_SCREENSHOT_BYTES / 3) * 4 ||
        !validBase64(input.screenshot_png)) {
      if (typeof input.screenshot_png === 'string' && input.screenshot_png.length > Math.ceil(MAX_SCREENSHOT_BYTES / 3) * 4) {
        throw new StateStoreError('payload_too_large', 'screenshot_png is too large');
      }
      throw new StateStoreError('invalid_submission', 'screenshot_png is invalid');
    }
    screenshot = Buffer.from(input.screenshot_png, 'base64');
    if (screenshot.length > MAX_SCREENSHOT_BYTES || screenshot.toString('base64') !== input.screenshot_png) {
      throw new StateStoreError('invalid_submission', 'screenshot_png is not a valid encoded PNG');
    }
    screenshotSha256 = validatePng(screenshot, { submission: true }).sha256;
  }
  return {
    operation_id: input.operation_id,
    clear_generation: input.clear_generation,
    url: optionalString(input.url, 'url', 8192),
    origin: optionalString(input.origin, 'origin', 2048),
    title: optionalString(input.title, 'title', 4096),
    project: optionalString(input.project, 'project', 256),
    selected_text: optionalString(input.selected_text, 'selected_text', 128 * 1024) || '',
    comment: optionalString(input.comment, 'comment', 128 * 1024) || '',
    context: jsonValue(input.context, 'context', 256 * 1024),
    rect: jsonValue(input.rect, 'rect', 16 * 1024),
    screenshot,
    screenshot_sha256: screenshotSha256,
  };
}

function replayResult(item, replayed) {
  const result = structuredClone(item);
  Object.defineProperty(result, 'replayed', { value: replayed, enumerable: false });
  return result;
}

function ensurePrivateDirectory(directory, label) {
  try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a real directory; symlinks are refused`);
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isDirectory() || opened.dev !== stat.dev || opened.ino !== stat.ino) {
      throw new Error(`${label} changed while opening`);
    }
    fs.fchmodSync(fd, 0o700);
  } finally { fs.closeSync(fd); }
}

function removeRegularIfPresent(file, label) {
  if (inspectRegular(file, label, false) === null) return false;
  fs.unlinkSync(file);
  fsyncDirectory(path.dirname(file));
  return true;
}

function listPrivateFiles(directory, label) {
  ensurePrivateDirectory(directory, label);
  const names = fs.readdirSync(directory).sort();
  for (const name of names) {
    if (!/^[A-Za-z0-9_.-]+\.png$/.test(name) || name === '.' || name === '..') {
      throw new Error(`${label} contains an unsafe entry; refusing to clear it`);
    }
    inspectRegular(path.join(directory, name), `${label} entry`, false);
  }
  return names;
}

function inspectRegular(file, label, encoding = 'utf8') {
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
    if (encoding === false) return true;
    return fs.readFileSync(fd, encoding === null ? undefined : encoding);
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
    const existing = inspectRegular(file, path.basename(file), false);
    void existing;
    fs.renameSync(tmp, file);
    inspectRegular(file, path.basename(file), false);
    fsyncDirectory(dir);
  } finally { fs.rmSync(tmp, { force: true }); }
}

class StateStore {
  constructor(root, {
    now = () => Date.now(), secretFactory = randomSecret, processIdentity = readProcessIdentity,
    lockFault = () => {}, lockNow = () => Date.now(), lockStaleMs = LOCK_STALE_MS,
    transactionFault = () => {}, clearFault = () => {},
  } = {}) {
    this.root = path.resolve(root);
    this.stateFile = path.join(this.root, 'state.json');
    this.cliFile = path.join(this.root, 'cli-credential');
    this.lockFile = path.join(this.root, 'state.lock');
    this.screenshotsDir = path.join(this.root, 'screenshots');
    this.stagingDir = path.join(this.root, 'staging');
    this.transactionIntentFile = path.join(this.root, 'transaction-intent.json');
    this.clearIntentFile = path.join(this.root, 'clear-intent.json');
    this.legacyFile = path.join(this.root, 'redlines.json');
    this.legacyBackupFile = path.join(this.root, 'redlines.json.migrated');
    this.now = now;
    this.secretFactory = secretFactory;
    this.processIdentity = processIdentity;
    this.lockFault = lockFault;
    this.lockNow = lockNow;
    this.lockStaleMs = lockStaleMs;
    this.transactionFault = transactionFault;
    this.clearFault = clearFault;
    this.queue = Promise.resolve();
  }

  _serialized(operation, { cleanupOrphanStaging = true } = {}) {
    const run = async () => {
      this._ensureRoot();
      const release = await this._acquireLock();
      try {
        this._recoverLocked({ cleanupOrphanStaging });
        return operation();
      } finally { release(); }
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

  _ensureContentDirectories() {
    ensurePrivateDirectory(this.screenshotsDir, 'screenshots');
    ensurePrivateDirectory(this.stagingDir, 'staging');
  }

  _readTransactionIntent() {
    const raw = inspectRegular(this.transactionIntentFile, 'transaction intent');
    if (raw === null) return null;
    let intent;
    try { intent = JSON.parse(raw); } catch { throw new Error('transaction intent contains invalid JSON; preserving it'); }
    const keys = intent && typeof intent === 'object' && !Array.isArray(intent)
      ? Object.keys(intent).sort().join(',') : '';
    const commonValid = intent && typeof intent === 'object' && !Array.isArray(intent) && intent.version === 1 &&
      ['create', 'delete'].includes(intent.kind) && /^rl_[A-Za-z0-9_-]+$/.test(intent.redline_id || '');
    const createValid = intent?.kind === 'create' &&
      keys === 'client_id,kind,operation_id,payload_hash,redline_id,screenshot_file,screenshot_id,screenshot_sha256,staging_file,version' &&
      validOperationClientId(intent.client_id) &&
      OPERATION_ID_PATTERN.test(intent.operation_id || '') && /^ss_[0-9a-f]{32}$/.test(intent.screenshot_id || '') &&
      /^[0-9a-f]{64}$/.test(intent.payload_hash || '') && /^[0-9a-f]{64}$/.test(intent.screenshot_sha256 || '') &&
      intent.staging_file === `op_${crypto.createHash('sha256')
        .update(`${intent.client_id}\0${intent.operation_id}`).digest('hex').slice(0, 32)}.png` &&
      intent.screenshot_file === `${intent.screenshot_id}.png`;
    const deleteValid = intent?.kind === 'delete' &&
      keys === 'kind,redline_id,screenshot_files,screenshot_hashes,version' &&
      Array.isArray(intent.screenshot_files) && intent.screenshot_hashes &&
      typeof intent.screenshot_hashes === 'object' && !Array.isArray(intent.screenshot_hashes) &&
      new Set(intent.screenshot_files).size === intent.screenshot_files.length &&
      intent.screenshot_files.every((name) => /^ss_[A-Za-z0-9_-]+\.png$/.test(name)) &&
      Object.keys(intent.screenshot_hashes).sort().join(',') === [...intent.screenshot_files].sort().join(',') &&
      Object.values(intent.screenshot_hashes).every((digest) => /^[0-9a-f]{64}$/.test(digest));
    if (!commonValid || (!createValid && !deleteValid)) {
      throw new Error('transaction intent has an invalid schema; preserving it');
    }
    return intent;
  }

  _promoteTransactionScreenshot(intent) {
    const staged = path.join(this.stagingDir, intent.staging_file);
    const final = path.join(this.screenshotsDir, intent.screenshot_file);
    const existing = inspectRegular(final, 'transaction screenshot', null);
    if (existing !== null) {
      validatePng(existing);
      if (crypto.createHash('sha256').update(existing).digest('hex') !== intent.screenshot_sha256) {
        throw new Error('committed transaction screenshot does not match its intent');
      }
      removeRegularIfPresent(staged, 'staged transaction screenshot');
      return;
    }
    const stagedBytes = inspectRegular(staged, 'staged transaction screenshot', null);
    if (stagedBytes === null) throw new Error('committed transaction screenshot is missing; preserving transaction intent');
    validatePng(stagedBytes);
    if (crypto.createHash('sha256').update(stagedBytes).digest('hex') !== intent.screenshot_sha256) {
      throw new Error('staged transaction screenshot does not match its intent');
    }
    fs.renameSync(staged, final);
    inspectRegular(final, 'transaction screenshot', false);
    fsyncDirectory(this.stagingDir);
    fsyncDirectory(this.screenshotsDir);
  }

  _recoverTransactionLocked(state = this._read(), { cleanupOrphanStaging = true } = {}) {
    this._ensureContentDirectories();
    const intent = this._readTransactionIntent();
    if (!intent) {
      if (!cleanupOrphanStaging) return state;
      for (const name of listPrivateFiles(this.stagingDir, 'staging')) {
        removeRegularIfPresent(path.join(this.stagingDir, name), 'orphaned staged screenshot');
      }
      return state;
    }
    if (intent.kind === 'delete') {
      for (const name of intent.screenshot_files) {
        const bytes = inspectRegular(path.join(this.screenshotsDir, name), 'deleted transaction screenshot', null);
        if (bytes !== null && crypto.createHash('sha256').update(bytes).digest('hex') !== intent.screenshot_hashes[name]) {
          throw new Error('transaction intent deletion target changed; preserving it');
        }
      }
      const item = state.redlines[intent.redline_id];
      if (item) {
        const remaining = Object.values(state.redlines).filter((redline) => redline.id !== intent.redline_id);
        const referenced = new Set(remaining.map((redline) => redline.screenshot_id).filter(Boolean));
        const expected = listPrivateFiles(this.screenshotsDir, 'screenshots')
          .filter((name) => /^ss_[A-Za-z0-9_-]+\.png$/.test(name) && !referenced.has(name.slice(0, -4))).sort();
        if (expected.join(',') !== [...intent.screenshot_files].sort().join(',')) {
          throw new Error('transaction intent deletion set does not match state; preserving it');
        }
      } else {
        const referenced = new Set(Object.values(state.redlines).map((redline) => redline.screenshot_id).filter(Boolean));
        const actual = listPrivateFiles(this.screenshotsDir, 'screenshots');
        if (actual.some((name) => !intent.screenshot_files.includes(name)) ||
            intent.screenshot_files.some((name) => referenced.has(name.slice(0, -4)))) {
          throw new Error('transaction intent deletion set does not match state; preserving it');
        }
        for (const name of intent.screenshot_files) {
          removeRegularIfPresent(path.join(this.screenshotsDir, name), 'deleted transaction screenshot');
        }
      }
    } else {
      if (intent.client_id !== DEVELOPMENT_OPERATION_CLIENT_ID && !Object.hasOwn(state.clients, intent.client_id)) {
        throw new Error('transaction intent references an unknown browser client; preserving it');
      }
      const operation = state.operations[intent.client_id]?.[intent.operation_id];
      const committed = operation?.payload_hash === intent.payload_hash && operation.redline_id === intent.redline_id;
      if (committed) {
        const item = state.redlines[intent.redline_id];
        if (!item || operation.response.screenshot_id !== intent.screenshot_id ||
            operation.response.screenshot_sha256 !== intent.screenshot_sha256 ||
            item.screenshot_id !== intent.screenshot_id || item.screenshot_sha256 !== intent.screenshot_sha256) {
          throw new Error('transaction intent references do not match committed state; preserving it');
        }
        this._promoteTransactionScreenshot(intent);
      } else {
        if (operation || Object.hasOwn(state.redlines, intent.redline_id)) {
          throw new Error('transaction intent references inconsistent state; preserving it');
        }
        const stagedFile = path.join(this.stagingDir, intent.staging_file);
        const stagedBytes = inspectRegular(stagedFile, 'staged transaction screenshot', null);
        if (stagedBytes === null) {
          throw new StateStoreError('recovery_evidence_mismatch',
            'staged transaction screenshot is missing; preserving transaction intent');
        }
        try { validatePng(stagedBytes); } catch {
          throw new StateStoreError('recovery_evidence_mismatch',
            'staged transaction screenshot is invalid; preserving transaction intent');
        }
        if (crypto.createHash('sha256').update(stagedBytes).digest('hex') !== intent.screenshot_sha256) {
          throw new StateStoreError('recovery_evidence_mismatch',
            'staged transaction screenshot does not match its intent; preserving transaction intent');
        }
        removeRegularIfPresent(stagedFile, 'staged transaction screenshot');
      }
    }
    removeRegularIfPresent(this.transactionIntentFile, 'transaction intent');
    if (cleanupOrphanStaging) {
      for (const name of listPrivateFiles(this.stagingDir, 'staging')) {
        removeRegularIfPresent(path.join(this.stagingDir, name), 'orphaned staged screenshot');
      }
    }
    return state;
  }

  _readClearIntent() {
    const raw = inspectRegular(this.clearIntentFile, 'clear intent');
    if (raw === null) return null;
    let intent;
    try { intent = JSON.parse(raw); } catch { throw new Error('clear intent contains invalid JSON; preserving it'); }
    const validNames = (names) => Array.isArray(names) && new Set(names).size === names.length &&
      names.every((name) => typeof name === 'string' && /^[A-Za-z0-9_.-]+\.png$/.test(name));
    if (!intent || typeof intent !== 'object' || Array.isArray(intent) ||
        Object.keys(intent).sort().join(',') !== 'legacy_files,screenshot_files,staging_files,target_generation,version' ||
        intent.version !== 1 || !Number.isSafeInteger(intent.target_generation) ||
        intent.target_generation < 1 || !validNames(intent.screenshot_files) || !validNames(intent.staging_files) ||
        !Array.isArray(intent.legacy_files) || new Set(intent.legacy_files).size !== intent.legacy_files.length ||
        intent.legacy_files.some((name) => name !== 'redlines.json.migrated')) {
      throw new Error('clear intent has an invalid schema; preserving it');
    }
    return intent;
  }

  _finishCommittedClear(intent) {
    for (const [directory, names, label] of [
      [this.screenshotsDir, intent.screenshot_files, 'clear screenshot'],
      [this.stagingDir, intent.staging_files, 'clear staging file'],
    ]) {
      for (const name of names) {
        removeRegularIfPresent(path.join(directory, name), label);
        this.clearFault(`after-delete:${path.basename(directory)}:${name}`);
      }
      fsyncDirectory(directory);
    }
    for (const name of intent.legacy_files) {
      removeRegularIfPresent(path.join(this.root, name), 'legacy migration backup');
      this.clearFault(`after-delete:root:${name}`);
    }
    fsyncDirectory(this.root);
    this.clearFault('before-intent-removal');
    removeRegularIfPresent(this.clearIntentFile, 'clear intent');
  }

  _recoverClearLocked(state = this._read()) {
    this._ensureContentDirectories();
    const intent = this._readClearIntent();
    if (!intent) return state;
    if (state.clear_generation === intent.target_generation) {
      if (state.pairing !== null || Object.keys(state.clients).length || Object.keys(state.redlines).length ||
          Object.keys(state.operations).length) {
        throw new Error('committed clear state is inconsistent; preserving clear intent');
      }
      const actualScreenshots = listPrivateFiles(this.screenshotsDir, 'screenshots');
      const actualStaging = listPrivateFiles(this.stagingDir, 'staging');
      const actualLegacy = inspectRegular(this.legacyBackupFile, 'legacy migration backup') === null
        ? [] : ['redlines.json.migrated'];
      if (actualScreenshots.some((name) => !intent.screenshot_files.includes(name)) ||
          actualStaging.some((name) => !intent.staging_files.includes(name)) ||
          actualLegacy.some((name) => !intent.legacy_files.includes(name))) {
        throw new Error('clear intent deletion set does not match files; preserving it');
      }
      this._finishCommittedClear(intent);
      return state;
    }
    if (state.clear_generation === intent.target_generation - 1) {
      const exact = (actual, expected) => actual.join(',') === [...expected].sort().join(',');
      const actualLegacy = inspectRegular(this.legacyBackupFile, 'legacy migration backup') === null
        ? [] : ['redlines.json.migrated'];
      if (!exact(listPrivateFiles(this.screenshotsDir, 'screenshots'), intent.screenshot_files) ||
          !exact(listPrivateFiles(this.stagingDir, 'staging'), intent.staging_files) ||
          !exact(actualLegacy, intent.legacy_files)) {
        throw new Error('clear intent deletion set does not match files; preserving it');
      }
      removeRegularIfPresent(this.clearIntentFile, 'precommit clear intent');
      return state;
    }
    throw new Error('clear intent generation does not match state; preserving evidence');
  }

  _finishLegacyRename() {
    const legacy = inspectRegular(this.legacyFile, 'legacy redlines.json');
    if (legacy === null) return;
    if (inspectRegular(this.legacyBackupFile, 'legacy migration backup') !== null) {
      throw new Error('both legacy redlines.json and its migration backup exist; preserving evidence');
    }
    fs.renameSync(this.legacyFile, this.legacyBackupFile);
    inspectRegular(this.legacyBackupFile, 'legacy migration backup', false);
    fsyncDirectory(this.root);
  }

  _migrateLegacyLocked(state) {
    if (state.legacy_migrated) {
      this._finishLegacyRename();
      return state;
    }
    const raw = inspectRegular(this.legacyFile, 'legacy redlines.json');
    if (raw === null) {
      state.legacy_migrated = true;
      this._write(state);
      return state;
    }
    let legacy;
    try { legacy = JSON.parse(raw); } catch {
      throw new Error('legacy redlines.json contains invalid JSON; refusing to overwrite it');
    }
    if (!Array.isArray(legacy)) throw new Error('legacy redlines.json must contain an array; refusing migration');
    const imported = { ...state.redlines };
    for (const item of legacy) {
      if (!item || typeof item !== 'object' || Array.isArray(item) ||
          typeof item.id !== 'string' || !/^rl_[A-Za-z0-9_-]+$/.test(item.id) || Object.hasOwn(imported, item.id)) {
        throw new Error('legacy redlines.json has invalid or duplicate records; refusing migration');
      }
      if (item.screenshot_id !== undefined && item.screenshot_id !== null &&
          (typeof item.screenshot_id !== 'string' || !/^ss_[A-Za-z0-9_-]+$/.test(item.screenshot_id))) {
        throw new Error('legacy redlines.json has an unsafe screenshot reference; refusing migration');
      }
      if (item.screenshot_id) {
        const screenshot = inspectRegular(path.join(this.screenshotsDir, `${item.screenshot_id}.png`),
          'legacy screenshot', null);
        if (screenshot === null) throw new Error('legacy redlines.json references a missing screenshot; refusing migration');
        imported[item.id] = { ...item, screenshot_sha256: validatePng(screenshot, { decode: false }).sha256 };
      } else {
        imported[item.id] = item;
      }
    }
    state.redlines = imported;
    state.legacy_migrated = true;
    this._write(state);
    this._finishLegacyRename();
    return state;
  }

  _recoverLocked({ cleanupOrphanStaging = true } = {}) {
    this._ensureContentDirectories();
    listPrivateFiles(this.screenshotsDir, 'screenshots');
    listPrivateFiles(this.stagingDir, 'staging');
    let state = this._read();
    state = this._migrateLegacyLocked(state);
    state = this._recoverClearLocked(state);
    state = this._recoverTransactionLocked(state, { cleanupOrphanStaging });
    this._validateReferencedScreenshotsLocked(state);
    if (this._removeExpiredTombstones(state)) this._write(state);
    return state;
  }

  _removeExpiredTombstones(state) {
    let changed = false;
    for (const [clientId, operations] of Object.entries(state.operations)) {
      for (const [operationId, operation] of Object.entries(operations)) {
        if (operation.deleted_at && Date.parse(operation.expires_at) <= this.now()) {
          delete operations[operationId];
          changed = true;
        }
      }
      if (Object.keys(operations).length === 0) {
        delete state.operations[clientId];
        changed = true;
      }
    }
    for (const [operationId, receipt] of Object.entries(state.clear_receipts)) {
      if (Date.parse(receipt.expires_at) <= this.now()) {
        delete state.clear_receipts[operationId];
        changed = true;
      }
    }
    return changed;
  }

  _validateReferencedScreenshotsLocked(state) {
    for (const item of Object.values(state.redlines)) {
      if (!item.screenshot_id) continue;
      const screenshot = inspectRegular(path.join(this.screenshotsDir, `${item.screenshot_id}.png`),
        'referenced screenshot', null);
      if (screenshot === null) throw new Error('referenced screenshot is missing; refusing to continue');
      const metadata = validatePng(screenshot, { decode: false });
      if (metadata.sha256 !== item.screenshot_sha256) {
        throw new Error('referenced screenshot digest does not match state; refusing to continue');
      }
    }
  }

  _read() {
    this._ensureRoot();
    const raw = inspectRegular(this.stateFile, 'state.json');
    if (raw === null) return defaultState();
    let value;
    try { value = JSON.parse(raw); } catch { throw new Error('state.json contains invalid JSON; refusing to overwrite it'); }
    if (value && value.version === 1 && value.redlines === undefined && value.operations === undefined &&
        value.legacy_migrated === undefined) {
      value = { ...value, version: STATE_VERSION, redlines: {}, operations: {}, legacy_migrated: false };
    }
    if (value && value.version === STATE_VERSION && value.clear_receipts === undefined) {
      value = { ...value, clear_receipts: {} };
    }
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

  consumePairingSecret(secret, { consentVersion = null } = {}) {
    return this._serialized(() => {
      if (consentVersion !== 1) return null;
      const state = this._read();
      if (!state.pairing || Date.parse(state.pairing.expires_at) <= this.now() ||
          !verifySecret(secret, state.pairing.hash)) return null;
      state.pairing = null;
      const clientId = `rlc_${crypto.randomBytes(16).toString('hex')}`;
      const token = this.secretFactory(32);
      state.clients[clientId] = {
        token_hash: hashSecret(token),
        created_at: new Date(this.now()).toISOString(),
        consent_version: consentVersion,
      };
      this._write(state);
      return { clientId, token, clearGeneration: state.clear_generation };
    });
  }

  verifyClientToken(token) {
    return this._serialized(() => {
      const state = this._read();
      return this._browserClientIdLocked(state, token);
    });
  }

  _browserClientIdLocked(state, token) {
    for (const [clientId, client] of Object.entries(state.clients)) {
      if (client.consent_version === 1 && verifySecret(token, client.token_hash)) return clientId;
    }
    return null;
  }

  _requireBrowserClientLocked(state, token) {
    const clientId = this._browserClientIdLocked(state, token);
    if (!clientId) throw new StateStoreError('unauthorized', 'browser client is not connected');
    return clientId;
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

  revokeCurrentBrowser(token) {
    return this._serialized(() => {
      const state = this._read();
      const clientId = this._browserClientIdLocked(state, token);
      if (!clientId) return false;
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

  currentGeneration({ browserToken = null } = {}) {
    return this._serialized(() => {
      const state = this._read();
      if (browserToken !== null) this._requireBrowserClientLocked(state, browserToken);
      return state.clear_generation;
    });
  }

  incrementClearGeneration() {
    return this._serialized(() => {
      const state = this._read();
      if (state.clear_generation >= Number.MAX_SAFE_INTEGER) throw new Error('clear generation is exhausted');
      state.clear_generation += 1;
      this._write(state);
      return state.clear_generation;
    });
  }

  submitRedline(clientId, input, { browserToken = null } = {}) {
    return this._serialized(() => {
      this._ensureContentDirectories();
      const state = this._read();
      if (browserToken !== null) clientId = this._requireBrowserClientLocked(state, browserToken);
      if (!Object.hasOwn(state.clients, clientId)) throw new StateStoreError('unauthorized', 'browser client is not connected');
      return this._submitRedlineLocked(state, clientId, input);
    });
  }

  submitDevelopmentRedline(input) {
    return this._serialized(() => {
      this._ensureContentDirectories();
      return this._submitRedlineLocked(this._read(), DEVELOPMENT_OPERATION_CLIENT_ID, input);
    });
  }

  _submitRedlineLocked(state, clientId, input) {
    const submission = normalizeSubmission(input);
    if (submission.clear_generation !== state.clear_generation) {
      throw new StateStoreError('data_cleared', 'submission belongs to cleared Redline data');
    }
    const payload = { ...submission };
    delete payload.operation_id;
    delete payload.screenshot;
    const payloadHash = crypto.createHash('sha256').update(canonicalJson(payload)).digest('hex');
    const clientOperations = state.operations[clientId] || {};
    const existing = clientOperations[submission.operation_id];
    if (existing) {
      if (existing.deleted_at) throw new StateStoreError('operation_deleted', 'operation was deleted');
      if (existing.payload_hash !== payloadHash) throw new StateStoreError('operation_conflict', 'operation ID was already used');
      if (existing.response.screenshot_id) {
        const screenshot = inspectRegular(path.join(this.screenshotsDir, `${existing.response.screenshot_id}.png`),
          'replayed screenshot', null);
        if (screenshot === null || validatePng(screenshot, { decode: false }).sha256 !== existing.response.screenshot_sha256) {
          throw new Error('replayed screenshot digest does not match the immutable operation');
        }
      }
      return replayResult(existing.response, true);
    }
    const id = `rl_${this.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
    const screenshotId = submission.screenshot ? `ss_${crypto.randomBytes(16).toString('hex')}` : null;
    const item = {
      id,
      created_at: new Date(this.now()).toISOString(),
      status: 'pending',
      url: submission.url,
      origin: submission.origin,
      title: submission.title,
      project: submission.project,
      selected_text: submission.selected_text,
      comment: submission.comment,
      context: submission.context,
      screenshot_id: screenshotId,
      screenshot_sha256: submission.screenshot_sha256,
      rect: submission.rect,
    };
    let intent = null;
    if (submission.screenshot) {
      const stagingFile = `op_${crypto.createHash('sha256').update(`${clientId}\0${submission.operation_id}`).digest('hex').slice(0, 32)}.png`;
      const screenshotFile = `${screenshotId}.png`;
      const staged = path.join(this.stagingDir, stagingFile);
      const fd = fs.openSync(staged, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW || 0), 0o600);
      try {
        fs.writeFileSync(fd, submission.screenshot);
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1) throw new Error('staged screenshot is unsafe');
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      fsyncDirectory(this.stagingDir);
      this.transactionFault('after-screenshot-stage');
      intent = {
        version: 1,
        kind: 'create',
        client_id: clientId,
        operation_id: submission.operation_id,
        payload_hash: payloadHash,
        redline_id: id,
        screenshot_id: screenshotId,
        screenshot_sha256: submission.screenshot_sha256,
        staging_file: stagingFile,
        screenshot_file: screenshotFile,
      };
      atomicWrite(this.transactionIntentFile, `${JSON.stringify(intent, null, 2)}\n`);
      this.transactionFault('after-intent-fsync');
    }
    state.redlines[id] = item;
    clientOperations[submission.operation_id] = {
      payload_hash: payloadHash,
      redline_id: id,
      created_at: item.created_at,
      response: structuredClone(item),
    };
    state.operations[clientId] = clientOperations;
    this._write(state);
    this.transactionFault('after-state-replace');
    if (intent) {
      this._promoteTransactionScreenshot(intent);
      this.transactionFault('after-screenshot-promote');
      removeRegularIfPresent(this.transactionIntentFile, 'transaction intent');
    }
    return replayResult(item, false);
  }

  listRedlines(filters = {}, { browserToken = null } = {}) {
    return this._serialized(() => {
      const state = this._read();
      if (browserToken !== null) this._requireBrowserClientLocked(state, browserToken);
      let items = Object.values(state.redlines);
      for (const field of ['status', 'origin', 'project']) {
        if (filters[field]) items = items.filter((item) => item[field] === filters[field]);
      }
      return items;
    });
  }

  createLegacyRedline(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new StateStoreError('invalid_submission', 'legacy submission is invalid');
    }
    return this._serialized(() => {
      const state = this._read();
      const id = `rl_${this.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
      const screenshotId = typeof input.screenshot_id === 'string' && /^ss_[A-Za-z0-9_-]+$/.test(input.screenshot_id)
        ? input.screenshot_id : null;
      let screenshotSha256 = null;
      if (screenshotId) {
        const screenshot = inspectRegular(path.join(this.screenshotsDir, `${screenshotId}.png`),
          'development screenshot', null);
        if (screenshot === null) throw new StateStoreError('invalid_submission', 'referenced screenshot is missing');
        screenshotSha256 = validatePng(screenshot, { submission: true }).sha256;
      }
      const item = {
        id, created_at: new Date(this.now()).toISOString(), status: 'pending',
        url: optionalString(input.url, 'url', 8192),
        origin: optionalString(input.origin, 'origin', 2048),
        title: optionalString(input.title, 'title', 4096),
        project: optionalString(input.project, 'project', 256),
        selected_text: optionalString(input.selected_text, 'selected_text', 128 * 1024) || '',
        comment: optionalString(input.comment, 'comment', 128 * 1024) || '',
        context: jsonValue(input.context, 'context', 256 * 1024),
        screenshot_id: screenshotId,
        screenshot_sha256: screenshotSha256,
        rect: jsonValue(input.rect, 'rect', 16 * 1024),
      };
      state.redlines[id] = item;
      this._write(state);
      return item;
    });
  }

  updateRedline(redlineId, input, { ack = false, browserToken = null } = {}) {
    return this._serialized(() => {
      const state = this._read();
      if (browserToken !== null) this._requireBrowserClientLocked(state, browserToken);
      if (typeof redlineId !== 'string' || !/^rl_[A-Za-z0-9_-]+$/.test(redlineId) ||
          !input || typeof input !== 'object' || Array.isArray(input)) {
        throw new StateStoreError('invalid_request', 'redline update is invalid');
      }
      const item = state.redlines[redlineId];
      if (!item) return null;
      if (ack) {
        item.status = 'acked';
        item.acked_at = new Date(this.now()).toISOString();
      } else {
        const stringFields = { url: 8192, origin: 2048, title: 4096, project: 256, selected_text: 128 * 1024, comment: 128 * 1024 };
        for (const [field, max] of Object.entries(stringFields)) {
          if (Object.hasOwn(input, field)) item[field] = optionalString(input[field], field, max) ?? (['selected_text', 'comment'].includes(field) ? '' : null);
        }
        if (Object.hasOwn(input, 'context')) item.context = jsonValue(input.context, 'context', 256 * 1024);
        if (Object.hasOwn(input, 'rect')) item.rect = jsonValue(input.rect, 'rect', 16 * 1024);
        item.updated_at = new Date(this.now()).toISOString();
      }
      this._write(state);
      return item;
    });
  }

  storeDevelopmentScreenshot(dataUrl) {
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) {
      throw new StateStoreError('invalid_submission', 'expected an encoded PNG screenshot');
    }
    const normalized = normalizeSubmission({ operation_id: 'dev_screenshot', clear_generation: 0, screenshot_png: dataUrl.slice(22) });
    return this._serialized(() => {
      const id = `ss_${crypto.randomBytes(16).toString('hex')}`;
      const file = path.join(this.screenshotsDir, `${id}.png`);
      const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW || 0), 0o600);
      try { fs.writeFileSync(fd, normalized.screenshot); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fsyncDirectory(this.screenshotsDir);
      return { id, bytes: normalized.screenshot.length };
    });
  }

  readScreenshot(screenshotId, { browserToken = null } = {}) {
    return this._serialized(() => {
      const state = this._read();
      if (browserToken !== null) this._requireBrowserClientLocked(state, browserToken);
      if (typeof screenshotId !== 'string' || !/^ss_[A-Za-z0-9_-]+$/.test(screenshotId)) return null;
      const item = Object.values(state.redlines).find((redline) => redline.screenshot_id === screenshotId);
      if (!item) return null;
      const screenshot = inspectRegular(path.join(this.screenshotsDir, `${screenshotId}.png`), 'screenshot', null);
      if (screenshot === null) throw new Error('referenced screenshot is missing');
      if (validatePng(screenshot, { decode: false }).sha256 !== item.screenshot_sha256) {
        throw new Error('screenshot digest does not match state');
      }
      return screenshot;
    });
  }

  deleteRedline(redlineId, { browserToken = null } = {}) {
    return this._serialized(() => {
      this._ensureContentDirectories();
      const state = this._read();
      if (browserToken !== null) this._requireBrowserClientLocked(state, browserToken);
      if (typeof redlineId !== 'string' || !/^rl_[A-Za-z0-9_-]+$/.test(redlineId)) {
        throw new StateStoreError('invalid_request', 'redline ID is invalid');
      }
      const item = state.redlines[redlineId];
      if (!item) {
        const referenced = new Set(Object.values(state.redlines).map((redline) => redline.screenshot_id).filter(Boolean));
        for (const name of listPrivateFiles(this.screenshotsDir, 'screenshots')) {
          if (/^ss_[A-Za-z0-9_-]+\.png$/.test(name) && !referenced.has(name.slice(0, -4))) {
            removeRegularIfPresent(path.join(this.screenshotsDir, name), 'orphaned screenshot');
          }
        }
        return false;
      }
      const remaining = Object.values(state.redlines).filter((redline) => redline.id !== redlineId);
      const referenced = new Set(remaining.map((redline) => redline.screenshot_id).filter(Boolean));
      const screenshotFiles = listPrivateFiles(this.screenshotsDir, 'screenshots')
        .filter((name) => /^ss_[A-Za-z0-9_-]+\.png$/.test(name) && !referenced.has(name.slice(0, -4)));
      const screenshotHashes = Object.fromEntries(screenshotFiles.map((name) => {
        const bytes = inspectRegular(path.join(this.screenshotsDir, name), 'deleted transaction screenshot', null);
        return [name, crypto.createHash('sha256').update(bytes).digest('hex')];
      }));
      const intent = {
        version: 1, kind: 'delete', redline_id: redlineId,
        screenshot_files: screenshotFiles, screenshot_hashes: screenshotHashes,
      };
      atomicWrite(this.transactionIntentFile, `${JSON.stringify(intent, null, 2)}\n`);
      this.transactionFault('after-delete-intent-fsync');
      delete state.redlines[redlineId];
      const deletedAt = new Date(this.now()).toISOString();
      for (const operations of Object.values(state.operations)) {
        for (const [operationId, operation] of Object.entries(operations)) {
          if (operation.redline_id !== redlineId) continue;
          operations[operationId] = {
            redline_id: redlineId,
            deleted_at: deletedAt,
            expires_at: new Date(Date.parse(deletedAt) + TOMBSTONE_TTL_MS).toISOString(),
          };
        }
      }
      this._write(state);
      this.transactionFault('after-delete-state-replace');
      for (const name of screenshotFiles) {
        removeRegularIfPresent(path.join(this.screenshotsDir, name), 'deleted transaction screenshot');
        this.transactionFault(`after-delete-screenshot:${name}`);
      }
      this.transactionFault('after-delete-screenshot');
      this.transactionFault('before-delete-intent-removal');
      removeRegularIfPresent(this.transactionIntentFile, 'transaction intent');
      return true;
    });
  }

  initialize() {
    return this._serialized(() => this._read());
  }

  clearAll({ browserToken = null, operationId = null } = {}) {
    return this._serialized(() => {
      this._ensureContentDirectories();
      const state = this._read();
      let clearReceipt = null;
      if (browserToken !== null) {
        if (typeof operationId !== 'string' || !OPERATION_ID_PATTERN.test(operationId)) {
          throw new StateStoreError('invalid_request', 'browser clear operation ID is invalid');
        }
        const existing = state.clear_receipts[operationId];
        if (existing) {
          if (!verifySecret(browserToken, existing.token_hash)) {
            throw new StateStoreError('unauthorized', 'browser client is not connected');
          }
          return existing.clear_generation;
        }
        this._requireBrowserClientLocked(state, browserToken);
        const completedAtMs = this.now();
        const completedAt = new Date(completedAtMs).toISOString();
        clearReceipt = {
          token_hash: hashSecret(browserToken),
          clear_generation: state.clear_generation + 1,
          completed_at: completedAt,
          expires_at: new Date(completedAtMs + CLEAR_RECEIPT_TTL_MS).toISOString(),
        };
      }
      if (state.clear_generation >= Number.MAX_SAFE_INTEGER) throw new Error('clear generation is exhausted');
      const targetGeneration = state.clear_generation + 1;
      const intent = {
        version: 1,
        target_generation: targetGeneration,
        screenshot_files: listPrivateFiles(this.screenshotsDir, 'screenshots'),
        staging_files: listPrivateFiles(this.stagingDir, 'staging'),
        legacy_files: inspectRegular(this.legacyBackupFile, 'legacy migration backup') === null
          ? [] : ['redlines.json.migrated'],
      };
      this.clearFault('before-intent-write');
      atomicWrite(this.clearIntentFile, `${JSON.stringify(intent, null, 2)}\n`);
      this.clearFault('after-intent-fsync');
      const cleared = {
        ...defaultState(),
        cli_hash: state.cli_hash,
        clear_generation: targetGeneration,
        clear_receipts: {
          ...state.clear_receipts,
          ...(clearReceipt ? { [operationId]: clearReceipt } : {}),
        },
        legacy_migrated: state.legacy_migrated,
      };
      this._write(cleared);
      this.clearFault('after-state-replace');
      this._finishCommittedClear(intent);
      return targetGeneration;
    }, { cleanupOrphanStaging: false });
  }
}

module.exports = { PAIRING_TTL_MS, TOMBSTONE_TTL_MS, StateStore, StateStoreError, canonicalJson };
