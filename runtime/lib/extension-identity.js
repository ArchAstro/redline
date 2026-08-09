'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');

function validExtensionId(value) {
  return typeof value === 'string' && /^[a-p]{32}$/.test(value) && !/^(.)\1{31}$/.test(value) &&
    value !== 'abcdefghijklmnopabcdefghijklmnop';
}

function extensionIdFromPublicKey(publicKey) {
  if (typeof publicKey !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(publicKey)) {
    throw new Error('Chrome Web Store public key is invalid');
  }
  const keyBytes = Buffer.from(publicKey, 'base64');
  if (keyBytes.toString('base64') !== publicKey) {
    throw new Error('Chrome Web Store public key is invalid');
  }
  let parsed;
  try {
    parsed = crypto.createPublicKey({ key: keyBytes, format: 'der', type: 'spki' });
  } catch {
    throw new Error('Chrome Web Store public key is invalid');
  }
  if (parsed.asymmetricKeyType !== 'rsa') throw new Error('Chrome Web Store public key is invalid');
  const digest = crypto.createHash('sha256').update(keyBytes).digest('hex').slice(0, 32);
  return digest.replace(/[0-9a-f]/g, (digit) =>
    String.fromCharCode('a'.charCodeAt(0) + Number.parseInt(digit, 16)));
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
  if (extensionIdFromPublicKey(identity.public_key) !== identity.extension_id) {
    throw new Error('Chrome Web Store public key does not match the configured extension ID');
  }
  let listing;
  try { listing = new URL(identity.web_store_url); } catch {
    throw new Error('Chrome Web Store identity configuration is invalid');
  }
  if (listing.protocol !== 'https:' || listing.hostname !== 'chromewebstore.google.com' ||
      !listing.pathname.split('/').includes(identity.extension_id)) {
    throw new Error('Chrome Web Store identity configuration is invalid');
  }
  return {
    extensionId: identity.extension_id,
    publicKey: identity.public_key,
    storeListingUrl: listing.href,
  };
}

module.exports = { extensionIdFromPublicKey, loadExtensionIdentity, validExtensionId };
