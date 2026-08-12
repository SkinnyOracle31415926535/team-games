const assert = require('node:assert/strict');
const { existsSync, readFileSync } = require('node:fs');
const { test } = require('node:test');

const index = readFileSync(new URL('../index.html', `file://${__filename}`), 'utf8');
const storage = readFileSync(new URL('../team-games-storage.js', `file://${__filename}`), 'utf8');

test('Team Games no longer ships the retired private-sync client', () => {
  assert.doesNotMatch(index, /semantic-app-sync\.js|SemanticAppSync|transfer-theme\.js/);
  assert.doesNotMatch(storage, /makeAdapters|attachHandles|app-sync|remote|semantic|sync/i);
  assert.equal(existsSync(new URL('../semantic-app-sync.js', `file://${__filename}`)), false);
  assert.equal(existsSync(new URL('../transfer-theme.js', `file://${__filename}`)), false);
});
