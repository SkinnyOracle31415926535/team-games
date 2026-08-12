const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const source = readFileSync(new URL('../automatic-app-sync.js', `file://${__filename}`), 'utf8');

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function createEnvironment({ local = { value: 'local' }, responses = [], persisted = {} } = {}) {
  const values = new Map(Object.entries(persisted));
  const listeners = new Map();
  const timers = [];
  let localValue = local;
  let handles = null;
  const eventTarget = {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
  };
  const window = {
    ...eventTarget,
    setTimeout(task, delay) { timers.push({ task, delay }); return timers.length; },
    clearTimeout() {},
    setInterval(task, delay) { timers.push({ task, delay, interval: true }); return timers.length; },
    clearInterval() {},
  };
  const document = { ...eventTarget, visibilityState: 'visible' };
  const localStorage = {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
  const calls = [];
  const context = {
    window,
    document,
    location: { protocol: 'https:', hostname: 'example.chatgpt.site' },
    localStorage,
    TextEncoder,
    console: { warn() {} },
    Date,
    JSON,
    Promise,
    fetch: async (url, options) => {
      calls.push({ url, options });
      const next = responses.shift();
      if (next instanceof Error) throw next;
      if (!next) throw new Error(`Unexpected fetch ${url}`);
      return typeof next === 'function' ? next(url, options) : next;
    },
  };
  vm.runInNewContext(source, context, { filename: 'automatic-app-sync.js' });
  const storage = {
    makeAdapters() {
      return {
        preferences: {
          collection: 'preferences',
          recordId: 'current',
          schemaVersion: 1,
          validate(value) {
            return value && typeof value === 'object' && typeof value.value === 'string';
          },
          readLocal() { return localValue; },
          applyRemote(value, metadata) {
            assert.equal(metadata.source, 'remote');
            localValue = metadata.deleted ? undefined : value;
          },
        },
      };
    },
    attachHandles(next) { handles = next; },
  };
  const client = window.AutomaticAppSync.install({ appId: 'test-app', storage });
  return {
    calls,
    client,
    get handles() { return handles; },
    get localValue() { return localValue; },
    set localValue(value) { localValue = value; },
    storage: values,
    timers,
  };
}

test('automatic runtime has no sync controls or DOM construction', () => {
  assert.doesNotMatch(source, /createElement|showModal|<dialog|ryan-semantic|private sync/i);
  const environment = createEnvironment();
  assert.equal(typeof environment.handles.preferences.save, 'function');
  assert.ok(environment.timers.some((timer) => timer.delay === 60));
});

test('automatic runtime uploads local-only records without blocking local handlers', async () => {
  const environment = createEnvironment({
    responses: [
      response({ version: 1, appId: 'test-app', records: [] }),
      response({
        record: {
          collection: 'preferences', recordId: 'current', revision: 1,
          updatedAt: '2026-08-12T00:00:00.000Z',
          value: { schemaVersion: 1, deleted: false, data: { value: 'local' } },
        },
      }),
    ],
  });
  await environment.handles.preferences.save({ value: 'local' });
  assert.deepEqual(environment.localValue, { value: 'local' });
  assert.equal(await environment.client.sync(), true);
  assert.equal(environment.calls.length, 2);
  assert.equal(environment.calls[0].options.credentials, 'same-origin');
  assert.equal(environment.calls[1].options.method, 'PUT');
  assert.match(environment.calls[1].options.body, /"appId":"test-app"/);
});

test('automatic runtime keeps local data when offline and retries later', async () => {
  const environment = createEnvironment({ responses: [new Error('offline')] });
  environment.localValue = { value: 'saved locally' };
  await environment.handles.preferences.save(environment.localValue);
  assert.deepEqual(environment.localValue, { value: 'saved locally' });
  assert.equal(await environment.client.sync(), false);
  assert.ok(environment.timers.some((timer) => timer.delay === 1_000));
});

test('an unknown divergent local record is recovered before the shared record applies', async () => {
  const remotePayload = { schemaVersion: 1, deleted: false, data: { value: 'shared' } };
  const environment = createEnvironment({
    local: { value: 'device-only' },
    responses: [response({
      version: 1,
      appId: 'test-app',
      records: [{
        collection: 'preferences', recordId: 'current', revision: 4,
        updatedAt: '2026-08-12T00:00:00.000Z', value: remotePayload,
      }],
    })],
  });
  assert.equal(await environment.client.sync(), true);
  assert.deepEqual(environment.localValue, { value: 'shared' });
  const recovery = JSON.parse(environment.storage.get('__ryan_automatic_app_sync_recovery_test-app_v1'));
  assert.equal(recovery.entries.length, 1);
  assert.deepEqual(recovery.entries[0].local.data, { value: 'device-only' });
});

test('a migrated baseline without a recorded local edit lets the shared record win safely', async () => {
  const key = 'preferences\u001fcurrent';
  const baseline = { schemaVersion: 1, deleted: false, data: { value: 'baseline' } };
  const shared = { schemaVersion: 1, deleted: false, data: { value: 'shared' } };
  const environment = createEnvironment({
    local: { value: 'device-only' },
    persisted: {
      '__ryan_semantic_sync_test-app_v1': JSON.stringify({
        version: 1,
        records: {
          [key]: {
            collection: 'preferences', recordId: 'current', revision: 1,
            fingerprint: JSON.stringify(baseline),
          },
        },
      }),
    },
    responses: [response({
      version: 1,
      appId: 'test-app',
      records: [{
        collection: 'preferences', recordId: 'current', revision: 2,
        updatedAt: '2026-08-12T00:00:00.000Z', value: shared,
      }],
    })],
  });

  assert.equal(await environment.client.sync(), true);
  assert.deepEqual(environment.localValue, { value: 'shared' });
  assert.equal(environment.calls.length, 1);
  const recovery = JSON.parse(environment.storage.get('__ryan_automatic_app_sync_recovery_test-app_v1'));
  assert.deepEqual(recovery.entries[0].local.data, { value: 'device-only' });
});

test('a recorded newer local edit wins a concurrent shared update', async () => {
  const key = 'preferences\u001fcurrent';
  const baseline = { schemaVersion: 1, deleted: false, data: { value: 'baseline' } };
  const shared = { schemaVersion: 1, deleted: false, data: { value: 'shared' } };
  const local = { schemaVersion: 1, deleted: false, data: { value: 'local' } };
  const environment = createEnvironment({
    local: { value: 'local' },
    persisted: {
      '__ryan_automatic_app_sync_test-app_v2': JSON.stringify({
        version: 2,
        records: {
          [key]: {
            collection: 'preferences', recordId: 'current', revision: 1,
            fingerprint: JSON.stringify(baseline),
          },
        },
        dirty: { [key]: 2_000_000_000_000 },
      }),
    },
    responses: [
      response({
        version: 1,
        appId: 'test-app',
        records: [{
          collection: 'preferences', recordId: 'current', revision: 2,
          updatedAt: '2026-08-12T00:00:00.000Z', value: shared,
        }],
      }),
      response({
        record: {
          collection: 'preferences', recordId: 'current', revision: 3,
          updatedAt: '2026-08-12T00:00:01.000Z', value: local,
        },
      }),
    ],
  });

  assert.equal(await environment.client.sync(), true);
  assert.deepEqual(environment.localValue, { value: 'local' });
  assert.equal(environment.calls[1].options.method, 'PUT');
});
