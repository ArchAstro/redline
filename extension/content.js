(() => {
  if (window.__rlInjected) return;
  window.__rlInjected = true;

  const RECONCILE_INTERVAL_MS = 2000;

  const STATE = {
    pendingSelection: null,
    button: null,
    popover: null,
    highlights: new Map(),
    staleTimer: null,
  };

  function storageLocal() {
    return globalThis.chrome?.storage?.local || null;
  }

  async function getLocal(keys) {
    const area = storageLocal();
    if (!area) return {};
    try {
      return await area.get(keys);
    } catch {
      return {};
    }
  }

  async function setLocal(value) {
    const area = storageLocal();
    if (!area) return;
    try {
      await area.set(value);
    } catch {
      // Storage is only used for local marker persistence and convenience defaults.
    }
  }

  function submissionErrorMessage(error) {
    if (/Extension context invalidated/i.test(error?.message || '')) {
      return 'Redline updated. Refresh this page and try again.';
    }
    return error?.message || 'request failed';
  }

  function cssPath(node) {
    if (node && node.nodeType !== 1) node = node.parentElement;
    const parts = [];
    while (node && node.nodeType === 1 && node !== document.documentElement && parts.length < 12) {
      let part = node.tagName.toLowerCase();
      if (node.id) {
        part += `#${CSS.escape(node.id)}`;
        parts.unshift(part);
        return parts.join(' > ');
      }
      const parent = node.parentElement;
      if (parent) {
        const sibs = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (sibs.length > 1) part += `:nth-of-type(${sibs.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  function surroundingText(range, pad = 160) {
    const c = range.commonAncestorContainer;
    const root = c.nodeType === 1 ? c : c.parentElement;
    if (!root) return range.toString();
    const text = root.textContent || '';
    const selected = range.toString();
    const idx = text.indexOf(selected);
    if (idx < 0) return selected;
    return text.slice(Math.max(0, idx - pad), Math.min(text.length, idx + selected.length + pad));
  }

  function ensureButton() {
    if (STATE.button) return STATE.button;
    const b = document.createElement('div');
    b.className = 'rl-add-btn';
    b.textContent = 'Redline';
    b.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
    b.addEventListener('click', (e) => { e.stopPropagation(); openPopover(); });
    document.body.appendChild(b);
    STATE.button = b;
    return b;
  }

  function hideButton() {
    if (STATE.button) STATE.button.style.display = 'none';
  }

  function showButtonAtRange(range) {
    const rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) return;
    const b = ensureButton();
    b.style.display = 'block';
    b.style.top = `${window.scrollY + rect.bottom + 6}px`;
    b.style.left = `${window.scrollX + rect.left}px`;
  }

  function openPopover(existing = null) {
    closePopover();
    const range = existing?.range || STATE.pendingSelection?.range;
    if (!range) return;
    const rect = range.getBoundingClientRect();
    const p = document.createElement('div');
    p.className = 'rl-popover';
    p.innerHTML = `
      <div class="rl-popover-head">
        <strong>${existing ? 'Edit redline' : 'New redline'}</strong>
        <button class="rl-close" title="Close">×</button>
      </div>
      <div class="rl-selected"></div>
      <textarea class="rl-comment" placeholder="What's wrong / what should this say?"></textarea>
      <input class="rl-project" placeholder="optional project tag (e.g. my-app)" />
      <div class="rl-actions">
        ${existing ? '<button class="rl-delete">Delete</button>' : ''}
        <span class="rl-status"></span>
        <button class="rl-submit">${existing ? 'Update' : 'Submit'}</button>
      </div>
    `;
    p.style.top = `${window.scrollY + rect.bottom + 32}px`;
    p.style.left = `${window.scrollX + Math.max(0, rect.left)}px`;
    document.body.appendChild(p);
    STATE.popover = p;

    p.querySelector('.rl-selected').textContent = range.toString().slice(0, 280);
    const ta = p.querySelector('.rl-comment');
    const proj = p.querySelector('.rl-project');
    if (existing) {
      ta.value = existing.item.comment || '';
      proj.value = existing.item.project || '';
    } else {
      getLocal(['rl_last_project']).then(({ rl_last_project }) => {
        if (rl_last_project) proj.value = rl_last_project;
      });
    }
    setTimeout(() => ta.focus(), 0);

    p.querySelector('.rl-close').addEventListener('click', closePopover);
    p.querySelector('.rl-submit').addEventListener('click', async () => {
      const status = p.querySelector('.rl-status');
      status.textContent = 'sending…';
      try {
        await submit({ range, existing, comment: ta.value, project: proj.value.trim() });
        status.textContent = 'sent';
        setLocal({ rl_last_project: proj.value.trim() || null });
        setTimeout(closePopover, 400);
      } catch (e) {
        status.textContent = 'error: ' + submissionErrorMessage(e);
      }
    });
    if (existing) {
      p.querySelector('.rl-delete').addEventListener('click', async () => {
        const status = p.querySelector('.rl-status');
        status.textContent = 'deleting…';
        try {
          const r = await chrome.runtime.sendMessage({ type: 'delete-redline', id: existing.item.id });
          if (!r?.ok) throw new Error(r?.error || 'delete failed');
          await removeFromLocal(existing.item.id);
          removeHighlight(existing.item.id);
          closePopover();
        } catch (e) {
          status.textContent = 'error: ' + submissionErrorMessage(e);
        }
      });
    }
  }

  function closePopover() {
    if (STATE.popover) { STATE.popover.remove(); STATE.popover = null; }
  }

  function refreshCssHighlight() {
    if (!CSS.highlights || typeof Highlight === 'undefined') return;
    const ranges = Array.from(STATE.highlights.values()).map((h) => h.range);
    if (!ranges.length) {
      CSS.highlights.delete('rl-redline');
      return;
    }
    CSS.highlights.set('rl-redline', new Highlight(...ranges));
  }

  function addHighlight(item, range, ser = null) {
    STATE.highlights.set(item.id, { range, item, ser });
    refreshCssHighlight();
  }

  function removeHighlight(id) {
    STATE.highlights.delete(id);
    refreshCssHighlight();
  }

  function serializeRange(range) {
    return {
      startSelector: cssPath(range.startContainer),
      startOffset: range.startOffset,
      endSelector: cssPath(range.endContainer),
      endOffset: range.endOffset,
      text: range.toString(),
    };
  }

  function findFirstTextNode(el) {
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    return w.nextNode();
  }

  function deserializeRange(s) {
    try {
      const startEl = document.querySelector(s.startSelector);
      const endEl = document.querySelector(s.endSelector);
      if (!startEl || !endEl) return null;
      const startNode = findFirstTextNode(startEl) || startEl;
      const endNode = findFirstTextNode(endEl) || endEl;
      const r = document.createRange();
      const startLen = (startNode.textContent || '').length;
      const endLen = (endNode.textContent || '').length;
      r.setStart(startNode, Math.min(s.startOffset, startLen));
      r.setEnd(endNode, Math.min(s.endOffset, endLen));
      if (s.text && r.toString() !== s.text) return null;
      return r;
    } catch {
      return null;
    }
  }

  async function submit({ range, existing, comment, project }) {
    if (!comment.trim()) throw new Error('comment is empty');
    const ser = serializeRange(range);
    const rect = range.getBoundingClientRect();
    const ancestor = range.commonAncestorContainer.nodeType === 1
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
    const payload = {
      url: location.href,
      origin: location.origin,
      title: document.title,
      project: project || null,
      selected_text: range.toString(),
      comment,
      context: {
        selector: ser.startSelector,
        surrounding_text: surroundingText(range),
        html_snippet: ancestor?.outerHTML?.slice(0, 1200) || null,
        viewport: { w: window.innerWidth, h: window.innerHeight },
        range_ref: ser,
      },
      rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
    };

    const resp = existing
      ? await chrome.runtime.sendMessage({ type: 'update-redline', id: existing.item.id, payload })
      : await chrome.runtime.sendMessage({ type: 'submit-redline', payload });
    if (!resp?.ok) throw new Error(resp?.error || 'submit failed');
    addHighlight(resp.item, range, ser);
    await upsertLocal(resp.item, ser);
  }

  function localKey() {
    return `rl_items::${location.origin}${location.pathname}`;
  }

  async function upsertLocal(item, ser) {
    const key = localKey();
    const data = (await getLocal([key]))[key] || [];
    const idx = data.findIndex((x) => x.item.id === item.id);
    if (idx >= 0) {
      data[idx] = { item, ser };
    } else {
      data.push({ item, ser });
    }
    await setLocal({ [key]: data });
  }

  function pageKeyForUrl(url) {
    try {
      const u = new URL(url);
      return `${u.origin}${u.pathname}`;
    } catch {
      return null;
    }
  }

  async function pendingServerIdsForPage() {
    const resp = await chrome.runtime.sendMessage({
      type: 'list-redlines',
      status: 'pending',
      origin: location.origin,
    });
    if (!resp?.ok) throw new Error(resp?.error || 'list failed');
    const here = localKey().replace(/^rl_items::/, '');
    return new Set((resp.items || [])
      .filter((item) => pageKeyForUrl(item.url) === here)
      .map((item) => item.id));
  }

  async function removeFromLocal(id) {
    const key = localKey();
    const data = (await getLocal([key]))[key] || [];
    await setLocal({ [key]: data.filter((x) => x.item.id !== id) });
  }

  async function removeManyFromLocal(ids) {
    if (!ids.length) return;
    const doomed = new Set(ids);
    const key = localKey();
    const data = (await getLocal([key]))[key] || [];
    await setLocal({ [key]: data.filter((x) => !doomed.has(x.item.id)) });
  }

  function textStillMatches(item, ser, range) {
    const expected = ser?.text || item?.selected_text || '';
    return !expected || range.toString() === expected;
  }

  async function reconcileHighlights() {
    const key = localKey();
    const data = (await getLocal([key]))[key] || [];
    if (!data.length) {
      for (const id of STATE.highlights.keys()) removeHighlight(id);
      return;
    }
    let pendingIds = null;
    try {
      pendingIds = await pendingServerIdsForPage();
    } catch {
      // The sidecar may be down while browsing; keep local markers in that case.
    }
    const kept = [];
    const visible = new Set();
    for (const { item, ser } of data) {
      const existing = STATE.highlights.get(item.id);
      const range = existing?.range || deserializeRange(ser);
      if (range && textStillMatches(item, ser, range) && (!pendingIds || pendingIds.has(item.id))) {
        addHighlight(item, range, ser);
        kept.push({ item, ser });
        visible.add(item.id);
      } else {
        removeHighlight(item.id);
      }
    }
    for (const id of STATE.highlights.keys()) {
      if (!visible.has(id)) removeHighlight(id);
    }
    if (kept.length !== data.length) {
      await setLocal({ [key]: kept });
    }
  }

  async function loadLocal() {
    await reconcileHighlights();
  }

  async function pruneStaleHighlights() {
    const stale = [];
    for (const [id, h] of STATE.highlights) {
      if (!textStillMatches(h.item, h.ser, h.range)) {
        stale.push(id);
        removeHighlight(id);
      }
    }
    await removeManyFromLocal(stale);
  }

  function scheduleStalePrune() {
    if (STATE.staleTimer) clearTimeout(STATE.staleTimer);
    STATE.staleTimer = setTimeout(() => {
      STATE.staleTimer = null;
      pruneStaleHighlights();
    }, 250);
  }

  document.addEventListener('mouseup', () => {
    setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim()) {
        hideButton();
        STATE.pendingSelection = null;
        return;
      }
      const range = sel.getRangeAt(0).cloneRange();
      STATE.pendingSelection = { range };
      showButtonAtRange(range);
    }, 0);
  });

  document.addEventListener('mousedown', (e) => {
    if (STATE.button && STATE.button.contains(e.target)) return;
    if (STATE.popover && STATE.popover.contains(e.target)) return;
    hideButton();
  });

  document.addEventListener('click', (e) => {
    if (STATE.popover && STATE.popover.contains(e.target)) return;
    if (STATE.button && STATE.button.contains(e.target)) return;
    for (const [, h] of STATE.highlights) {
      const rects = h.range.getClientRects();
      for (const r of rects) {
        if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
          openPopover({ range: h.range, item: h.item });
          return;
        }
      }
    }
  });

  window.addEventListener('focus', reconcileHighlights);
  window.addEventListener('pageshow', reconcileHighlights);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') reconcileHighlights();
  });
  setInterval(() => {
    if (document.visibilityState !== 'hidden') reconcileHighlights();
  }, RECONCILE_INTERVAL_MS);

  if (typeof MutationObserver !== 'undefined') {
    new MutationObserver(scheduleStalePrune).observe(document.documentElement, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  }

  loadLocal();
})();
