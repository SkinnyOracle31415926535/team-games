/* Owner-only semantic record sync used during the private Sites migration. */
(() => {
  'use strict';

  const MAX_VALUE_BYTES = 900 * 1024;
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const exactKeys = (value, expected) => isObject(value)
    && Object.keys(value).length === expected.length
    && Object.keys(value).every((key) => expected.includes(key));
  const bytes = (value) => new TextEncoder().encode(value).byteLength;

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

  const identity = (collection, recordId) => `${collection}\u001f${recordId}`;
  const comparable = (value) => JSON.stringify(value);
  const supported = () => location.protocol === 'https:' && location.hostname.endsWith('.chatgpt.site');
  const storageKey = (appId) => `__ryan_semantic_sync_${appId}_v1`;

  function readState(appId) {
    try {
      const parsed = JSON.parse(localStorage.getItem(storageKey(appId)) || 'null');
      if (!isObject(parsed) || parsed.version !== 1 || typeof parsed.enabled !== 'boolean' || !isObject(parsed.records)) {
        return { version: 1, enabled: false, records: {} };
      }
      return { version: 1, enabled: parsed.enabled, records: parsed.records };
    } catch {
      return { version: 1, enabled: false, records: {} };
    }
  }

  function saveState(appId, state) {
    localStorage.setItem(storageKey(appId), JSON.stringify({ version: 1, enabled: Boolean(state.enabled), records: state.records }));
  }

  function download(value, name) {
    const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function makeUi(appName) {
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'ryan-semantic-sync-open';
    open.textContent = 'Private sync';
    open.setAttribute('aria-haspopup', 'dialog');
    const dialog = document.createElement('dialog');
    dialog.className = 'ryan-semantic-sync-dialog';
    dialog.innerHTML = `
      <section class="ryan-semantic-sync-card" aria-labelledby="ryan-semantic-sync-title">
        <header><div><small>OWNER-ONLY DEVICE SYNC</small><h2 id="ryan-semantic-sync-title">${appName}</h2></div><button type="button" data-close aria-label="Close private sync">×</button></header>
        <p>Syncs independent app records between approved devices. Same-record edits pause for review; neither version is overwritten automatically.</p>
        <p class="ryan-semantic-sync-status" data-status>Private sync is ready for this ChatGPT Site.</p>
        <div class="ryan-semantic-sync-actions"><button type="button" data-sync>Enable private sync &amp; sync now</button></div>
        <section data-conflicts hidden><h3>Records needing review</h3><div data-conflict-list></div></section>
      </section>`;
    const style = document.createElement('style');
    style.textContent = `
      .ryan-semantic-sync-open{position:fixed!important;left:12px!important;bottom:12px!important;z-index:2147482998!important;min-height:42px!important;padding:8px 12px!important;border:2px solid #102117!important;border-radius:7px!important;background:#d7f0b7!important;color:#102117!important;box-shadow:3px 3px 0 #102117!important;font:700 14px/1.15 Tahoma,Verdana,Arial,sans-serif!important;letter-spacing:.02em!important;cursor:pointer!important}.ryan-semantic-sync-open:focus-visible,.ryan-semantic-sync-dialog button:focus-visible{outline:3px solid #1677ff!important;outline-offset:2px!important}.ryan-semantic-sync-dialog{z-index:2147482999!important;width:min(700px,calc(100vw - 24px))!important;max-width:700px!important;max-height:calc(100vh - 24px)!important;margin:auto!important;padding:0!important;border:0!important;border-radius:12px!important;background:#f5f8ee!important;color:#102117!important;box-shadow:0 18px 60px rgba(0,0,0,.48)!important;font:16px/1.45 Tahoma,Verdana,Arial,sans-serif!important}.ryan-semantic-sync-dialog::backdrop{background:rgba(0,0,0,.62)!important}.ryan-semantic-sync-card{padding:18px!important}.ryan-semantic-sync-card header{display:flex!important;justify-content:space-between!important;gap:16px!important;align-items:flex-start!important;padding-bottom:12px!important;border-bottom:2px solid #a8be9a!important}.ryan-semantic-sync-card h2,.ryan-semantic-sync-card h3,.ryan-semantic-sync-card p{margin:0!important;color:#102117!important;text-align:left!important}.ryan-semantic-sync-card h2{font-size:24px!important}.ryan-semantic-sync-card h3{font-size:17px!important}.ryan-semantic-sync-card small{font-weight:700!important;letter-spacing:.09em!important}.ryan-semantic-sync-card button{display:inline-flex!important;align-items:center!important;justify-content:center!important;min-height:40px!important;padding:8px 11px!important;border:2px solid #102117!important;border-radius:6px!important;background:#d7f0b7!important;color:#102117!important;font:700 14px/1.2 Tahoma,Verdana,Arial,sans-serif!important;cursor:pointer!important}.ryan-semantic-sync-card header button{min-width:36px!important;font-size:24px!important}.ryan-semantic-sync-status,.ryan-semantic-sync-card section{margin-top:13px!important;padding:12px!important;border:1px solid #8ba377!important;border-radius:7px!important;background:#fff!important}.ryan-semantic-sync-actions{display:flex!important;flex-wrap:wrap!important;gap:9px!important;margin-top:15px!important}.ryan-semantic-conflict{display:grid!important;gap:7px!important;margin-top:10px!important;padding-top:10px!important;border-top:1px solid #cad8be!important}.ryan-semantic-conflict-actions{display:flex!important;flex-wrap:wrap!important;gap:6px!important}.ryan-semantic-conflict small{color:#34503c!important}@media(max-width:520px){.ryan-semantic-sync-open{left:8px!important;bottom:8px!important}.ryan-semantic-sync-card{padding:14px!important}}`;
    document.head.append(style);
    document.body.append(open, dialog);
    const status = dialog.querySelector('[data-status]');
    const sync = dialog.querySelector('[data-sync]');
    const conflicts = dialog.querySelector('[data-conflicts]');
    const list = dialog.querySelector('[data-conflict-list]');
    const show = () => typeof dialog.showModal === 'function' ? dialog.showModal() : dialog.setAttribute('open', '');
    const close = () => typeof dialog.close === 'function' ? dialog.close() : dialog.removeAttribute('open');
    open.addEventListener('click', show);
    dialog.querySelector('[data-close]').addEventListener('click', close);
    dialog.addEventListener('click', (event) => { if (event.target === dialog) close(); });
    return {
      setStatus(message) { status.textContent = message; },
      setEnabled(enabled) { sync.textContent = enabled ? 'Sync now' : 'Enable private sync & sync now'; },
      onSync(task) { sync.addEventListener('click', () => { void task(true); }); },
      renderConflicts(items) {
        list.replaceChildren();
        conflicts.hidden = items.length === 0;
        for (const item of items) {
          const row = document.createElement('div');
          row.className = 'ryan-semantic-conflict';
          const title = document.createElement('strong');
          title.textContent = `${item.collection} / ${item.recordId}`;
          const note = document.createElement('small');
          note.textContent = `This device and revision ${item.remote.revision} differ. Both versions remain available until you choose.`;
          const actions = document.createElement('div');
          actions.className = 'ryan-semantic-conflict-actions';
          const review = document.createElement('button');
          review.type = 'button'; review.textContent = 'Download both versions';
          review.addEventListener('click', () => { item.download(); review.textContent = 'Both versions downloaded'; review.disabled = true; });
          const local = document.createElement('button');
          local.type = 'button'; local.textContent = 'Keep this device';
          local.addEventListener('click', () => { item.download(); void item.resolve('local'); });
          const remote = document.createElement('button');
          remote.type = 'button'; remote.textContent = 'Use synchronized record';
          remote.addEventListener('click', () => { item.download(); void item.resolve('remote'); });
          actions.append(review, local, remote);
          row.append(title, note, actions);
          list.append(row);
        }
      },
    };
  }

  function install(options) {
    if (!isObject(options) || typeof options.appId !== 'string' || typeof options.appName !== 'string'
      || !options.storage || typeof options.storage.makeAdapters !== 'function'
      || typeof options.storage.attachHandles !== 'function') {
      throw new Error('Semantic private sync was not configured safely.');
    }
    const adapterMap = options.storage.makeAdapters();
    if (!isObject(adapterMap)) throw new Error('Semantic private sync adapters are unavailable.');
    const descriptors = Object.entries(adapterMap).map(([name, adapter]) => {
      if (!isObject(adapter) || typeof adapter.collection !== 'string' || typeof adapter.validate !== 'function') {
        throw new Error('A semantic sync adapter is invalid.');
      }
      const fixed = typeof adapter.recordId === 'string';
      if (fixed && (typeof adapter.readLocal !== 'function' || typeof adapter.applyRemote !== 'function')) {
        throw new Error('A fixed semantic sync adapter is incomplete.');
      }
      if (!fixed && (typeof adapter.listLocal !== 'function' || typeof adapter.applyRemote !== 'function')) {
        throw new Error('A list semantic sync adapter is incomplete.');
      }
      return { name, adapter, fixed, schemaVersion: adapter.schemaVersion || 1 };
    });
    const ui = makeUi(options.appName);
    let state = readState(options.appId);
    let running = false;
    let queued = false;

    const descriptorFor = (collection, recordId) => descriptors.find(({ adapter, fixed }) =>
      adapter.collection === collection && (!fixed || adapter.recordId === recordId));
    const validPayload = (descriptor, recordId, payload) => exactKeys(payload, ['schemaVersion', 'deleted', 'data'])
      && payload.schemaVersion === descriptor.schemaVersion
      && typeof payload.deleted === 'boolean'
      && (payload.deleted ? payload.data === null : safeJson(payload.data)
        && bytes(JSON.stringify(payload.data)) <= MAX_VALUE_BYTES
        && descriptor.adapter.validate(payload.data, recordId));
    const localPayload = (descriptor, value) => ({
      schemaVersion: descriptor.schemaVersion,
      deleted: value === undefined,
      data: value === undefined ? null : value,
    });
    const remember = (collection, recordId, record, payload) => {
      state.records[identity(collection, recordId)] = {
        collection, recordId, revision: record.revision, fingerprint: comparable(payload),
      };
    };
    const forget = (collection, recordId) => { delete state.records[identity(collection, recordId)]; };

    async function responseJson(response) { try { return await response.json(); } catch { return null; } }
    async function upload(descriptor, recordId, payload, expectedRevision) {
      const response = await fetch('/api/app-sync', {
        method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: 1, appId: options.appId, collection: descriptor.adapter.collection, recordId, expectedRevision, value: payload }),
      });
      const body = await responseJson(response);
      if (response.ok && body?.record) return { ok: true, record: body.record };
      if (response.status === 409 && body?.current) return { ok: false, conflict: body.current };
      throw new Error(body?.error || 'Private sync could not save a record.');
    }
    async function applyRemote(descriptor, recordId, payload) {
      if (!validPayload(descriptor, recordId, payload)) throw new Error(`The synchronized ${descriptor.adapter.collection} record is invalid.`);
      if (descriptor.fixed) return descriptor.adapter.applyRemote(payload.data, { source: 'remote', deleted: payload.deleted });
      return descriptor.adapter.applyRemote(recordId, payload.data, { source: 'remote', deleted: payload.deleted });
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
            descriptor, collection: descriptor.adapter.collection, recordId: descriptor.adapter.recordId, value,
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
            descriptor, collection: descriptor.adapter.collection, recordId: item.recordId, value: item.value,
          });
        }
      }
      return records;
    }
    function conflictItem(descriptor, recordId, local, remote) {
      let saved = false;
      const bundle = () => ({
        version: 1, kind: 'ryan_semantic_sync_conflict', appId: options.appId,
        exportedAt: new Date().toISOString(), collection: descriptor.adapter.collection, recordId,
        local: local, remote: { revision: remote.revision, value: remote.value, updatedAt: remote.updatedAt || null },
      });
      return {
        collection: descriptor.adapter.collection, recordId, local, remote,
        download: () => { if (!saved) { download(bundle(), `${options.appId}-conflict-${recordId}-${new Date().toISOString().slice(0, 10)}.json`); saved = true; } },
        resolve: async (choice) => {
          try {
            if (choice === 'remote') {
              await applyRemote(descriptor, recordId, remote.value);
              remember(descriptor.adapter.collection, recordId, remote, remote.value);
            } else {
              const result = await upload(descriptor, recordId, local, remote.revision);
              if (!result.ok) throw new Error('That synchronized record changed again. Review it once more.');
              remember(descriptor.adapter.collection, recordId, result.record, local);
            }
            state.enabled = true; saveState(options.appId, state); await sync(false);
          } catch (error) { ui.setStatus(error instanceof Error ? error.message : 'Conflict resolution did not finish.'); }
        },
      };
    }

    async function sync(interactive = false) {
      if (!supported()) { ui.setStatus('Private sync is available in this app’s ChatGPT Site. Local data is preserved.'); return; }
      if (running) { queued = true; return; }
      running = true;
      ui.setStatus('Syncing independent records safely…');
      try {
        const response = await fetch(`/api/app-sync?appId=${encodeURIComponent(options.appId)}`, { cache: 'no-store', credentials: 'same-origin' });
        const manifest = await responseJson(response);
        if (!response.ok || !manifest || !Array.isArray(manifest.records)) throw new Error(manifest?.error || 'Private sync is unavailable. Local data is preserved.');
        const remote = new Map();
        for (const record of manifest.records) {
          if (!isObject(record) || typeof record.collection !== 'string' || typeof record.recordId !== 'string'
            || !Number.isSafeInteger(record.revision) || record.revision < 1) throw new Error('A synchronized record has an invalid revision.');
          const descriptor = descriptorFor(record.collection, record.recordId);
          if (!descriptor || !validPayload(descriptor, record.recordId, record.value)) throw new Error('A synchronized record has an unsupported schema.');
          remote.set(identity(record.collection, record.recordId), { ...record, descriptor });
        }
        const local = await readLocal();
        const all = new Set([...local.keys(), ...remote.keys(), ...Object.keys(state.records)]);
        const conflicts = [];
        let changed = 0;
        for (const key of [...all].sort()) {
          const item = local.get(key);
          const currentRemote = remote.get(key) || null;
          const known = state.records[key];
          const descriptor = item?.descriptor || currentRemote?.descriptor || descriptorFor(known?.collection, known?.recordId);
          if (!descriptor) { delete state.records[key]; continue; }
          const collection = descriptor.adapter.collection;
          const recordId = item?.recordId || currentRemote?.recordId || known.recordId;
          const localValue = localPayload(descriptor, item?.value);
          if (!currentRemote) {
            if (!localValue.deleted) {
              const result = await upload(descriptor, recordId, localValue, null);
              if (!result.ok) conflicts.push(conflictItem(descriptor, recordId, localValue, result.conflict));
              else { remember(collection, recordId, result.record, localValue); changed += 1; }
            } else forget(collection, recordId);
            continue;
          }
          const remoteValue = currentRemote.value;
          if (!known) {
            if (localValue.deleted) {
              await applyRemote(descriptor, recordId, remoteValue);
              remember(collection, recordId, currentRemote, remoteValue); changed += 1;
            } else if (comparable(localValue) === comparable(remoteValue)) {
              remember(collection, recordId, currentRemote, localValue);
            } else conflicts.push(conflictItem(descriptor, recordId, localValue, currentRemote));
            continue;
          }
          const localChanged = known.fingerprint !== comparable(localValue);
          const remoteChanged = known.revision !== currentRemote.revision;
          if (localChanged && remoteChanged && comparable(localValue) !== comparable(remoteValue)) {
            conflicts.push(conflictItem(descriptor, recordId, localValue, currentRemote));
          } else if (localChanged) {
            const result = await upload(descriptor, recordId, localValue, known.revision);
            if (!result.ok) conflicts.push(conflictItem(descriptor, recordId, localValue, result.conflict));
            else { remember(collection, recordId, result.record, localValue); changed += 1; }
          } else if (remoteChanged) {
            await applyRemote(descriptor, recordId, remoteValue);
            remember(collection, recordId, currentRemote, remoteValue); changed += 1;
          } else remember(collection, recordId, currentRemote, localValue);
        }
        state.enabled = true;
        saveState(options.appId, state);
        ui.setEnabled(true);
        ui.renderConflicts(conflicts);
        ui.setStatus(conflicts.length ? `${conflicts.length} record${conflicts.length === 1 ? '' : 's'} need your choice. Nothing was overwritten.` : changed ? `Synced ${changed} record${changed === 1 ? '' : 's'} safely.` : 'Synced. Every independent record is current.');
      } catch (error) {
        ui.setStatus(error instanceof Error ? error.message : 'Private sync did not finish. Local data is preserved.');
      } finally {
        running = false;
        if (queued) { queued = false; void sync(false); }
      }
    }

    const handles = {};
    for (const descriptor of descriptors) {
      handles[descriptor.name] = descriptor.fixed
        ? { save: () => state.enabled ? (void sync(false), Promise.resolve()) : Promise.resolve() }
        : {
          save: () => state.enabled ? (void sync(false), Promise.resolve()) : Promise.resolve(),
          remove: () => state.enabled ? (void sync(false), Promise.resolve()) : Promise.resolve(),
        };
    }
    options.storage.attachHandles(handles);
    ui.setEnabled(state.enabled);
    ui.onSync(sync);
    if (state.enabled && supported()) {
      void sync(false);
      window.setInterval(() => { void sync(false); }, 15_000);
      window.addEventListener('focus', () => { void sync(false); });
    }
    return Object.freeze({ sync });
  }

  window.SemanticAppSync = Object.freeze({ install });
})();
