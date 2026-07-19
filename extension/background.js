importScripts('auth.js');

const PORT = globalThis.REDLINE_CONFIG.port;
const BASE = `http://127.0.0.1:${PORT}`;
const REDLINE_AUTH_HEADERS = { 'x-redline-token': globalThis.REDLINE_CONFIG.token };

function sidecarFetch(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: { ...REDLINE_AUTH_HEADERS, ...(options.headers || {}) },
  });
}

function sidecarError(response, operation) {
  if (response.status === 401) {
    return new Error('Redline authentication changed. Reload Redline in chrome://extensions, then refresh this page.');
  }
  return new Error(`${operation} ${response.status}`);
}

const screenshotByTab = new Map();
const SCREENSHOT_TIMEOUT_MS = 2000;

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
  if (cached && cached.url === tab.url) return cached.screenshot_id;
  const dataUrl = await withTimeout(
    chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }),
    SCREENSHOT_TIMEOUT_MS,
    'screenshot capture timed out'
  );
  const resp = await sidecarFetch(`${BASE}/screenshots`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data_url: dataUrl }),
  });
  if (!resp.ok) throw sidecarError(resp, 'screenshot upload');
  const json = await resp.json();
  screenshotByTab.set(tabId, { url: tab.url, screenshot_id: json.id });
  return json.id;
}

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url) screenshotByTab.delete(tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => screenshotByTab.delete(tabId));

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === 'submit-redline') {
        const tabId = sender.tab?.id;
        let screenshot_id = null;
        if (tabId != null) {
          try {
            screenshot_id = await captureScreenshotForTab(tabId);
          } catch (e) {
            console.warn('[redline] screenshot capture failed:', e.message);
          }
        }
        const payload = { ...msg.payload, screenshot_id };
        const resp = await sidecarFetch(`${BASE}/redlines`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!resp.ok) throw sidecarError(resp, 'POST /redlines');
        const item = await resp.json();
        sendResponse({ ok: true, item });
        return;
      }

      if (msg.type === 'update-redline') {
        const resp = await sidecarFetch(`${BASE}/redlines/${msg.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(msg.payload),
        });
        if (!resp.ok) throw sidecarError(resp, `PATCH /redlines/${msg.id}`);
        const item = await resp.json();
        sendResponse({ ok: true, item });
        return;
      }

      if (msg.type === 'delete-redline') {
        const resp = await sidecarFetch(`${BASE}/redlines/${msg.id}`, { method: 'DELETE' });
        if (!resp.ok && resp.status !== 204) throw sidecarError(resp, 'DELETE /redlines');
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === 'list-redlines') {
        const params = new URLSearchParams();
        if (msg.status) params.set('status', msg.status);
        if (msg.origin) params.set('origin', msg.origin);
        if (msg.project) params.set('project', msg.project);
        const qs = params.toString();
        const resp = await sidecarFetch(`${BASE}/redlines${qs ? `?${qs}` : ''}`);
        if (!resp.ok) throw sidecarError(resp, 'GET /redlines');
        sendResponse({ ok: true, items: await resp.json() });
        return;
      }

      if (msg.type === 'refresh-screenshot') {
        const tabId = msg.tabId ?? sender.tab?.id;
        if (tabId != null) screenshotByTab.delete(tabId);
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
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true;
});
