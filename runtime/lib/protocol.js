'use strict';

const { version: packageVersion } = require('../../package.json');

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const INSTANCE_ID_PATTERN = /^rli_[0-9a-f]{32}$/;
const LAUNCH_ID_PATTERN = /^rll_[0-9a-f]{32}$/;

function deepFreeze(value) {
  Object.freeze(value);
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === 'object' && !Object.isFrozen(nested)) deepFreeze(nested);
  }
  return value;
}

const PROTOCOL = deepFreeze({
  product: 'redline',
  version: { major: 1, minor: 0 },
  requiredCapabilities: ['pairing-v1', 'idempotent-redlines-v1'],
});

function parsePort(value) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    throw new TypeError(
      `invalid Redline port ${JSON.stringify(value)}; expected a canonical decimal integer from 1 to 65535`,
    );
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port > 65535) {
    throw new TypeError(
      `invalid Redline port ${JSON.stringify(value)}; expected a canonical decimal integer from 1 to 65535`,
    );
  }
  return port;
}

function parseInstanceId(value) {
  if (typeof value !== 'string' || !INSTANCE_ID_PATTERN.test(value)) {
    throw new TypeError('expected a valid Redline instance ID');
  }
  return value;
}

function parseLaunchId(value) {
  if (typeof value !== 'string' || !LAUNCH_ID_PATTERN.test(value)) {
    throw new TypeError('expected a valid Redline launch ID');
  }
  return value;
}

function parseDirectoryProof(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      typeof value.device !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value.device) ||
      typeof value.inode !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value.inode)) {
    throw new TypeError('expected canonical decimal device and inode strings');
  }
  return { device: value.device, inode: value.inode };
}

function healthPayload({
  instanceId = process.env.REDLINE_INSTANCE_ID,
  launchId = process.env.REDLINE_LAUNCH_ID,
  directory,
  pairing = { available: false },
} = {}) {
  const validatedInstanceId = parseInstanceId(instanceId);
  const validatedLaunchId = parseLaunchId(launchId);
  const validatedDirectory = parseDirectoryProof(directory);
  return {
    product: PROTOCOL.product,
    package_version: packageVersion,
    protocol: { ...PROTOCOL.version },
    capabilities: [...PROTOCOL.requiredCapabilities],
    pairing: pairing.available
      ? { available: true, expires_at: new Date(pairing.expiresAt).toISOString() }
      : { available: false },
    process: { pid: process.pid },
    instance: { id: validatedInstanceId },
    launch: { id: validatedLaunchId },
    directory: validatedDirectory,
  };
}

function checkHealthCompatibility(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { compatible: false, reason: 'health response must be a JSON object' };
  }
  if (payload.product !== PROTOCOL.product) {
    return { compatible: false, reason: 'health response product is not redline' };
  }
  if (typeof payload.package_version !== 'string' || payload.package_version.trim().length === 0) {
    return { compatible: false, reason: 'health response package_version must be a non-empty string' };
  }
  if (!SEMVER_PATTERN.test(payload.package_version)) {
    return { compatible: false, reason: 'health response package_version must be a valid semantic version' };
  }
  const version = payload.protocol;
  if (!version || typeof version !== 'object' ||
      !Number.isSafeInteger(version.major) || version.major < 0 ||
      !Number.isSafeInteger(version.minor) || version.minor < 0) {
    return {
      compatible: false,
      reason: 'health response protocol must contain non-negative integer major and minor versions',
    };
  }
  if (version.major !== PROTOCOL.version.major) {
    return {
      compatible: false,
      reason: `incompatible Redline protocol major ${version.major}; expected ${PROTOCOL.version.major}`,
    };
  }
  if (!Array.isArray(payload.capabilities) ||
      !payload.capabilities.every((capability) => typeof capability === 'string')) {
    return { compatible: false, reason: 'health response capabilities must be an array of strings' };
  }
  for (const capability of PROTOCOL.requiredCapabilities) {
    if (!payload.capabilities.includes(capability)) {
      return {
        compatible: false,
        reason: `Redline health response is missing required capability ${capability}`,
      };
    }
  }
  if (!payload.pairing || typeof payload.pairing !== 'object' ||
      typeof payload.pairing.available !== 'boolean') {
    return { compatible: false, reason: 'health response pairing.available must be a boolean' };
  }
  let pairingExpiresAt;
  if (payload.pairing.available) {
    pairingExpiresAt = payload.pairing.expires_at;
    if (typeof pairingExpiresAt !== 'string' || !Number.isFinite(Date.parse(pairingExpiresAt)) ||
        new Date(pairingExpiresAt).toISOString() !== pairingExpiresAt) {
      return { compatible: false, reason: 'available pairing must include a valid ISO expiry' };
    }
  } else if (Object.hasOwn(payload.pairing, 'expires_at')) {
    return { compatible: false, reason: 'unavailable pairing must not include an expiry' };
  }
  if (!payload.process || typeof payload.process !== 'object' ||
      !Number.isSafeInteger(payload.process.pid) || payload.process.pid <= 0) {
    return { compatible: false, reason: 'health response process.pid must be a positive safe integer' };
  }
  try {
    parseInstanceId(payload.instance?.id);
  } catch {
    return { compatible: false, reason: 'health response instance.id must be a valid Redline instance ID' };
  }
  try {
    parseLaunchId(payload.launch?.id);
  } catch {
    return { compatible: false, reason: 'health response launch.id must be a valid Redline launch ID' };
  }
  let directory;
  try {
    directory = parseDirectoryProof(payload.directory);
  } catch {
    return {
      compatible: false,
      reason: 'health response directory must contain only canonical decimal device and inode strings',
    };
  }
  return {
    compatible: true,
    packageVersion: payload.package_version,
    pairingAvailable: payload.pairing.available,
    ...(pairingExpiresAt ? { pairingExpiresAt } : {}),
    processId: payload.process.pid,
    instanceId: payload.instance.id,
    launchId: payload.launch.id,
    directory,
  };
}

function parseHealthResponse(text) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return { compatible: false, reason: 'health response is not valid JSON' };
  }
  return checkHealthCompatibility(payload);
}

module.exports = {
  PROTOCOL,
  checkHealthCompatibility,
  healthPayload,
  parseHealthResponse,
  parseDirectoryProof,
  parseInstanceId,
  parseLaunchId,
  parsePort,
};
