const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");

const source = readFileSync(new URL("../transfer-theme.js", `file://${__filename}`), "utf8");

test("Team Games sync theme replaces only the generic sync chrome", () => {
  assert.match(source, /styleMarkers/);
  assert.match(source, /style\.remove\(\)/);
  assert.doesNotMatch(source, /Tahoma/);
  assert.doesNotMatch(source, /ryan-transfer|ryan-v3-recovery/);
  assert.match(source, /ryan-semantic-sync/);
  assert.match(source, /panel-title/);
});
