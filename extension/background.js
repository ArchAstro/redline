importScripts('permissions.js', 'revocations.js');

const DEV_CONFIG = globalThis.REDLINE_CONFIG;
const PORT = DEV_CONFIG?.port ?? 7878;
const BASE = `http://127.0.0.1:${PORT}`;
const DEV_MODE = PORT !== 7878;
const POPUP_PROTOCOL_VERSION = 1;
const CONNECTION_KEY = 'redline_connection';
const SIDECAR_REQUEST_TIMEOUT_MS = 3000;
const OPERATION_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PENDING_DB_NAME = 'redline_pending';
const PENDING_DB_VERSION = 1;
const PENDING_STORE_NAME = 'submissions';
const PAIRING_SECRET_KEY = 'redline_pairing_secret';
const PAIRING_SECRET_TTL_MS = 10 * 60 * 1000;
const PAIRING_SECRET_ALARM = 'redline-pairing-secret-expiry';
const PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MARKER_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PENDING_CLEANUP_ALARM = 'redline-pending-cleanup';
const REVOCATION_RETRY_ALARM = 'redline-revocation-retry';
const REVOCATION_RETRY_MS = 60 * 1000;
const PENDING_CLEAR_KEY = 'redline_pending_clear';
const CLEAR_CLEANUP_RETRY_ALARM = 'redline-clear-cleanup-retry';
let storageAccessError = null;
let pairingSecretOperation = Promise.resolve();
let pendingMaintenanceOperation = Promise.resolve();
let revocationOperation = Promise.resolve();
let permissionController = null;
const screenshotByTab = new Map();
let captureContextEpoch = 0;
const revocationStore = globalThis.RedlineRevocations.createRevocationStore(chrome.storage.local);
const storageAreasSupportTrustedAccess =
  typeof chrome.storage.local?.setAccessLevel === 'function' &&
  typeof chrome.storage.session?.setAccessLevel === 'function' &&
  typeof chrome.alarms?.create === 'function' && typeof chrome.alarms?.get === 'function' &&
  typeof chrome.alarms?.clear === 'function' && typeof chrome.alarms?.onAlarm?.addListener === 'function';
const storageAccessReady = (storageAreasSupportTrustedAccess ? Promise.all([
  chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
  chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
]) : Promise.reject(new Error('trusted-context storage APIs are unavailable'))).catch((error) => {
  storageAccessError = error;
});

async function notifyDisabledOrigins(origins) {
  screenshotByTab.clear();
  const tabs = await chrome.tabs.query?.({}) || [];
  await Promise.all(tabs
    .filter((tab) => Number.isSafeInteger(tab.id))
    .map((tab) => chrome.tabs.sendMessage?.(tab.id, {
      type: 'redline-disable-site',
      origins,
    }).catch?.(() => {})));
}

function notifyPermissionsChanged() {
  captureContextEpoch += 1;
  screenshotByTab.clear();
}

if (!DEV_MODE && globalThis.RedlinePermissions && chrome.permissions && chrome.scripting) {
  permissionController = globalThis.RedlinePermissions.createPermissionController({
    permissions: chrome.permissions,
    scripting: chrome.scripting,
    storage: chrome.storage.local,
    onOriginsDisabled: notifyDisabledOrigins,
    onPermissionsChanged: notifyPermissionsChanged,
  });
  permissionController.start().catch((error) => {
    console.warn('[redline] permission reconciliation failed:', error.message);
  });
  chrome.runtime.onStartup?.addListener(() => {
    permissionController.reconcile().catch((error) => {
      console.warn('[redline] permission reconciliation failed:', error.message);
    });
  });
}

function requirePermissionController() {
  if (!permissionController) {
    throw new RedlineExtensionError('permission_unavailable',
      'Per-site controls are available in the Chrome Web Store extension.');
  }
  return permissionController;
}

function markerStorageKeys(sender) {
  if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || !sender.tab ||
      typeof sender.url !== 'string') {
    throw new RedlineExtensionError('invalid_marker_storage', 'Marker storage sender was rejected.');
  }
  let url;
  try { url = new URL(sender.url); } catch {}
  if (!url || !['http:', 'https:'].includes(url.protocol)) {
    throw new RedlineExtensionError('invalid_marker_storage', 'Marker storage sender was rejected.');
  }
  return new Set(['rl_last_project', `rl_items::${url.origin}${url.pathname}`]);
}

