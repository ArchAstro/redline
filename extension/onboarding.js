(function initializeRedlineOnboarding(root) {
  'use strict';

  const SECRET_KEY = 'redline_pairing_secret';
  const SETUP_COMMAND = 'npx --yes @archastro/redline setup';

  function createOnboardingController({
    connectionClient, localStorage, sessionStorage, view, siteEnabler = null,
    visibility = { isVisible: () => true, subscribe: () => () => {} }, scheduler = null,
    now = Date.now,
  }) {
    if (!connectionClient || typeof connectionClient.probeHealth !== 'function') {
      throw new TypeError('onboarding connection client is required');
    }
    if (!localStorage || !sessionStorage || !view) {
      throw new TypeError('onboarding storage and view are required');
    }

    let stagedSecret = null;
    let connected = false;
    let timer = null;
    let expiryTimer = null;
    let unsubscribe = null;
    let pollingDeadline = null;
    let consentAttempt = null;
    let terminalStatus = null;
    let refreshPromise = null;
    let stateEpoch = 0;

    async function expireStagedSecret() {
      terminalStatus = 'pairing_expired';
      stateEpoch += 1;
      stopPolling();
      clearExpiryTimer();
      stagedSecret = null;
      await sessionStorage.remove(SECRET_KEY);
      view.showDeclined({
        message: 'The one-time connection window expired. Redline is not connected.',
        guidance: 'Run setup again, clear local extension data, or uninstall Redline from Chrome.',
      });
    }

    function clearExpiryTimer() {
      if (expiryTimer !== null && typeof scheduler?.clearTimeout === 'function') {
        scheduler.clearTimeout(expiryTimer);
      }
      expiryTimer = null;
    }

    function scheduleExpiry(expiresAt) {
      if (typeof scheduler?.setTimeout !== 'function') return;
      const expiry = Date.parse(expiresAt);
      if (!Number.isFinite(expiry) || new Date(expiry).toISOString() !== expiresAt) return;
      clearExpiryTimer();
      const delay = Math.max(0, Math.min(expiry - now(), 2_147_483_647));
      expiryTimer = scheduler.setTimeout(async () => {
        expiryTimer = null;
        if (terminalStatus || connected) return;
        if (now() < expiry) {
          scheduleExpiry(expiresAt);
          return;
        }
        try {
          await expireStagedSecret();
        } catch {
          view.showConnectionError?.({ status: 'secret_cleanup_failed' });
        }
      }, delay);
    }

    async function performRefresh(epoch) {
      if (terminalStatus) return { status: terminalStatus };
      if (typeof connectionClient.checkConnection === 'function') {
        const connection = await connectionClient.checkConnection();
        if (terminalStatus || epoch !== stateEpoch) return { status: terminalStatus || 'superseded' };
        if (connection.status === 'connected') {
          connected = true;
          stopPolling();
          view.showConnected();
          return { status: 'connected' };
        }
        view.showStatus?.(connection);
      }
      const stored = await sessionStorage.get(SECRET_KEY);
      if (terminalStatus || epoch !== stateEpoch) return { status: terminalStatus || 'superseded' };
      const staged = stored?.[SECRET_KEY];
      const stagedExpiry = typeof staged?.expires_at === 'string' ? Date.parse(staged.expires_at) : NaN;
      const validStaged = staged && typeof staged === 'object' && !Array.isArray(staged) &&
        Object.keys(staged).sort().join(',') === 'expires_at,secret' &&
        /^[A-Za-z0-9_-]{43}$/.test(staged.secret || '') && Number.isFinite(stagedExpiry) &&
        new Date(stagedExpiry).toISOString() === staged.expires_at;
      if (validStaged && stagedExpiry <= now()) {
        await expireStagedSecret();
        return { status: 'pairing_expired' };
      }
      stagedSecret = validStaged ? staged.secret : null;
      if (/^[A-Za-z0-9_-]{43}$/.test(stagedSecret || '')) {
        pollingDeadline = null;
        const health = await connectionClient.probeHealth();
        if (terminalStatus || epoch !== stateEpoch) return { status: terminalStatus || 'superseded' };
        if (health.status === 'consent_required') {
          const effectiveExpiry = new Date(Math.min(stagedExpiry, Date.parse(health.pairingExpiresAt))).toISOString();
          scheduleExpiry(effectiveExpiry);
          view.showDisclosure({ pairingExpiresAt: effectiveExpiry });
          return { status: 'consent_required' };
        }
        if (health.status === 'pairing_expired') {
          await expireStagedSecret();
        }
        return { status: health.status };
      }
      stagedSecret = null;
      view.showSetup?.({ command: SETUP_COMMAND });
      const health = await connectionClient.probeHealth();
      if (terminalStatus || epoch !== stateEpoch) return { status: terminalStatus || 'superseded' };
      view.showStatus?.(health);
      return { status: 'setup_required' };
    }

    function refresh() {
      if (refreshPromise) return refreshPromise;
      const epoch = stateEpoch;
      refreshPromise = performRefresh(epoch).finally(() => { refreshPromise = null; });
      return refreshPromise;
    }

    function stopPolling() {
      if (timer !== null) scheduler.clearInterval(timer);
      timer = null;
    }

    function schedulePolling() {
      if (!scheduler || timer !== null || connected || terminalStatus) return;
      if (pollingDeadline === null) pollingDeadline = now() + 600_000;
      timer = scheduler.setInterval(async () => {
        if (pollingDeadline !== null && now() >= pollingDeadline) {
          if (!stagedSecret) {
            stopPolling();
            view.showSetup?.({ command: SETUP_COMMAND });
          }
          return;
        }
        if (visibility.isVisible()) await refresh();
      }, 1000);
    }

    async function handleVisibility() {
      if (!visibility.isVisible()) {
        stopPolling();
        return;
      }
      await refresh();
      schedulePolling();
    }

    return {
      async init() {
        unsubscribe = visibility.subscribe(handleVisibility);
        if (!visibility.isVisible()) {
          view.showSetup?.({ command: SETUP_COMMAND });
          return { status: 'setup_required' };
        }
        const result = await refresh();
        schedulePolling();
        return result;
      },
      async decline() {
        terminalStatus = 'declined';
        stateEpoch += 1;
        stopPolling();
        clearExpiryTimer();
        stagedSecret = null;
        await sessionStorage.remove(SECRET_KEY);
        view.showDeclined({
          message: 'Redline is not connected and cannot access site content.',
          guidance: 'Clear local extension data or uninstall Redline from Chrome at any time.',
        });
        return { status: 'declined' };
      },
      async acceptConsent(affirmed) {
        if (affirmed !== true) return { status: 'consent_required' };
        if (!/^[A-Za-z0-9_-]{43}$/.test(stagedSecret || '')) return { status: 'setup_required' };
        if (consentAttempt) return consentAttempt;
        consentAttempt = (async () => {
          const result = await connectionClient.pair(stagedSecret, { consent: true });
          if (terminalStatus) {
            if (result.status === 'paired') {
              const revoked = await connectionClient.revoke?.(result.connection);
              if (!revoked) {
                view.showConnectionError?.({ status: 'pairing_cleanup_required' });
                return { status: 'pairing_cleanup_required' };
              }
              try {
                await localStorage.remove('redline_connection');
              } catch {
                view.showConnectionError?.({ status: 'local_cleanup_required' });
                return { status: 'local_cleanup_required' };
              }
            }
            return { status: terminalStatus };
          }
          if (result.status === 'paired') {
            connected = true;
            stopPolling();
            clearExpiryTimer();
            stagedSecret = null;
            await sessionStorage.remove(SECRET_KEY);
            view.showConnected();
            return { status: 'paired' };
          }
          if (result.status === 'pairing_expired') await expireStagedSecret();
          else if (result.recoverable) {
            view.showConnectionError?.({ status: result.status, command: result.command });
          }
          return { status: result.status };
        })();
        try {
          return await consentAttempt;
        } finally {
          consentAttempt = null;
        }
      },
      async enableSite() {
        if (!connected) return { status: 'consent_required' };
        if (typeof siteEnabler !== 'function') return { status: 'site_enable_unavailable' };
        const result = await siteEnabler();
        return { status: 'site_enabled', origin: result.origin };
      },
      dispose() {
        stopPolling();
        clearExpiryTimer();
        unsubscribe?.();
        unsubscribe = null;
      },
    };
  }

  function bindOnboardingPage({
    document, chrome, fetch, navigator, window,
    connectionApi = root.RedlineConnection,
  }) {
    const status = document.getElementById('status');
    const setup = document.getElementById('setup-command');
    const disclosure = document.getElementById('data-disclosure');
    const siteStep = document.getElementById('site-step');
    const declinedStep = document.getElementById('declined-step');
    const consent = document.getElementById('consent');
    const connect = document.getElementById('connect');
    const decline = document.getElementById('decline');
    const copy = document.getElementById('copy-command');
    const enableSite = document.getElementById('enable-site');

    const view = {
      showSetup() {
        setup.hidden = false;
        disclosure.hidden = true;
        siteStep.hidden = true;
        declinedStep.hidden = true;
        status.textContent = 'Run the setup command, then keep this page open.';
      },
      showStatus(state) {
        const messages = {
          missing_helper: 'Waiting for the local Redline helper.',
          invalid_helper: 'Port 7878 is not serving a compatible Redline helper.',
          extension_update_required: state.message,
        };
        status.textContent = messages[state.status] || status.textContent;
      },
      showDisclosure() {
        setup.hidden = true;
        disclosure.hidden = false;
        siteStep.hidden = true;
        declinedStep.hidden = true;
        status.textContent = 'Local helper found. Review the disclosure before connecting.';
      },
      showConnected() {
        setup.hidden = true;
        disclosure.hidden = true;
        declinedStep.hidden = true;
        siteStep.hidden = false;
        status.textContent = 'This browser is connected to the local Redline helper.';
        enableSite.focus();
      },
      showDeclined(guidance) {
        disclosure.hidden = true;
        siteStep.hidden = true;
        declinedStep.hidden = false;
        status.textContent = `${guidance.message} ${guidance.guidance}`;
        declinedStep.querySelector('h2')?.focus?.();
      },
      showConnectionError(error) {
        status.textContent = error.command
          ? `Connection failed. Run ${error.command} and retry.`
          : 'Connection failed. Retry setup.';
      },
    };
    const visibility = {
      isVisible: () => document.visibilityState === 'visible',
      subscribe(listener) {
        document.addEventListener('visibilitychange', listener);
        return () => document.removeEventListener('visibilitychange', listener);
      },
    };
    const scheduler = {
      setInterval: (callback, delay) => window.setInterval(callback, delay),
      clearInterval: (id) => window.clearInterval(id),
      setTimeout: (callback, delay) => window.setTimeout(callback, delay),
      clearTimeout: (id) => window.clearTimeout(id),
    };
    const connectionClient = connectionApi.createConnectionClient({
      fetch: fetch.bind(window),
      storage: chrome.storage.local,
    });
    const controller = createOnboardingController({
      connectionClient,
      localStorage: chrome.storage.local,
      sessionStorage: chrome.storage.session,
      view,
      visibility,
      scheduler,
    });

    consent.addEventListener('change', () => {
      connect.disabled = !consent.checked;
    });
    connect.addEventListener('click', async () => {
      connect.disabled = true;
      const result = await controller.acceptConsent(consent.checked);
      if (result.status !== 'paired') {
        status.textContent = 'Redline could not connect. Run setup again and retry.';
        connect.disabled = !consent.checked;
      }
    });
    decline.addEventListener('click', () => controller.decline());
    copy.addEventListener('click', async () => {
      await navigator.clipboard.writeText(SETUP_COMMAND);
      status.textContent = 'Setup command copied.';
    });
    enableSite.addEventListener('click', async () => {
      const result = await controller.enableSite();
      if (result.status === 'site_enable_unavailable') {
        status.textContent = 'Open the target page and use the Redline extension to enable that site.';
      }
    });
    window.addEventListener('beforeunload', () => controller.dispose(), { once: true });
    return controller.init().then(() => controller);
  }

  const api = { SECRET_KEY, SETUP_COMMAND, bindOnboardingPage, createOnboardingController };
  root.RedlineOnboarding = api;
  if (typeof module === 'object' && module?.exports) module.exports = api;

  if (root.document && root.chrome && root.RedlineConnection) {
    bindOnboardingPage({
      document: root.document,
      chrome: root.chrome,
      fetch: root.fetch,
      navigator: root.navigator,
      window: root,
    }).catch((error) => {
      const status = root.document.getElementById('status');
      if (status) status.textContent = `Redline setup failed: ${error.message}`;
    });
  }
})(globalThis);
