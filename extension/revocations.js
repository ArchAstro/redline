(function initializeRedlineRevocations(root) {
  'use strict';

  const LEGACY_KEY = 'redline_pending_revocation';
  const KEY_PREFIX = `${LEGACY_KEY}::`;

  function validRevocation(value) {
    return value && typeof value === 'object' && !Array.isArray(value) &&
      Object.keys(value).sort().join(',') === 'client_id,token' &&
      (value.client_id === null || /^rlc_[0-9a-f]{32}$/.test(value.client_id)) &&
      /^[A-Za-z0-9_-]{43}$/.test(value.token || '');
  }

  async function tokenDigest(token) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  async function storageKey(revocation) {
    if (!validRevocation(revocation)) throw new TypeError('invalid Redline revocation');
    const identity = revocation.client_id || `token-${await tokenDigest(revocation.token)}`;
    return `${KEY_PREFIX}${identity}`;
  }

  function createRevocationStore(storage) {
    if (!storage || typeof storage.get !== 'function' || typeof storage.set !== 'function' ||
        typeof storage.remove !== 'function') throw new TypeError('revocation storage is required');

    async function put(revocation) {
      const key = await storageKey(revocation);
      await storage.set({ [key]: revocation });
      return key;
    }

    async function list() {
      let all = await storage.get(null);
      if (Object.hasOwn(all, LEGACY_KEY)) {
        const raw = all[LEGACY_KEY];
        const candidates = Array.isArray(raw) ? raw : validRevocation(raw) ? [raw] : [];
        for (const candidate of candidates) await put(candidate);
        await storage.remove(LEGACY_KEY);
        all = await storage.get(null);
      }
      const entries = [];
      for (const [key, value] of Object.entries(all).sort(([left], [right]) => left.localeCompare(right))) {
        if (!key.startsWith(KEY_PREFIX) || !validRevocation(value)) continue;
        if (key === await storageKey(value)) entries.push(value);
      }
      return entries;
    }

    async function remove(revocation) {
      await storage.remove(await storageKey(revocation));
    }

    async function clear() {
      const all = await storage.get(null);
      const keys = Object.keys(all).filter((key) => key === LEGACY_KEY || key.startsWith(KEY_PREFIX));
      if (keys.length) await storage.remove(keys);
    }

    return { clear, list, put, remove };
  }

  const api = { createRevocationStore, validRevocation };
  root.RedlineRevocations = api;
  if (typeof module === 'object' && module?.exports) module.exports = api;
})(globalThis);
