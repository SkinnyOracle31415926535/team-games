const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");

const html = readFileSync(new URL("../index.html", `file://${__filename}`), "utf8");
const manifest = JSON.parse(readFileSync(new URL("../manifest.webmanifest", `file://${__filename}`), "utf8"));

function pngSize(path) {
  const image = readFileSync(new URL(`../${path}`, `file://${__filename}`));
  assert.equal(image.toString("ascii", 1, 4), "PNG", `${path} is a PNG`);
  return [image.readUInt32BE(16), image.readUInt32BE(20)];
}

test("Team Games uses the current v3 flag artwork for every install icon", () => {
  assert.match(html, /<link rel="icon" type="image\/png" sizes="32x32" href="favicon-32-v3\.png">/);
  assert.match(html, /<link rel="apple-touch-icon" sizes="180x180" href="apple-touch-icon-v3\.png">/);
  assert.doesNotMatch(html, /href="icon-v3\.png"/);

  assert.deepEqual(manifest.icons.map(({ src, sizes }) => [src, sizes]), [
    ["icon-192-v3.png", "192x192"],
    ["icon-512-v3.png", "512x512"],
  ]);

  for (const [path, expected] of [
    ["favicon-32-v3.png", [32, 32]],
    ["apple-touch-icon-v3.png", [180, 180]],
    ["icon-192-v3.png", [192, 192]],
    ["icon-512-v3.png", [512, 512]],
  ]) {
    assert.deepEqual(pngSize(path), expected, `${path} has the declared dimensions`);
  }
});
