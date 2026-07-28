const assert = require('node:assert/strict');
const { createHash, webcrypto } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');
const { TextEncoder } = require('node:util');

const source = readFileSync(
  new URL('../team-games-storage.js', `file://${__filename}`),
  'utf8',
);

class FakeStorage {
  constructor(initial = {}) {
    this.values = new Map(Object.entries(initial));
    this.reads = [];
    this.onGet = null;
  }

  getItem(key) {
    this.reads.push(key);
    if (this.onGet) this.onGet(key, this);
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    this.values.set(String(key), String(value));
  }

  removeItem(key) {
    this.values.delete(key);
  }

  snapshot() {
    return Object.fromEntries(this.values);
  }
}

class LockManager {
  constructor() {
    this.chains = new Map();
    this.calls = [];
  }

  request(name, _options, task) {
    this.calls.push(name);
    const previous = this.chains.get(name) || Promise.resolve();
    const current = previous.then(task);
    this.chains.set(name, current.catch(() => {}));
    return current;
  }
}

function loadStorage(initial = {}) {
  const localStorage = new FakeStorage(initial);
  const locks = new LockManager();
  const events = [];
  class CustomEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.detail = init.detail;
    }
  }
  const window = {
    localStorage,
    navigator: { locks },
    crypto: webcrypto,
    dispatchEvent(event) {
      events.push(event);
      return true;
    },
  };
  const context = vm.createContext({
    window,
    TextEncoder,
    Uint8Array,
    CustomEvent,
    console,
  });
  new vm.Script(source, { filename: 'team-games-storage.js' }).runInContext(context);
  const realm = (value) => {
    context.__fixtureJson = JSON.stringify(value);
    try {
      return vm.runInContext('JSON.parse(__fixtureJson)', context);
    } finally {
      delete context.__fixtureJson;
    }
  };
  return {
    api: window.TeamGamesStorage,
    localStorage,
    locks,
    events,
    context,
    realm,
  };
}

const keys = {
  state: 'camp-group-randomizer-v1',
  selected: 'team-games-selected-class-v1',
  cache: 'team-games-class-roster-cache-v1',
};

const emptyGameState = (name = 'Game Student') => ({
  students: [{
    id: `builtin:boys-nga:${name.toLowerCase().replaceAll(' ', '-')}`,
    name,
    rating: null,
    wins: 0,
    active: true,
  }],
  archivedStudents: [],
  groupCount: '2',
  winHistory: [],
  redoWinHistory: [],
  weekArchive: [],
  groupTallies: [],
  timerDuration: 60,
  timerRemaining: 60,
});

const appState = (overrides = {}) => ({
  version: 2,
  selectedClassKey: 'builtin:boys-nga',
  gameStates: {
    'builtin:boys-nga': emptyGameState(),
  },
  ...overrides,
});

const remoteMetadata = (deleted = false) =>
  Object.freeze({ source: 'remote', deleted, revision: 1 });

test('central adapters read only selected class and per-class game records', async () => {
  const state = appState();
  const environment = loadStorage({
    [keys.state]: JSON.stringify(state),
    [keys.selected]: state.selectedClassKey,
    [keys.cache]: '{"marker":"ROSTER_CACHE_ONLY"}',
    unrelated: 'DO_NOT_READ',
  });
  const adapters = environment.api.makeAdapters();
  environment.localStorage.reads.length = 0;

  const preferences = await adapters.preferences.readLocal();
  const records = await adapters.gameStates.listLocal();

  assert.equal(preferences.selectedClassKey, 'builtin:boys-nga');
  assert.equal(records.length, 1);
  assert.equal(records[0].value.classKey, 'builtin:boys-nga');
  assert.match(records[0].recordId, /^game-[a-f0-9]{64}$/);
  assert.deepEqual(
    [...new Set(environment.localStorage.reads)].sort(),
    [keys.selected, keys.state].sort(),
  );
  assert.ok(environment.locks.calls.every((name) => name === environment.api.aggregateLock));
});

test('stable SHA-256 IDs are derived only from the exact class key', async () => {
  const environment = loadStorage();
  const classKey = 'custom:Tuesday 5 PM';
  const expected = createHash('sha256').update(classKey).digest('hex');
  assert.equal(await environment.api.gameRecordId(classKey), `game-${expected}`);
  assert.equal(await environment.api.gameRecordId(classKey), `game-${expected}`);
});

