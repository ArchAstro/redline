importScripts('auth.js');

const PORT = globalThis.REDLINE_CONFIG.port;
const BASE = `http://127.0.0.1:${PORT}`;
const DEV_MODE = PORT !== 7878;
const CONNECTION_KEY = 'redline_connection';
const SIDECAR_REQUEST_TIMEOUT_MS = 3000;
const OPERATION_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PENDING_DB_NAME = 'redline_pending';
const PENDING_DB_VERSION = 1;
const PENDING_STORE_NAME = 'submissions';

class RedlineExtensionError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function connectionState() {
  if (DEV_MODE) {
    const token = globalThis.REDLINE_CONFIG.token;
    if (typeof token !== 'string' || !token) {
      throw new RedlineExtensionError('connection_required', 'Redline contributor mode needs setup again before submitting.');
    }
    return { clientId: 'development', clearGeneration: 0, headers: { 'x-redline-token': token } };
  }
  const stored = await chrome.storage.local.get(CONNECTION_KEY);
  const connection = stored?.[CONNECTION_KEY];
  if (!connection || typeof connection !== 'object' ||
      !/^rlc_[0-9a-f]{32}$/.test(connection.client_id || '') ||
      typeof connection.token !== 'string' || !connection.token ||
      !Number.isSafeInteger(connection.clear_generation) || connection.clear_generation < 0 ||
      (connection.port !== undefined && connection.port !== 7878)) {
    throw new RedlineExtensionError('connection_required', 'Redline needs to be connected again before submitting.');
  }
  return {
    clientId: connection.client_id,
    clearGeneration: connection.clear_generation,
    headers: { authorization: `Bearer ${connection.token}` },
  };
}

async function sidecarRequest(url, options = {}, consumeBody = null, authHeaders = null) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SIDECAR_REQUEST_TIMEOUT_MS);
  try {
    const headers = authHeaders || (await connectionState()).headers;
    const response = await fetch(url, {
      ...options,
      headers: { ...headers, ...(options.headers || {}) },
      signal: controller.signal,
    });
    const body = consumeBody ? await consumeBody(response) : null;
    return { response, body };
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('Redline sidecar request timed out');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function sidecarFetch(url, options = {}) {
  return (await sidecarRequest(url, options)).response;
}

async function sidecarJson(url, options = {}, authHeaders = null) {
  return await sidecarRequest(url, options, async (response) => {
    try { return await response.json(); } catch (error) {
      if (error?.name === 'AbortError') throw error;
      return null;
    }
  }, authHeaders);
}

function sidecarError(response, body, operation) {
  const code = body?.error?.code;
  if (response.status === 401) {
    return new RedlineExtensionError('unauthorized',
      'Redline authentication changed. Reload Redline in chrome://extensions, then refresh this page.');
  }
  const messages = {
    operation_conflict: 'This Redline draft conflicts with an earlier submission. Discard it and try again.',
    operation_deleted: 'This Redline draft was already deleted. Discard it before trying again.',
    data_cleared: 'Redline data was cleared. Reconnect and discard this old draft before trying again.',
  };
  if (messages[code]) return new RedlineExtensionError(code, messages[code]);
  return new RedlineExtensionError('sidecar_error', `${operation} failed (HTTP ${response.status}).`);
}

const screenshotByTab = new Map();
const SCREENSHOT_TIMEOUT_MS = 2000;
let screenshotOperation = Promise.resolve();

function withScreenshotLock(operation) {
  const run = screenshotOperation.then(operation, operation);
  screenshotOperation = run.catch(() => {});
  return run;
}

async function withTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function captureScreenshotForTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const cached = screenshotByTab.get(tabId);
  if (cached && cached.url === tab.url) return cached.screenshot_png;
  const dataUrl = await withTimeout(
    chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }),
    SCREENSHOT_TIMEOUT_MS,
    'screenshot capture timed out'
  );
  const prefix = 'data:image/png;base64,';
  const encoded = typeof dataUrl === 'string' && dataUrl.startsWith(prefix) ? dataUrl.slice(prefix.length) : null;
  if (encoded === null || encoded.length === 0 || encoded.length % 4 !== 0) {
    throw new Error('captured screenshot is not an encoded PNG');
  }
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  for (let index = 0; index < encoded.length - padding; index += 1) {
    const code = encoded.charCodeAt(index);
    if (!((code >= 48 && code <= 57) || (code >= 65 && code <= 90) ||
        (code >= 97 && code <= 122) || code === 43 || code === 47)) {
      throw new Error('captured screenshot is not an encoded PNG');
    }
  }
  if (encoded.slice(0, encoded.length - padding).includes('=')) {
    throw new Error('captured screenshot is not an encoded PNG');
  }
  if (encoded.length > Math.ceil(MAX_SCREENSHOT_BYTES / 3) * 4) {
    throw new Error('captured screenshot is too large');
  }
  let decoded;
  try { decoded = atob(encoded); } catch { throw new Error('captured screenshot is not valid base64'); }
  if (decoded.length < PNG_MAGIC.length || decoded.length > MAX_SCREENSHOT_BYTES ||
      PNG_MAGIC.some((byte, index) => decoded.charCodeAt(index) !== byte)) {
    throw new Error('captured screenshot is not a valid PNG');
  }
  screenshotByTab.set(tabId, { url: tab.url, screenshot_png: encoded });
  return encoded;
}