async function requireEnabledContentSender(sender) {
  if (!permissionController || !sender?.tab) return;
  const senderUrl = typeof sender.url === 'string' ? sender.url : sender.tab.url;
  if (sender.id !== chrome.runtime.id || sender.frameId !== 0 ||
      typeof senderUrl !== 'string' || sender.tab.url !== senderUrl) {
    throw new RedlineExtensionError('invalid_page_sender', 'Page sender was rejected.');
  }
  const state = await permissionController.getState(senderUrl);
  if (!state.supported || !state.siteEnabled) {
    throw new RedlineExtensionError('site_not_enabled',
      'Redline is disabled for this site. Enable it from the extension popup to continue.');
  }
}

function requireTrustedExtensionPageSender(sender) {
  if (sender?.id !== chrome.runtime.id || sender.frameId !== 0 || sender.tab ||
      typeof sender.url !== 'string' ||
      !sender.url.startsWith(`chrome-extension://${chrome.runtime.id}/`)) {
    throw new RedlineExtensionError('invalid_extension_sender',
      'Extension page sender was rejected.');
  }
}

function validMarkerRecord(record, { requireFuture = false } = {}) {
  if (!record || typeof record !== 'object' || Array.isArray(record) ||
      !record.item || typeof record.item !== 'object' || Array.isArray(record.item) ||
      typeof record.item.id !== 'string' || !record.item.id ||
      !record.ser || typeof record.ser !== 'object' || Array.isArray(record.ser) ||
      !canonicalTimestamp(record.expires_at)) return false;
  const expiry = Date.parse(record.expires_at);
  if (expiry > Date.now() + MARKER_TTL_MS) return false;
  return !requireFuture || expiry > Date.now();
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function validateMarkerStorageRequest(values, sender, { write = false } = {}) {
  const allowed = markerStorageKeys(sender);
  const keys = write
    ? (values && typeof values === 'object' && !Array.isArray(values) ? Object.keys(values) : [])
    : (Array.isArray(values) ? values : []);
  if (!keys.length || keys.length > 2 || new Set(keys).size !== keys.length ||
      keys.some((key) => typeof key !== 'string' || !allowed.has(key))) {
    throw new RedlineExtensionError('invalid_marker_storage', 'Marker storage request was rejected.');
  }
  if (write) {
    const project = values.rl_last_project;
    if (Object.hasOwn(values, 'rl_last_project') &&
        !(project === null || (typeof project === 'string' && project.length <= 200))) {
      throw new RedlineExtensionError('invalid_marker_storage', 'Marker storage value was rejected.');
    }
    for (const key of keys.filter((candidate) => candidate.startsWith('rl_items::'))) {
      if (!Array.isArray(values[key]) ||
          values[key].some((record) => !validMarkerRecord(record, { requireFuture: true }))) {
        throw new RedlineExtensionError('invalid_marker_storage', 'Marker storage value was rejected.');
      }
    }
    if (new TextEncoder().encode(JSON.stringify(values)).byteLength > 1024 * 1024) {
      throw new RedlineExtensionError('invalid_marker_storage', 'Marker storage value is too large.');
    }
  }
  return keys;
}

async function injectRedlineIntoTab(tabId) {
  if (!Number.isSafeInteger(tabId)) return;
  await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] });
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
}

async function screenshotAllowed(tabId, senderUrl) {
  if (!permissionController) return true;
  const url = senderUrl || (await chrome.tabs.get(tabId)).url;
  return permissionController.canCaptureScreenshot(url);
}

function exactConnectUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port === '7878' &&
      url.pathname === '/connect' && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function exactPairingTabUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port !== '7878' ||
        url.pathname !== '/connect' || url.username || url.password || url.search) return false;
    return /^#pair=[A-Za-z0-9_-]{43}&expires_at=\d{4}-\d{2}-\d{2}T\d{2}(?:%3A|:)\d{2}(?:%3A|:)\d{2}\.\d{3}Z$/.test(url.hash);
  } catch {
    return false;
  }
}

function validConnectSender(msg, sender) {
  return msg && typeof msg === 'object' && !Array.isArray(msg) &&
    Object.keys(msg).sort().join(',') === 'expires_at,secret,source,type' &&
    msg.type === 'redline-stage-pairing-secret' && msg.source === 'redline-connect-v1' &&
    /^[A-Za-z0-9_-]{43}$/.test(msg.secret || '') &&
    canonicalTimestamp(msg.expires_at) && Date.parse(msg.expires_at) > Date.now() &&
    Date.parse(msg.expires_at) <= Date.now() + PAIRING_SECRET_TTL_MS &&
    sender?.id === chrome.runtime.id && sender.frameId === 0 &&
    Number.isSafeInteger(sender.tab?.id) &&
    (exactConnectUrl(sender.url) || exactPairingTabUrl(sender.url)) &&
    (exactConnectUrl(sender.tab.url) || exactPairingTabUrl(sender.tab.url));
}

