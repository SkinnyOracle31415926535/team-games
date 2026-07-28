(() => {
  'use strict';

  const migrationGate = (preview) => {
    if (!preview || !Number.isInteger(preview.writesPerformed) ||
        !Number.isInteger(preview.remoteCount) ||
        !Number.isInteger(preview.orphanedCount) ||
        preview.writesPerformed < 0 || preview.remoteCount < 0 ||
        preview.orphanedCount < 0) {
      return {
        safe: false,
        message: 'Migration is blocked because the preview counts are invalid.',
      };
    }
    if (preview.writesPerformed !== 0) {
      return {
        safe: false,
        message: 'Migration is blocked because the preview performed writes.',
      };
    }
    if (preview.remoteCount > 0) {
      return {
        safe: false,
        message: `Migration is blocked because ${preview.remoteCount} synchronized remote record` +
          `${preview.remoteCount === 1 ? '' : 's'} already exist.`,
      };
    }
    if (preview.orphanedCount > 0) {
      return {
        safe: false,
        message: `Migration is blocked because ${preview.orphanedCount} orphaned local sync intent` +
          `${preview.orphanedCount === 1 ? '' : 's'} need review.`,
      };
    }
    return {
      safe: true,
      message: 'Preview confirmed: 0 writes, 0 remote records, and 0 orphaned intents.',
    };
  };

  const requireSafeMigration = (preview) => {
    const gate = migrationGate(preview);
    if (!gate.safe) throw new Error(gate.message);
    return true;
  };

  window.TeamGamesSyncPolicy = Object.freeze({ migrationGate, requireSafeMigration });

  const store = window.TeamGamesStorage;
  const titlebar = document.querySelector('.titlebar');
  if (!document.body || !titlebar || !store) return;

  const openButton = document.createElement('button');
  openButton.type = 'button';
  openButton.className = 'team-games-sync-open';
  openButton.dataset.teamGamesSyncOpen = '';
  openButton.dataset.state = 'disconnected';
  openButton.textContent = 'sync & backup';
  openButton.setAttribute('aria-label', 'Open Team Games sync and backup');
  titlebar.append(openButton);

  const dialog = document.createElement('dialog');
  dialog.className = 'team-games-sync-dialog';
  dialog.setAttribute('aria-labelledby', 'team-games-sync-title');
  dialog.innerHTML = `
    <div class="team-games-sync-window">
      <div class="team-games-sync-heading">
        <div>
          <p class="team-games-sync-kicker">RYAN-ONLY APP SYNC</p>
          <h2 id="team-games-sync-title">sync &amp; backup</h2>
        </div>
        <button type="button" class="team-games-sync-close" data-team-games-sync-close
          aria-label="Close sync and backup window">×</button>
      </div>
      <p class="team-games-sync-copy">
        The selected class and each class’s Team Games scores, attendance choices,
        weekly history, tallies, ratings, and timer settings can sync between Ryan’s browsers.
      </p>
      <p class="team-games-sync-safety">
        The shared class-roster cache and roster-service response data are never central
        records and are also excluded from this backup. The exact backup contains only
        Team Games’ game-state value and selected-class value.
      </p>
      <p class="team-games-sync-roster-note">
        Class rosters remain a separate authenticated connection through the roster service.
        Student names already used inside Team Games remain part of their class game-state record.
      </p>
      <div class="team-games-sync-state" data-team-games-sync-state data-state="disconnected">
        <strong data-team-games-sync-state-label>Disconnected</strong>
        <span data-team-games-sync-state-message>Team Games records stay on this device.</span>
      </div>
      <p class="team-games-sync-alert" data-team-games-sync-alert role="alert" hidden></p>
      <div class="team-games-sync-actions">
        <button type="button" class="is-primary" data-team-games-sync-connect data-sync-action>
          connect as Ryan
        </button>
        <button type="button" data-team-games-sync-now data-sync-action>sync now</button>
        <button type="button" data-team-games-sync-backup data-sync-action>
          download exact local backup
        </button>
        <button type="button" data-team-games-sync-preview data-sync-action>
          create backup &amp; preview
        </button>
        <button type="button" data-team-games-sync-disconnect data-sync-action>disconnect</button>
        <button type="button" data-team-games-sync-reset data-sync-action>
          reset device connection
        </button>
      </div>
      <section class="team-games-sync-review" data-team-games-sync-review hidden
        aria-labelledby="team-games-sync-review-title">
        <h3 id="team-games-sync-review-title">migration preview</h3>
        <p data-team-games-sync-counts></p>
        <p class="team-games-sync-zero-write" data-team-games-sync-zero-write></p>
        <div class="team-games-sync-records" data-team-games-sync-records></div>
        <button type="button" class="is-primary" data-team-games-sync-apply
          data-sync-action disabled>apply reviewed migration</button>
      </section>
      <section class="team-games-sync-conflicts" data-team-games-sync-conflicts hidden
        aria-labelledby="team-games-sync-conflicts-title">
        <h3 id="team-games-sync-conflicts-title">sync conflicts</h3>
        <p>Choose each result deliberately. No choice is made automatically.</p>
        <div class="team-games-sync-conflict-list" data-team-games-sync-conflict-list></div>
      </section>
      <p class="team-games-sync-footnote">
        Resetting this connection never deletes local Team Games values or shared rosters.
      </p>
    </div>
  `;
  document.body.append(dialog);

  const closeButton = dialog.querySelector('[data-team-games-sync-close]');
  const connectButton = dialog.querySelector('[data-team-games-sync-connect]');
  const syncButton = dialog.querySelector('[data-team-games-sync-now]');
  const backupButton = dialog.querySelector('[data-team-games-sync-backup]');
  const previewButton = dialog.querySelector('[data-team-games-sync-preview]');
  const disconnectButton = dialog.querySelector('[data-team-games-sync-disconnect]');
  const resetButton = dialog.querySelector('[data-team-games-sync-reset]');
  const applyButton = dialog.querySelector('[data-team-games-sync-apply]');
  const stateBox = dialog.querySelector('[data-team-games-sync-state]');
  const stateLabel = dialog.querySelector('[data-team-games-sync-state-label]');
  const stateMessage = dialog.querySelector('[data-team-games-sync-state-message]');
  const alert = dialog.querySelector('[data-team-games-sync-alert]');
  const review = dialog.querySelector('[data-team-games-sync-review]');
  const counts = dialog.querySelector('[data-team-games-sync-counts]');
  const zeroWrite = dialog.querySelector('[data-team-games-sync-zero-write]');
  const records = dialog.querySelector('[data-team-games-sync-records]');
  const conflicts = dialog.querySelector('[data-team-games-sync-conflicts]');
  const conflictList = dialog.querySelector('[data-team-games-sync-conflict-list]');
  const actionButtons = Array.from(dialog.querySelectorAll('[data-sync-action]'));

  let client = null;
  let previewResult = null;
  let busy = false;
  let initialized = false;
  let restoreFocus = null;

  const stateLabels = {
    disconnected: 'disconnected',
    review: 'migration review required',
    syncing: 'syncing',
    synced: 'synced',
    offline: 'offline',
    conflict: 'conflict needs review',
  };

  const buttonLabels = {
    disconnected: 'sync & backup',
    review: 'review sync',
    syncing: 'syncing…',
    synced: 'synced',
    offline: 'offline backup',
    conflict: 'resolve sync',
  };

  const showAlert = (message = '') => {
    alert.hidden = !message;
    alert.textContent = message;
  };

  const showStorageWarning = (message = '') => {
    const current = document.querySelector('[data-team-games-storage-warning]');
    if (!message) {
      current?.remove();
      return;
    }
    const warning = current || document.createElement('p');
    warning.className = 'team-games-storage-warning';
    warning.dataset.teamGamesStorageWarning = '';
    warning.setAttribute('role', 'alert');
    warning.textContent = `${message} Download the exact local backup before changing this data.`;
    if (!current) titlebar.after(warning);
    showAlert(message);
  };

  window.TeamGamesSync = Object.freeze({
    showStorageWarning,
    rawBackup: () => store.rawBackup(),
  });

  const setBusy = (next) => {
    busy = next;
    dialog.setAttribute('aria-busy', String(next));
    actionButtons.forEach((button) => {
      button.disabled = next || (button === applyButton && !previewResult);
    });
    if (!next) {
      applyButton.disabled = !previewResult ||
        !migrationGate(previewResult.preview).safe;
    }
  };

  const downloadJson = (payload, filename) => {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const downloadRawBackup = () => {
    const today = new Date().toISOString().slice(0, 10);
    downloadJson(
      store.rawBackup(),
      `team-games-browser-local-raw-backup-${today}.json`,
    );
  };

  const invalidatePreview = () => {
    previewResult = null;
    review.hidden = true;
    records.replaceChildren();
    applyButton.disabled = true;
  };

  const makeReviewRow = (item) => {
    const row = document.createElement('div');
    row.className = 'team-games-sync-record';
    const identity = document.createElement('strong');
    identity.textContent = `${item.collection} · ${item.recordId}`;
    const status = document.createElement('span');
    status.textContent = String(item.status || '').replaceAll('-', ' ');
    row.append(identity, status);
    return row;
  };

  const renderPreview = (result) => {
    previewResult = result;
    review.hidden = false;
    counts.textContent =
      `${result.preview.localCount} local · ${result.preview.remoteCount} synchronized · ` +
      `${result.preview.conflictCount} conflict${result.preview.conflictCount === 1 ? '' : 's'} · ` +
      `${result.preview.orphanedCount} orphaned`;
    const gate = migrationGate(result.preview);
    zeroWrite.textContent = gate.message;
    zeroWrite.dataset.safe = String(gate.safe);
    records.replaceChildren(...result.preview.review.map(makeReviewRow));
    if (!result.preview.review.length) {
      const empty = document.createElement('p');
      empty.textContent = 'No registered local or synchronized records were found.';
      records.append(empty);
    }
    applyButton.disabled = busy || !gate.safe;
  };

  const conflictRecordLabel = (item) => {
    const parts = String(item.recordKey || '').split('\u001f');
    return parts.length === 4 ? `${parts[2]} · ${parts[3]}` : 'Team Games record';
  };

  const resolveConflict = async (item, strategy) => {
    if (!client) return;
    setBusy(true);
    showAlert('');
    try {
      await client.resolveConflict(item.recordKey, {
        strategy,
        expectedRemoteRevision: Number.isSafeInteger(item.current?.revision)
          ? item.current.revision
          : 0,
      });
      await renderConflicts();
    } catch (error) {
      showAlert(error.message || 'That conflict could not be resolved. Local data was preserved.');
    } finally {
      setBusy(false);
    }
  };

  const makeConflictRow = (item) => {
    const row = document.createElement('div');
    row.className = 'team-games-sync-conflict';
    const identity = document.createElement('strong');
    identity.textContent = conflictRecordLabel(item);
    const reason = document.createElement('span');
    reason.textContent = `Reason: ${String(item.reason || 'record conflict').replaceAll('-', ' ')}`;
    const actions = document.createElement('div');
    actions.className = 'team-games-sync-conflict-actions';
    const localButton = document.createElement('button');
    localButton.type = 'button';
    localButton.textContent = 'keep this device';
    localButton.addEventListener('click', () => void resolveConflict(item, 'keep-local'));
    const remoteButton = document.createElement('button');
    remoteButton.type = 'button';
    remoteButton.textContent = 'use synchronized record';
    remoteButton.addEventListener('click', () => void resolveConflict(item, 'accept-remote'));
    actions.append(localButton, remoteButton);
    row.append(identity, reason, actions);
    return row;
  };

  const renderConflicts = async () => {
    if (!client) return;
    const items = await client.listConflicts();
    conflicts.hidden = items.length === 0;
    conflictList.replaceChildren(...items.map(makeConflictRow));
  };

  const renderState = (next) => {
    const mode = next?.mode || 'disconnected';
    openButton.dataset.state = mode;
    openButton.textContent = buttonLabels[mode] || 'sync & backup';
    stateBox.dataset.state = mode;
    stateLabel.textContent = stateLabels[mode] || mode;
    stateMessage.textContent = next?.message || 'Team Games records stay on this device.';
    if (mode === 'conflict') void renderConflicts();
    else if (mode !== 'offline') showAlert('');
  };

  const runAction = async (task) => {
    if (!initialized || busy) return;
    setBusy(true);
    showAlert('');
    try {
      await task();
    } catch (error) {
      showAlert(error.message || 'The action did not finish. Local data was preserved.');
    } finally {
      setBusy(false);
    }
  };

  openButton.addEventListener('click', () => {
    restoreFocus = document.activeElement;
    if (!dialog.open) dialog.showModal();
    showStorageWarning(store.getStorageWarning());
    void renderConflicts();
  });

  closeButton.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener('close', () => {
    if (restoreFocus && typeof restoreFocus.focus === 'function') restoreFocus.focus();
    restoreFocus = null;
  });

  connectButton.addEventListener('click', () => void runAction(() => client.connect()));
  syncButton.addEventListener('click', () => void runAction(() => client.sync()));
  backupButton.addEventListener('click', () => {
    try {
      downloadRawBackup();
      showAlert('');
    } catch (error) {
      showAlert(error.message || 'The exact local backup could not be created.');
    }
  });
  previewButton.addEventListener('click', () => void runAction(async () => {
    store.assertOwnedStorageValid();
    downloadRawBackup();
    const result = await client.previewMigration({ downloadBackup: true });
    renderPreview(result);
  }));
  applyButton.addEventListener('click', () => void runAction(async () => {
    if (!previewResult) throw new Error('Create a fresh migration preview first.');
    requireSafeMigration(previewResult.preview);
    await client.applyMigration(previewResult.plan, {});
    invalidatePreview();
  }));
  disconnectButton.addEventListener('click', () => void runAction(async () => {
    await client.disconnect();
    invalidatePreview();
  }));
  resetButton.addEventListener('click', () => void runAction(async () => {
    await client.resetDevice();
    invalidatePreview();
  }));

  const initialize = async () => {
    if (!window.RyanAppSync || typeof window.RyanAppSync.create !== 'function') {
      throw new Error('Ryan App Sync did not load. Team Games data remains local.');
    }
    client = window.RyanAppSync.create({
      appId: store.appId,
      manifestVersion: 1,
      serviceOrigin: 'https://ryan-app-sync.ryan-666-mp3.chatgpt.site',
    });
    client.onStateChange(renderState);
    const adapters = store.makeAdapters();
    const preferences = await client.register(adapters.preferences);
    const gameStates = await client.registerCollection(adapters.gameStates);
    store.attachHandles({ preferences, gameStates });
    await client.finalizeRegistration();
    initialized = true;
    setBusy(false);
    showStorageWarning(store.getStorageWarning());
  };

  setBusy(true);
  void initialize().catch((error) => {
    showAlert(error.message || 'App sync could not initialize. Team Games data remains local.');
    openButton.dataset.state = 'offline';
    openButton.textContent = 'offline backup';
    stateBox.dataset.state = 'offline';
    stateLabel.textContent = 'sync unavailable';
    stateMessage.textContent = 'Team Games records remain only on this device.';
    Array.from(dialog.querySelectorAll('[data-sync-action]'))
      .forEach((button) => { button.disabled = true; });
  });
})();
