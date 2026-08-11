#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { healthPayload, parseInstanceId, parseLaunchId, parsePort } = require('./lib/protocol');
const { inspectLifecycleFile, parseLaunchMetadata, removeLifecycleFile } = require('./lib/sidecar-lifecycle');
const { bearerToken, readPrivateCredential, verifySecret, hashSecret } = require('./lib/auth');
const { loadExtensionIdentity, validExtensionId } = require('./lib/extension-identity');
const { StateStore, StateStoreError } = require('./lib/state-store');

let PORT;
try {
  PORT = parsePort(process.env.REDLINE_PORT ?? '7878');
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
const ROOT = process.env.REDLINE_DIR || path.join(os.homedir(), '.redline');
const DEV_MODE = process.env.REDLINE_DEV_MODE === '1';
const TEST_MODE = process.env.REDLINE_TEST_MODE === '1';
if (DEV_MODE && PORT === 7878) {
  console.error('explicit dev mode requires a non-7878 REDLINE_PORT');
  process.exit(1);
}
let LISTEN_PORT = PORT;
if (TEST_MODE && process.env.REDLINE_LISTEN_PORT !== undefined) {
  try { LISTEN_PORT = parsePort(process.env.REDLINE_LISTEN_PORT); } catch (error) {
    console.error(`REDLINE_LISTEN_PORT is invalid: ${error.message}`);
    process.exit(1);
  }
}
if (PORT !== 7878 && !DEV_MODE) {
  console.error('non-7878 REDLINE_PORT values require explicit REDLINE_DEV_MODE=1');
  process.exit(1);
}

function loadExtensionId() {
  if (DEV_MODE) {
    if (!validExtensionId(process.env.REDLINE_EXTENSION_ID)) {
      throw new Error('explicit dev mode requires a valid injected REDLINE_EXTENSION_ID');
    }
    return process.env.REDLINE_EXTENSION_ID;
  }
  const identityFile = TEST_MODE && process.env.REDLINE_IDENTITY_PATH
    ? process.env.REDLINE_IDENTITY_PATH
    : path.resolve(__dirname, '../config/extension-identity.json');
  return loadExtensionIdentity(identityFile).extensionId;
}

let EXTENSION_ID;
try { EXTENSION_ID = loadExtensionId(); } catch (error) {
  console.error(error.message);
  process.exit(1);
}
const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;
const EXPECTED_HOST = `127.0.0.1:${PORT}`;
const stateStore = new StateStore(ROOT);
const DEV_BROWSER_CREDENTIAL = path.join(ROOT, 'auth-token');

function exactArgument(name) {
  const prefix = `--${name}=`;
  const matches = process.argv.slice(2).filter((argument) => argument.startsWith(prefix));
  if (matches.length !== 1) throw new Error(`expected exactly one ${prefix}<value> argument`);
  return matches[0].slice(prefix.length);
}

let INSTANCE_ID;
try {
  INSTANCE_ID = parseInstanceId(process.env.REDLINE_INSTANCE_ID);
} catch (error) {
  console.error(`REDLINE_INSTANCE_ID is invalid: ${error.message}`);
  process.exit(1);
}
let LAUNCH_ID;
let LAUNCH_DIRECTORY;
try {
  if (process.argv.slice(2).length !== 3) throw new Error('expected exactly three Redline launch arguments');
  LAUNCH_ID = parseLaunchId(exactArgument('redline-launch-id'));
  if (LAUNCH_ID !== process.env.REDLINE_LAUNCH_ID) {
    throw new Error('launch ID does not match server argv');
  }
  const device = exactArgument('redline-dir-device');
  const inode = exactArgument('redline-dir-inode');
  if (!/^(?:0|[1-9]\d*)$/.test(device) || !/^(?:0|[1-9]\d*)$/.test(inode)) {
    throw new Error('launch directory identity must use canonical decimal integers');
  }
  LAUNCH_DIRECTORY = { device, inode };
} catch (error) {
  console.error(`Redline launch identity is invalid: ${error.message}`);
  process.exit(1);
}
fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
fs.chmodSync(ROOT, 0o700);
const rootIdentity = fs.lstatSync(ROOT, { bigint: true });
if (!rootIdentity.isDirectory() || rootIdentity.isSymbolicLink() ||
    String(rootIdentity.dev) !== LAUNCH_DIRECTORY.device || String(rootIdentity.ino) !== LAUNCH_DIRECTORY.inode) {
  console.error('Redline launch directory identity does not match REDLINE_DIR');
  process.exit(1);
}
class HttpRequestError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function readBody(req, limitMB = 20) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const limit = limitMB * 1024 * 1024;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      req.resume();
      finish(reject, new HttpRequestError(408, 'request_timeout', 'request body deadline exceeded'));
    }, 3000);
    req.on('data', (c) => {
      if (settled) return;
      size += c.length;
      if (size > limit) {
        req.resume();
        finish(reject, new HttpRequestError(413, 'payload_too_large', 'request body is too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => finish(resolve, Buffer.concat(chunks)));
    req.on('error', (error) => finish(reject, error));
    req.on('aborted', () => finish(reject, new HttpRequestError(400, 'invalid_request', 'request body was aborted')));
  });
}

async function readJsonBody(req, limitMB = 1) {
  if (!validJsonContentType(req)) {
    throw new HttpRequestError(415, 'unsupported_media_type', 'request requires application/json');
  }
  const raw = await readBody(req, limitMB);
  try { return JSON.parse(raw.toString('utf8')); } catch {
    throw new HttpRequestError(400, 'invalid_json', 'request body contains invalid JSON');
  }
}

async function readJsonObject(req, limitMB = 1) {
  const body = await readJsonBody(req, limitMB);
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpRequestError(400, 'invalid_json_object', 'request body must be a JSON object');
  }
  return body;
}

function requestOrigin(req) {
  return typeof req.headers.origin === 'string' ? req.headers.origin : null;
}

function isAllowedOrigin(origin) {
  return origin === null || origin === EXTENSION_ORIGIN;
}

function exactHost(req) {
  return req.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'host').length === 1 &&
    req.headers.host === EXPECTED_HOST;
}

