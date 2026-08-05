/* Read-only recovery for browser-storage rows written by the private v3 release. */
(() => {
  'use strict';

  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const exactKeys = (value, expected) => isObject(value)
    && Object.keys(value).length === expected.length
    && Object.keys(value).every((key) => expected.includes(key));

  const filePart = (value) => value.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
  const datePart = () => new Date().toISOString().slice(0, 10);

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

  function validV3Value(value) {
    if (!exactKeys(value, ['present', 'encoding', 'value'])
      || typeof value.present !== 'boolean'
      || !['json', 'text'].includes(value.encoding)) return false;
    if (!value.present) return value.encoding === 'text' && value.value === null;
    return value.encoding === 'text' ? typeof value.value === 'string' : true;
  }

  async function responseJson(response) {
    try { return await response.json(); } catch { return null; }
  }

  function makeUi(appName) {
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'ryan-v3-recovery-open';
    open.textContent = 'Recover v3 backup';
    open.setAttribute('aria-haspopup', 'dialog');
    const dialog = document.createElement('dialog');
    dialog.className = 'ryan-v3-recovery-dialog';
    dialog.innerHTML = `
      <section class="ryan-v3-recovery-card" aria-labelledby="ryan-v3-recovery-title">
        <header><div><small>READ-ONLY V3 RECOVERY</small><h2 id="ryan-v3-recovery-title">${appName}</h2></div><button type="button" data-close aria-label="Close v3 recovery">×</button></header>
        <p>This looks only for the older private v3 browser-storage copy. It never changes this browser or current semantic sync records.</p>
        <div class="ryan-v3-recovery-actions"><button type="button" data-fetch>Download v3 recovery backup</button><button type="button" data-import disabled>Download validated import file</button></div>
        <p data-status>A recovery backup is separate from current data. If a validated import file is available, use Transfer data → Import Settings &amp; Data to preview it, download the automatic safety backup, and confirm replacement.</p>
      </section>`;
    const style = document.createElement('style');
    style.textContent = `
      .ryan-v3-recovery-open{position:fixed!important;left:12px!important;bottom:66px!important;z-index:2147482996!important;min-height:38px!important;padding:7px 10px!important;border:2px solid #102117!important;border-radius:7px!important;background:#fff!important;color:#102117!important;box-shadow:3px 3px 0 #102117!important;font:700 12px/1.15 Tahoma,Verdana,Arial,sans-serif!important;cursor:pointer!important}.ryan-v3-recovery-open:focus-visible,.ryan-v3-recovery-dialog button:focus-visible{outline:3px solid #1677ff!important;outline-offset:2px!important}.ryan-v3-recovery-dialog{z-index:2147482997!important;width:min(680px,calc(100vw - 24px))!important;max-width:680px!important;max-height:calc(100vh - 24px)!important;margin:auto!important;padding:0!important;border:0!important;border-radius:12px!important;background:#f5f8ee!important;color:#102117!important;box-shadow:0 18px 60px rgba(0,0,0,.48)!important;font:16px/1.45 Tahoma,Verdana,Arial,sans-serif!important}.ryan-v3-recovery-dialog::backdrop{background:rgba(0,0,0,.62)!important}.ryan-v3-recovery-card{padding:18px!important}.ryan-v3-recovery-card header{display:flex!important;justify-content:space-between!important;gap:16px!important;align-items:flex-start!important;padding-bottom:12px!important;border-bottom:2px solid #a8be9a!important}.ryan-v3-recovery-card h2,.ryan-v3-recovery-card p{margin:0!important;color:#102117!important;text-align:left!important}.ryan-v3-recovery-card h2{font-size:24px!important}.ryan-v3-recovery-card small{font-weight:700!important;letter-spacing:.09em!important}.ryan-v3-recovery-card button{display:inline-flex!important;align-items:center!important;justify-content:center!important;min-height:40px!important;padding:8px 11px!important;border:2px solid #102117!important;border-radius:6px!important;background:#d7f0b7!important;color:#102117!important;font:700 14px/1.2 Tahoma,Verdana,Arial,sans-serif!important;cursor:pointer!important}.ryan-v3-recovery-card button:disabled{opacity:.56!important;cursor:not-allowed!important}.ryan-v3-recovery-card header button{min-width:36px!important;font-size:24px!important}.ryan-v3-recovery-actions{display:flex!important;flex-wrap:wrap!important;gap:9px!important;margin:15px 0!important}.ryan-v3-recovery-card [data-status]{padding:12px!important;border:1px solid #8ba377!important;border-radius:7px!important;background:#fff!important}@media(max-width:520px){.ryan-v3-recovery-open{left:8px!important;bottom:60px!important}.ryan-v3-recovery-card{padding:14px!important}}`;
    document.head.append(style);
    document.body.append(open, dialog);
    const status = dialog.querySelector('[data-status]');
    const fetchButton = dialog.querySelector('[data-fetch]');
    const importButton = dialog.querySelector('[data-import]');
    const show = () => typeof dialog.showModal === 'function' ? dialog.showModal() : dialog.setAttribute('open', '');
    const close = () => typeof dialog.close === 'function' ? dialog.close() : dialog.removeAttribute('open');
    open.addEventListener('click', show);
    dialog.querySelector('[data-close]').addEventListener('click', close);
    dialog.addEventListener('click', (event) => { if (event.target === dialog) close(); });
    return { status, fetchButton, importButton };
  }

  function install(options) {
    if (!isObject(options) || typeof options.appId !== 'string' || typeof options.appName !== 'string'
      || !Array.isArray(options.storageKeys) || !options.storageKeys.length
      || options.storageKeys.some((key) => typeof key !== 'string' || !key)) {
      throw new Error('v3 recovery was not configured safely.');
    }
    const mount = () => {
      if (document.querySelector('.ryan-v3-recovery-open')) return;
      const ui = makeUi(options.appName);
      let importBundle = null;
      ui.fetchButton.addEventListener('click', async () => {
        ui.fetchButton.disabled = true;
        ui.importButton.disabled = true;
        importBundle = null;
        ui.status.textContent = 'Looking for the owner-only v3 recovery copy…';
        try {
          const response = await fetch(`/api/legacy-v3-browser-storage?appId=${encodeURIComponent(options.appId)}`, {
            cache: 'no-store', credentials: 'same-origin',
          });
          const payload = await responseJson(response);
          if (!response.ok || !payload || payload.version !== 1 || payload.kind !== 'ryan_v3_browser_storage_recovery'
            || payload.appId !== options.appId || !Array.isArray(payload.records)) {
            throw new Error(payload?.error || 'The v3 recovery copy is unavailable.');
          }
          const allowed = new Set(options.storageKeys);
          const records = payload.records.map((record) => {
            if (!isObject(record) || typeof record.recordId !== 'string' || !allowed.has(record.recordId)
              || !Number.isSafeInteger(record.revision) || record.revision < 1 || !validV3Value(record.value)) {
              throw new Error('The v3 recovery copy contains an unsupported record.');
            }
            return {
              record_id: record.recordId,
              revision: record.revision,
              updated_at: typeof record.updatedAt === 'string' ? record.updatedAt : null,
              value: record.value,
            };
          });
          const rawArchive = {
            version: 1,
            kind: 'ryan_v3_browser_storage_recovery_archive',
            app_id: options.appId,
            exported_at: new Date().toISOString(),
            records,
          };
          if (records.length) download(rawArchive, `${filePart(options.appId)}-v3-recovery-backup-${datePart()}.json`);
          const byId = new Map(records.map((record) => [record.record_id, record.value]));
          const candidate = {
            version: 1,
            kind: 'ryan_app_settings_data_transfer',
            app_id: options.appId,
            exported_at: new Date().toISOString(),
            source: 'v3-private-recovery',
            records: options.storageKeys.map((key) => ({ key, ...(byId.get(key) || { present: false, encoding: 'text', value: null }) })),
          };
          try {
            importBundle = window.TemporaryDataTransfer?.normalizeBundle?.(candidate, {
              appId: options.appId,
              storageKeys: options.storageKeys,
            }) || null;
          } catch {
            importBundle = null;
          }
          if (!records.length) {
            ui.status.textContent = 'No v3 browser-storage rows were found. Current local and semantic data were not changed.';
          } else if (importBundle) {
            ui.importButton.disabled = false;
            ui.status.textContent = `Downloaded a read-only v3 recovery backup with ${records.length} record${records.length === 1 ? '' : 's'}. Download the validated import file only if you want to use the normal preview, safety backup, and confirmation flow.`;
          } else {
            ui.status.textContent = `Downloaded a read-only v3 recovery backup with ${records.length} record${records.length === 1 ? '' : 's'}, but it cannot form a safe complete import. No local or semantic data changed.`;
          }
        } catch (error) {
          ui.status.textContent = error instanceof Error ? error.message : 'The v3 recovery backup could not be downloaded.';
        } finally {
          ui.fetchButton.disabled = false;
        }
      });
      ui.importButton.addEventListener('click', () => {
        if (!importBundle) return;
        download(importBundle, `${filePart(options.appId)}-v3-recovered-settings-data-${datePart()}.json`);
        ui.status.textContent = 'Validated import file downloaded. Open Transfer data, choose Import Settings & Data, select this file, review the preview, and confirm. That flow downloads a current-data safety backup before replacing anything.';
      });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
    else mount();
  }

  window.LegacyV3Recovery = Object.freeze({ install });
})();
