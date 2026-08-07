'use strict';

const PORTAL_DESTINATION = 'org.freedesktop.portal.Desktop';
const PORTAL_PATH = '/org/freedesktop/portal/desktop';
const PORTAL_INTERFACE = 'org.freedesktop.portal.OpenURI';
const SAFE_SESSION_ADDRESS = /^unix:path=[^,;\0\r\n]+(?:,guid=[0-9a-fA-F]{32})?$/;

function portalError(message) {
  return new Error(message);
}

function openUriWithPortal(uri, {
  dbus, busAddress = process.env.DBUS_SESSION_BUS_ADDRESS, timeoutMs = 3000,
} = {}) {
  if (typeof uri !== 'string' || !/^https?:\/\/[^\0\r\n]+$/.test(uri)) {
    return Promise.reject(portalError('XDG desktop portal browser URL is invalid'));
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    return Promise.reject(portalError('XDG desktop portal timeout is invalid'));
  }
  if (typeof busAddress === 'string' && busAddress.startsWith('unix:abstract=')) {
    return Promise.reject(portalError('XDG desktop portal abstract D-Bus sockets are not supported; rerun from a Linux desktop session using a unix:path session bus'));
  }
  if (typeof busAddress !== 'string' || busAddress.length > 8192 || !SAFE_SESSION_ADDRESS.test(busAddress)) {
    return Promise.reject(portalError('XDG desktop portal session bus address is unavailable or unsafe; rerun from a Linux desktop session'));
  }

  let client;
  try { client = dbus || require('@homebridge/dbus-native'); } catch {
    return Promise.reject(portalError('XDG desktop portal support is unavailable; reinstall Redline'));
  }

  return new Promise((resolve, reject) => {
    let bus;
    let settled = false;
    let timer;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (bus?.connection) {
        bus.connection.removeListener('error', onConnectionError);
        // dbus-native can forward a stream error on a later turn after end().
        // Keep this sink on the private connection object for its remaining life.
        bus.connection.on('error', () => {});
        try { bus.connection.end(); } catch {}
      }
      if (error) reject(error); else resolve();
    };
    const onConnectionError = () => finish(portalError('XDG desktop portal is unavailable; start a desktop session and rerun redline setup'));

    try {
      bus = client.sessionBus({ busAddress });
      if (!bus?.connection || typeof bus.connection.on !== 'function' || typeof bus.connection.end !== 'function' ||
          typeof bus.invoke !== 'function') {
        throw new Error('invalid session bus');
      }
      bus.connection.on('error', onConnectionError);
      timer = setTimeout(() => finish(portalError('XDG desktop portal timed out; rerun redline setup')), timeoutMs);
      bus.invoke({
        destination: PORTAL_DESTINATION,
        path: PORTAL_PATH,
        interface: PORTAL_INTERFACE,
        member: 'OpenURI',
        signature: 'ssa{sv}',
        body: ['', uri, []],
      }, (error) => finish(error
        ? portalError('XDG desktop portal could not open the browser; rerun redline setup')
        : null));
    } catch {
      finish(portalError('XDG desktop portal is unavailable; start a desktop session and rerun redline setup'));
    }
  });
}

module.exports = { openUriWithPortal };