const SINGLETON_SECURITY_HEADERS = new Set([
  'host', 'origin', 'authorization', 'content-type', 'content-length', 'transfer-encoding',
  'x-redline-protocol', 'x-redline-token', 'access-control-request-method', 'access-control-request-headers',
]);

function duplicateSecurityHeader(req) {
  const counts = new Map();
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    const name = req.rawHeaders[index].toLowerCase();
    if (!SINGLETON_SECURITY_HEADERS.has(name)) continue;
    counts.set(name, (counts.get(name) || 0) + 1);
    if (counts.get(name) > 1) return name;
  }
  return null;
}

function corsHeaders(req, headers = {}) {
  const origin = requestOrigin(req);
  if (origin !== EXTENSION_ORIGIN) return headers;
  return {
    'access-control-allow-origin': EXTENSION_ORIGIN,
    vary: 'Origin',
    ...headers,
  };
}

function send(req, res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  const data = isBuf || typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': isBuf ? (headers['content-type'] || 'application/octet-stream') : 'application/json',
    ...corsHeaders(req, headers),
  });
  res.end(data);
}

function errorResponse(req, res, status, code, message) {
  return send(req, res, status, { error: { code, message } });
}

function validJsonContentType(req) {
  return /^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '');
}

function protectedRouteSupports(pathname, method) {
  if (pathname === '/redlines') return ['GET', 'POST'].includes(method);
  if (pathname === '/generation') return method === 'GET';
  if (pathname === '/clear') return method === 'POST';
  if (pathname === '/clients/current') return method === 'DELETE';
  if (/^\/redlines\/[^/]+\/ack$/.test(pathname)) return method === 'POST';
  if (/^\/redlines\/[^/]+$/.test(pathname)) return ['PATCH', 'DELETE'].includes(method);
  if (pathname === '/screenshots') return method === 'POST';
  if (/^\/screenshots\/[^/]+$/.test(pathname)) return method === 'GET';
  return false;
}