let onboardingHandoff = Promise.resolve();

function queueOnboardingHandoff(operation) {
  const run = onboardingHandoff.then(operation, operation);
  onboardingHandoff = run.catch(() => {});
  return run;
}

async function ensureOnboardingTab() {
  const onboardingUrl = chrome.runtime.getURL('onboarding.html');
  let existing = [];
  try {
    existing = await chrome.tabs.query({ url: onboardingUrl });
  } catch {
    existing = [];
  }
  const live = existing.filter((tab) => Number.isSafeInteger(tab.id));
  if (live.length) {
    try { await chrome.tabs.update(live[0].id, { active: true }); } catch { /* keep going */ }
    return live[0].id;
  }
  const created = await chrome.tabs.create({ url: onboardingUrl, active: true });
  return Number.isSafeInteger(created?.id) ? created.id : null;
}

async function returnToOnboarding(connectTabId) {
  await queueOnboardingHandoff(async () => {
    await ensureOnboardingTab();
    await chrome.tabs.remove(connectTabId);
  });
}

class RedlineExtensionError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function requireTrustedStorageAccess() {
  await storageAccessReady;
  if (storageAccessError) {
    throw new RedlineExtensionError('storage_access_failed',
      'Redline could not protect its local browser credentials. Reload the extension and retry.');
  }
}

async function maintainPairingSecret() {
  await requireTrustedStorageAccess();
  const stored = await chrome.storage.session.get(PAIRING_SECRET_KEY);
  const staged = stored?.[PAIRING_SECRET_KEY];
  const expiry = typeof staged?.expires_at === 'string' ? Date.parse(staged.expires_at) : NaN;
  const valid = staged && typeof staged === 'object' && !Array.isArray(staged) &&
    Object.keys(staged).sort().join(',') === 'expires_at,secret' &&
    /^[A-Za-z0-9_-]{43}$/.test(staged.secret || '') && Number.isFinite(expiry) &&
    new Date(expiry).toISOString() === staged.expires_at;
  if (!valid || expiry <= Date.now()) {
    if (staged !== undefined) await chrome.storage.session.remove(PAIRING_SECRET_KEY);
    await chrome.alarms.clear(PAIRING_SECRET_ALARM);
    return null;
  }
  await chrome.alarms.create(PAIRING_SECRET_ALARM, { when: expiry });
  return staged;
}

function queuePairingSecretOperation(operation) {
  const run = pairingSecretOperation.then(operation, operation);
  pairingSecretOperation = run.catch(() => {});
  return run;
}

function queuePendingMaintenance() {
  const run = pendingMaintenanceOperation.then(maintainPendingDrafts, maintainPendingDrafts);
  pendingMaintenanceOperation = run.catch(() => {});
  return run;
}

async function appendPendingRevocation(revocation) {
  await revocationStore.put(revocation);
}

async function maintainPendingRevocation() {
  await requireTrustedStorageAccess();
  const pending = await revocationStore.list();
  if (!pending.length) {
    await chrome.alarms.clear(REVOCATION_RETRY_ALARM);
    return true;
  }
  for (const revocation of pending) {
    try {
      const { response } = await sidecarRequest(`${BASE}/clients/current`, { method: 'DELETE' }, null, {
        authorization: `Bearer ${revocation.token}`,
      });
      if (response.status !== 204 && response.status !== 401) throw new Error('revocation failed');
      const local = await chrome.storage.local.get(CONNECTION_KEY);
      if (local?.[CONNECTION_KEY]?.token === revocation.token) {
        await chrome.storage.local.remove(CONNECTION_KEY);
      }
      await revocationStore.remove(revocation);
    } catch {
      // Keep failed entries in the durable queue for the retry alarm.
    }
  }
  if (!(await revocationStore.list()).length) {
    await chrome.alarms.clear(REVOCATION_RETRY_ALARM);
    return true;
  }
  await chrome.alarms.create(REVOCATION_RETRY_ALARM, { when: Date.now() + REVOCATION_RETRY_MS });
  return false;
}

function queueRevocationOperation(operation) {
  const run = revocationOperation.then(operation, operation);
  revocationOperation = run.catch(() => {});
  return run;
}

function queueRevocationMaintenance() {
  return queueRevocationOperation(maintainPendingRevocation);
}

