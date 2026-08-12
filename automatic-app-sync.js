/*
 * UI-free, owner-scoped record synchronization for private ChatGPT Sites.
 * Local persistence is always first: network work is scheduled separately and
 * never makes an app save fail.
 */
(() => {
  'use strict';

  const MAX_VALUE_BYTES = 900 * 1024;
  const MAX_RECOVERY_BYTES = 2 * 1024 * 1024;
  const MAX_RECOVERY_ENTRIES = 12;
  const POLL_MS = 30_000;
  const INITIAL_DELAY_MS = 60;
  const LOCAL_CHANGE_DELAY_MS = 350;
  const MAX_RETRY_MS = 5 * 60_000;

  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const exactKeys = (value, expected) => isObject(value)
    && Object.keys(value).length === expected.length
    && Object.keys(value).every((key) => expected.includes(key));
  const byteLength = (value) => new TextEncoder().encode(value).byteLength;
  const identity = (collection, recordId) => `${collection}\u001f${recordId}`;
  const comparable = (value) => JSON.stringify(value);
  const stateKey = (appId) => `__ryan_automatic_app_sync_${appId}_v2`;
  const legacyStateKey = (appId) => `__ryan_semantic_sync_${appId}_v1`;
  const recoveryKey = (appId) => `__ryan_automatic_app_sync_recovery_${appId}_v1`;

  function safeJson(value, depth = 0) {
    if (depth > 48 || value === null) return depth <= 48;
    if (typeof value === 'string' || typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (Array.isArray(value)) return value.length <= 20_000 && value.every((item) => safeJson(item, depth + 1));
    if (!isObject(value)) return false;
    return Object.entries(value).length <= 20_000 && Object.entries(value).every(([key, item]) => (
      key.length <= 240 && !['__proto__', 'constructor', 'prototype'].includes(key) && safeJson(item, depth + 1)
    ));
  }

  function supported() {
    return location.protocol === 'https:' && location.hostname.endsWith('.chatgpt.site');
  }

  function readJson(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function normalizedRecord(value) {
    if (!isObject(value) || typeof value.collection !== 'string' || typeof value.recordId !== 'string'
      || !Number.isSafeInteger(value.revision) || value.revision < 1 || typeof value.fingerprint !== 'string') {
      return null;
    }
    return {
      collection: value.collection,
      recordId: value.recordId,
      revision: value.revision,
      fingerprint: value.fingerprint,
    };
  }

  function normalizedDirty(value) {
    if (!Number.isFinite(value) || value <= 0) return null;
    return Math.floor(value);
  }

  function emptyState() {
    return { version: 2, records: {}, dirty: {} };
  }

  function normalizeState(value) {
    if (!isObject(value)) return null;
    const sourceRecords = isObject(value.records) ? value.records : null;
    if (!sourceRecords) return null;
    const state = emptyState();
    for (const [key, candidate] of Object.entries(sourceRecords)) {
      const record = normalizedRecord(candidate);
      if (record && key === identity(record.collection, record.recordId)) state.records[key] = record;
    }
    if (value.version === 2 && isObject(value.dirty)) {
      for (const [key, candidate] of Object.entries(value.dirty)) {
        const dirty = normalizedDirty(candidate);
        if (dirty) state.dirty[key] = dirty;
      }
    }
    return state;
  }

  function readState(appId) {
    const current = normalizeState(readJson(stateKey(appId)));
    if (current) return current;
    const legacy = normalizeState(readJson(legacyStateKey(appId)));
    return legacy || emptyState();
  }

  function saveState(appId, state) {
    try {
      localStorage.setItem(stateKey(appId), JSON.stringify({
        version: 2,
        records: state.records,
        dirty: state.dirty,
      }));
      return true;
    } catch {
      return false;
    }
  }

  function saveRecovery(appId, entry) {
    try {
      const current = readJson(recoveryKey(appId));
      const entries = Array.isArray(current?.entries) ? current.entries.filter(safeJson) : [];
      entries.push(entry);
      while (entries.length > MAX_RECOVERY_ENTRIES || byteLength(JSON.stringify({ version: 1, entries })) > MAX_RECOVERY_BYTES) {
        entries.shift();
      }
      const next = { version: 1, entries };
      if (byteLength(JSON.stringify(next)) > MAX_RECOVERY_BYTES) return false;
      localStorage.setItem(recoveryKey(appId), JSON.stringify(next));
      return true;
    } catch {
      return false;
    }
  }

  async function responseJson(response) {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  function descriptorFrom(name, adapter) {
    if (!isObject(adapter) || typeof adapter.collection !== 'string' || typeof adapter.validate !== 'function') {
      throw new Error(`Automatic sync adapter ${name} is invalid.`);
    }
    const fixed = typeof adapter.recordId === 'string';
    if (fixed && (typeof adapter.readLocal !== 'function' || typeof adapter.applyRemote !== 'function')) {
      throw new Error(`Automatic sync adapter ${name} is incomplete.`);
    }
    if (!fixed && (typeof adapter.listLocal !== 'function' || typeof adapter.applyRemote !== 'function')) {
      throw new Error(`Automatic sync adapter ${name} is incomplete.`);
    }
    const schemaVersion = Number.isSafeInteger(adapter.schemaVersion) ? adapter.schemaVersion : 1;
    const acceptedSchemaVersions = Array.isArray(adapter.acceptedSchemaVersions)
      ? adapter.acceptedSchemaVersions.filter((value) => Number.isSafeInteger(value) && value >= 1 && value <= 100)
      : [schemaVersion];
    if (!acceptedSchemaVersions.includes(schemaVersion)) acceptedSchemaVersions.push(schemaVersion);
    return { name, adapter, fixed, schemaVersion, acceptedSchemaVersions };
  }

  function validPayload(descriptor, recordId, payload) {
    if (!exactKeys(payload, ['schemaVersion', 'deleted', 'data'])
      || !descriptor.acceptedSchemaVersions.includes(payload.schemaVersion)
      || typeof payload.deleted !== 'boolean') return false;
    if (payload.deleted) return payload.data === null;
    if (!safeJson(payload.data) || byteLength(JSON.stringify(payload.data)) > MAX_VALUE_BYTES) return false;
    if (typeof descriptor.adapter.validatePayload === 'function') {
      return descriptor.adapter.validatePayload(payload, recordId);
    }
    return descriptor.adapter.validate(payload.data, recordId);
  }

  function localPayload(descriptor, value) {
    return {
      schemaVersion: descriptor.schemaVersion,
      deleted: value === undefined,
      data: value === undefined ? null : value,
    };
  }

  function install(options) {
    if (!isObject(options) || typeof options.appId !== 'string' || !options.appId
      || !options.storage || typeof options.storage.makeAdapters !== 'function'
      || typeof options.storage.attachHandles !== 'function') {
      throw new Error('Automatic app sync was not configured safely.');
    }

    const adapterMap = options.storage.makeAdapters();
    if (!isObject(adapterMap)) throw new Error('Automatic sync adapters are unavailable.');
    const descriptors = Object.entries(adapterMap).map(([name, adapter]) => descriptorFrom(name, adapter));
    const descriptorFor = (collection, recordId) => descriptors.find(({ adapter, fixed }) =>
      adapter.collection === collection && (!fixed || adapter.recordId === recordId));
    const state = readState(options.appId);
    let running = false;
    let queued = false;
    let stopped = false;
    let timer = null;
    let retryDelay = 1_000;
    let lastError = '';

    function persistState() {
      saveState(options.appId, state);
    }

    function remember(collection, recordId, record, payload) {
      state.records[identity(collection, recordId)] = {
        collection,
        recordId,
        revision: record.revision,
        fingerprint: comparable(payload),
      };
      delete state.dirty[identity(collection, recordId)];
      persistState();
    }

    function forget(collection, recordId) {
      const key = identity(collection, recordId);
      delete state.records[key];
      delete state.dirty[key];
      persistState();
    }

    function markDirty(descriptor, recordId) {
      if (!recordId) return;
      state.dirty[identity(descriptor.adapter.collection, recordId)] = Date.now();
      persistState();
    }

    function schedule(delay = LOCAL_CHANGE_DELAY_MS) {
      if (stopped || !supported()) return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        void sync();
      }, delay);
    }

    async function upload(descriptor, recordId, payload, expectedRevision) {
      const response = await fetch('/api/app-sync', {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          appId: options.appId,
          collection: descriptor.adapter.collection,
          recordId,
          expectedRevision,
          value: payload,
        }),
      });
      const body = await responseJson(response);
      if (response.ok && body?.record) return { ok: true, record: body.record };
      if (response.status === 409 && body?.current) return { ok: false, conflict: body.current };
      throw new Error(body?.error || 'Automatic sync could not save a record.');
    }

    async function applyRemote(descriptor, recordId, payload) {
      if (!validPayload(descriptor, recordId, payload)) {
        throw new Error(`A synchronized ${descriptor.adapter.collection} record is invalid.`);
      }
      const metadata = { source: 'remote', deleted: payload.deleted, schemaVersion: payload.schemaVersion };
      if (descriptor.fixed) return descriptor.adapter.applyRemote(payload.data, metadata);
      return descriptor.adapter.applyRemote(recordId, payload.data, metadata);
    }

    async function readLocal() {
      const records = new Map();
      for (const descriptor of descriptors) {
        if (descriptor.fixed) {
          const value = await descriptor.adapter.readLocal();
          if (value !== undefined && !descriptor.adapter.validate(value, descriptor.adapter.recordId)) {
            throw new Error(`This device's ${descriptor.adapter.collection} record is invalid.`);
          }
          records.set(identity(descriptor.adapter.collection, descriptor.adapter.recordId), {
            descriptor,
            collection: descriptor.adapter.collection,
            recordId: descriptor.adapter.recordId,
            value,
          });
          continue;
        }
        const listed = await descriptor.adapter.listLocal();
        if (!Array.isArray(listed)) throw new Error(`This device's ${descriptor.adapter.collection} records are invalid.`);
        for (const item of listed) {
          if (!isObject(item) || typeof item.recordId !== 'string' || !descriptor.adapter.validate(item.value, item.recordId)) {
            throw new Error(`This device's ${descriptor.adapter.collection} records are invalid.`);
          }
          records.set(identity(descriptor.adapter.collection, item.recordId), {
            descriptor,
            collection: descriptor.adapter.collection,
            recordId: item.recordId,
            value: item.value,
          });
        }
      }
      return records;
    }

    function remoteChangedAfterLocal(remote, dirtyAt) {
      const remoteAt = Date.parse(remote.updatedAt || '');
      return Number.isFinite(remoteAt) && Number.isFinite(dirtyAt) && remoteAt > dirtyAt;
    }

    function shouldPreferLocal(key, known, localChanged, remote) {
      if (!localChanged) return false;
      const dirtyAt = normalizedDirty(state.dirty[key]);
      if (dirtyAt) return !remoteChangedAfterLocal(remote, dirtyAt);
      return false;
    }

    async function applyRemotePreservingLocal(descriptor, recordId, local, remote, reason) {
      const localDifferent = comparable(local) !== comparable(remote.value);
      if (localDifferent && !local.deleted) {
        const saved = saveRecovery(options.appId, {
          capturedAt: new Date().toISOString(),
          reason,
          collection: descriptor.adapter.collection,
          recordId,
          local,
          remote: {
            revision: remote.revision,
            updatedAt: remote.updatedAt || null,
            value: remote.value,
          },
        });
        if (!saved) throw new Error('Automatic sync kept local data because its recovery snapshot could not be saved.');
      }
      await applyRemote(descriptor, recordId, remote.value);
      remember(descriptor.adapter.collection, recordId, remote, remote.value);
    }

    function checkedRemote(descriptor, recordId, record) {
      if (!isObject(record) || !Number.isSafeInteger(record.revision) || record.revision < 1
        || record.collection !== descriptor.adapter.collection || record.recordId !== recordId
        || !validPayload(descriptor, recordId, record.value)) {
        throw new Error('A synchronized record has an unsupported schema.');
      }
      return record;
    }

    async function uploadOrResolve(descriptor, recordId, local, expectedRevision, known) {
      const first = await upload(descriptor, recordId, local, expectedRevision);
      if (first.ok) {
        remember(descriptor.adapter.collection, recordId, first.record, local);
        return;
      }
      const current = checkedRemote(descriptor, recordId, first.conflict);
      const key = identity(descriptor.adapter.collection, recordId);
      if (shouldPreferLocal(key, known, true, current)) {
        const retry = await upload(descriptor, recordId, local, current.revision);
        if (retry.ok) {
          remember(descriptor.adapter.collection, recordId, retry.record, local);
          return;
        }
        await applyRemotePreservingLocal(descriptor, recordId, local,
          checkedRemote(descriptor, recordId, retry.conflict), 'concurrent-update');
        return;
      }
      await applyRemotePreservingLocal(descriptor, recordId, local, current, 'remote-won-conflict');
    }

    async function sync() {
      if (stopped || !supported()) return false;
      if (running) {
        queued = true;
        return false;
      }
      running = true;
      try {
        const response = await fetch(`/api/app-sync?appId=${encodeURIComponent(options.appId)}`, {
          cache: 'no-store',
          credentials: 'same-origin',
        });
        const manifest = await responseJson(response);
        if (!response.ok || !manifest || !Array.isArray(manifest.records)) {
          throw new Error(manifest?.error || 'Automatic sync is unavailable.');
        }
        const remote = new Map();
        for (const record of manifest.records) {
          if (!isObject(record) || typeof record.collection !== 'string' || typeof record.recordId !== 'string') {
            throw new Error('A synchronized record has an invalid identity.');
          }
          const descriptor = descriptorFor(record.collection, record.recordId);
          if (!descriptor) continue;
          remote.set(identity(record.collection, record.recordId), {
            ...checkedRemote(descriptor, record.recordId, record),
            descriptor,
          });
        }
        const local = await readLocal();
        const all = new Set([...local.keys(), ...remote.keys(), ...Object.keys(state.records), ...Object.keys(state.dirty)]);
        for (const key of [...all].sort()) {
          const item = local.get(key);
          const currentRemote = remote.get(key) || null;
          const known = state.records[key] || null;
          const descriptor = item?.descriptor || currentRemote?.descriptor
            || descriptorFor(known?.collection, known?.recordId);
          if (!descriptor) {
            delete state.records[key];
            delete state.dirty[key];
            continue;
          }
          const recordId = item?.recordId || currentRemote?.recordId || known?.recordId;
          const localValue = localPayload(descriptor, item?.value);
          if (!currentRemote) {
            if (localValue.deleted) forget(descriptor.adapter.collection, recordId);
            else await uploadOrResolve(descriptor, recordId, localValue, null, known);
            continue;
          }
          if (!known) {
            if (localValue.deleted) {
              await applyRemote(descriptor, recordId, currentRemote.value);
              remember(descriptor.adapter.collection, recordId, currentRemote, currentRemote.value);
            } else if (comparable(localValue) === comparable(currentRemote.value)) {
              remember(descriptor.adapter.collection, recordId, currentRemote, localValue);
            } else if (shouldPreferLocal(key, null, true, currentRemote)) {
              await uploadOrResolve(descriptor, recordId, localValue, currentRemote.revision, null);
            } else {
              await applyRemotePreservingLocal(descriptor, recordId, localValue, currentRemote, 'first-device-bootstrap');
            }
            continue;
          }
          const localChanged = known.fingerprint !== comparable(localValue);
          const remoteChanged = known.revision !== currentRemote.revision;
          if (!localChanged && !remoteChanged) {
            remember(descriptor.adapter.collection, recordId, currentRemote, localValue);
          } else if (localChanged && (!remoteChanged || shouldPreferLocal(key, known, true, currentRemote))) {
            await uploadOrResolve(descriptor, recordId, localValue, currentRemote.revision, known);
          } else if (remoteChanged) {
            await applyRemotePreservingLocal(descriptor, recordId, localValue, currentRemote,
              localChanged ? 'remote-won-conflict' : 'remote-update');
          }
        }
        persistState();
        retryDelay = 1_000;
        lastError = '';
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Automatic sync is unavailable.';
        if (message !== lastError) {
          lastError = message;
          console.warn(`Automatic sync for ${options.appId} is deferred: ${message}`);
        }
        schedule(retryDelay);
        retryDelay = Math.min(retryDelay * 2, MAX_RETRY_MS);
        return false;
      } finally {
        running = false;
        if (queued) {
          queued = false;
          schedule(0);
        }
      }
    }

    const handles = {};
    for (const descriptor of descriptors) {
      const recordIdFor = (args) => descriptor.fixed ? descriptor.adapter.recordId : args[0];
      const save = (...args) => {
        markDirty(descriptor, recordIdFor(args));
        schedule();
        return Promise.resolve();
      };
      handles[descriptor.name] = descriptor.fixed ? { save } : { save, remove: save };
    }
    options.storage.attachHandles(handles);

    const onFocus = () => schedule(0);
    const onOnline = () => schedule(0);
    const onVisibility = () => { if (document.visibilityState === 'visible') schedule(0); };
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisibility);
    const interval = window.setInterval(() => schedule(0), POLL_MS);
    schedule(INITIAL_DELAY_MS);

    return Object.freeze({
      sync,
      stop() {
        stopped = true;
        if (timer !== null) window.clearTimeout(timer);
        window.clearInterval(interval);
        window.removeEventListener('focus', onFocus);
        window.removeEventListener('online', onOnline);
        document.removeEventListener('visibilitychange', onVisibility);
      },
    });
  }

  window.AutomaticAppSync = Object.freeze({ install });
})();