function parseRequestedHeaders(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const rawTokens = value.split(',');
  if (rawTokens.some((token) => token.trim().length === 0)) return null;
  const tokens = rawTokens.map((token) => token.trim().toLowerCase());
  if (tokens.some((token) => !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(token)) || new Set(tokens).size !== tokens.length) {
    return null;
  }
  return tokens;
}

async function requestIsAuthorized(req) {
  if (DEV_MODE && requestOrigin(req) === EXTENSION_ORIGIN && typeof req.headers['x-redline-token'] === 'string') {
    try {
      const expected = readPrivateCredential(DEV_BROWSER_CREDENTIAL);
      return verifySecret(req.headers['x-redline-token'], hashSecret(expected)) ? { kind: 'development' } : null;
    } catch {
      return null;
    }
  }
  const token = bearerToken(req.headers.authorization);
  if (!token) return null;
  if (requestOrigin(req) === EXTENSION_ORIGIN) {
    return { kind: 'browser', token };
  }
  if (requestOrigin(req) === null) return await stateStore.verifyCliToken(token) ? { kind: 'cli' } : null;
  return null;
}

const CONNECT_HTML = '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Connect Redline</title><body><main><h1>Connecting to Redline</h1><p>This secure handoff tab closes automatically. Continue in the Redline setup tab.</p></main></body></html>';

