'use strict';

const WORKER_PROTOCOL_VERSION = 1;
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

function setWorkerControlsEnabled(enabled) {
  for (const control of document.querySelectorAll('[data-worker-control]')) {
    control.disabled = !enabled;
  }
}

function showRestartRecovery(message) {
  setWorkerControlsEnabled(false);
  document.getElementById('connection-status').textContent = 'Restart needed';
  document.getElementById('connection-status').classList.remove('connected');
  document.getElementById('enable-site').hidden = true;
  document.getElementById('disable-site').hidden = true;
  document.getElementById('open-setup').hidden = true;
  document.getElementById('restart-extension').hidden = false;
  showSiteMessage(message || 'Redline could not finish loading. Restart its extension process and try again.', true);
}

function applyPermissionState(state) {
  permissionState = state;
  const enable = document.getElementById('enable-site');
  const disable = document.getElementById('disable-site');
  const fullVisual = document.getElementById('full-visual');
  fullVisual.checked = !!state.fullVisualEnabled;
  if (state.isLocal) {
    enable.hidden = true;
    disable.hidden = true;
    showSiteMessage('Redline is enabled for local development.');
  } else {
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
  setWorkerControlsEnabled(false);
  document.getElementById('restart-extension').hidden = true;
  activeTab = await getActiveTab();
  activeOrigin = pageOrigin(activeTab?.url);
  document.getElementById('origin').textContent = activeOrigin || 'This page cannot be enabled';

  const connection = await send({ type: 'connection-status' });
  if (connection.protocol_version !== WORKER_PROTOCOL_VERSION) {
    const error = new Error('Redline was upgraded, but Chrome is still running an older background process. Restart Redline to finish updating.');
    error.code = 'worker_version_mismatch';
    throw error;
  }
  const status = document.getElementById('connection-status');
  status.textContent = connection.connected ? 'Connected' : 'Setup needed';
  status.classList.toggle('connected', connection.connected);

  const permission = await send({ type: 'permission-state', url: activeTab?.url || '' });
  applyPermissionState(permission.state);
  document.getElementById('enable-site').disabled = !connection.connected;
  const openSetup = document.getElementById('open-setup');

  if (!connection.connected) {
    document.getElementById('enable-site').hidden = true;
    document.getElementById('disable-site').hidden = true;
    openSetup.hidden = false;
    showSiteMessage(connection.message || 'This popup cannot pair. Open the setup page, run redline setup once, then approve the consent form.', true);
    allItems = [];
  } else if (activeOrigin) {
    openSetup.hidden = true;
    const items = await send({ type: 'list-redlines', origin: activeOrigin });
    allItems = Array.isArray(items.items) ? items.items : [];
    allItems.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  } else {
    openSetup.hidden = true;
    allItems = [];
  }
  renderItems();
  setWorkerControlsEnabled(true);
  document.getElementById('enable-site').disabled = !connection.connected;
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

document.getElementById('open-setup').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') });
  window.close();
});

document.getElementById('enable-site').addEventListener('click', (event) => runControl(event.currentTarget, async () => {
  if (!permissionState?.pattern) throw new Error('Redline is still loading this site. Restart Redline and try again.');
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

document.getElementById('restart-extension').addEventListener('click', (event) => {
  event.currentTarget.disabled = true;
  event.currentTarget.textContent = 'Restarting…';
  chrome.runtime.reload();
  window.close();
});

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
  console.warn('[redline] popup initialization failed:', error.message);
  const message = error.code === 'worker_version_mismatch'
    ? error.message
    : 'Redline could not start its background process. This can happen after an update. Restart Redline and try again.';
  showRestartRecovery(message);
  renderItems();
});
