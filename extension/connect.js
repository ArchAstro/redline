(function readRedlinePairingFragment() {
  'use strict';

  if (globalThis.__REDLINE_CONNECT_READER_RAN__ || window.top !== window) return;

  let url;
  try { url = new URL(location.href); } catch { return; }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port !== '7878' ||
      url.pathname !== '/connect' || url.username || url.password || url.search) return;

  const fragment = url.hash.match(/^#pair=([A-Za-z0-9_-]{43})$/);
  if (!fragment) return;
  const secret = fragment[1];

  globalThis.__REDLINE_CONNECT_READER_RAN__ = true;
  url.hash = '';
  history.replaceState(null, '', url.href);
  chrome.runtime.sendMessage({
    type: 'redline-stage-pairing-secret',
    source: 'redline-connect-v1',
    secret,
  });
})();