const server = http.createServer(async (req, res) => {
  if (duplicateSecurityHeader(req)) {
    return errorResponse(req, res, 400, 'duplicate_header', 'request contains a duplicate security header');
  }
  if (!exactHost(req)) return errorResponse(req, res, 400, 'invalid_host', 'request host is not the Redline loopback service');
  const url = new URL(req.url, `http://${EXPECTED_HOST}`);
  const route = `${req.method} ${url.pathname}`;

  if (!isAllowedOrigin(requestOrigin(req))) {
    return errorResponse(req, res, 403, 'forbidden_origin', 'request origin is not allowed');
  }

  if (req.method === 'OPTIONS') {
    const requestedMethod = req.headers['access-control-request-method'];
    const requestedHeaders = parseRequestedHeaders(req.headers['access-control-request-headers']);
    if (requestOrigin(req) !== EXTENSION_ORIGIN) {
      return errorResponse(req, res, 403, 'forbidden_preflight', 'pairing preflight is not allowed');
    }
    if (url.pathname === '/pair' && requestedMethod === 'POST' && requestedHeaders &&
        requestedHeaders.length === 2 && requestedHeaders.includes('content-type') &&
        requestedHeaders.includes('x-redline-protocol')) {
      return send(req, res, 204, '', {
        'access-control-allow-methods': 'POST',
        'access-control-allow-headers': 'Content-Type, X-Redline-Protocol',
        'cache-control': 'no-store',
      });
    }
    const protectedAuthHeader = DEV_MODE && requestedHeaders?.includes('x-redline-token')
      ? 'x-redline-token'
      : 'authorization';
    if (requestedHeaders && protectedRouteSupports(url.pathname, requestedMethod) && requestedHeaders.includes(protectedAuthHeader) &&
        requestedHeaders.every((header) => [protectedAuthHeader, 'content-type'].includes(header))) {
      const allowedHeaders = [protectedAuthHeader, 'content-type']
        .filter((header) => requestedHeaders.includes(header))
        .map((header) => {
          if (header === 'authorization') return 'Authorization';
          if (header === 'x-redline-token') return 'X-Redline-Token';
          return 'Content-Type';
        });
      return send(req, res, 204, '', {
        'access-control-allow-methods': requestedMethod,
        'access-control-allow-headers': allowedHeaders.join(', '),
        'cache-control': 'no-store',
      });
    }
    return errorResponse(req, res, 403, 'forbidden_preflight', 'request preflight is not allowed');
  }

  try {
    if (route === 'GET /health') {
      const pairing = await stateStore.pairingStatus();
      return send(req, res, 200, healthPayload({
        instanceId: INSTANCE_ID,
        launchId: LAUNCH_ID,
        directory: LAUNCH_DIRECTORY,
        pairing,
      }), { 'cache-control': 'no-store' });
    }

    if (route === 'GET /connect') {
      return send(req, res, 200, CONNECT_HTML, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      });
    }

    if (route === 'POST /pair') {
      if (requestOrigin(req) !== EXTENSION_ORIGIN) {
        return errorResponse(req, res, 403, 'forbidden_origin', 'pairing requires the Redline extension');
      }
      if (req.headers['x-redline-protocol'] !== '1') {
        return errorResponse(req, res, 400, 'incompatible_protocol', 'pairing requires Redline protocol major 1');
      }
      if (!validJsonContentType(req)) {
        return errorResponse(req, res, 415, 'unsupported_media_type', 'pairing requires application/json');
      }
      const body = await readJsonObject(req, 1);
      if (typeof body.secret !== 'string') {
        return errorResponse(req, res, 400, 'invalid_request', 'pairing request is invalid');
      }
      if (body.consent_version !== 1) {
        return errorResponse(req, res, 400, 'consent_required', 'pairing requires the current data consent grant');
      }
      if (Object.keys(body).sort().join(',') !== 'consent_version,secret') {
        return errorResponse(req, res, 400, 'invalid_request', 'pairing request is invalid');
      }
      const client = await stateStore.consumePairingSecret(body.secret, { consentVersion: body.consent_version });
      if (!client) return errorResponse(req, res, 401, 'invalid_pairing_secret', 'pairing secret is invalid or expired');
      return send(req, res, 201, {
        client_id: client.clientId,
        token: client.token,
        clear_generation: client.clearGeneration,
        consent_version: 1,
      }, { 'cache-control': 'no-store' });
    }

    const auth = await requestIsAuthorized(req);
    if (!auth) {
      return errorResponse(req, res, 401, 'unauthorized', 'missing or invalid Redline bearer token');
    }

    if (route === 'GET /generation') {
      if (!['browser', 'development'].includes(auth.kind)) {
        return errorResponse(req, res, 403, 'forbidden_origin', 'generation is available only to Redline browsers');
      }
      const clearGeneration = await stateStore.currentGeneration(
        auth.kind === 'browser' ? { browserToken: auth.token } : undefined);
      return send(req, res, 200, { clear_generation: clearGeneration }, { 'cache-control': 'no-store' });
    }

    if (route === 'DELETE /clients/current') {
      if (auth.kind !== 'browser') {
        return errorResponse(req, res, 403, 'forbidden_origin', 'browser revocation requires a paired Redline profile');
      }
      const revoked = await stateStore.revokeCurrentBrowser(auth.token);
      if (!revoked) return errorResponse(req, res, 401, 'unauthorized', 'browser client is not connected');
      return send(req, res, 204, '', { 'cache-control': 'no-store' });
    }

    if (route === 'POST /admin/pairing') {
      if (requestOrigin(req) !== null) {
        return errorResponse(req, res, 403, 'forbidden_origin', 'pairing administration is CLI-only');
      }
      const pairing = await stateStore.createPairingWindow();
      return send(req, res, 201, {
        secret: pairing.secret,
        expires_at: pairing.expiresAt,
      }, { 'cache-control': 'no-store' });
    }

    if (route === 'DELETE /admin/pairing') {
      if (requestOrigin(req) !== null) {
        return errorResponse(req, res, 403, 'forbidden_origin', 'pairing administration is CLI-only');
      }
      const body = await readJsonObject(req, 1);
      if (typeof body.secret !== 'string') {
        return errorResponse(req, res, 400, 'invalid_request', 'pairing invalidation request is invalid');
      }
      await stateStore.invalidatePairingWindow(body.secret);
      return send(req, res, 204, '', { 'cache-control': 'no-store' });
    }

    if (route === 'POST /admin/clear') {
      if (auth.kind !== 'cli' || requestOrigin(req) !== null) {
        return errorResponse(req, res, 403, 'forbidden_origin', 'clear administration is CLI-only');
      }
      const clearGeneration = await stateStore.clearAll();
      return send(req, res, 200, { clear_generation: clearGeneration }, { 'cache-control': 'no-store' });
    }

    if (route === 'POST /clear') {
      if (auth.kind !== 'browser') {
        return errorResponse(req, res, 403, 'forbidden_origin', 'browser clear requires a paired Redline profile');
      }
      if (!validJsonContentType(req)) {
        return errorResponse(req, res, 415, 'unsupported_media_type', 'browser clear requires application/json');
      }
      const body = await readJsonObject(req, 1);
      if (typeof body.operation_id !== 'string' ||
          Object.keys(body).sort().join(',') !== 'operation_id') {
        return errorResponse(req, res, 400, 'invalid_request', 'browser clear request is invalid');
      }
      const clearGeneration = await stateStore.clearAll({
        browserToken: auth.token,
        operationId: body.operation_id,
      });
      return send(req, res, 200, { clear_generation: clearGeneration }, { 'cache-control': 'no-store' });
    }

    if (route === 'POST /redlines') {
      const body = await readJsonObject(req, 20);
      if (auth.kind === 'browser') {
        const item = await stateStore.submitRedline(null, body, { browserToken: auth.token });
        return send(req, res, item.replayed ? 200 : 201, item);
      }
      if (auth.kind === 'development') {
        const item = await stateStore.submitDevelopmentRedline(body);
        return send(req, res, item.replayed ? 200 : 201, item);
      }
      const item = await stateStore.createLegacyRedline(body);
      return send(req, res, 201, item);
    }

    if (route === 'GET /redlines') {
      const status = url.searchParams.get('status');
      const origin = url.searchParams.get('origin');
      const project = url.searchParams.get('project');
      const items = await stateStore.listRedlines({ status, origin, project },
        auth.kind === 'browser' ? { browserToken: auth.token } : undefined);
      return send(req, res, 200, items);
    }

    const ackMatch = url.pathname.match(/^\/redlines\/([^/]+)\/ack$/);
    if (req.method === 'POST' && ackMatch) {
      const item = await stateStore.updateRedline(ackMatch[1], {}, {
        ack: true, ...(auth.kind === 'browser' ? { browserToken: auth.token } : {}),
      });
      if (!item) return send(req, res, 404, { error: 'not found' });
      return send(req, res, 200, item);
    }

    const updateMatch = url.pathname.match(/^\/redlines\/([^/]+)$/);
    if (req.method === 'PATCH' && updateMatch) {
      const body = await readJsonObject(req, 1);
      const item = await stateStore.updateRedline(updateMatch[1], body,
        auth.kind === 'browser' ? { browserToken: auth.token } : undefined);
      if (!item) return send(req, res, 404, { error: 'not found' });
      return send(req, res, 200, item);
    }

    const delMatch = url.pathname.match(/^\/redlines\/([^/]+)$/);
    if (req.method === 'DELETE' && delMatch) {
      await stateStore.deleteRedline(delMatch[1],
        auth.kind === 'browser' ? { browserToken: auth.token } : undefined);
      return send(req, res, 204, '');
    }

    if (route === 'POST /screenshots') {
      if (!DEV_MODE) return errorResponse(req, res, 404, 'not_found', 'separate screenshot upload is unavailable');
      const body = await readJsonObject(req, 20);
      const screenshot = await stateStore.storeDevelopmentScreenshot(body.data_url);
      return send(req, res, 201, screenshot);
    }

    const shotMatch = url.pathname.match(/^\/screenshots\/([^/]+)$/);
    if (req.method === 'GET' && shotMatch) {
      const screenshot = await stateStore.readScreenshot(shotMatch[1].replace(/\.png$/, ''),
        auth.kind === 'browser' ? { browserToken: auth.token } : undefined);
      if (!screenshot) return send(req, res, 404, { error: 'not found' });
      return send(req, res, 200, screenshot, { 'content-type': 'image/png' });
    }

    send(req, res, 404, { error: 'not found', route });
  } catch (error) {
    if (error instanceof HttpRequestError) {
      return errorResponse(req, res, error.status, error.code, error.message);
    }
    if (error instanceof StateStoreError) {
      const statuses = {
        operation_conflict: 409, operation_deleted: 410, data_cleared: 410,
        unauthorized: 401, payload_too_large: 413,
      };
      return errorResponse(req, res, statuses[error.code] || 400, error.code, error.message);
    }
    send(req, res, 500, { error: 'Redline request failed' });
  }
});

