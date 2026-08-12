(() => {
  'use strict';

  const APP_ID = 'team-games';
  const LOCAL_STATE_VERSION = 2;
  const AGGREGATE_LOCK = 'team-games:central-state-v1';
  const STORAGE_KEYS = Object.freeze({
    state: 'camp-group-randomizer-v1',
    selectedClass: 'team-games-selected-class-v1',
  });
  const RAW_BACKUP_KEYS = Object.freeze([
    STORAGE_KEYS.state,
    STORAGE_KEYS.selectedClass,
  ]);
  const MAX_LOCAL_STATE_BYTES = 8 * 1024 * 1024;
  const MAX_RAW_BACKUP_VALUE_BYTES = 16 * 1024 * 1024;
  let storageWarning = '';
  let seedState = null;
  let fallbackQueue = Promise.resolve();

  const withAggregateLock = (task) => {
    const locks = window.navigator && window.navigator.locks;
    if (locks && typeof locks.request === 'function') {
      return locks.request(AGGREGATE_LOCK, { mode: 'exclusive' }, task);
    }
    const result = fallbackQueue.then(task, task);
    fallbackQueue = result.catch(() => {});
    return result;
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
      validClassKey(classKey) && validateGameState(gameState)) &&
      jsonBytes(candidate) <= MAX_LOCAL_STATE_BYTES;
  };

  const canonicalState = (candidate) => cloneJson(candidate);

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

  const writeFullStateUnlocked = (candidate) => {
    if (!validateState(candidate)) throw new Error('The Team Games app state is invalid.');
    const value = canonicalState(candidate);
    const snapshot = captureRaw();
    readStateFromSnapshot(snapshot);
    compareAndSet(snapshot, [
      { key: STORAGE_KEYS.state, raw: JSON.stringify(value) },
      { key: STORAGE_KEYS.selectedClass, raw: value.selectedClassKey },
    ], 'Team Games app data');
    storageWarning = '';
    return true;
  };

  const saveState = (candidate) => {
    if (!validateState(candidate)) {
      return Promise.reject(new Error('The Team Games app state is invalid.'));
    }
    const value = canonicalState(candidate);
    return withAggregateLock(() => writeFullStateUnlocked(value));
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
    storageKeys: STORAGE_KEYS,
    rawBackupKeys: RAW_BACKUP_KEYS,
    rawBackup,
    validateState,
    saveState,
    loadState,
    loadSelectedClassKey,
    assertOwnedStorageValid,
    getStorageWarning: () => storageWarning,
  });
})();