test('exact raw backup contains only the state and selected-class keys', () => {
  const environment = loadStorage({
    [keys.state]: JSON.stringify(appState()),
    [keys.selected]: 'builtin:boys-nga',
    [keys.cache]: '{"marker":"ROSTER_CACHE_ONLY"}',
    unrelated: 'DO_NOT_EXPORT',
  });
  const backup = environment.api.rawBackup();

  assert.deepEqual(
    Array.from(backup.records, (record) => record.key),
    [keys.state, keys.selected],
  );
  assert.doesNotMatch(JSON.stringify(backup), /ROSTER_CACHE_ONLY|DO_NOT_EXPORT|unrelated/);
});

test('local-first save preserves roster cache bytes and stages only app records', async () => {
  const original = appState();
  const next = appState({
    selectedClassKey: 'builtin:level-3-boys',
    gameStates: {
      ...original.gameStates,
      'builtin:level-3-boys': emptyGameState('Level Three Student'),
    },
  });
  const cache = '{"marker":"ROSTER_CACHE_ONLY","revision":9}';
  const environment = loadStorage({
    [keys.state]: JSON.stringify(original),
    [keys.selected]: original.selectedClassKey,
    [keys.cache]: cache,
  });
  const calls = [];
  environment.context.__handles = {
    preferences: { save: async (value) => calls.push(['preferences', value]) },
    gameStates: {
      save: async (recordId, value) => calls.push(['game', recordId, value]),
      remove: async (recordId) => calls.push(['remove', recordId]),
    },
  };
  environment.api.attachHandles(
    vm.runInContext('({ ...__handles })', environment.context),
  );

  await environment.api.saveState(environment.realm(next));

  assert.equal(environment.localStorage.getItem(keys.cache), cache);
  assert.equal(environment.localStorage.getItem(keys.selected), 'builtin:level-3-boys');
  assert.equal(JSON.parse(environment.localStorage.getItem(keys.state)).selectedClassKey,
    'builtin:level-3-boys');
  assert.equal(calls.filter(([kind]) => kind === 'preferences').length, 1);
  assert.equal(calls.filter(([kind]) => kind === 'game').length, 1);
  assert.doesNotMatch(JSON.stringify(calls), /ROSTER_CACHE_ONLY/);
});

test('malformed owned bytes fail closed without changing cache or either owned key', async () => {
  const initial = {
    [keys.state]: '{not-json',
    [keys.selected]: 'builtin:boys-nga',
    [keys.cache]: '{"marker":"ROSTER_CACHE_ONLY"}',
  };
  const environment = loadStorage(initial);
  const fallback = environment.realm(appState({ selectedClassKey: '', gameStates: {} }));

  assert.equal(environment.api.loadState(fallback).selectedClassKey, '');
  assert.match(environment.api.getStorageWarning(), /backup and review/);
  await assert.rejects(
    environment.api.saveState(environment.realm(appState())),
    /backup and review/,
  );
  assert.deepEqual(environment.localStorage.snapshot(), initial);
});

test('recognized legacy game data is exposed for review without rewriting its raw bytes', () => {
  const legacyRaw = JSON.stringify(emptyGameState('Legacy Student'));
  const environment = loadStorage({ [keys.state]: legacyRaw });
  const fallback = environment.realm(appState({ selectedClassKey: '', gameStates: {} }));

  const loaded = environment.api.loadState(fallback);

  assert.equal(loaded.selectedClassKey, 'legacy');
  assert.deepEqual(Object.keys(loaded.gameStates), ['legacy']);
  assert.equal(environment.localStorage.getItem(keys.state), legacyRaw);
  assert.equal(environment.localStorage.getItem(keys.selected), null);
});

test('strict validators reject inherited objects, accessors, malformed IDs, and oversize records', () => {
  const environment = loadStorage();
  const valid = environment.realm(appState());
  environment.context.__validState = valid;
  const inherited = vm.runInContext(
    'Object.assign(Object.create({ inherited: true }), __validState)',
    environment.context,
  );
  assert.equal(environment.api.validateState(inherited), false);

  const accessor = vm.runInContext(`(() => {
    const value = { ...__validState };
    Object.defineProperty(value, 'selectedClassKey', {
      enumerable: true,
      get() { throw new Error('must not execute'); },
    });
    return value;
  })()`, environment.context);
  assert.equal(environment.api.validateState(accessor), false);
  const hostileToJson = vm.runInContext(`(() => {
    const value = JSON.parse(JSON.stringify(__validState));
    value.gameStates['builtin:boys-nga'].toJSON = () => {
      throw new Error('must not execute');
    };
    return value;
  })()`, environment.context);
  assert.doesNotThrow(() => {
    assert.equal(environment.api.validateState(hostileToJson), false);
  });

  const record = {
    version: 1,
    classKey: 'builtin:boys-nga',
    state: emptyGameState(),
  };
  assert.equal(environment.api.validateGameRecord(
    environment.realm(record),
    'game-not-a-hash',
  ), false);
  record.state.students[0].name = 'x'.repeat(129 * 1024);
  assert.equal(environment.api.validateGameRecord(
    environment.realm(record),
    `game-${'0'.repeat(64)}`,
  ), false);
});

