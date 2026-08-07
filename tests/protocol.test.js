'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { version: packageVersion } = require('../package.json');

const {
  PROTOCOL,
  checkHealthCompatibility,
  healthPayload,
  parseInstanceId,
  parseLaunchId,
  parsePort,
  parseHealthResponse,
} = require('../runtime/lib/protocol');

const INSTANCE_ID = 'rli_0123456789abcdef0123456789abcdef';
const LAUNCH_ID = 'rll_fedcba9876543210fedcba9876543210';
const DIRECTORY = { device: '16777234', inode: '987654321' };
const validHealth = () => healthPayload({ instanceId: INSTANCE_ID, launchId: LAUNCH_ID, directory: DIRECTORY });

test('healthPayload returns the exact public Redline protocol identity', () => {
  assert.deepEqual(healthPayload({ instanceId: INSTANCE_ID, launchId: LAUNCH_ID, directory: DIRECTORY }), {
    product: 'redline',
    package_version: packageVersion,
    protocol: { major: 1, minor: 0 },
    capabilities: ['pairing-v1', 'idempotent-redlines-v1'],
    pairing: { available: false },
    process: { pid: process.pid },
    instance: { id: INSTANCE_ID },
    launch: { id: LAUNCH_ID },
    directory: DIRECTORY,
  });
});

test('protocol constants are deeply immutable', () => {
  assert.equal(Object.isFrozen(PROTOCOL), true);
  assert.equal(Object.isFrozen(PROTOCOL.version), true);
  assert.equal(Object.isFrozen(PROTOCOL.requiredCapabilities), true);
  assert.throws(() => {
    PROTOCOL.version.major = 2;
  }, TypeError);
  assert.throws(() => {
    PROTOCOL.requiredCapabilities.push('unexpected');
  }, TypeError);
});

test('compatible health tolerates a higher minor version and unknown fields', () => {
  const result = checkHealthCompatibility({
    ...validHealth(),
    protocol: { major: 1, minor: 7, patch: 3 },
    pairing: { available: true, expires_at: 'later' },
    future_field: { supported: true },
  });

  assert.deepEqual(result, {
    compatible: true,
    pairingAvailable: true,
    processId: process.pid,
    instanceId: INSTANCE_ID,
    launchId: LAUNCH_ID,
    directory: DIRECTORY,
  });
});

test('directory proof tolerates unknown fields and canonicalizes the result', () => {
  const directory = { ...DIRECTORY, future_field: true };

  assert.deepEqual(checkHealthCompatibility({ ...validHealth(), directory }), {
    compatible: true,
    pairingAvailable: false,
    processId: process.pid,
    instanceId: INSTANCE_ID,
    launchId: LAUNCH_ID,
    directory: DIRECTORY,
  });
  assert.deepEqual(healthPayload({
    instanceId: INSTANCE_ID,
    launchId: LAUNCH_ID,
    directory,
  }).directory, DIRECTORY);
});

test('directory proof exposes only canonical opaque device and inode numbers', () => {
  for (const directory of [
    undefined,
    null,
    {},
    { device: 1, inode: '2' },
    { device: '01', inode: '2' },
    { device: '1', inode: '../path' },
  ]) {
    assert.deepEqual(checkHealthCompatibility({ ...validHealth(), directory }), {
      compatible: false,
      reason: 'health response directory must contain only canonical decimal device and inode strings',
    });
  }
});

test('launch identity is a validated opaque public identifier', () => {
  assert.equal(parseLaunchId(LAUNCH_ID), LAUNCH_ID);
  for (const value of [undefined, null, '', 'rll_short', 'RLL_fedcba9876543210fedcba9876543210',
    'rll_fedcba9876543210fedcba9876543210\n', '../launch-id']) {
    assert.throws(() => parseLaunchId(value), /valid Redline launch ID/);
    assert.deepEqual(checkHealthCompatibility({
      ...validHealth(),
      launch: { id: value },
    }), {
      compatible: false,
      reason: 'health response launch.id must be a valid Redline launch ID',
    });
  }
});

test('instance identity is a validated opaque public identifier', () => {
  assert.equal(parseInstanceId(INSTANCE_ID), INSTANCE_ID);
  for (const value of [undefined, null, '', 'rli_short', 'RLI_0123456789abcdef0123456789abcdef',
    'rli_0123456789abcdef0123456789abcdef\n', '../instance-id']) {
    assert.throws(() => parseInstanceId(value), /valid Redline instance ID/);
    assert.deepEqual(checkHealthCompatibility({
      ...validHealth(),
      instance: { id: value },
    }), {
      compatible: false,
      reason: 'health response instance.id must be a valid Redline instance ID',
    });
  }
});

test('malformed JSON and non-object health responses are rejected safely', () => {
  assert.deepEqual(parseHealthResponse('{broken'), {
    compatible: false,
    reason: 'health response is not valid JSON',
  });
  assert.deepEqual(parseHealthResponse('null'), {
    compatible: false,
    reason: 'health response must be a JSON object',
  });
  assert.deepEqual(checkHealthCompatibility([]), {
    compatible: false,
    reason: 'health response must be a JSON object',
  });
});