function submissionOperationId(value) {
  if (value !== undefined) {
    if (typeof value !== 'string' || !OPERATION_ID_PATTERN.test(value)) {
      throw new RedlineExtensionError('invalid_operation_id', 'The Redline draft operation ID is invalid.');
    }
    return value;
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `op_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function canonicalDraftJson(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (!value || typeof value !== 'object' || ancestors.has(value)) {
    throw new RedlineExtensionError('invalid_submission', 'The Redline draft contains invalid data.');
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new RedlineExtensionError('invalid_submission', 'The Redline draft contains invalid data.');
        }
        items.push(canonicalDraftJson(value[index], ancestors));
      }
      return `[${items.join(',')}]`;
    }
    if (Object.prototype.toString.call(value) !== '[object Object]') {
      throw new RedlineExtensionError('invalid_submission', 'The Redline draft contains invalid data.');
    }
    return `{${Object.keys(value).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalDraftJson(value[key], ancestors)}`).join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

async function sha256Text(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function durableDraftIdentity(msg, sender) {
  const sourceHash = await sha256Text(canonicalDraftJson(msg.payload || {}));
  if (msg.submission_key !== undefined) {
    if (typeof msg.submission_key !== 'string' || !/^draft_[A-Za-z0-9_-]{16,128}$/.test(msg.submission_key)) {
      throw new RedlineExtensionError('invalid_submission_key', 'The Redline submission key is invalid.');
    }
    return { sourceHash, storageKey: `redline_pending::${msg.submission_key}` };
  }
  const tabId = Number.isSafeInteger(sender.tab?.id) ? sender.tab.id : null;
  const keyHash = await sha256Text(canonicalDraftJson({ payload: msg.payload || {}, tab_id: tabId }));
  return { sourceHash, storageKey: `redline_pending::draft_${keyHash}` };
}

function validatePendingDraft(value, sourceHash, connection, version = 2) {
  const keys = value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).sort().join(',') : '';
  const expectedKeys = version === 1
    ? 'client_id,operation_id,payload,source_hash,version'
    : 'client_id,operation_id,payload,payload_hash,source_hash,version';
  if (keys !== expectedKeys || value.version !== version ||
      value.client_id !== connection.clientId || value.source_hash !== sourceHash ||
      typeof value.operation_id !== 'string' || !OPERATION_ID_PATTERN.test(value.operation_id) ||
      (version === 2 && !/^[0-9a-f]{64}$/.test(value.payload_hash || '')) ||
      !value.payload || typeof value.payload !== 'object' || Array.isArray(value.payload) ||
      value.payload.operation_id !== value.operation_id ||
      !Number.isSafeInteger(value.payload.clear_generation) || value.payload.clear_generation < 0) {
    throw new RedlineExtensionError('pending_submission_invalid',
      'The saved Redline submission cannot be retried safely. Discard it before trying again.');
  }
  canonicalDraftJson(value.payload);
  return value;
}

function pendingStorageError() {
  return new RedlineExtensionError('pending_storage_unavailable',
    'The Redline draft could not be saved safely. Try submitting again without discarding it.');
}

function openPendingDatabase() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB !== 'object' || indexedDB === null || typeof indexedDB.open !== 'function') {
      reject(pendingStorageError());
      return;
    }
    let request;
    try { request = indexedDB.open(PENDING_DB_NAME, PENDING_DB_VERSION); } catch { reject(pendingStorageError()); return; }
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(PENDING_STORE_NAME)) {
        request.result.createObjectStore(PENDING_STORE_NAME);
      }
    };
    request.onerror = () => reject(pendingStorageError());
    request.onsuccess = () => resolve(request.result);
  });
}

async function pendingDatabaseRequest(mode, makeRequest) {
  const database = await openPendingDatabase();
  try {
    let transaction;
    try { transaction = database.transaction(PENDING_STORE_NAME, mode); } catch { throw pendingStorageError(); }
    let request;
    try { request = makeRequest(transaction.objectStore(PENDING_STORE_NAME)); } catch { throw pendingStorageError(); }
    return await new Promise((resolve, reject) => {
      let requestFinished = false;
      let transactionFinished = false;
      let requestResult;
      let settled = false;
      const fail = () => {
        if (settled) return;
        settled = true;
        reject(pendingStorageError());
      };
      const finish = () => {
        if (settled || !requestFinished || !transactionFinished) return;
        settled = true;
        resolve(requestResult);
      };
      request.onsuccess = () => {
        requestResult = request.result;
        requestFinished = true;
        finish();
      };
      request.onerror = fail;
      transaction.oncomplete = () => {
        transactionFinished = true;
        finish();
      };
      transaction.onerror = fail;
      transaction.onabort = fail;
    });
  } finally {
    database.close();
  }
}

const pendingDatabase = {
  get(key) { return pendingDatabaseRequest('readonly', (store) => store.get(key)); },
  put(key, value) { return pendingDatabaseRequest('readwrite', (store) => store.put(value, key)); },
  delete(key) { return pendingDatabaseRequest('readwrite', (store) => store.delete(key)); },
};

async function pendingLocalGet(key) {
  try { return await chrome.storage.local.get(key); } catch { throw pendingStorageError(); }
}

async function pendingLocalSet(key, value) {
  try { await chrome.storage.local.set({ [key]: value }); } catch { throw pendingStorageError(); }
}

async function pendingLocalRemove(key) {
  try { await chrome.storage.local.remove(key); } catch { throw pendingStorageError(); }
}

function pendingLocator(pending) {
  return {
    version: 2,
    client_id: pending.client_id,
    source_hash: pending.source_hash,
    operation_id: pending.operation_id,
    payload_hash: pending.payload_hash,
  };
}

function validatePendingLocator(value, sourceHash, connection) {
  const keys = value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).sort().join(',') : '';
  if (keys !== 'client_id,operation_id,payload_hash,source_hash,version' || value.version !== 2 ||
      value.client_id !== connection.clientId || value.source_hash !== sourceHash ||
      typeof value.operation_id !== 'string' || !OPERATION_ID_PATTERN.test(value.operation_id) ||
      !/^[0-9a-f]{64}$/.test(value.payload_hash || '')) {
    throw new RedlineExtensionError('pending_submission_invalid',
      'The saved Redline submission cannot be retried safely. Discard it before trying again.');
  }
  return value;
}

async function loadPendingDraft(storageKey, sourceHash, connection) {
  const stored = await pendingLocalGet(storageKey);
  const local = Object.hasOwn(stored || {}, storageKey) ? stored[storageKey] : null;
  if (local?.version === 1) {
    const legacy = validatePendingDraft(local, sourceHash, connection, 1);
    const migrated = {
      ...legacy,
      version: 2,
      payload_hash: await sha256Text(canonicalDraftJson(legacy.payload)),
    };
    await pendingDatabase.put(storageKey, migrated);
    await pendingLocalSet(storageKey, pendingLocator(migrated));
    return migrated;
  }
  if (local !== null) validatePendingLocator(local, sourceHash, connection);
  const durable = await pendingDatabase.get(storageKey);
  if (durable === undefined) {
    if (local !== null) {
      throw new RedlineExtensionError('pending_submission_invalid',
        'The saved Redline submission cannot be retried safely. Discard it before trying again.');
    }
    return null;
  }
  const pending = validatePendingDraft(durable, sourceHash, connection);
  if (await sha256Text(canonicalDraftJson(pending.payload)) !== pending.payload_hash) {
    throw new RedlineExtensionError('pending_submission_invalid',
      'The saved Redline submission cannot be retried safely. Discard it before trying again.');
  }
  if (durable.version !== 2 || (local !== null && local.operation_id !== pending.operation_id)) {
    throw new RedlineExtensionError('pending_submission_invalid',
      'The saved Redline submission cannot be retried safely. Discard it before trying again.');
  }
  if (local !== null && local.payload_hash !== pending.payload_hash) {
    throw new RedlineExtensionError('pending_submission_invalid',
      'The saved Redline submission cannot be retried safely. Discard it before trying again.');
  }
  if (local === null) await pendingLocalSet(storageKey, pendingLocator(pending));
  return pending;
}

async function currentClearGeneration(authHeaders) {
  const { response, body } = await sidecarJson(`${BASE}/generation`, { method: 'GET' }, authHeaders);
  if (!response.ok) throw sidecarError(response, body, 'GET /generation');
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).sort().join(',') !== 'clear_generation' ||
      !Number.isSafeInteger(body.clear_generation) || body.clear_generation < 0) {
    throw new RedlineExtensionError('invalid_generation', 'Redline returned an invalid data generation.');
  }
  return body.clear_generation;
}

async function savePendingDraft(storageKey, pending) {
  await pendingDatabase.put(storageKey, pending);
  await pendingLocalSet(storageKey, pendingLocator(pending));
}

async function removePendingDraft(storageKey) {
  await pendingLocalRemove(storageKey);
  await pendingDatabase.delete(storageKey);
}

async function submitTransaction(payload, authHeaders) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await sidecarJson(`${BASE}/redlines`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }, authHeaders);
      if (!result.response.ok) throw sidecarError(result.response, result.body, 'POST /redlines');
      if (!result.body || typeof result.body !== 'object' || !/^rl_[A-Za-z0-9_-]+$/.test(result.body.id || '')) {
        throw new Error('Redline sidecar returned an invalid submission response');
      }
      return result.body;
    } catch (error) {
      if (error instanceof RedlineExtensionError || attempt === 1) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url) screenshotByTab.delete(tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => screenshotByTab.delete(tabId));

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === 'submit-redline') {
        const item = await withScreenshotLock(async () => {
          const connection = await connectionState();
          const identity = await durableDraftIdentity(msg, sender);
          let pending = await loadPendingDraft(identity.storageKey, identity.sourceHash, connection);
          if (!pending) {
            const operation_id = submissionOperationId(msg.operation_id ?? msg.payload?.operation_id);
            const clear_generation = await currentClearGeneration(connection.headers);
            const tabId = sender.tab?.id;
            let screenshot_png = null;
            if (tabId != null) {
              try {
                screenshot_png = await captureScreenshotForTab(tabId);
              } catch (e) {
                console.warn('[redline] screenshot capture failed:', e.message);
              }
            }
            const payload = {
              ...msg.payload,
              operation_id,
              clear_generation,
            };
            delete payload.screenshot_id;
            delete payload.screenshot_png;
            if (screenshot_png) payload.screenshot_png = screenshot_png;
            canonicalDraftJson(payload);
            pending = {
              version: 2,
              client_id: connection.clientId,
              source_hash: identity.sourceHash,
              operation_id,
              payload,
              payload_hash: await sha256Text(canonicalDraftJson(payload)),
            };
            await savePendingDraft(identity.storageKey, pending);
          }
          const receipt = await submitTransaction(pending.payload, connection.headers);
          await removePendingDraft(identity.storageKey);
          return receipt;
        });
        sendResponse({ ok: true, item });
        return;
      }

      if (msg.type === 'update-redline') {
        const { response: resp, body: item } = await sidecarJson(`${BASE}/redlines/${msg.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(msg.payload),
        });
        if (!resp.ok) throw sidecarError(resp, item, `PATCH /redlines/${msg.id}`);
        sendResponse({ ok: true, item });
        return;
      }

      if (msg.type === 'delete-redline') {
        await withScreenshotLock(async () => {
          const resp = await sidecarFetch(`${BASE}/redlines/${msg.id}`, { method: 'DELETE' });
          if (!resp.ok && resp.status !== 204) throw sidecarError(resp, null, 'DELETE /redlines');
          // Deleting the final redline for a screenshot also deletes the PNG in
          // the sidecar. Drop all cached IDs so none can be reused after removal.
          screenshotByTab.clear();
        });
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === 'list-redlines') {
        const params = new URLSearchParams();
        if (msg.status) params.set('status', msg.status);
        if (msg.origin) params.set('origin', msg.origin);
        if (msg.project) params.set('project', msg.project);
        const qs = params.toString();
        const { response: resp, body: items } = await sidecarJson(`${BASE}/redlines${qs ? `?${qs}` : ''}`);
        if (!resp.ok) throw sidecarError(resp, items, 'GET /redlines');
        sendResponse({ ok: true, items });
        return;
      }

      if (msg.type === 'refresh-screenshot') {
        const tabId = msg.tabId ?? sender.tab?.id;
        await withScreenshotLock(async () => {
          if (tabId != null) screenshotByTab.delete(tabId);
        });
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === 'health') {
        const r = await fetch(`${BASE}/health`).catch(() => null);
        sendResponse({ ok: !!(r && r.ok) });
        return;
      }

      sendResponse({ ok: false, error: 'unknown message: ' + msg.type });
    } catch (e) {
      sendResponse({ ok: false, error_code: e.code || 'request_failed', error: e.message });
    }
  })();
  return true;
});
