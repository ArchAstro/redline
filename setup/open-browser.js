'use strict';

const { spawnSync } = require('node:child_process');

function assertSupportedPlatform(platform = process.platform) {
  if (!['darwin', 'linux'].includes(platform)) {
    throw new Error('Redline Chrome setup currently supports macOS and Linux');
  }
}

async function openBrowser(url, { platform = process.platform, spawn = spawnSync, portalClient } = {}) {
  assertSupportedPlatform(platform);
  if (typeof url !== 'string' || !/^https?:\/\/[^\0\r\n]+$/.test(url)) throw new Error('browser URL is invalid');
  if (platform === 'linux') {
    const openPortal = portalClient || require('./xdg-desktop-portal').openUriWithPortal;
    await openPortal(url);
    return;
  }
  const command = 'osascript';
  const program = `try
tell application "Google Chrome"
activate
open location ${JSON.stringify(url)}
end tell
on error
open location ${JSON.stringify(url)}
end try\n`;
  const result = spawn(command, ['-'], { input: program, encoding: 'utf8', stdio: ['pipe', 'ignore', 'ignore'] });
  if (result.error || result.status !== 0) {
    throw new Error(`could not open the browser with ${command}`);
  }
}

module.exports = { assertSupportedPlatform, openBrowser };
