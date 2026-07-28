const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');

const syncSource = readFileSync(
  new URL('../team-games-sync.js', `file://${__filename}`),
  'utf8',
);
const storageSource = readFileSync(
  new URL('../team-games-storage.js', `file://${__filename}`),
  'utf8',
);
const html = readFileSync(
  new URL('../index.html', `file://${__filename}`),
  'utf8',
);

const loadPolicy = () => {
  const window = {};
  const document = {
    body: null,
    querySelector() {
      return null;
    },
  };
  new vm.Script(syncSource, { filename: 'team-games-sync.js' })
    .runInNewContext({ window, document, Number, Object });
  return window.TeamGamesSyncPolicy;
};

test('migration gate requires zero writes, remote records, and orphaned intents', () => {
  const policy = loadPolicy();
  assert.equal(policy.migrationGate({
    writesPerformed: 0,
    remoteCount: 0,
    orphanedCount: 0,
  }).safe, true);
  assert.equal(policy.migrationGate({
    writesPerformed: 1,
    remoteCount: 0,
    orphanedCount: 0,
  }).safe, false);
  assert.equal(policy.migrationGate({
    writesPerformed: 0,
    remoteCount: 1,
    orphanedCount: 0,
  }).safe, false);
  assert.equal(policy.migrationGate({
    writesPerformed: 0,
    remoteCount: 0,
    orphanedCount: 1,
  }).safe, false);
  assert.equal(policy.migrationGate({}).safe, false);
});

test('central manifest and exact backup exclude the roster cache and response service', () => {
  assert.match(storageSource, /collection: 'preferences'/);
  assert.match(storageSource, /collection: 'game-states'/);
  assert.match(storageSource, /recordId: 'current'/);
  assert.match(storageSource, /gameRecordId/);
  assert.doesNotMatch(storageSource, /team-games-class-roster-cache-v1|api\/rosters/);
  assert.doesNotMatch(storageSource, /Storage\.prototype|localStorage\.clear\s*\(/);
  assert.doesNotMatch(storageSource, /localStorage\.(?:key|length)\b/);
  assert.match(storageSource,
    /RAW_BACKUP_KEYS = Object\.freeze\(\[\s*STORAGE_KEYS\.state,\s*STORAGE_KEYS\.selectedClass/);
  assert.match(html, /team-games-storage\.js/);
  assert.match(html, /ryan-app-sync[^"']*\/ryan-app-sync\.js/);
  const syncClientTag = html.match(
    /<script[^>]+ryan-app-sync[^>]+><\/script>/,
  )?.[0] || '';
  assert.doesNotMatch(syncClientTag, /\bcrossorigin\b/i);
  assert.match(html, /team-games-sync\.js/);
});

test('roster reads require helper auth, preserve the existing write helper, and reload after auth', () => {
  const loadBlock = html.match(
    /async function loadSharedClassData[\s\S]*?\n    }\n\n    async function syncSharedClassData/,
  )?.[0] || '';
  assert.match(loadBlock, /getAuthHeaders\?\.\(\)/);
  assert.match(loadBlock, /getWriteHeaders\?\.\(\)/);
  assert.match(loadBlock, /if \(!rosterHeaders\)[\s\S]*return;/);
  assert.match(loadBlock, /headers: rosterHeaders/);
  assert.match(html, /StudentShuffleRosterAuth\?\.getWriteHeaders\?\.\(\)/);
  assert.match(html, /student-shuffle-roster-authenticated/);
});

test('migration UI downloads the two-key exact backup before metadata preview', () => {
  const previewHandler = syncSource.match(
    /previewButton\.addEventListener\('click',[\s\S]*?\n  \}\)\);/,
  )?.[0] || '';
  assert.match(previewHandler, /store\.assertOwnedStorageValid\(\)/);
  assert.match(previewHandler, /downloadRawBackup\(\)/);
  assert.match(previewHandler, /client\.previewMigration\(\{ downloadBackup: true \}\)/);
  assert.ok(
    previewHandler.indexOf('downloadRawBackup()') <
    previewHandler.indexOf('client.previewMigration'),
  );
  assert.match(html,
    /selectClass\(initialClassKey, \{ announce: false, persist: false \}\)/);
});
