const PORT = 7878;
const BASE = `http://127.0.0.1:${PORT}`;

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
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
    list.innerHTML = `<div class="empty">Start it with <code>redline-sidecar start</code></div>`;
    return;
  }

  const items = origin
    ? await fetch(`${BASE}/redlines?origin=${encodeURIComponent(origin)}`).then((r) => r.json())
    : [];
  items.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));

  if (!items.length) {
    list.innerHTML = '<div class="empty">No redlines for this origin yet.</div>';
    return;
  }

  for (const it of items) {
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
      el.remove();
    });
    list.appendChild(el);
  }
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

init();
