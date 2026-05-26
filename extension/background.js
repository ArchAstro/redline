const PORT = 7878;
const BASE = `http://127.0.0.1:${PORT}`;

const screenshotByTab = new Map();

async function captureScreenshotForTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const cached = screenshotByTab.get(tabId);
  if (cached && cached.url === tab.url) return cached.screenshot_id;
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  const resp = await fetch(`${BASE}/screenshots`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data_url: dataUrl }),
  });
  if (!resp.ok) throw new Error(`screenshot upload ${resp.status}`);
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
        const resp = await fetch(`${BASE}/redlines`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!resp.ok) throw new Error(`POST /redlines ${resp.status}`);
        const item = await resp.json();
        sendResponse({ ok: true, item });
        return;
      }

      if (msg.type === 'delete-redline') {
        const resp = await fetch(`${BASE}/redlines/${msg.id}`, { method: 'DELETE' });
        if (!resp.ok && resp.status !== 204) throw new Error(`DELETE /redlines ${resp.status}`);
        sendResponse({ ok: true });
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
