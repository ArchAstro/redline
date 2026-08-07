'use strict';

const fs = require('node:fs');

function validExtensionId(value) {
  return typeof value === 'string' && /^[a-p]{32}$/.test(value) && !/^(.)\1{31}$/.test(value) &&
    value !== 'abcdefghijklmnopabcdefghijklmnop';
}

function loadExtensionIdentity(file) {
  let identity;
  try { identity = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {
    throw new Error('Chrome Web Store identity is not configured; install a release package containing config/extension-identity.json');
  }
  if (!identity || typeof identity !== 'object' || Array.isArray(identity) ||
      !validExtensionId(identity.extension_id) || typeof identity.web_store_url !== 'string') {
    throw new Error('Chrome Web Store identity configuration is invalid');
  }
  let listing;
  try { listing = new URL(identity.web_store_url); } catch {
    throw new Error('Chrome Web Store identity configuration is invalid');
  }
  if (listing.protocol !== 'https:' || listing.hostname !== 'chromewebstore.google.com' ||
      !listing.pathname.split('/').includes(identity.extension_id)) {
    throw new Error('Chrome Web Store identity configuration is invalid');
  }
  return { extensionId: identity.extension_id, storeListingUrl: listing.href };
}

module.exports = { loadExtensionIdentity, validExtensionId };
