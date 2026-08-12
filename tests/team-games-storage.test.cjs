const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');
const { TextEncoder } = require('node:util');

const source = readFileSync(new URL('../team-games-storage.js', `file://${__filename}`), 'utf8');

class FakeStorage {
  constructor(initial = {}) { this.values = new Map(Object.entries(initial)); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(String(key), String(value)); }
  removeItem(key) { this.values.delete(key); }
}

function loadStorage(initial = {}, { locks = true } = {}) {
  const localStorage = new FakeStorage(initial);
  const window = { localStorage, navigator: {} };
  if (locks) {
    window.navigator.locks = { request(_name, _options, task) { return Promise.resolve().then(task); } };
  }
  const context = vm.createContext({ window, TextEncoder });
  new vm.Script(source, { filename: 'team-games-storage.js' }).runInContext(context);
  const realm = (value) => {
    context.__fixture = JSON.stringify(value);
    try { return vm.runInContext('JSON.parse(__fixture)', context); }
    finally { delete context.__fixture; }
  };
  return { api: window.TeamGamesStorage, localStorage, realm };
}

const gameState = (name = 'Avery') => ({
  students: [{ id: `builtin:boys-nga:${name}`, name, rating: null, wins: 0, active: true }],
  archivedStudents: [],
  groupCount: '2',
  winHistory: [],
  redoWinHistory: [],
  weekArchive: [],
  groupTallies: [],
  timerDuration: 60,
  timerRemaining: 60,
});

const state = (selectedClassKey = 'builtin:boys-nga') => ({
  version: 2,
  selectedClassKey,
  gameStates: { [selectedClassKey]: gameState() },
});

test('Team Games saves validated state locally with and without navigator locks', async () => {
  for (const locks of [true, false]) {
    const environment = loadStorage({}, { locks });
    const next = environment.realm(state('builtin:level-3-boys'));
    await environment.api.saveState(next);

    assert.deepEqual(
      JSON.parse(environment.localStorage.getItem('camp-group-randomizer-v1')),
      JSON.parse(JSON.stringify(next)),
    );
    assert.equal(environment.localStorage.getItem('team-games-selected-class-v1'), 'builtin:level-3-boys');
    assert.equal(environment.api.loadSelectedClassKey(''), 'builtin:level-3-boys');
  }
});

test('Team Games preserves malformed local bytes instead of overwriting them', async () => {
  const raw = '{"version":2';
  const environment = loadStorage({ 'camp-group-randomizer-v1': raw });
  const displayed = environment.api.loadState(environment.realm(state()));

  assert.equal(displayed.selectedClassKey, 'builtin:boys-nga');
  assert.match(environment.api.getStorageWarning(), /exact raw backup and review/);
  await assert.rejects(environment.api.saveState(environment.realm(state())), /exact raw backup and review/);
  assert.equal(environment.localStorage.getItem('camp-group-randomizer-v1'), raw);
});
