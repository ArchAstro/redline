const PORT = 7878;
const BASE = `http://127.0.0.1:${PORT}`;
let filter = 'pending';
let allItems = [];

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function renderItems(origin) {
  const list = document.getElementById('list');
  const counts = document.getElementById('counts');
  const pendingCount = allItems.filter((it) => it.status === 'pending').length;
  const ackedCount = allItems.filter((it) => it.status === 'acked').length;
  counts.textContent = `${pendingCount} pending · ${ackedCount} acked`;

  const visibleItems = allItems.filter((it) => filter === 'all' || it.status === filter);
  list.textContent = '';

  if (!origin) {
    list.innerHTML = '<div class="empty">Open a web page to see redlines for that origin.</div>';
    return;
  }

  if (!visibleItems.length) {
    list.innerHTML = filter === 'pending'
      ? '<div class="empty">No pending redlines for this origin.</div>'
      : '<div class="empty">No redlines for this origin yet.</div>';
    return;
  }

  for (const it of visibleItems) {
    const el = document.createElement('div');
    el.className = 'item';
    el.innerHTML = `
      <div><span class="sel"></span></div>
      <div class="cm"></div>
      <div class="meta">
        <span class="status-${it.status}">${it.status}</span>
        <span>·</span>
        <span class="ts"></span>
        ${it.project ? `<span>·</span><span class="project"></span>` : ''}
        ${it.screenshot_id ? `<span>·</span><a href="${BASE}/screenshots/${it.screenshot_id}" target="_blank">screenshot</a>` : ''}
        <span style="flex:1"></span>
        <button class="btn secondary del">delete</button>
      </div>
    `;
    el.querySelector('.sel').textContent = (it.selected_text || '').slice(0, 100);
    el.querySelector('.cm').textContent = it.comment || '';
    el.querySelector('.ts').textContent = new Date(it.created_at).toLocaleString();
    if (it.project) el.querySelector('.project').textContent = it.project;
    el.querySelector('.del').addEventListener('click', async () => {
      await fetch(`${BASE}/redlines/${it.id}`, { method: 'DELETE' });
      allItems = allItems.filter((item) => item.id !== it.id);
      renderItems(origin);
    });
    list.appendChild(el);
  }
}

async function init() {
  const tab = await getActiveTab();
  const origin = tab?.url ? new URL(tab.url).origin : '';
  document.getElementById('origin').textContent = origin;

  const statusEl = document.getElementById('status');
  let serverUp = false;
  try {
    const r = await fetch(`${BASE}/health`);
    if (!r.ok) throw new Error();
    statusEl.textContent = 'server up';
    statusEl.className = 'badge ok';
    serverUp = true;
  } catch {
    statusEl.textContent = 'server down';
  }

  const list = document.getElementById('list');
  if (!serverUp) {
    document.getElementById('counts').textContent = '';
    list.innerHTML = `<div class="empty">Start it with <code>redline start</code></div>`;
    return;
  }

  allItems = origin
    ? await fetch(`${BASE}/redlines?origin=${encodeURIComponent(origin)}`).then((r) => r.json())
    : [];
  allItems.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  renderItems(origin);
}

document.getElementById('refreshShot').addEventListener('click', async () => {
  const tab = await getActiveTab();
  if (!tab) return;
  await chrome.runtime.sendMessage({ type: 'refresh-screenshot', tabId: tab.id });
  const btn = document.getElementById('refreshShot');
  const orig = btn.textContent;
  btn.textContent = 'queued';
  setTimeout(() => { btn.textContent = orig; }, 1200);
});

for (const btn of document.querySelectorAll('[data-filter]')) {
  btn.addEventListener('click', async () => {
    filter = btn.dataset.filter;
    for (const b of document.querySelectorAll('[data-filter]')) b.classList.toggle('active', b === btn);
    const tab = await getActiveTab();
    const origin = tab?.url ? new URL(tab.url).origin : '';
    renderItems(origin);
  });
}

document.getElementById('openExtensions').addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://extensions' });
});

init();