function validPendingClear(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 ||
      !/^rlc_[0-9a-f]{32}$/.test(value.client_id || '') ||
      !/^[A-Za-z0-9_-]{43}$/.test(value.token || '') ||
      (value.state !== 'requested' && value.state !== 'committed')) return false;
  if (value.state === 'requested') {
    return Object.keys(value).sort().join(',') === 'client_id,operation_id,state,token,version' &&
      OPERATION_ID_PATTERN.test(value.operation_id || '');
  }
  return Object.keys(value).sort().join(',') === 'clear_generation,client_id,operation_id,state,token,version' &&
    OPERATION_ID_PATTERN.test(value.operation_id || '') &&
    (value.clear_generation === null ||
      (Number.isSafeInteger(value.clear_generation) && value.clear_generation >= 0));
}

async function maintainPendingClear() {
  await requireTrustedStorageAccess();
  const stored = await chrome.storage.local.get(PENDING_CLEAR_KEY);
  let intent = stored?.[PENDING_CLEAR_KEY];
  if (intent === undefined) {
    await chrome.alarms.clear(CLEAR_CLEANUP_RETRY_ALARM);
    return { complete: true, clear_generation: null };
  }
  if (!validPendingClear(intent)) {
    await chrome.storage.local.remove(PENDING_CLEAR_KEY);
    await chrome.alarms.clear(CLEAR_CLEANUP_RETRY_ALARM);
    return { complete: false, clear_generation: null };
  }
  try {
    if (intent.state === 'requested') {
      const { response, body } = await sidecarJson(`${BASE}/clear`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operation_id: intent.operation_id }),
      }, {
        authorization: `Bearer ${intent.token}`,
      });
      if (response.ok && body && typeof body === 'object' && !Array.isArray(body) &&
          Object.keys(body).join(',') === 'clear_generation' &&
          Number.isSafeInteger(body.clear_generation) && body.clear_generation >= 0) {
        intent = { ...intent, state: 'committed', clear_generation: body.clear_generation };
      } else {
        throw sidecarError(response, body, 'POST /clear');
      }
      await chrome.storage.local.set({ [PENDING_CLEAR_KEY]: intent });
    }
    await clearPendingDrafts();
    await clearMarkerStorage();
    await queuePairingSecretOperation(async () => {
      await chrome.storage.session.remove(PAIRING_SECRET_KEY);
      await chrome.alarms.clear(PAIRING_SECRET_ALARM);
    });
    screenshotByTab.clear();
    if (permissionController) await permissionController.disableEverywhere();
    await chrome.storage.local.remove(CONNECTION_KEY);
    await revocationStore.clear();
    await chrome.storage.local.remove(PENDING_CLEAR_KEY);
    await chrome.alarms.clear(CLEAR_CLEANUP_RETRY_ALARM);
    return { complete: true, clear_generation: intent.clear_generation };
  } catch {
    await chrome.alarms.create(CLEAR_CLEANUP_RETRY_ALARM, { when: Date.now() + REVOCATION_RETRY_MS });
    return { complete: false, clear_generation: null };
  }
}

function queuePendingClearMaintenance() {
  return withScreenshotLock(maintainPendingClear);
}

chrome.alarms?.onAlarm?.addListener(async (alarm) => {
  if (alarm.name === PAIRING_SECRET_ALARM) await queuePairingSecretOperation(maintainPairingSecret);
  if (alarm.name === PENDING_CLEANUP_ALARM) await queuePendingMaintenance();
  if (alarm.name === REVOCATION_RETRY_ALARM) await queueRevocationMaintenance();
  if (alarm.name === CLEAR_CLEANUP_RETRY_ALARM) await queuePendingClearMaintenance();
});

chrome.storage.onChanged?.addListener((changes, areaName) => {
  if (areaName === 'local' && Object.keys(changes).some((key) =>
    key === 'redline_pending_revocation' || key.startsWith('redline_pending_revocation::'))) {
    queueRevocationMaintenance().catch(() => {});
  }
});

storageAccessReady.then(() => {
  if (!storageAccessError) {
    queuePairingSecretOperation(maintainPairingSecret).catch(() => {});
    queuePendingMaintenance().catch(() => {});
    queueRevocationMaintenance().catch(() => {});
    queuePendingClearMaintenance().catch(() => {});
  }
});

