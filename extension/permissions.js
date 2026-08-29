(function initializeRedlinePermissions(root) {
  'use strict';

  const ENABLED_ORIGINS_KEY = 'redline_enabled_origins';
  const REGISTRATION_PREFIX = 'redline-site-';
  const FULL_VISUAL_PATTERN = '<all_urls>';
  const SIDECAR_PATTERN = 'http://127.0.0.1:7878/*';

  class PermissionError extends Error {
    constructor(code, message) {
      super(message);
      this.name = 'PermissionError';
      this.code = code;
    }
  }

  function originDetails(value) {
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new PermissionError('restricted_url', 'Open an HTTP or HTTPS page to enable Redline.');
    }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') ||
        url.username || url.password || url.origin === 'null') {
      const message = url.protocol === 'chrome:' || url.protocol === 'chrome-extension:'
        ? 'Chrome pages cannot be enabled. Open the website you want to review.'
        : 'This page cannot be enabled. Open an HTTP or HTTPS website to use Redline.';
      throw new PermissionError('restricted_url', message);
    }
    return { origin: url.origin, pattern: `${url.protocol}//${url.host}/*` };
  }

  function originPattern(value) {
    return originDetails(value).pattern;
  }

  function isLocalOrigin(origin) {
    try {
      const url = new URL(origin);
      const host = url.hostname.toLowerCase();
      return host === 'localhost' || host === '127.0.0.1' || host.endsWith('.localhost');
    } catch {
      return false;
    }
  }

  async function registrationId(origin) {
    const digest = new Uint8Array(await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(origin)
    ));
    const suffix = Array.from(digest.slice(0, 12), (byte) =>
      byte.toString(16).padStart(2, '0')).join('');
    return `${REGISTRATION_PREFIX}${suffix}`;
  }

  function createPermissionController({
    permissions,
    scripting,
    storage,
    onOriginsDisabled = async () => {},
    onPermissionsChanged = () => {},
  }) {
    if (!permissions || typeof permissions.getAll !== 'function' ||
        typeof permissions.contains !== 'function' ||
        typeof permissions.remove !== 'function') {
      throw new TypeError('Chrome permissions API is required');
    }
    if (!scripting || typeof scripting.getRegisteredContentScripts !== 'function' ||
        typeof scripting.registerContentScripts !== 'function' ||
        typeof scripting.unregisterContentScripts !== 'function') {
      throw new TypeError('Chrome scripting API is required');
    }
    if (!storage || typeof storage.get !== 'function' || typeof storage.set !== 'function') {
      throw new TypeError('Chrome local storage is required');
    }

    let operation = Promise.resolve();
    let started = false;

    function enqueue(callback) {
      const run = operation.then(callback, callback);
      operation = run.catch(() => {});
      return run;
    }

    async function readStoredOrigins() {
      const stored = await storage.get(ENABLED_ORIGINS_KEY);
      const values = stored?.[ENABLED_ORIGINS_KEY];
      if (!Array.isArray(values)) return [];
      const origins = [];
      for (const value of values) {
        if (typeof value !== 'string') continue;
        try {
          const details = originDetails(value);
          if (details.origin === value && !origins.includes(value)) origins.push(value);
        } catch {}
      }
      return origins.sort();
    }

    async function writeStoredOrigins(origins) {
      await storage.set({ [ENABLED_ORIGINS_KEY]: [...new Set(origins)].sort() });
    }

    function containsOrigin(pattern) {
      return permissions.contains({ origins: [pattern] });
    }

    function registrationFor(id, pattern) {
      return {
        id,
        matches: [pattern],
        js: ['content.js'],
        css: ['content.css'],
        runAt: 'document_idle',
        allFrames: false,
        persistAcrossSessions: true,
      };
    }

    function sameRegistration(actual, expected) {
      return actual.id === expected.id && actual.runAt === expected.runAt &&
        actual.allFrames === expected.allFrames &&
        actual.persistAcrossSessions !== false &&
        JSON.stringify(actual.matches) === JSON.stringify(expected.matches) &&
        JSON.stringify(actual.js) === JSON.stringify(expected.js) &&
        JSON.stringify(actual.css) === JSON.stringify(expected.css);
    }

    async function reconcileNow() {
      const [storedOrigins, registrations] = await Promise.all([
        readStoredOrigins(),
        scripting.getRegisteredContentScripts(),
      ]);
      const grants = await Promise.all(storedOrigins.map((origin) => containsOrigin(originPattern(origin))));
      const enabledOrigins = storedOrigins.filter((_, index) => grants[index]);
      const desired = new Map();
      for (const origin of enabledOrigins) {
        const pattern = originPattern(origin);
        const id = await registrationId(origin);
        desired.set(id, registrationFor(id, pattern));
      }

      const current = registrations.filter((item) =>
        typeof item?.id === 'string' && item.id.startsWith(REGISTRATION_PREFIX));
      const staleIds = current
        .filter((item) => !desired.has(item.id) || !sameRegistration(item, desired.get(item.id)))
        .map((item) => item.id);
      if (staleIds.length) await scripting.unregisterContentScripts({ ids: staleIds });

      const currentById = new Map(current
        .filter((item) => !staleIds.includes(item.id))
        .map((item) => [item.id, item]));
      const missing = [...desired.values()].filter((item) => !currentById.has(item.id));
      if (missing.length) await scripting.registerContentScripts(missing);

      await writeStoredOrigins(enabledOrigins);
      const revokedOrigins = storedOrigins.filter((origin) => !enabledOrigins.includes(origin));
      if (revokedOrigins.length) await onOriginsDisabled(revokedOrigins);
      return enabledOrigins;
    }

    async function stateFor(value) {
      let details;
      try {
        details = value ? originDetails(value) : null;
      } catch (error) {
        if (!(error instanceof PermissionError)) throw error;
        const fullVisualEnabled = await containsOrigin(FULL_VISUAL_PATTERN);
        return {
          supported: false,
          errorCode: error.code,
          message: error.message,
          fullVisualEnabled,
          siteEnabled: false,
        };
      }
      if (details && isLocalOrigin(details.origin)) {
        const fullVisualEnabled = await containsOrigin(FULL_VISUAL_PATTERN);
        return {
          supported: true,
          origin: details.origin,
          pattern: details.pattern,
          siteEnabled: true,
          fullVisualEnabled,
          isLocal: true,
        };
      }
      const [storedOrigins, siteEnabled, fullVisualEnabled] = await Promise.all([
        readStoredOrigins(),
        details ? containsOrigin(details.pattern) : false,
        containsOrigin(FULL_VISUAL_PATTERN),
      ]);
      return {
        supported: true,
        origin: details?.origin || null,
        pattern: details?.pattern || null,
        siteEnabled: !!details && storedOrigins.includes(details.origin) && siteEnabled,
        fullVisualEnabled,
        isLocal: false,
      };
    }

    const controller = {
      async start() {
        if (!started) {
          started = true;
          permissions.onRemoved?.addListener((removed) => {
            onPermissionsChanged(removed);
            return enqueue(reconcileNow);
          });
        }
        return enqueue(reconcileNow);
      },
      reconcile() {
        return enqueue(reconcileNow);
      },
      async enableSite(value) {
        const details = originDetails(value);
        if (isLocalOrigin(details.origin)) {
          return { ...details, isLocal: true };
        }
        if (!await containsOrigin(details.pattern)) {
          throw new PermissionError('permission_denied',
            `Redline was not enabled for ${details.origin}. Chrome has not granted site access.`);
        }
        return enqueue(async () => {
          const origins = await readStoredOrigins();
          if (!origins.includes(details.origin)) origins.push(details.origin);
          await writeStoredOrigins(origins);
          await reconcileNow();
          return details;
        });
      },
      async disableSite(value) {
        const details = originDetails(value);
        if (isLocalOrigin(details.origin)) {
          return { ...details, isLocal: true };
        }
        if (!await containsOrigin(FULL_VISUAL_PATTERN)) {
          await permissions.remove({ origins: [details.pattern] });
        }
        return enqueue(async () => {
          const origins = (await readStoredOrigins()).filter((origin) => origin !== details.origin);
          await writeStoredOrigins(origins);
          await reconcileNow();
          await onOriginsDisabled([details.origin]);
          return details;
        });
      },
      async disableEverywhere() {
        const grant = await permissions.getAll();
        const optionalOrigins = [...new Set((grant.origins || [])
          .filter((origin) => origin !== SIDECAR_PATTERN))].sort();
        if (optionalOrigins.length) await permissions.remove({ origins: optionalOrigins });
        return enqueue(async () => {
          const origins = await readStoredOrigins();
          const registrations = await scripting.getRegisteredContentScripts();
          const ids = registrations.filter((item) => item.id?.startsWith(REGISTRATION_PREFIX))
            .map((item) => item.id);
          if (ids.length) await scripting.unregisterContentScripts({ ids });
          await writeStoredOrigins([]);
          if (origins.length) await onOriginsDisabled(origins);
          return { disabledOrigins: origins };
        });
      },
      async enableFullVisual() {
        if (!await containsOrigin(FULL_VISUAL_PATTERN)) {
          throw new PermissionError('permission_denied',
            'Full visual mode remains off because Chrome did not grant website screenshot access.');
        }
        await enqueue(reconcileNow);
        return { fullVisualEnabled: true };
      },
      async disableFullVisual() {
        await permissions.remove({ origins: [FULL_VISUAL_PATTERN] });
        await enqueue(reconcileNow);
        return { fullVisualEnabled: false };
      },
      getState(value) {
        return enqueue(() => stateFor(value));
      },
      canCaptureScreenshot(value) {
        return enqueue(async () => {
          const state = await stateFor(value);
          return state.supported && state.siteEnabled && state.fullVisualEnabled;
        });
      },
    };

    return controller;
  }

  const api = {
    ENABLED_ORIGINS_KEY,
    FULL_VISUAL_PATTERN,
    PermissionError,
    createPermissionController,
    originPattern,
  };
  root.RedlinePermissions = api;
  if (typeof module === 'object' && module?.exports) module.exports = api;
})(globalThis);
