'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const net = require('node:net');
const test = require('node:test');

const SECRET_URL = 'http://127.0.0.1:7878/connect#pair=portal-secret';
const BUS_ADDRESS = 'unix:path=/run/user/1000/bus';

function loadPortal() {
  let module;
  assert.doesNotThrow(() => { module = require('../setup/xdg-desktop-portal'); });
  return module.openUriWithPortal;
}

function fakeDbus(invoke) {
  const connection = new EventEmitter();
  connection.endCalls = 0;
  connection.end = () => { connection.endCalls += 1; };
  const bus = { connection, invoke };
  let sessionCalls = 0;
  let sessionOptions;
  return {
    dbus: { sessionBus: (options) => { sessionCalls += 1; sessionOptions = options; return bus; } },
    bus,
    sessionCalls: () => sessionCalls,
    sessionOptions: () => sessionOptions,
  };
}

test('Linux portal sends the exact OpenURI D-Bus call and closes the session bus', async () => {
  const openUriWithPortal = loadPortal();
  let message;
  const fixture = fakeDbus((value, callback) => { message = value; callback(null, '/org/freedesktop/portal/desktop/request/1'); });
  await openUriWithPortal(SECRET_URL, {
    dbus: fixture.dbus, busAddress: BUS_ADDRESS, timeoutMs: 50,
  });
  assert.equal(fixture.sessionCalls(), 1);
  assert.deepEqual(fixture.sessionOptions(), { busAddress: BUS_ADDRESS });
  assert.deepEqual(message, {
    destination: 'org.freedesktop.portal.Desktop',
    path: '/org/freedesktop/portal/desktop',
    interface: 'org.freedesktop.portal.OpenURI',
    member: 'OpenURI',
    signature: 'ssa{sv}',
    body: ['', SECRET_URL, []],
  });
  const wire = require('@homebridge/dbus-native/lib/message');
  const decoded = wire.unmarshall(wire.marshall({ ...message, serial: 1 }));
  assert.equal(decoded.signature, 'ssa{sv}');
  assert.deepEqual(decoded.body, ['', SECRET_URL, []]);
  assert.equal(fixture.bus.connection.endCalls, 1);
});

test('Linux portal rejects session bus addresses that could spawn or leave Unix transport', async () => {
  const openUriWithPortal = loadPortal();
  for (const busAddress of [
    'unixexec:path=/tmp/not-allowed,arg0=secret',
    'tcp:host=127.0.0.1,port=1234',
    'unix:path=/run/user/1000/bus;unixexec:path=/tmp/not-allowed',
    'unix:path=/run/user/1000/bus\n',
  ]) {
    const fixture = fakeDbus(() => {});
    await assert.rejects(openUriWithPortal(SECRET_URL, {
      dbus: fixture.dbus, busAddress, timeoutMs: 50,
    }), /session bus.*unsafe|unavailable/i, busAddress);
    assert.equal(fixture.sessionCalls(), 0, busAddress);
  }
});

test('Linux portal rejects unsupported abstract sockets before loading the D-Bus client', async () => {
  const openUriWithPortal = loadPortal();
  const fixture = fakeDbus(() => {});
  await assert.rejects(openUriWithPortal(SECRET_URL, {
    dbus: fixture.dbus, busAddress: 'unix:abstract=/tmp/not-packaged', timeoutMs: 50,
  }), /abstract.*not supported/i);
  assert.equal(fixture.sessionCalls(), 0);
});

test('Linux portal passes an accepted unix:path address to the installed dependency connector', async (t) => {
  const openUriWithPortal = loadPortal();
  const dbus = require('@homebridge/dbus-native');
  const originalCreateConnection = net.createConnection;
  let connectorArgument;
  net.createConnection = (...args) => {
    connectorArgument = args;
    throw new Error('test connector stop');
  };
  t.after(() => { net.createConnection = originalCreateConnection; });

  await assert.rejects(openUriWithPortal(SECRET_URL, {
    dbus, busAddress: BUS_ADDRESS, timeoutMs: 50,
  }), /desktop portal.*unavailable/i);
  assert.deepEqual(connectorArgument, ['/run/user/1000/bus']);
});

test('Linux portal errors are actionable, non-secret, and close the session bus', async () => {
  const openUriWithPortal = loadPortal();
  const fixture = fakeDbus((_message, callback) => callback({ message: `failed ${SECRET_URL}` }));
  let stdout = '';
  let stderr = '';
  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;
  process.stdout.write = (value) => { stdout += value; return true; };
  process.stderr.write = (value) => { stderr += value; return true; };
  try {
    await assert.rejects(openUriWithPortal(SECRET_URL, {
      dbus: fixture.dbus, busAddress: BUS_ADDRESS, timeoutMs: 50,
    }), (error) => {
      assert.match(error.message, /desktop portal.*unavailable|could not open/i);
      assert.equal(error.message.includes(SECRET_URL), false);
      return true;
    });
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }
  assert.equal(stdout, '');
  assert.equal(stderr, '');
  assert.equal(fixture.bus.connection.endCalls, 1);
});

test('Linux portal bounds an unanswered call and closes the session bus', async () => {
  const openUriWithPortal = loadPortal();
  const fixture = fakeDbus(() => {});
  const started = Date.now();
  await assert.rejects(openUriWithPortal(SECRET_URL, {
    dbus: fixture.dbus, busAddress: BUS_ADDRESS, timeoutMs: 20,
  }), /desktop portal.*timed out/i);
  assert.ok(Date.now() - started < 1000);
  assert.equal(fixture.bus.connection.endCalls, 1);
});

test('Linux portal safely absorbs connection errors raised during shutdown', async () => {
  const openUriWithPortal = loadPortal();
  const fixture = fakeDbus((_message, callback) => callback(null, '/request/1'));
  fixture.bus.connection.end = function () {
    this.endCalls += 1;
    this.emit('error', new Error(`shutdown ${SECRET_URL}`));
  };
  await openUriWithPortal(SECRET_URL, {
    dbus: fixture.dbus, busAddress: BUS_ADDRESS, timeoutMs: 50,
  });
  assert.equal(fixture.bus.connection.endCalls, 1);
});

test('Linux portal absorbs a next-turn connection error after shutdown', async () => {
  const openUriWithPortal = loadPortal();
  const fixture = fakeDbus((_message, callback) => callback(null, '/request/1'));
  fixture.bus.connection.end = function () {
    this.endCalls += 1;
    setImmediate(() => this.emit('error', new Error(`late shutdown ${SECRET_URL}`)));
  };
  await openUriWithPortal(SECRET_URL, {
    dbus: fixture.dbus, busAddress: BUS_ADDRESS, timeoutMs: 50,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.bus.connection.endCalls, 1);
});