test('fixed preference tombstones fail while a class tombstone removes only its hashed game state', async () => {
  const original = appState({
    gameStates: {
      'builtin:boys-nga': emptyGameState('NGA Student'),
      'builtin:level-3-boys': emptyGameState('Level Three Student'),
    },
  });
  const cache = '{"marker":"ROSTER_CACHE_ONLY"}';
  const environment = loadStorage({
    [keys.state]: JSON.stringify(original),
    [keys.selected]: original.selectedClassKey,
    [keys.cache]: cache,
  });
  const adapters = environment.api.makeAdapters();

  assert.throws(
    () => adapters.preferences.applyRemote(null, remoteMetadata(true)),
    /fixed record and cannot be deleted/,
  );
  const recordId = await environment.api.gameRecordId('builtin:level-3-boys');
  await adapters.gameStates.applyRemote(recordId, null, remoteMetadata(true));

  const stored = JSON.parse(environment.localStorage.getItem(keys.state));
  assert.deepEqual(Object.keys(stored.gameStates), ['builtin:boys-nga']);
  assert.equal(environment.localStorage.getItem(keys.cache), cache);
});

test('CAS race preserves a newer local aggregate state', async () => {
  const original = appState();
  const newer = appState({ selectedClassKey: 'builtin:advanced-boys' });
  const environment = loadStorage({
    [keys.state]: JSON.stringify(original),
    [keys.selected]: original.selectedClassKey,
  });
  let stateReads = 0;
  let injectRace = false;
  environment.localStorage.onGet = (key, storage) => {
    if (key !== keys.state) return;
    stateReads += 1;
    if (injectRace && stateReads === 2) {
      storage.values.set(keys.state, JSON.stringify(newer));
      storage.values.set(keys.selected, newer.selectedClassKey);
    }
  };
  const adapters = environment.api.makeAdapters();
  injectRace = true;

  await assert.rejects(
    adapters.preferences.applyRemote(
      environment.realm({ version: 1, selectedClassKey: 'builtin:level-3-boys' }),
      remoteMetadata(false),
    ),
    /changed during an atomic update/,
  );
  assert.equal(JSON.parse(environment.localStorage.getItem(keys.state)).selectedClassKey,
    'builtin:advanced-boys');
});

test('rapid saves coalesce to the latest aggregate state', async () => {
  const environment = loadStorage();
  environment.api.loadState(environment.realm(appState({
    selectedClassKey: '',
    gameStates: {},
  })));
  const calls = [];
  environment.context.__handles = {
    preferences: { save: async (value) => calls.push(['preferences', value]) },
    gameStates: {
      save: async (recordId, value) => calls.push(['game', recordId, value]),
      remove: async (recordId) => calls.push(['remove', recordId]),
    },
  };
  environment.api.attachHandles(
    vm.runInContext('({ ...__handles })', environment.context),
  );
  const first = environment.api.saveState(environment.realm(appState()));
  const latestValue = appState({ selectedClassKey: 'builtin:level-3-boys' });
  const latest = environment.api.saveState(environment.realm(latestValue));

  await Promise.all([first, latest]);

  assert.equal(environment.localStorage.getItem(keys.selected), 'builtin:level-3-boys');
  assert.equal(calls.filter(([kind]) => kind === 'preferences').length, 1);
  assert.equal(calls.find(([kind]) => kind === 'preferences')[1].selectedClassKey,
    'builtin:level-3-boys');
});

test('remote apply waits for an active game and loses to a newer local generation', async () => {
  const original = appState();
  const environment = loadStorage({
    [keys.state]: JSON.stringify(original),
    [keys.selected]: original.selectedClassKey,
  });
  const adapters = environment.api.makeAdapters();
  environment.api.setEditorState(environment.realm({ active: true, dirty: true }));

  const remote = adapters.preferences.applyRemote(
    environment.realm({ version: 1, selectedClassKey: 'builtin:advanced-boys' }),
    remoteMetadata(false),
  );
  await Promise.resolve();
  await environment.api.saveState(environment.realm(appState({
    selectedClassKey: 'builtin:level-3-boys',
  })));
  environment.api.setEditorState(environment.realm({ active: false, dirty: false }));

  await assert.rejects(remote, /newer local action needs review/);
  assert.equal(environment.localStorage.getItem(keys.selected), 'builtin:level-3-boys');
});