async function connectionState() {
  await requireTrustedStorageAccess();
  if (DEV_MODE) {
    const token = DEV_CONFIG.token;
    if (typeof token !== 'string' || !token) {
      throw new RedlineExtensionError('connection_required', 'Redline contributor mode needs setup again before submitting.');
    }
    return { clientId: 'development', clearGeneration: 0, headers: { 'x-redline-token': token } };
  }
  const stored = await chrome.storage.local.get(CONNECTION_KEY);
  const connection = stored?.[CONNECTION_KEY];
  if (!connection || typeof connection !== 'object' ||
      !/^rlc_[0-9a-f]{32}$/.test(connection.client_id || '') ||
      typeof connection.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(connection.token) ||
      !Number.isSafeInteger(connection.clear_generation) || connection.clear_generation < 0 ||
      connection.consent_version !== 1 ||
      (connection.port !== undefined && connection.port !== 7878)) {
    throw new RedlineExtensionError('connection_required', 'Redline needs to be connected again before submitting.');
  }
  return {
    clientId: connection.client_id,
    token: connection.token,
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

async function captureScreenshotForTab(tabId, expectedUrl, expectedEpoch) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.id !== tabId || tab.active !== true || !Number.isSafeInteger(tab.windowId) ||
      typeof tab.url !== 'string' || tab.url !== expectedUrl || captureContextEpoch !== expectedEpoch) {
    throw new Error('submitting tab is not the active visible tab');
  }
  const cached = screenshotByTab.get(tabId);
  if (cached && cached.url === tab.url) {
    if (!await screenshotAllowed(tabId, expectedUrl) || captureContextEpoch !== expectedEpoch) {
      throw new Error('screenshot permission changed before cached screenshot reuse');
    }
    return cached.screenshot_png;
  }
  const dataUrl = await withTimeout(
    chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }),
    SCREENSHOT_TIMEOUT_MS,
    'screenshot capture timed out'
  );
  const confirmedTab = await chrome.tabs.get(tabId);
  if (confirmedTab.id !== tabId || confirmedTab.active !== true ||
      confirmedTab.windowId !== tab.windowId || confirmedTab.url !== tab.url ||
      captureContextEpoch !== expectedEpoch) {
    throw new Error('submitting tab changed during screenshot capture');
  }
  if (!await screenshotAllowed(tabId, expectedUrl) || captureContextEpoch !== expectedEpoch) {
    throw new Error('screenshot permission changed during capture');
  }
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

function canonicalTimestamp(value) {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function validatePendingDraft(value, sourceHash, connection, version = 3) {
  const keys = value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).sort().join(',') : '';
  const expectedKeys = version === 1
    ? 'client_id,operation_id,payload,source_hash,version'
    : version === 2
      ? 'client_id,operation_id,payload,payload_hash,source_hash,version'
      : 'client_id,created_at,expires_at,operation_id,payload,payload_hash,source_hash,version';
  if (keys !== expectedKeys || value.version !== version ||
      value.client_id !== connection.clientId || value.source_hash !== sourceHash ||
      typeof value.operation_id !== 'string' || !OPERATION_ID_PATTERN.test(value.operation_id) ||
      (version >= 2 && !/^[0-9a-f]{64}$/.test(value.payload_hash || '')) ||
      (version === 3 && (!canonicalTimestamp(value.created_at) || !canonicalTimestamp(value.expires_at) ||
        Date.parse(value.expires_at) - Date.parse(value.created_at) !== PENDING_TTL_MS)) ||
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
  keys() { return pendingDatabaseRequest('readonly', (store) => store.getAllKeys()); },
  put(key, value) { return pendingDatabaseRequest('readwrite', (store) => store.put(value, key)); },
  delete(key) { return pendingDatabaseRequest('readwrite', (store) => store.delete(key)); },
};

async function maintainPendingDrafts() {
  await requireTrustedStorageAccess();
  const keys = await pendingDatabase.keys();
  const local = await pendingLocalGet(null);
  const pendingKeys = new Set([
    ...keys,
    ...Object.keys(local || {}).filter((key) => key.startsWith('redline_pending::')),
  ]);
  let nextExpiry = Infinity;
  for (const key of pendingKeys) {
    const pending = await pendingDatabase.get(key);
    if (!pending || pending.version !== 3 || !canonicalTimestamp(pending.created_at) ||
        !canonicalTimestamp(pending.expires_at) ||
        Date.parse(pending.expires_at) - Date.parse(pending.created_at) !== PENDING_TTL_MS) {
      await pendingLocalRemove(key);
      await pendingDatabase.delete(key);
      continue;
    }
    const expiry = Date.parse(pending.expires_at);
    if (expiry <= Date.now()) {
      await pendingLocalRemove(key);
      await pendingDatabase.delete(key);
    } else {
      nextExpiry = Math.min(nextExpiry, expiry);
    }
  }
  nextExpiry = Math.min(nextExpiry, await maintainMarkerStorage());
  if (Number.isFinite(nextExpiry)) await chrome.alarms.create(PENDING_CLEANUP_ALARM, { when: nextExpiry });
  else await chrome.alarms.clear(PENDING_CLEANUP_ALARM);
}

async function maintainMarkerStorage() {
  const local = await pendingLocalGet(null);
  const updates = {};
  const removals = [];
  let nextExpiry = Infinity;
  for (const [key, value] of Object.entries(local || {})) {
    if (!key.startsWith('rl_items::')) continue;
    const kept = Array.isArray(value)
      ? value.filter((record) => validMarkerRecord(record) && Date.parse(record.expires_at) > Date.now())
      : [];
    for (const record of kept) nextExpiry = Math.min(nextExpiry, Date.parse(record.expires_at));
    if (!kept.length) removals.push(key);
    else if (kept.length !== value.length) updates[key] = kept;
  }
  if (Object.keys(updates).length) await chrome.storage.local.set(updates);
  if (removals.length) await chrome.storage.local.remove(removals);
  return nextExpiry;
}

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
    version: 3,
    client_id: pending.client_id,
    created_at: pending.created_at,
    expires_at: pending.expires_at,
    source_hash: pending.source_hash,
    operation_id: pending.operation_id,
    payload_hash: pending.payload_hash,
  };
}