test('health requires Redline product identity', () => {
  assert.deepEqual(checkHealthCompatibility({ ...validHealth(), product: 'other' }), {
    compatible: false,
    reason: 'health response product is not redline',
  });
  const missing = validHealth();
  delete missing.product;
  assert.deepEqual(checkHealthCompatibility(missing), {
    compatible: false,
    reason: 'health response product is not redline',
  });
});

test('health requires a non-empty package version', () => {
  for (const packageVersion of [undefined, null, '', '   ', 26]) {
    assert.deepEqual(checkHealthCompatibility({
      ...validHealth(),
      package_version: packageVersion,
    }), {
      compatible: false,
      reason: 'health response package_version must be a non-empty string',
    });
  }
});

test('health rejects malformed semantic package versions', () => {
  for (const packageVersion of [
    'not-a-version',
    '1',
    '1.2.3.4',
    '01.2.3',
    '1.02.3',
    '1.2.03',
    '1.2.3-01',
    '1.2.3-alpha..1',
    '1.2.3+build..1',
  ]) {
    assert.deepEqual(checkHealthCompatibility({
      ...validHealth(),
      package_version: packageVersion,
    }), {
      compatible: false,
      reason: 'health response package_version must be a valid semantic version',
    });
  }
});

test('health accepts standard semantic package versions with prerelease and build metadata', () => {
  for (const packageVersion of [
    '0.0.0',
    '1.2.3',
    '1.0.0-alpha',
    '1.0.0-alpha.1',
    '1.0.0-0.3.7',
    '1.0.0-x.7.z.92',
    '1.0.0+20130313144700',
    '1.0.0-beta+exp.sha.5114f85',
    '1.0.0-rc.1+build.1',
  ]) {
    assert.deepEqual(checkHealthCompatibility({
      ...validHealth(),
      package_version: packageVersion,
    }), {
      compatible: true,
      pairingAvailable: false,
      processId: process.pid,
      instanceId: INSTANCE_ID,
      launchId: LAUNCH_ID,
      directory: DIRECTORY,
    });
  }
});

test('health requires a compatible numeric protocol version', () => {
  assert.deepEqual(checkHealthCompatibility({ ...validHealth(), protocol: { major: 2, minor: 0 } }), {
    compatible: false,
    reason: 'incompatible Redline protocol major 2; expected 1',
  });
  for (const protocol of [
    undefined,
    null,
    { major: '1', minor: 0 },
    { major: 1, minor: -1 },
    { major: Number.MAX_SAFE_INTEGER + 1, minor: 0 },
    { major: 1, minor: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    assert.deepEqual(checkHealthCompatibility({ ...validHealth(), protocol }), {
      compatible: false,
      reason: 'health response protocol must contain non-negative integer major and minor versions',
    });
  }
});

test('health requires every protocol capability', () => {
  assert.deepEqual(checkHealthCompatibility({
    ...validHealth(),
    capabilities: ['pairing-v1'],
  }), {
    compatible: false,
    reason: 'Redline health response is missing required capability idempotent-redlines-v1',
  });
  assert.deepEqual(checkHealthCompatibility({ ...validHealth(), capabilities: 'pairing-v1' }), {
    compatible: false,
    reason: 'health response capabilities must be an array of strings',
  });
});

test('health parses pairing availability only from an explicit boolean', () => {
  for (const pairing of [undefined, null, {}, { available: 'false' }]) {
    assert.deepEqual(checkHealthCompatibility({ ...validHealth(), pairing }), {
      compatible: false,
      reason: 'health response pairing.available must be a boolean',
    });
  }
  assert.deepEqual(checkHealthCompatibility({
    ...validHealth(),
    pairing: { available: false },
  }), {
    compatible: true,
    pairingAvailable: false,
    processId: process.pid,
    instanceId: INSTANCE_ID,
    launchId: LAUNCH_ID,
    directory: DIRECTORY,
  });
});

test('health requires a positive safe process PID', () => {
  for (const processIdentity of [
    undefined,
    null,
    {},
    { pid: 0 },
    { pid: -1 },
    { pid: '123' },
    { pid: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    assert.deepEqual(checkHealthCompatibility({ ...validHealth(), process: processIdentity }), {
      compatible: false,
      reason: 'health response process.pid must be a positive safe integer',
    });
  }
});

test('parsePort accepts only canonical decimal ports from 1 through 65535', () => {
  assert.equal(parsePort('1'), 1);
  assert.equal(parsePort('7878'), 7878);
  assert.equal(parsePort('65535'), 65535);

  for (const value of ['54336junk', '0', '65536', ' 7878', '7878 ', '07878', '', '1.0', '+1', '-1']) {
    assert.throws(() => parsePort(value), {
      name: 'TypeError',
      message: `invalid Redline port ${JSON.stringify(value)}; expected a canonical decimal integer from 1 to 65535`,
    });
  }
});
