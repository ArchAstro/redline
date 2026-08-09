'use strict';

let filter = 'pending';
let allItems = [];
let activeTab = null;
let activeOrigin = '';
let permissionState = null;

async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) {
    const error = new Error(response?.error || 'Redline could not complete that action.');
    error.code = response?.error_code || 'request_failed';
    throw error;
  }
  return response;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

function pageOrigin(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : '';
  } catch {
    return '';
  }
}

function showSiteMessage(message, isError = false) {
  const node = document.getElementById('site-message');
  node.textContent = message || '';
  node.classList.toggle('error', isError);
}

function applyPermissionState(state) {
  permissionState = state;
  const enable = document.getElementById('enable-site');
  const disable = document.getElementById('disable-site');
  const fullVisual = document.getElementById('full-visual');
  fullVisual.checked = !!state.fullVisualEnabled;
  enable.hidden = !state.supported || state.siteEnabled;
  disable.hidden = !state.supported || !state.siteEnabled;
  if (!state.supported) {
    const message = state.errorCode === 'restricted_url'
      ? (state.message || 'Chrome pages cannot be enabled. Open a website to use Redline.')
      : state.message;
    showSiteMessage(message, true);
  } else {
    showSiteMessage(state.siteEnabled ? 'Redline is enabled here.' : 'Redline is off for this site.');
  }
}

async function openScreenshot(screenshotId) {
  const { screenshot_png } = await send({ type: 'get-screenshot', id: screenshotId });
  const binary = atob(screenshot_png);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const objectUrl = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
  try {
    await chrome.tabs.create({ url: objectUrl });
  } finally {
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  }
}

function renderItems() {
  const list = document.getElementById('list');
  const counts = document.getElementById('counts');
  const pendingCount = allItems.filter((it) => it.status === 'pending').length;
  const ackedCount = allItems.filter((it) => it.status === 'acked').length;
  counts.textContent = `${pendingCount} pending / ${ackedCount} completed`;
  const visibleItems = allItems.filter((it) => filter === 'all' || it.status === filter);
  list.textContent = '';

  if (!activeOrigin) {
    list.innerHTML = '<div class="empty">Open a website to see its feedback.</div>';
    return;
  }
  if (!visibleItems.length) {
    list.innerHTML = `<div class="empty">${filter === 'pending' ? 'No pending feedback.' : 'No feedback yet.'}</div>`;
    return;
  }

  for (const it of visibleItems) {
    const item = document.createElement('article');
    item.className = 'item';
    item.innerHTML = `
      <div><span class="selected"></span></div>
      <div class="comment"></div>
      <div class="meta">
        <span class="state"></span><span class="time"></span>
        <span class="delete-status" role="status"></span><span class="spacer"></span>
        ${it.screenshot_id ? '<button class="screenshot">View screenshot</button>' : ''}
        <button class="delete">Delete</button>
      </div>`;
    item.querySelector('.selected').textContent = (it.selected_text || '').slice(0, 140);
    item.querySelector('.comment').textContent = it.comment || '';
    item.querySelector('.state').textContent = it.status;
    item.querySelector('.time').textContent = new Date(it.created_at).toLocaleString();
    const deleteButton = item.querySelector('.delete');
    const deleteStatus = item.querySelector('.delete-status');
    item.querySelector('.screenshot')?.addEventListener('click', async (event) => {
      await runControl(event.currentTarget, () => openScreenshot(it.screenshot_id));
    });
    deleteButton.addEventListener('click', async () => {
      deleteButton.disabled = true;
      deleteStatus.textContent = 'Deleting';
      try {
        const response = await chrome.runtime.sendMessage({ type: 'delete-redline', id: it.id });
        if (!response?.ok) throw new Error(response?.error || 'Could not delete feedback.');
        allItems = allItems.filter((item) => item.id !== it.id);
        renderItems();
      } catch (error) {
        deleteButton.disabled = false;
        deleteStatus.textContent = error.message;
      }
    });
    list.appendChild(item);
  }
}