let launchCommitted = typeof process.send !== 'function';

function launcherPath(name) {
  const candidate = process.env[name];
  if (!candidate) return null;
  const root = path.resolve(ROOT);
  const resolved = path.resolve(candidate);
  return path.dirname(resolved) === root ? resolved : null;
}

function removeOwnedFile(file, expected, label) {
  if (!file) return;
  try { removeLifecycleFile(file, label, expected); } catch {}
}

function removeOwnedLaunchFile(file, label) {
  if (!file) return;
  try {
    const inspected = inspectLifecycleFile(file, label);
    if (!inspected) return;
    const metadata = parseLaunchMetadata(inspected.contents);
    if (metadata.pid !== process.pid || metadata.launch_id !== LAUNCH_ID) return;
    removeLifecycleFile(file, label, inspected.contents);
  } catch {}
}

function cleanUncommittedLaunch() {
  if (launchCommitted) return;
  const pidFile = launcherPath('REDLINE_LAUNCH_PID_FILE');
  const pidTmp = launcherPath('REDLINE_LAUNCH_PID_TMP');
  const lockDir = launcherPath('REDLINE_LAUNCH_LOCK_DIR');
  const expectedOwner = process.env.REDLINE_LAUNCH_LOCK_OWNER;
  removeOwnedLaunchFile(pidFile, 'sidecar.pid');
  removeOwnedLaunchFile(pidTmp, 'temporary sidecar.pid');
  try {
    if (lockDir) {
      const lock = fs.lstatSync(lockDir);
      if (!lock.isDirectory() || lock.isSymbolicLink()) return;
      const ownerFile = path.join(lockDir, 'owner.pid');
      removeOwnedFile(ownerFile, expectedOwner, 'startup lock owner');
      const current = fs.lstatSync(lockDir);
      if (current.isDirectory() && !current.isSymbolicLink() &&
          current.dev === lock.dev && current.ino === lock.ino) fs.rmdirSync(lockDir);
    }
  } catch {}
}

