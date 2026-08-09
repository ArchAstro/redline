'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { webcrypto } = require('node:crypto');

globalThis.crypto ||= webcrypto;
const { createRevocationStore } = require('../extension/revocations');

function storageArea(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    async get(keys) {
      if (keys === null) return structuredClone(data);
      const names = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(names.filter((key) => Object.hasOwn(data, key))
        .map((key) => [key, structuredClone(data[key])]));
    },
    async set(values) { Object.assign(data, structuredClone(values)); },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    },
  };
}

test('revocations use independent durable records so removing one cannot erase another', async () => {
  const storage = storageArea();
  const store = createRevocationStore(storage);
  const first = { client_id: 'rlc_0123456789abcdef0123456789abcdef', token: 'a'.repeat(43) };
  const second = { client_id: 'rlc_fedcba9876543210fedcba9876543210', token: 'b'.repeat(43) };

  await Promise.all([store.put(first), store.put(second)]);
  assert.deepEqual(await store.list(), [first, second]);

  await store.remove(first);
  assert.deepEqual(await store.list(), [second]);
});

test('revocations migrate the legacy shared queue to independent records', async () => {
  const first = { client_id: 'rlc_0123456789abcdef0123456789abcdef', token: 'a'.repeat(43) };
  const second = { client_id: 'rlc_fedcba9876543210fedcba9876543210', token: 'b'.repeat(43) };
  const storage = storageArea({ redline_pending_revocation: [first, second] });
  const store = createRevocationStore(storage);

  assert.deepEqual(await store.list(), [first, second]);
  assert.equal(Object.hasOwn(storage.data, 'redline_pending_revocation'), false);
  assert.equal(Object.keys(storage.data).filter((key) => key.startsWith('redline_pending_revocation::')).length, 2);
});