async function refreshState() {
  activeTab = await getActiveTab();
  activeOrigin = pageOrigin(activeTab?.url);
  document.getElementById('origin').textContent = activeOrigin || 'This page cannot be enabled';

  const connection = await send({ type: 'connection-status' });
  const status = document.getElementById('connection-status');
  status.textContent = connection.connected ? 'Connected' : 'Setup needed';
  status.classList.toggle('connected', connection.connected);

  const permission = await send({ type: 'permission-state', url: activeTab?.url || '' });
  applyPermissionState(permission.state);
  document.getElementById('enable-site').disabled = !connection.connected;

  if (!connection.connected) {
    showSiteMessage(connection.message || 'Run Redline setup to connect this browser.', true);
    allItems = [];
  } else if (activeOrigin) {
    const items = await send({ type: 'list-redlines', origin: activeOrigin });
    allItems = Array.isArray(items.items) ? items.items : [];
    allItems.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  } else {
    allItems = [];
  }
  renderItems();
}

async function runControl(button, action) {
  button.disabled = true;
  try {
    await action();
  } catch (error) {
    showSiteMessage(error.message, true);
  } finally {
    button.disabled = false;
  }
}

document.getElementById('enable-site').addEventListener('click', (event) => runControl(event.currentTarget, async () => {
  const granted = await chrome.permissions.request({ origins: [permissionState.pattern] });
  if (!granted) throw new Error(`Chrome did not grant access to ${activeOrigin}.`);
  await send({ type: 'enable-site', url: activeTab?.url || '', tabId: activeTab?.id });
  applyPermissionState((await send({ type: 'permission-state', url: activeTab?.url || '' })).state);
}));

document.getElementById('disable-site').addEventListener('click', (event) => runControl(event.currentTarget, async () => {
  await send({ type: 'disable-site', url: activeTab?.url || '', tabId: activeTab?.id });
  applyPermissionState((await send({ type: 'permission-state', url: activeTab?.url || '' })).state);
}));

document.getElementById('full-visual').addEventListener('change', async (event) => {
  const toggle = event.currentTarget;
  toggle.disabled = true;
  try {
    if (toggle.checked) {
      const granted = await chrome.permissions.request({ origins: ['<all_urls>'] });
      if (!granted) throw new Error('Chrome did not grant website screenshot access.');
      await send({ type: 'enable-full-visual' });
    } else {
      await send({ type: 'disable-full-visual' });
    }
    applyPermissionState((await send({
      type: 'permission-state', url: activeTab?.url || '',
    })).state);
  } catch (error) {
    toggle.checked = !toggle.checked;
    showSiteMessage(error.message, true);
  } finally {
    toggle.disabled = false;
  }
});

document.getElementById('refreshShot').addEventListener('click', (event) => runControl(event.currentTarget, async () => {
  await send({ type: 'refresh-screenshot', tabId: activeTab?.id });
}));

document.getElementById('disconnect').addEventListener('click', (event) => runControl(event.currentTarget, async () => {
  await send({ type: 'disconnect' });
  await refreshState();
}));

document.getElementById('disable-everywhere').addEventListener('click', (event) => runControl(event.currentTarget, async () => {
  await send({ type: 'disable-everywhere' });
  await refreshState();
}));

document.getElementById('clear-data').addEventListener('click', (event) => runControl(event.currentTarget, async () => {
  if (!confirm('Delete every submitted Redline and screenshot, revoke every browser connection, and clear this profile\'s drafts and permissions? Other Chrome profiles retain their browser-local drafts and permissions.')) return;
  await send({ type: 'clear-data' });
  await refreshState();
}));

for (const button of document.querySelectorAll('[data-filter]')) {
  button.addEventListener('click', () => {
    filter = button.dataset.filter;
    for (const candidate of document.querySelectorAll('[data-filter]')) {
      candidate.classList.toggle('active', candidate === button);
    }
    renderItems();
  });
}

refreshState().catch((error) => {
  document.getElementById('connection-status').textContent = 'Unavailable';
  showSiteMessage(error.message, true);
  renderItems();
});