function abortUncommittedLaunch() {
  if (launchCommitted) return;
  cleanUncommittedLaunch();
  server.close(() => process.exit(1));
  setTimeout(() => process.exit(1), 250).unref();
}

if (typeof process.send === 'function') {
  process.once('disconnect', abortUncommittedLaunch);
  process.on('message', (message) => {
    if (launchCommitted || !message || message.type !== 'redline-commit' ||
        message.pid !== process.pid || message.instanceId !== INSTANCE_ID || message.launchId !== LAUNCH_ID) return;
    const pidFile = launcherPath('REDLINE_LAUNCH_PID_FILE');
    try {
      if (!pidFile) return;
      const metadata = parseLaunchMetadata(inspectLifecycleFile(pidFile, 'sidecar.pid')?.contents);
      if (metadata.pid !== process.pid || metadata.instance_id !== INSTANCE_ID || metadata.launch_id !== LAUNCH_ID) return;
    } catch {
      return;
    }
    launchCommitted = true;
    process.send({ type: 'redline-committed', pid: process.pid, instanceId: INSTANCE_ID, launchId: LAUNCH_ID });
  });
}

async function startServer() {
  await stateStore.ensureCliCredential();
  await stateStore.initialize();
  server.listen(LISTEN_PORT, '127.0.0.1', () => {
    console.log(`redline sidecar listening on http://127.0.0.1:${LISTEN_PORT}`);
    console.log(`data dir: ${ROOT}`);
    if (typeof process.send === 'function') {
      process.send({ type: 'redline-ready', pid: process.pid, instanceId: INSTANCE_ID, launchId: LAUNCH_ID });
    }
  });
}

startServer().catch((error) => {
  console.error(`Redline state initialization failed: ${error.message}`);
  cleanUncommittedLaunch();
  process.exit(1);
});