function validatePendingLocator(value, sourceHash, connection) {
  const keys = value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).sort().join(',') : '';
  const legacy = value?.version === 2 && keys === 'client_id,operation_id,payload_hash,source_hash,version';
  const current = value?.version === 3 &&
    keys === 'client_id,created_at,expires_at,operation_id,payload_hash,source_hash,version' &&
    canonicalTimestamp(value.created_at) && canonicalTimestamp(value.expires_at) &&
    Date.parse(value.expires_at) - Date.parse(value.created_at) === PENDING_TTL_MS;
  if ((!legacy && !current) ||
      value.client_id !== connection.clientId || value.source_hash !== sourceHash ||
      typeof value.operation_id !== 'string' || !OPERATION_ID_PATTERN.test(value.operation_id) ||
      !/^[0-9a-f]{64}$/.test(value.payload_hash || '')) {
    throw new RedlineExtensionError('pending_submission_invalid',
      'The saved Redline submission cannot be retried safely. Discard it before trying again.');
  }
  return value;
}

function currentPendingDraft(value) {
  if (value.version === 3) return value;
  const createdAt = new Date(Date.now()).toISOString();
  return {
    ...value,
    version: 3,
    created_at: createdAt,
    expires_at: new Date(Date.parse(createdAt) + PENDING_TTL_MS).toISOString(),
  };
}

