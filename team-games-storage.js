(() => {
  'use strict';

  const APP_ID = 'team-games';
  const SCHEMA_VERSION = 1;
  const LOCAL_STATE_VERSION = 2;
  const CHANGE_EVENT = 'team-games:persistent-state-change';
  const AGGREGATE_LOCK = 'team-games:central-state-v1';
  const STORAGE_KEYS = Object.freeze({
    state: 'camp-group-randomizer-v1',
    selectedClass: 'team-games-selected-class-v1',
  });
  const RAW_BACKUP_KEYS = Object.freeze([
    STORAGE_KEYS.state,
    STORAGE_KEYS.selectedClass,
  ]);
  const MAX_RECORD_BYTES = 128 * 1024;
  const MAX_LOCAL_STATE_BYTES = 8 * 1024 * 1024;
  const MAX_RAW_BACKUP_VALUE_BYTES = 16 * 1024 * 1024;
  const mutationState = {
    issuedGeneration: 0,
    pending: [],
    inFlightGeneration: 0,
    draining: false,
    editorActive: false,
    editorDirty: false,
    editorWaiters: new Set(),
  };
  let storageWarning = '';
  let seedState = null;
  let handles = null;

  const withAggregateLock = (task) => {
    const locks = window.navigator && window.navigator.locks;
    if (!locks || typeof locks.request !== 'function') {
      return Promise.reject(
        new Error('Shared browser locking is unavailable. Team Games data was not changed.')
      );
    }
    return locks.request(AGGREGATE_LOCK, { mode: 'exclusive' }, task);
  };

  const dataObjectDescriptors = (value) => {
    try {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) return null;
      const descriptors = Object.getOwnPropertyDescriptors(value);
      for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key !== 'string') return null;
        const descriptor = descriptors[key];
        if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
            descriptor.get || descriptor.set || !descriptor.enumerable) {
          return null;
        }
      }
      return descriptors;
    } catch (_error) {
      return null;
    }
  };

  const safeEntries = (value) => {
    const descriptors = dataObjectDescriptors(value);
    return descriptors
      ? Object.keys(descriptors).map((key) => [key, descriptors[key].value])
      : null;
  };

  const safeKeys = (value) => {
    const descriptors = dataObjectDescriptors(value);
    return descriptors ? Object.keys(descriptors) : null;
  };

  const plainObject = (value) => Boolean(dataObjectDescriptors(value));

  const exactKeys = (value, expected) => {
    const keys = safeKeys(value);
    return Boolean(keys &&
      keys.slice().sort().join('\u001f') === expected.slice().sort().join('\u001f'));
  };

  const allowedKeys = (value, required, optional = []) => {
    const keys = safeKeys(value);
    if (!keys || required.some((key) => !keys.includes(key))) return false;
    const allowed = new Set([...required, ...optional]);
    return keys.every((key) => allowed.has(key));
  };

  const safeArrayValues = (value, maximum) => {
    try {
      if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
          value.length > maximum) {
        return null;
      }
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const ownKeys = Reflect.ownKeys(descriptors);
      if (ownKeys.some((key) => typeof key !== 'string') ||
          ownKeys.length !== value.length + 1 ||
          !descriptors.length || descriptors.length.value !== value.length) {
        return null;
      }
      const result = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
            descriptor.get || descriptor.set || !descriptor.enumerable) {
          return null;
        }
        result.push(descriptor.value);
      }
      return result;
    } catch (_error) {
      return null;
    }
  };

  const jsonBytes = (value) => {
    try {
      return new TextEncoder().encode(JSON.stringify(value)).byteLength;
    } catch (_error) {
      return Number.POSITIVE_INFINITY;
    }
  };

  const rawBytes = (value) => {
    try {
      return new TextEncoder().encode(value).byteLength;
    } catch (_error) {
      return Number.POSITIVE_INFINITY;
    }
  };

  const cloneJson = (value) => JSON.parse(JSON.stringify(value));

  const validText = (value, maximum, { allowEmpty = false } = {}) =>
    typeof value === 'string' && value.length <= maximum &&
    value === value.trim() && (allowEmpty || value.length > 0) &&
    !/[\u0000-\u001f\u007f]/.test(value);

  const validClassKey = (value, { allowEmpty = false } = {}) => {
    if (allowEmpty && value === '') return true;
    if (!validText(value, 240)) return false;
    if (value === 'legacy') return true;
    if (/^builtin:[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) return true;
    if (!value.startsWith('custom:')) return false;
    return validText(value.slice('custom:'.length), 200);
  };

  const validInteger = (value, minimum = 0, maximum = 1000000) =>
    Number.isSafeInteger(value) && value >= minimum && value <= maximum;

  const validRating = (value) =>
    value === null || (Number.isInteger(value) && value >= 1 && value <= 5);

  const validTimestamp = (value) =>
    validText(value, 64, { allowEmpty: true }) &&
    (value === '' || !Number.isNaN(Date.parse(value)));

  const uniqueStrings = (value, maximum, validator) => {
    const items = safeArrayValues(value, maximum);
    if (!items || items.some((item) => !validator(item))) return false;
    return new Set(items).size === items.length;
  };

  const validateStudent = (candidate) => {
    if (!exactKeys(candidate, ['id', 'name', 'rating', 'wins', 'active'])) return false;
    const value = Object.fromEntries(safeEntries(candidate));
    return validText(value.id, 300) && validText(value.name, 200) &&
      validRating(value.rating) && validInteger(value.wins) &&
      typeof value.active === 'boolean';
  };

  const validateStudentArray = (candidate, maximum = 500) => {
    const values = safeArrayValues(candidate, maximum);
    if (!values || values.some((student) => !validateStudent(student))) return false;
    const ids = values.map((student) => Object.fromEntries(safeEntries(student)).id);
    return new Set(ids).size === ids.length;
  };

  const validateSnapshotMember = (candidate) => {
    if (!exactKeys(candidate, ['id', 'name', 'rating'])) return false;
    const value = Object.fromEntries(safeEntries(candidate));
    return validText(value.id, 300) && validText(value.name, 200) &&
      validRating(value.rating);
  };

  const validateGroupSnapshot = (candidate) => {
    const groups = safeArrayValues(candidate, 12);
    if (!groups) return false;
    const ids = [];
    for (const group of groups) {
      if (!exactKeys(group, ['members'])) return false;
      const members = safeArrayValues(Object.fromEntries(safeEntries(group)).members, 500);
      if (!members || members.some((member) => !validateSnapshotMember(member))) return false;
      ids.push(...members.map((member) => Object.fromEntries(safeEntries(member)).id));
    }
    return ids.length <= 500 && new Set(ids).size === ids.length;
  };

  const validateTimerSnapshot = (candidate) => {
    if (!exactKeys(candidate, ['duration', 'remaining'])) return false;
    const value = Object.fromEntries(safeEntries(candidate));
    return validInteger(value.duration, 0, 600) &&
      validInteger(value.remaining, 0, 600);
  };

  const validateWinEntry = (candidate) => {
    const required = [
      'groupName',
      'memberIds',
      'memberNames',
      'groupSnapshot',
      'groupTallies',
      'timerSnapshot',
      'recordedAt',
    ];
    if (!allowedKeys(candidate, required, ['redoneAt', 'gameTally'])) return false;
    const value = Object.fromEntries(safeEntries(candidate));
    const tallies = safeArrayValues(value.groupTallies, 12);
    return validText(value.groupName, 80) &&
      uniqueStrings(value.memberIds, 500, (item) => validText(item, 300)) &&
      uniqueStrings(value.memberNames, 500, (item) => validText(item, 200)) &&
      validateGroupSnapshot(value.groupSnapshot) &&
      Boolean(tallies && tallies.every((score) => validInteger(score))) &&
      validateTimerSnapshot(value.timerSnapshot) &&
      validTimestamp(value.recordedAt) &&
      (!Object.prototype.hasOwnProperty.call(value, 'redoneAt') ||
        validTimestamp(value.redoneAt)) &&
      (!Object.prototype.hasOwnProperty.call(value, 'gameTally') ||
        validInteger(value.gameTally));
  };

  const validateWinHistory = (candidate) => {
    const values = safeArrayValues(candidate, 1000);
    return Boolean(values && values.every(validateWinEntry));
  };

  const validateArchiveRanking = (candidate) => {
    const values = safeArrayValues(candidate, 500);
    if (!values) return false;
    const names = [];
    for (const candidateEntry of values) {
      if (!exactKeys(candidateEntry, ['name', 'wins'])) return false;
      const entry = Object.fromEntries(safeEntries(candidateEntry));
      if (!validText(entry.name, 200) || !validInteger(entry.wins)) return false;
      names.push(entry.name.toLocaleLowerCase());
    }
    return new Set(names).size === names.length;
  };

  const validateWeekArchiveEntry = (candidate) => {
    if (!exactKeys(candidate, [
      'id',
      'weekNumber',
      'endedAt',
      'totalGames',
      'winners',
      'ranking',
    ])) {
      return false;
    }
    const value = Object.fromEntries(safeEntries(candidate));
    return validText(value.id, 300) && validInteger(value.weekNumber, 1) &&
      validTimestamp(value.endedAt) && validInteger(value.totalGames) &&
      uniqueStrings(value.winners, 500, (name) => validText(name, 200)) &&
      validateArchiveRanking(value.ranking);
  };

  const validateGameState = (candidate) => {
    if (!exactKeys(candidate, [
      'students',
      'archivedStudents',
      'groupCount',
      'winHistory',
      'redoWinHistory',
      'weekArchive',
      'groupTallies',
      'timerDuration',
      'timerRemaining',
    ])) {
      return false;
    }
    const value = Object.fromEntries(safeEntries(candidate));
    const active = safeArrayValues(value.students, 500);
    const archived = safeArrayValues(value.archivedStudents, 500);
    const weeks = safeArrayValues(value.weekArchive, 250);
    const tallies = safeArrayValues(value.groupTallies, 12);
    if (!active || !archived || !weeks || !tallies ||
        !validateStudentArray(value.students) ||
        !validateStudentArray(value.archivedStudents) ||
        !/^(?:[2-9]|1[0-2])$/.test(value.groupCount) ||
        !validateWinHistory(value.winHistory) ||
        !validateWinHistory(value.redoWinHistory) ||
        !weeks.every(validateWeekArchiveEntry) ||
        !tallies.every((score) => validInteger(score)) ||
        !validInteger(value.timerDuration, 0, 600) ||
        !validInteger(value.timerRemaining, 0, 600)) {
      return false;
    }
    const allIds = [...active, ...archived]
      .map((student) => Object.fromEntries(safeEntries(student)).id);
    return new Set(allIds).size === allIds.length;
  };

  const validatePreferences = (candidate) => {
    if (!exactKeys(candidate, ['version', 'selectedClassKey']) ||
        jsonBytes(candidate) > MAX_RECORD_BYTES) {
      return false;
    }
    const value = Object.fromEntries(safeEntries(candidate));
    return value.version === SCHEMA_VERSION &&
      validClassKey(value.selectedClassKey, { allowEmpty: true });
  };

  const validateGameRecord = (
    candidate,
    recordId = `game-${'0'.repeat(64)}`,
  ) => {
    if (!/^game-[a-f0-9]{64}$/.test(recordId || '') ||
        !exactKeys(candidate, ['version', 'classKey', 'state'])) {
      return false;
    }
    const value = Object.fromEntries(safeEntries(candidate));
    return value.version === SCHEMA_VERSION &&
      validClassKey(value.classKey) && validateGameState(value.state) &&
      jsonBytes(candidate) <= MAX_RECORD_BYTES;
  };

  const validateState = (candidate) => {
    if (!exactKeys(candidate, ['version', 'selectedClassKey', 'gameStates'])) {
      return false;
    }
    const value = Object.fromEntries(safeEntries(candidate));
    const entries = safeEntries(value.gameStates);
    if (value.version !== LOCAL_STATE_VERSION ||
        !validClassKey(value.selectedClassKey, { allowEmpty: true }) ||
        !entries || entries.length > 200) {
      return false;
    }
    return entries.every(([classKey, gameState]) =>
      validClassKey(classKey) &&
      validateGameRecord({
        version: SCHEMA_VERSION,
        classKey,
        state: gameState,
      })) && jsonBytes(candidate) <= MAX_LOCAL_STATE_BYTES;
  };

  const canonicalState = (candidate) => cloneJson(candidate);
  const canonicalPreferences = (candidate) => cloneJson(candidate);
  const canonicalGameRecord = (candidate) => cloneJson(candidate);

  const sha256 = async (value) => {
    if (!window.crypto || !window.crypto.subtle) {
      throw new Error('Secure hashing is required to synchronize Team Games records.');
    }
    const digest = await window.crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(value),
    );
    return Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, '0')).join('');
  };

  const gameRecordId = async (classKey) => {
    if (!validClassKey(classKey)) throw new Error('The Team Games class key is invalid.');
    return `game-${await sha256(classKey)}`;
  };

  const identifyGames = async (gameStates) => {
    const entries = safeEntries(gameStates);
    if (!entries) throw new Error('The Team Games class states are invalid.');
    const records = await Promise.all(entries.map(async ([classKey, state]) => {
      const recordId = await gameRecordId(classKey);
      const value = {
        version: SCHEMA_VERSION,
        classKey,
        state: cloneJson(state),
      };
      if (!validateGameRecord(value, recordId)) {
        throw new Error(`The saved Team Games state for ${classKey} is invalid.`);
      }
      return { sourceId: classKey, recordId, value };
    }));
    if (new Set(records.map(({ recordId }) => recordId)).size !== records.length) {
      throw new Error('Local Team Games class identities collide and need review.');
    }
    return records;
  };

  const captureRaw = () => RAW_BACKUP_KEYS.map((key) => ({
    key,
    raw: window.localStorage.getItem(key),
  }));

  const assertRawUnchanged = (snapshot, label) => {
    if (snapshot.some(({ key, raw }) => window.localStorage.getItem(key) !== raw)) {
      throw new Error(`${label} changed during an atomic update. The newer local value was preserved.`);
    }
  };

  const restoreAppliedChanges = (snapshot, changes) => {
    const originalByKey = new Map(snapshot.map(({ key, raw }) => [key, raw]));
    for (const { key, raw } of changes) {
      if (window.localStorage.getItem(key) !== raw) continue;
      const original = originalByKey.get(key);
      if (original === null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, original);
    }
  };

  const compareAndSet = (snapshot, changes, label) => {
    assertRawUnchanged(snapshot, label);
    try {
      for (const { key, raw } of changes) {
        if (raw === null) window.localStorage.removeItem(key);
        else window.localStorage.setItem(key, raw);
      }
      for (const { key, raw } of changes) {
        if (window.localStorage.getItem(key) !== raw) {
          throw new Error(`${label} could not be verified after writing.`);
        }
      }
    } catch (error) {
      restoreAppliedChanges(snapshot, changes);
      throw error;
    }
  };

  const parseSelectedRaw = (raw) => {
    if (raw === null) return undefined;
    if (!validClassKey(raw, { allowEmpty: true })) {
      throw new Error(
        'The selected Team Games class needs an exact raw backup and review.'
      );
    }
    return raw;
  };

  const readStateFromSnapshot = (snapshot) => {
    const byKey = new Map(snapshot.map(({ key, raw }) => [key, raw]));
    const rawState = byKey.get(STORAGE_KEYS.state);
    const selectedOverride = parseSelectedRaw(byKey.get(STORAGE_KEYS.selectedClass));
    if (rawState === null) {
      if (selectedOverride === undefined) return undefined;
      return {
        version: LOCAL_STATE_VERSION,
        selectedClassKey: selectedOverride,
        gameStates: {},
      };
    }
    if (rawBytes(rawState) > MAX_LOCAL_STATE_BYTES) {
      throw new Error('Team Games data is too large and needs an exact raw backup and review.');
    }
    let parsed;
    try {
      parsed = JSON.parse(rawState);
    } catch (_error) {
      throw new Error('Team Games data needs an exact raw backup and review.');
    }
    if (validateState(parsed)) {
      const current = canonicalState(parsed);
      if (selectedOverride !== undefined) current.selectedClassKey = selectedOverride;
      return current;
    }
    if (validateGameState(parsed)) {
      return {
        version: LOCAL_STATE_VERSION,
        selectedClassKey: selectedOverride === undefined ? 'legacy' : selectedOverride,
        gameStates: { legacy: cloneJson(parsed) },
      };
    }
    throw new Error('Team Games data needs an exact raw backup and review.');
  };

  const readStateUnlocked = () => readStateFromSnapshot(captureRaw());

  const baseStateForWrite = (snapshot) => {
    const current = readStateFromSnapshot(snapshot);
    if (current) return current;
    if (!seedState || !validateState(seedState)) {
      throw new Error('Team Games defaults are unavailable. Local data was not changed.');
    }
    return canonicalState(seedState);
  };

  const dispatchChange = (collection, source, classKey = '') => {
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, {
      detail: { collection, source, classKey },
    }));
  };

  const localWorkPending = () =>
    Boolean(mutationState.pending.length || mutationState.inFlightGeneration);

  const assertConsistentRead = () => {
    if (localWorkPending() || mutationState.editorActive || mutationState.editorDirty) {
      throw new Error(
        'Local Team Games actions must settle before synchronization can read them.'
      );
    }
  };

  const wakeEditorWaiters = () => {
    if (mutationState.editorActive || mutationState.editorDirty) return;
    for (const resolve of mutationState.editorWaiters) resolve();
    mutationState.editorWaiters.clear();
  };

  const waitForEditorIdle = () => {
    if (!mutationState.editorActive && !mutationState.editorDirty) return Promise.resolve();
    return new Promise((resolve) => mutationState.editorWaiters.add(resolve));
  };

  const assertRemoteWritable = (generation) => {
    if (mutationState.issuedGeneration !== generation || localWorkPending() ||
        mutationState.editorActive || mutationState.editorDirty) {
      throw new Error(
        'Remote Team Games data was not applied because a newer local action needs review.'
      );
    }
  };

  const withConsistentRead = (task) => withAggregateLock(() => {
    assertConsistentRead();
    return task();
  });

  const withRemoteWrite = async (task) => {
    const generation = mutationState.issuedGeneration;
    if (localWorkPending()) {
      throw new Error('Remote Team Games data was not applied because local work is pending.');
    }
    await waitForEditorIdle();
    assertRemoteWritable(generation);
    return withAggregateLock(async () => {
      assertRemoteWritable(generation);
      return task(() => assertRemoteWritable(generation));
    });
  };

  const enqueueLatest = (perform) => {
    const generation = ++mutationState.issuedGeneration;
    const promise = new Promise((resolve, reject) => {
      const pending = mutationState.pending[0];
      if (!pending) {
        mutationState.pending.push({
          generation,
          perform,
          waiters: [{ resolve, reject }],
        });
      } else {
        pending.generation = generation;
        pending.perform = perform;
        pending.waiters.push({ resolve, reject });
      }
    });
    if (!mutationState.draining) {
      mutationState.draining = true;
      Promise.resolve().then(async () => {
        try {
          while (mutationState.pending.length) {
            const job = mutationState.pending.shift();
            mutationState.inFlightGeneration = job.generation;
            try {
              const result = await job.perform(job.generation);
              job.waiters.forEach(({ resolve }) => resolve(result));
            } catch (error) {
              job.waiters.forEach(({ reject }) => reject(error));
            } finally {
              mutationState.inFlightGeneration = 0;
            }
          }
        } finally {
          mutationState.draining = false;
        }
      });
    }
    return promise;
  };

  const setEditorState = (update) => {
    if (!plainObject(update)) throw new Error('The Team Games editor state is invalid.');
    const value = Object.fromEntries(safeEntries(update));
    if (Object.prototype.hasOwnProperty.call(value, 'active')) {
      if (typeof value.active !== 'boolean') {
        throw new Error('The Team Games editor state is invalid.');
      }
      mutationState.editorActive = value.active;
    }
    if (Object.prototype.hasOwnProperty.call(value, 'dirty')) {
      if (typeof value.dirty !== 'boolean') {
        throw new Error('The Team Games editor state is invalid.');
      }
      mutationState.editorDirty = value.dirty;
    }
    wakeEditorWaiters();
  };

  const writeFullStateUnlocked = (
    candidate,
    source,
    assertCurrent = () => {},
    collection = 'state',
    classKey = '',
  ) => {
    if (!validateState(candidate)) throw new Error('The Team Games app state is invalid.');
    const value = canonicalState(candidate);
    const snapshot = captureRaw();
    const previous = readStateFromSnapshot(snapshot);
    assertCurrent();
    compareAndSet(snapshot, [
      { key: STORAGE_KEYS.state, raw: JSON.stringify(value) },
      { key: STORAGE_KEYS.selectedClass, raw: value.selectedClassKey },
    ], 'Team Games app data');
    storageWarning = '';
    dispatchChange(collection, source, classKey);
    return previous;
  };

  const applyPreferencesUnlocked = (candidate, source, assertCurrent = () => {}) => {
    if (!validatePreferences(candidate)) {
      throw new Error('The synchronized Team Games preferences are invalid.');
    }
    const value = canonicalPreferences(candidate);
    const snapshot = captureRaw();
    const current = baseStateForWrite(snapshot);
    current.selectedClassKey = value.selectedClassKey;
    assertCurrent();
    compareAndSet(snapshot, [
      { key: STORAGE_KEYS.state, raw: JSON.stringify(current) },
      { key: STORAGE_KEYS.selectedClass, raw: current.selectedClassKey },
    ], 'Team Games selected class');
    storageWarning = '';
    dispatchChange('preferences', source);
    return true;
  };

  const listGamesUnlocked = async () => {
    const snapshot = captureRaw();
    const current = readStateFromSnapshot(snapshot);
    if (!current) return [];
    const records = await identifyGames(current.gameStates);
    assertRawUnchanged(snapshot, 'Team Games class states');
    return records.map(({ recordId, value }) => ({ recordId, value }));
  };

  const applyGameUnlocked = async (
    recordId,
    candidate,
    deleted,
    source,
    assertCurrent = () => {},
  ) => {
    if (!/^game-[a-f0-9]{64}$/.test(recordId || '')) {
      throw new Error('The synchronized Team Games game-state ID is invalid.');
    }
    const snapshot = captureRaw();
    const current = baseStateForWrite(snapshot);
    const identified = await identifyGames(current.gameStates);
    assertRawUnchanged(snapshot, 'Team Games class states');
    const matches = identified.filter((item) => item.recordId === recordId);
    if (matches.length > 1) {
      throw new Error('Local Team Games class identities collide and need review.');
    }
    let changedClassKey = matches[0]?.sourceId || '';
    if (deleted) {
      if (!matches.length) {
        assertCurrent();
        assertRawUnchanged(snapshot, 'Team Games class states');
        return true;
      }
      delete current.gameStates[matches[0].sourceId];
    } else {
      if (!validateGameRecord(candidate, recordId)) {
        throw new Error('The synchronized Team Games game state is invalid.');
      }
      const value = canonicalGameRecord(candidate);
      if (await gameRecordId(value.classKey) !== recordId) {
        throw new Error('The synchronized Team Games class identity does not match its record.');
      }
      if (matches.length && matches[0].sourceId !== value.classKey) {
        throw new Error('The synchronized Team Games class identity collides with local data.');
      }
      current.gameStates[value.classKey] = value.state;
      changedClassKey = value.classKey;
    }
    if (!validateState(current)) {
      throw new Error('The synchronized game state would make local Team Games data invalid.');
    }
    assertCurrent();
    compareAndSet(snapshot, [
      { key: STORAGE_KEYS.state, raw: JSON.stringify(current) },
      { key: STORAGE_KEYS.selectedClass, raw: current.selectedClassKey },
    ], 'Team Games class state');
    storageWarning = '';
    dispatchChange('game-states', source, changedClassKey);
    return true;
  };

  const requireWriteSource = (metadata) => {
    if (!metadata || !['local', 'remote-migration'].includes(metadata.source)) {
      throw new Error('The sync client requested an invalid local write source.');
    }
  };

  const requireRemoteSource = (metadata) => {
    if (!metadata || !['remote', 'migration'].includes(metadata.source)) {
      throw new Error('The sync client requested an invalid remote write source.');
    }
  };

  const rejectFixedTombstone = (metadata, label) => {
    if (metadata && metadata.deleted) {
      throw new Error(`${label} is a fixed record and cannot be deleted.`);
    }
  };

  const localOrMigratedWrite = (metadata, task) => {
    requireWriteSource(metadata);
    return metadata.source === 'remote-migration'
      ? withRemoteWrite(task)
      : withAggregateLock(() => task(() => {}));
  };

  const readPreferencesUnlocked = () => {
    const current = readStateUnlocked();
    return current ? {
      version: SCHEMA_VERSION,
      selectedClassKey: current.selectedClassKey,
    } : undefined;
  };

  const makeAdapters = () => ({
    preferences: {
      scope: APP_ID,
      appId: APP_ID,
      collection: 'preferences',
      recordId: 'current',
      schemaVersion: SCHEMA_VERSION,
      validate: validatePreferences,
      readLocal: () => withConsistentRead(readPreferencesUnlocked),
      writeLocal: (value, metadata) => {
        rejectFixedTombstone(metadata, 'Team Games preferences');
        return localOrMigratedWrite(metadata, (assertCurrent) =>
          applyPreferencesUnlocked(value, metadata.source, assertCurrent));
      },
      applyRemote: (value, metadata) => {
        requireRemoteSource(metadata);
        rejectFixedTombstone(metadata, 'Team Games preferences');
        return withRemoteWrite((assertCurrent) =>
          applyPreferencesUnlocked(value, metadata.source, assertCurrent));
      },
    },
    gameStates: {
      scope: APP_ID,
      appId: APP_ID,
      collection: 'game-states',
      schemaVersion: SCHEMA_VERSION,
      validate: validateGameRecord,
      listLocal: () => withConsistentRead(listGamesUnlocked),
      writeLocal: (recordId, value, metadata) =>
        localOrMigratedWrite(metadata, (assertCurrent) =>
          applyGameUnlocked(
            recordId,
            value,
            Boolean(metadata.deleted),
            metadata.source,
            assertCurrent,
          )),
      applyRemote: (recordId, value, metadata) => {
        requireRemoteSource(metadata);
        return withRemoteWrite((assertCurrent) =>
          applyGameUnlocked(
            recordId,
            value,
            Boolean(metadata.deleted),
            metadata.source,
            assertCurrent,
          ));
      },
    },
  });

  const attachHandles = (next) => {
    if (!exactKeys(next, ['preferences', 'gameStates'])) {
      throw new Error('Team Games sync handles are incomplete.');
    }
    const value = Object.fromEntries(safeEntries(next));
    if (!value.preferences || typeof value.preferences.save !== 'function' ||
        !value.gameStates || typeof value.gameStates.save !== 'function' ||
        typeof value.gameStates.remove !== 'function') {
      throw new Error('Team Games sync handles are incomplete.');
    }
    handles = Object.freeze({ ...value });
  };

  const sameValue = (left, right) => JSON.stringify(left) === JSON.stringify(right);

  const stageStateChanges = async (previous, current) => {
    if (!handles) return;
    const oldPreference = previous ? {
      version: SCHEMA_VERSION,
      selectedClassKey: previous.selectedClassKey,
    } : undefined;
    const newPreference = {
      version: SCHEMA_VERSION,
      selectedClassKey: current.selectedClassKey,
    };
    if (!oldPreference || !sameValue(oldPreference, newPreference)) {
      await handles.preferences.save(newPreference);
    }

    const oldGames = previous ? await identifyGames(previous.gameStates) : [];
    const newGames = await identifyGames(current.gameStates);
    const oldById = new Map(oldGames.map((item) => [item.recordId, item]));
    const newById = new Map(newGames.map((item) => [item.recordId, item]));
    for (const item of newGames) {
      if (!oldById.has(item.recordId) ||
          !sameValue(oldById.get(item.recordId).value, item.value)) {
        await handles.gameStates.save(item.recordId, item.value);
      }
    }
    for (const item of oldGames) {
      if (!newById.has(item.recordId)) {
        await handles.gameStates.remove(item.recordId);
      }
    }
  };

  const saveState = (candidate) => {
    if (!validateState(candidate)) {
      return Promise.reject(new Error('The Team Games app state is invalid.'));
    }
    const value = canonicalState(candidate);
    return enqueueLatest(async () => {
      const previous = await withAggregateLock(() =>
        writeFullStateUnlocked(value, 'local'));
      await stageStateChanges(previous, value);
      return true;
    });
  };

  const loadState = (fallback) => {
    if (!validateState(fallback)) throw new Error('Team Games defaults are invalid.');
    seedState = canonicalState(fallback);
    try {
      const current = readStateUnlocked();
      storageWarning = '';
      return current || canonicalState(seedState);
    } catch (error) {
      storageWarning = error.message;
      return canonicalState(seedState);
    }
  };

  const loadSelectedClassKey = (fallback = '') => {
    if (!validClassKey(fallback, { allowEmpty: true })) {
      throw new Error('The selected Team Games class fallback is invalid.');
    }
    try {
      const current = readStateUnlocked();
      storageWarning = '';
      return current ? current.selectedClassKey : fallback;
    } catch (error) {
      storageWarning = error.message;
      return fallback;
    }
  };

  const assertOwnedStorageValid = () => {
    readStateUnlocked();
    return true;
  };

  const rawBackup = () => ({
    version: 1,
    kind: 'team_games_browser_local_raw_backup',
    app_id: APP_ID,
    exported_at: new Date().toISOString(),
    records: RAW_BACKUP_KEYS.map((key) => {
      const rawValue = window.localStorage.getItem(key);
      if (rawValue !== null && rawBytes(rawValue) > MAX_RAW_BACKUP_VALUE_BYTES) {
        throw new Error(`The exact local value for ${key} is too large to download safely.`);
      }
      return {
        key,
        present: rawValue !== null,
        raw_value: rawValue,
      };
    }),
  });

  window.TeamGamesStorage = Object.freeze({
    appId: APP_ID,
    schemaVersion: SCHEMA_VERSION,
    changeEvent: CHANGE_EVENT,
    aggregateLock: AGGREGATE_LOCK,
    storageKeys: STORAGE_KEYS,
    rawBackupKeys: RAW_BACKUP_KEYS,
    rawBackup,
    validateState,
    validatePreferences,
    validateGameRecord,
    gameRecordId,
    makeAdapters,
    attachHandles,
    setEditorState,
    saveState,
    loadState,
    loadSelectedClassKey,
    assertOwnedStorageValid,
    getStorageWarning: () => storageWarning,
  });
})();
