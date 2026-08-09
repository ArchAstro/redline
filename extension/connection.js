(function initializeRedlineConnection(root) {
  'use strict';

  const BASE_URL = 'http://127.0.0.1:7878';
  const SETUP_COMMAND = 'npx --yes @archastro/redline setup';
  const REQUIRED_CAPABILITIES = ['pairing-v1', 'idempotent-redlines-v1'];
  const RESPONSE_LIMIT_BYTES = 64 * 1024;
  const REQUEST_TIMEOUT_MS = 3000;
  const Revocations = root.RedlineRevocations ||
    (typeof module === 'object' && module?.exports ? require('./revocations') : null);
  const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

  class InvalidHelperResponse extends Error {}

  function createConnectionClient({ fetch: fetchImpl, storage, cleanupStorage = storage, now = Date.now }) {
    if (typeof fetchImpl !== 'function') throw new TypeError('connection fetch is required');
    if (!storage || typeof storage.get !== 'function' ||
        typeof storage.set !== 'function' || typeof storage.remove !== 'function') {
      throw new TypeError('connection storage is required');
    }
    if (!cleanupStorage || typeof cleanupStorage.get !== 'function' ||
        typeof cleanupStorage.set !== 'function' || typeof cleanupStorage.remove !== 'function') {
      throw new TypeError('connection cleanup storage is required');
    }

    let pendingRevocation = null;
    if (!Revocations) throw new TypeError('revocation support is required');
    const revocations = Revocations.createRevocationStore(cleanupStorage);

    async function request(url, options) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        return await fetchImpl(url, { ...options, signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
    }

    async function requestJson(url, options) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const response = await fetchImpl(url, { ...options, signal: controller.signal });
        try {
          return { response, payload: await boundedJson(response) };
        } catch (error) {
          if (error?.name === 'AbortError') throw error;
          throw new InvalidHelperResponse('helper response is invalid');
        }
      } finally {
        clearTimeout(timer);
      }
    }

    async function boundedJson(response) {
      const declared = Number(response.headers?.get?.('content-length'));
      if (Number.isFinite(declared) && declared > RESPONSE_LIMIT_BYTES) throw new TypeError('response too large');
      let text = '';
      if (response.body?.getReader) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let bytes = 0;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > RESPONSE_LIMIT_BYTES) {
            await reader.cancel();
            throw new TypeError('response too large');
          }
          text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
      } else {
        text = await response.text();
        if (new TextEncoder().encode(text).byteLength > RESPONSE_LIMIT_BYTES) throw new TypeError('response too large');
      }
      return JSON.parse(text);
    }

    async function revokeConnection(connection) {
      if (!connection || !/^[A-Za-z0-9_-]{43}$/.test(connection.token || '')) return false;
      const revocation = {
        client_id: /^rlc_[0-9a-f]{32}$/.test(connection.client_id || '') ? connection.client_id : null,
        token: connection.token,
      };
      let durable = true;
      try { await revocations.put(revocation); } catch { durable = false; }
      try {
        const response = await request(`${BASE_URL}/clients/current`, {
          method: 'DELETE',
          cache: 'no-store',
          headers: { authorization: `Bearer ${connection.token}` },
        });
        if (response.status === 204 || response.status === 401) {
          try {
            const stored = await storage.get('redline_connection');
            if (stored?.redline_connection?.token === connection.token) {
              await storage.remove('redline_connection');
            }
            if (durable) await revocations.remove(revocation);
            if (pendingRevocation?.token === connection.token) pendingRevocation = null;
            return true;
          } catch {}
        }
      } catch {}
      pendingRevocation = connection;
      return durable ? false : null;
    }

    const client = {
      async probeHealth() {
        let response;
        let payload;
        try {
          ({ response, payload } = await requestJson(`${BASE_URL}/health`, { method: 'GET', cache: 'no-store' }));
        } catch (error) {
          if (error instanceof InvalidHelperResponse) {
            return {
              status: 'invalid_helper',
              recoverable: true,
              command: SETUP_COMMAND,
              message: 'Port 7878 did not return a valid Redline helper response.',
            };
          }
          return {
            status: 'missing_helper',
            recoverable: true,
            command: SETUP_COMMAND,
            message: 'Redline helper was not found on 127.0.0.1:7878.',
          };
        }
        const expiry = payload?.pairing?.expires_at;
        const expiryTime = typeof expiry === 'string' ? Date.parse(expiry) : NaN;
        const canonicalExpiry = Number.isFinite(expiryTime) && new Date(expiryTime).toISOString() === expiry;
        if (response.ok && payload?.product === 'redline' &&
            Number.isSafeInteger(payload.protocol?.major) && payload.protocol.major > 1) {
          return {
            status: 'extension_update_required',
            recoverable: true,
            message: 'This Redline helper requires a newer Redline extension. Update Redline in Chrome.',
          };
        }
        if (response.ok && payload?.product === 'redline' &&
            typeof payload.package_version === 'string' && SEMVER_PATTERN.test(payload.package_version) &&
            payload.protocol?.major === 1 &&
            Number.isSafeInteger(payload.protocol?.minor) && payload.protocol.minor >= 0 &&
            Array.isArray(payload.capabilities) &&
            payload.capabilities.every((capability) => typeof capability === 'string' && capability.length <= 64) &&
            REQUIRED_CAPABILITIES.every((capability) => payload.capabilities.includes(capability)) &&
            payload.pairing?.available === true &&
            canonicalExpiry && expiryTime > now()) {
          return {
            status: 'consent_required',
            pairingExpiresAt: expiry,
            packageVersion: payload.package_version,
            protocol: { major: payload.protocol.major, minor: payload.protocol.minor },
          };
        }
        if (response.ok && payload?.product === 'redline' && payload.pairing?.available === true &&
            canonicalExpiry && expiryTime <= now()) {
          return {
            status: 'pairing_expired',
            recoverable: true,
            command: SETUP_COMMAND,
            message: 'The Redline connection window expired. Run setup again.',
          };
        }
        if (response.ok && payload?.product === 'redline' &&
            typeof payload.package_version === 'string' && SEMVER_PATTERN.test(payload.package_version) &&
            payload.protocol?.major === 1 && Number.isSafeInteger(payload.protocol?.minor) && payload.protocol.minor >= 0 &&
            Array.isArray(payload.capabilities) &&
            payload.capabilities.every((capability) => typeof capability === 'string' && capability.length <= 64) &&
            REQUIRED_CAPABILITIES.every((capability) => payload.capabilities.includes(capability)) &&
            payload.pairing?.available === false && !Object.hasOwn(payload.pairing, 'expires_at')) {
          return {
            status: 'setup_required',
            recoverable: true,
            command: SETUP_COMMAND,
            message: 'Run setup to open a local Redline connection window.',
          };
        }
        return {
          status: 'invalid_helper',
          recoverable: true,
          command: SETUP_COMMAND,
          message: 'Port 7878 did not return a valid Redline helper response.',
        };
      },
      async pair(secret, { consent = false } = {}) {
        if (consent !== true) {
          return { status: 'consent_required' };
        }
        if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(secret)) {
          return { status: 'invalid_pairing_secret', recoverable: true, command: SETUP_COMMAND };
        }
        const health = await client.probeHealth();
        if (health.status !== 'consent_required') return health;
        let response;
        let payload;
        try {
          ({ response, payload } = await requestJson(`${BASE_URL}/pair`, {
            method: 'POST',
            cache: 'no-store',
            headers: { 'content-type': 'application/json', 'x-redline-protocol': '1' },
            body: JSON.stringify({ secret, consent_version: 1 }),
          }));
        } catch {
          return {
            status: 'pairing_failed',
            recoverable: true,
            command: SETUP_COMMAND,
            message: 'Redline could not reach the local helper while pairing.',
          };
        }
        if (response.status === 401 && payload?.error?.code === 'invalid_pairing_secret') {
          return {
            status: 'pairing_expired',
            recoverable: true,
            command: SETUP_COMMAND,
            message: 'The Redline connection window expired or was already used. Run setup again.',
          };
        }
        const mintedConnection = response.status === 201 &&
          typeof payload?.token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(payload.token)
          ? { client_id: payload.client_id, token: payload.token }
          : null;
        if (response.status !== 201 ||
            Object.keys(payload || {}).sort().join(',') !== 'clear_generation,client_id,consent_version,token' ||
            !/^rlc_[0-9a-f]{32}$/.test(payload?.client_id || '') ||
            typeof payload?.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(payload.token) ||
            !Number.isSafeInteger(payload?.clear_generation) || payload.clear_generation < 0 ||
            payload?.consent_version !== 1) {
          const revoked = mintedConnection ? await revokeConnection(mintedConnection) : true;
          if (revoked === null) {
            return {
              status: 'pairing_cleanup_persistence_failed', recoverable: false,
              message: 'Redline could not durably save cleanup for this browser credential. Keep this page open and restart the local helper.',
            };
          }
          if (!revoked) {
            return {
              status: 'pairing_cleanup_required', recoverable: false,
              message: 'Redline received an invalid pairing response and is still revoking its browser credential.',
            };
          }
          return { status: 'pairing_failed', recoverable: true, command: SETUP_COMMAND };
        }
        const connection = {
          port: 7878,
          client_id: payload.client_id,
          token: payload.token,
          clear_generation: payload.clear_generation,
          consent_version: payload.consent_version,
          protocol: {
            major: health.protocol.major,
            minor: health.protocol.minor,
            helper_version: health.packageVersion,
          },
          setup: { consent: 'accepted', consented_at: new Date(now()).toISOString() },
        };
        try {
          await storage.set({ redline_connection: connection });
        } catch {
          const revoked = await revokeConnection(connection);
          if (revoked === null) {
            return {
              status: 'pairing_cleanup_persistence_failed', recoverable: false,
              message: 'Redline could not durably save cleanup for this browser credential. Keep this page open and restart the local helper.',
            };
          }
          if (!revoked) {
            return {
              status: 'pairing_cleanup_required',
              recoverable: false,
              message: 'Redline could not save or revoke this browser credential. Keep this page open and restart the local helper.',
            };
          }
          return {
            status: 'pairing_failed',
            recoverable: true,
            command: SETUP_COMMAND,
            message: 'Redline connected but could not save this browser credential. Run setup again.',
          };
        }
        return { status: 'paired', connection };
      },
      revoke(connection) {
        return revokeConnection(connection);
      },
      async revokePending() {
        const durable = await revocations.list();
        let complete = true;
        for (const revocation of durable) {
          complete = (await revokeConnection(revocation)) === true && complete;
        }
        if (pendingRevocation && !durable.some((entry) => entry.token === pendingRevocation.token)) {
          complete = (await revokeConnection(pendingRevocation)) === true && complete;
        }
        return complete;
      },
      async checkConnection() {
        const stored = await storage.get('redline_connection');
        const connection = stored?.redline_connection;
        if (!connection || !/^rlc_[0-9a-f]{32}$/.test(connection.client_id || '') ||
            !/^[A-Za-z0-9_-]{43}$/.test(connection.token || '') || connection.consent_version !== 1) {
          return { status: 'disconnected' };
        }
        let response;
        let payload;
        try {
          ({ response, payload } = await requestJson(`${BASE_URL}/generation`, {
            method: 'GET',
            cache: 'no-store',
            headers: { authorization: `Bearer ${connection.token}` },
          }));
        } catch {
          return {
            status: 'missing_helper', recoverable: true, command: SETUP_COMMAND,
            message: 'Redline helper was not found on 127.0.0.1:7878.',
          };
        }
        if (response.status === 401) {
          return {
            status: 'stale_token',
            recoverable: true,
            command: SETUP_COMMAND,
            message: 'This browser connection is stale. Run setup again to reconnect.',
          };
        }
        if (!response.ok) return { status: 'connection_error' };
        if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
            Object.keys(payload).join(',') !== 'clear_generation' ||
            !Number.isSafeInteger(payload.clear_generation) || payload.clear_generation < 0) {
          return { status: 'connection_error' };
        }
        return { status: 'connected' };
      },
    };
    return client;
  }

  const api = { BASE_URL, SETUP_COMMAND, createConnectionClient };
  root.RedlineConnection = api;
  if (typeof module === 'object' && module?.exports) module.exports = api;
})(globalThis);