async function loadPendingDraft(storageKey, sourceHash, connection) {
  const stored = await pendingLocalGet(storageKey);
  const local = Object.hasOwn(stored || {}, storageKey) ? stored[storageKey] : null;
  if (local?.version === 1) {
    const legacy = validatePendingDraft(local, sourceHash, connection, 1);
    const migrated = currentPendingDraft({
      ...legacy,
      version: 2,
      payload_hash: await sha256Text(canonicalDraftJson(legacy.payload)),
    });
    await pendingDatabase.put(storageKey, migrated);
    await pendingLocalSet(storageKey, pendingLocator(migrated));
    await queuePendingMaintenance();
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
  let pending = validatePendingDraft(durable, sourceHash, connection, durable.version);
  if (pending.version === 2) {
    pending = currentPendingDraft(pending);
    await pendingDatabase.put(storageKey, pending);
    await pendingLocalSet(storageKey, pendingLocator(pending));
    await queuePendingMaintenance();
  }
  pending = validatePendingDraft(pending, sourceHash, connection);
  if (Date.parse(pending.expires_at) <= Date.now()) {
    await removePendingDraft(storageKey);
    return null;
  }
  if (await sha256Text(canonicalDraftJson(pending.payload)) !== pending.payload_hash) {
    throw new RedlineExtensionError('pending_submission_invalid',
      'The saved Redline submission cannot be retried safely. Discard it before trying again.');
  }
  if (pending.version !== 3 || (local !== null && local.operation_id !== pending.operation_id)) {
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
  if (response.status === 401) {
    throw new RedlineExtensionError('connection_required',
      'Redline needs a valid consented browser connection before handling page content.');
  }
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
  await queuePendingMaintenance();
}

async function removePendingDraft(storageKey) {
  await pendingLocalRemove(storageKey);
  await pendingDatabase.delete(storageKey);
}

async function clearPendingDrafts() {
  const [keys, local] = await Promise.all([
    pendingDatabase.keys(),
    pendingLocalGet(null),
  ]);
  const pendingKeys = new Set([
    ...keys,
    ...Object.keys(local || {}).filter((key) => key.startsWith('redline_pending::')),
  ]);
  for (const key of pendingKeys) await removePendingDraft(key);
  await chrome.alarms.clear(PENDING_CLEANUP_ALARM);
}

async function clearMarkerStorage() {
  const local = await chrome.storage.local.get(null);
  const keys = Object.keys(local || {}).filter((key) =>
    key === 'rl_last_project' || key.startsWith('rl_items::'));
  if (keys.length) await chrome.storage.local.remove(keys);
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
  if (info.url || info.status === 'loading') {
    captureContextEpoch += 1;
    screenshotByTab.delete(tabId);
  }
});
chrome.tabs.onActivated?.addListener(() => { captureContextEpoch += 1; });
chrome.tabs.onRemoved.addListener((tabId) => {
  captureContextEpoch += 1;
  screenshotByTab.delete(tabId);
});

chrome.runtime.onInstalled?.addListener(async (details) => {
  if (DEV_MODE) return;
  const tabs = await chrome.tabs.query({ url: 'http://127.0.0.1:7878/connect' });
  for (const tab of tabs) {
    if (!Number.isSafeInteger(tab.id) || !exactPairingTabUrl(tab.url)) continue;
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, frameIds: [0] },
        files: ['connect.js'],
      });
    } catch {
      // The connect tab may close while the extension is being installed.
    }
  }
  if (details?.reason === 'install') {
    await queueOnboardingHandoff(() => ensureOnboardingTab());
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === 'marker-storage-get') {
        await requireEnabledContentSender(sender);
        const keys = validateMarkerStorageRequest(msg.keys, sender);
        const values = await chrome.storage.local.get(keys);
        sendResponse({ ok: true, values });
        return;
      }

      if (msg.type === 'marker-storage-set') {
        await requireEnabledContentSender(sender);
        validateMarkerStorageRequest(msg.values, sender, { write: true });
        await chrome.storage.local.set(msg.values);
        await queuePendingMaintenance();
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === 'redline-stage-pairing-secret') {
        await requireTrustedStorageAccess();
        if (!validConnectSender(msg, sender)) {
          throw new RedlineExtensionError('invalid_connect_sender', 'Pairing secret sender was rejected.');
        }
        await queuePairingSecretOperation(async () => {
          await chrome.storage.session.set({
            [PAIRING_SECRET_KEY]: { secret: msg.secret, expires_at: msg.expires_at },
          });
          await chrome.alarms.create(PAIRING_SECRET_ALARM, { when: Date.parse(msg.expires_at) });
        });
        try {
          await returnToOnboarding(sender.tab.id);
        } catch {
          // Pairing is staged even if the bridge tab closes during handoff.
        }
        sendResponse({ ok: true, status: 'staged' });
        return;
      }

      if (msg.type === 'submit-redline') {
        await requireEnabledContentSender(sender);
        const item = await withScreenshotLock(async () => {
          const connection = await connectionState();
          const identity = await durableDraftIdentity(msg, sender);
          let pending = await loadPendingDraft(identity.storageKey, identity.sourceHash, connection);
          if (!pending) {
            const operation_id = submissionOperationId(msg.operation_id ?? msg.payload?.operation_id);
            const clear_generation = await currentClearGeneration(connection.headers);
            const tabId = sender.tab?.id;
            const captureEpoch = captureContextEpoch;
            let screenshot_png = null;
            if (tabId != null && await screenshotAllowed(tabId, sender.tab?.url)) {
              try {
                screenshot_png = await captureScreenshotForTab(tabId, sender.tab?.url, captureEpoch);
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
            const createdAt = new Date(Date.now()).toISOString();
            pending = {
              version: 3,
              client_id: connection.clientId,
              created_at: createdAt,
              expires_at: new Date(Date.parse(createdAt) + PENDING_TTL_MS).toISOString(),
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
        await requireEnabledContentSender(sender);
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
        await requireEnabledContentSender(sender);
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
        await requireEnabledContentSender(sender);
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

      if (msg.type === 'get-screenshot') {
        requireTrustedExtensionPageSender(sender);
        if (!/^ss_[A-Za-z0-9_-]{1,128}$/.test(msg.id || '')) {
          throw new RedlineExtensionError('invalid_screenshot', 'Screenshot identifier was rejected.');
        }
        const { response, body } = await sidecarRequest(
          `${BASE}/screenshots/${msg.id}`,
          { method: 'GET' },
          async (result) => result.arrayBuffer(),
        );
        if (!response.ok) throw sidecarError(response, null, 'GET /screenshots');
        const bytes = new Uint8Array(body);
        if (!bytes.length || bytes.length > MAX_SCREENSHOT_BYTES ||
            PNG_MAGIC.some((value, index) => bytes[index] !== value)) {
          throw new RedlineExtensionError('invalid_screenshot',
            'Redline returned an invalid screenshot.');
        }
        sendResponse({ ok: true, screenshot_png: bytesToBase64(bytes) });
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

      if (msg.type === 'disconnect') {
        await withScreenshotLock(async () => {
          await requireTrustedStorageAccess();
          await connectionState();
          const stored = await chrome.storage.local.get(CONNECTION_KEY);
          const connection = stored?.[CONNECTION_KEY];
          await queueRevocationOperation(() => appendPendingRevocation({
            client_id: connection.client_id,
            token: connection.token,
          }));
          const revoked = await queueRevocationMaintenance();
          let cleanupError = null;
          try {
            await clearPendingDrafts();
          } catch (error) {
            cleanupError = error;
          }
          screenshotByTab.clear();
          if (!revoked) {
            throw new RedlineExtensionError('disconnect_pending',
              'Redline will finish disconnecting when the local helper is available.');
          }
          if (cleanupError) throw cleanupError;
        });
        sendResponse({ ok: true, disconnected: true });
        return;
      }

      if (msg.type === 'clear-data') {
        const clearGeneration = await withScreenshotLock(async () => {
          const connection = await connectionState();
          await chrome.storage.local.set({
            [PENDING_CLEAR_KEY]: {
              version: 1,
              state: 'requested',
              client_id: connection.clientId,
              token: connection.token,
              operation_id: submissionOperationId(),
            },
          });
          const result = await maintainPendingClear();
          if (!result.complete) {
            throw new RedlineExtensionError('clear_pending',
              'Redline will finish clearing browser data when the local helper is available.');
          }
          return result.clear_generation;
        });
        sendResponse({ ok: true, clear_generation: clearGeneration });
        return;
      }

      if (msg.type === 'connection-status') {
        try {
          const connection = await connectionState();
          await currentClearGeneration(connection.headers);
          sendResponse({ ok: true, connected: true, protocol_version: POPUP_PROTOCOL_VERSION });
        } catch (error) {
          sendResponse({
            ok: true,
            connected: false,
            protocol_version: POPUP_PROTOCOL_VERSION,
            error_code: error.code || 'helper_unavailable',
            message: error.code === 'connection_required'
              ? 'This popup cannot pair. Open the setup page, run redline setup once, then approve the consent form.'
              : error.message,
          });
        }
        return;
      }

      if (msg.type === 'permission-state') {
        const state = await requirePermissionController().getState(msg.url);
        sendResponse({ ok: true, state });
        return;
      }

      if (msg.type === 'enable-site') {
        const result = await requirePermissionController().enableSite(msg.url);
        try { await injectRedlineIntoTab(msg.tabId); } catch {}
        sendResponse({ ok: true, ...result });
        return;
      }

      if (msg.type === 'disable-site') {
        const result = await requirePermissionController().disableSite(msg.url);
        if (Number.isSafeInteger(msg.tabId)) screenshotByTab.delete(msg.tabId);
        if (Number.isSafeInteger(msg.tabId)) {
          await chrome.tabs.sendMessage?.(msg.tabId, {
            type: 'redline-disable-site',
            origins: [result.origin],
          }).catch?.(() => {});
        }
        sendResponse({ ok: true, ...result });
        return;
      }

      if (msg.type === 'disable-everywhere') {
        const result = await requirePermissionController().disableEverywhere();
        screenshotByTab.clear();
        sendResponse({ ok: true, ...result });
        return;
      }

      if (msg.type === 'enable-full-visual') {
        const result = await requirePermissionController().enableFullVisual();
        sendResponse({ ok: true, ...result });
        return;
      }

      if (msg.type === 'disable-full-visual') {
        const result = await requirePermissionController().disableFullVisual();
        screenshotByTab.clear();
        sendResponse({ ok: true, ...result });
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
