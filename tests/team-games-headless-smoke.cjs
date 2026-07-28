const assert = require('node:assert/strict');
const http = require('node:http');
const { readFileSync } = require('node:fs');
const { readFile } = require('node:fs/promises');
const { extname, join, normalize } = require('node:path');
const { chromium } = require('playwright');

const root = normalize(join(__dirname, '..'));
const screenshotRoot = '/private/tmp';
const mime = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
};
const syncClient = readFileSync(
  '/Users/ryansadler/Developer/ryan-app-sync/public/ryan-app-sync.js',
  'utf8',
);

const rosterAuthStub = `
(() => {
  'use strict';
  const getHeaders = () => localStorage.getItem('team-games-roster-connected') === 'yes'
    ? { Authorization: 'Bearer roster-test-token' }
    : null;
  const create = () => {
    if (document.getElementById('student-shuffle-roster-auth')) return;
    const button = document.createElement('button');
    button.id = 'student-shuffle-roster-auth';
    button.type = 'button';
    button.textContent = 'Roster access · connected';
    button.style.cssText = [
      'position:fixed', 'right:10px', 'bottom:10px', 'z-index:2147483647',
      'max-width:calc(100vw - 20px)', 'border:1px solid #14532d',
      'border-radius:999px', 'padding:7px 10px', 'background:#effbea',
      'color:#14532d', 'font:700 12px/1.2 system-ui', 'cursor:pointer'
    ].join(';');
    document.body.append(button);
  };
  window.StudentShuffleRosterAuth = Object.freeze({
    connect() {},
    getAuthHeaders: getHeaders,
    getWriteHeaders: getHeaders,
    mode: 'roster-authentication-only',
  });
  if (document.body) create();
  else document.addEventListener('DOMContentLoaded', create, { once: true });
})();
`;

let sharedRosterRevision = 7;
let sharedRosterState = {
  version: 2,
  custom: {
    ROSTER_CACHE_ONLY_CLASS: ['ROSTER_RESPONSE_ONLY_STUDENT'],
  },
  builtinOverrides: {
    'builtin:boys-nga': ['Game Student One', 'Game Student Two'],
    'builtin:level-3-boys': ['Level Three One', 'Level Three Two'],
  },
};

const gameState = (classKey, names) => ({
  students: names.map((name) => ({
    id: `${classKey}:${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    name,
    rating: null,
    wins: 0,
    active: true,
  })),
  archivedStudents: [],
  groupCount: '2',
  winHistory: [],
  redoWinHistory: [],
  weekArchive: [],
  groupTallies: [],
  timerDuration: 60,
  timerRemaining: 60,
});

const seededAppState = {
  version: 2,
  selectedClassKey: 'builtin:boys-nga',
  gameStates: {
    'builtin:boys-nga': gameState(
      'builtin:boys-nga',
      ['Game Student One', 'Game Student Two'],
    ),
  },
};

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1');
    let relative = decodeURIComponent(url.pathname);
    if (relative === '/team-games/' || relative === '/team-games') {
      relative = '/index.html';
    } else {
      relative = relative.replace(/^\/team-games/, '');
    }
    const path = normalize(join(root, relative));
    if (!path.startsWith(root)) throw new Error('outside root');
    const body = await readFile(path);
    response.writeHead(200, {
      'content-type': mime[extname(path)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    response.end(body);
  } catch (_error) {
    response.writeHead(404);
    response.end('Not found');
  }
});

const readOutbox = () => new Promise((resolve, reject) => {
  const request = indexedDB.open('ryan-app-sync:team-games');
  request.onerror = () => reject(request.error);
  request.onsuccess = () => {
    const database = request.result;
    const transaction = database.transaction('outbox', 'readonly');
    const all = transaction.objectStore('outbox').getAll();
    all.onerror = () => reject(all.error);
    all.onsuccess = () => resolve(all.result);
  };
});

(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await context.newPage();
  const errors = [];
  const requests = [];
  const rosterGetHeaders = [];
  const rosterPutHeaders = [];
  let rosterGetCount = 0;
  let rosterPutCount = 0;

  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('request', (request) => requests.push(request.url()));
  await page.addInitScript(({ seededAppState, sharedRosterState }) => {
    if (localStorage.getItem('team-games-smoke-seeded') === 'yes') return;
    localStorage.setItem('team-games-smoke-seeded', 'yes');
    localStorage.setItem('team-games-roster-connected', 'yes');
    localStorage.setItem('camp-group-randomizer-v1', JSON.stringify(seededAppState));
    localStorage.setItem(
      'team-games-selected-class-v1',
      seededAppState.selectedClassKey,
    );
    localStorage.setItem(
      'team-games-class-roster-cache-v1',
      JSON.stringify(sharedRosterState),
    );
    localStorage.setItem('another-app-secret', 'NEVER_EXPORT_THIS');
  }, { seededAppState, sharedRosterState });
  await page.route(
    'https://ryan-app-sync.ryan-666-mp3.chatgpt.site/ryan-app-sync.js',
    (route) => route.fulfill({
      status: 200,
      contentType: 'text/javascript',
      body: syncClient,
    }),
  );
  await page.route(
    'https://student-shuffle-shared.ryan-666-mp3.chatgpt.site/roster-auth.js',
    (route) => route.fulfill({
      status: 200,
      contentType: 'text/javascript',
      body: rosterAuthStub,
    }),
  );
  await page.route(
    'https://student-shuffle-shared.ryan-666-mp3.chatgpt.site/api/rosters',
    async (route) => {
      const request = route.request();
      const headers = request.headers();
      if (request.method() === 'PUT') {
        rosterPutCount += 1;
        rosterPutHeaders.push(headers);
        sharedRosterState = JSON.parse(request.postData() || '{}');
        sharedRosterRevision += 1;
      } else {
        rosterGetCount += 1;
        rosterGetHeaders.push(headers);
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          state: sharedRosterState,
          revision: sharedRosterRevision,
        }),
      });
    },
  );

  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`http://127.0.0.1:${port}/team-games/`, {
      waitUntil: 'networkidle',
    });
    await page.locator('[data-team-games-sync-open][data-state]').waitFor();
    await page.locator('#student-shuffle-roster-auth').waitFor();
    await page.waitForFunction(() =>
      document.getElementById('status')?.textContent.includes('shared class rosters loaded'));

    assert.equal(await page.locator('#classSelect').inputValue(), 'builtin:boys-nga');
    assert.equal(
      await page.evaluate(() => window.StudentShuffleRosterAuth?.mode),
      'roster-authentication-only',
    );
    assert.ok(rosterGetCount >= 1);
    assert.ok(rosterGetHeaders.every((headers) =>
      headers.authorization === 'Bearer roster-test-token'));

    await page.locator('#classSelect').selectOption('builtin:level-3-boys');
    await page.waitForFunction(() =>
      localStorage.getItem('team-games-selected-class-v1') ===
        'builtin:level-3-boys');
    await page.locator('#studentName').fill('Locally Added Player');
    await page.locator('#addStudent').click();
    await page.waitForFunction(() => {
      const saved = JSON.parse(localStorage.getItem('camp-group-randomizer-v1'));
      return saved.gameStates['builtin:level-3-boys'].students
        .some((student) => student.name === 'Locally Added Player');
    });
    await page.waitForFunction(() =>
      document.getElementById('status')?.textContent.includes('saved for every browser'));
    assert.equal(rosterPutCount, 1);
    assert.equal(rosterPutHeaders[0].authorization, 'Bearer roster-test-token');
    assert.equal(rosterPutHeaders[0]['if-match'], '"7"');

    await page.locator('#generateGroups').click();
    await page.locator('#gameScreen:not(.screen-hidden)').waitFor();
    const winner = page.locator('.group-card').first().locator('.group-actions button');
    await winner.click();
    await winner.click();
    await page.locator('#homeScreen:not(.screen-hidden)').waitFor();
    await page.waitForFunction(() => {
      const saved = JSON.parse(localStorage.getItem('camp-group-randomizer-v1'));
      return saved.gameStates['builtin:level-3-boys'].winHistory.length === 1;
    });

    await page.locator('#generateGroups').click();
    await page.locator('#gameScreen:not(.screen-hidden)').waitFor();
    await page.waitForTimeout(100);
    await page.evaluate(() => {
      window.__teamGamesRemoteApply = 'pending';
      const adapters = window.TeamGamesStorage.makeAdapters();
      void adapters.preferences.applyRemote(
        { version: 1, selectedClassKey: 'builtin:advanced-boys' },
        { source: 'remote', deleted: false, revision: 99 },
      ).then(
        () => { window.__teamGamesRemoteApply = 'applied'; },
        () => { window.__teamGamesRemoteApply = 'rejected'; },
      );
    });
    await page.waitForTimeout(100);
    assert.equal(
      await page.evaluate(() => window.__teamGamesRemoteApply),
      'pending',
    );
    await page.locator('.timer-preset').filter({ hasText: '30 sec' }).click();
    await page.locator('#backToHome').click();
    await page.locator('#homeScreen:not(.screen-hidden)').waitFor();
    await page.waitForFunction(() => window.__teamGamesRemoteApply === 'rejected');
    assert.equal(await page.locator('#classSelect').inputValue(), 'builtin:level-3-boys');

    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() =>
      document.getElementById('status')?.textContent.includes('shared class rosters loaded'));
    assert.equal(await page.locator('#classSelect').inputValue(), 'builtin:level-3-boys');
    assert.equal(await page.locator('#gameTotal').textContent(), '1');
    assert.equal(
      await page.locator('.student-name').allTextContents()
        .then((values) => values.some((value) => /Locally Added Player/.test(value))),
      true,
    );
    assert.equal(
      await page.evaluate(() => {
        const saved = JSON.parse(localStorage.getItem('camp-group-randomizer-v1'));
        return saved.gameStates['builtin:level-3-boys'].timerDuration;
      }),
      30,
    );

    const getsBeforeDisconnect = rosterGetCount;
    await page.evaluate(() => localStorage.removeItem('team-games-roster-connected'));
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(300);
    assert.equal(rosterGetCount, getsBeforeDisconnect);
    assert.equal(
      await page.locator('#classSelect option').allTextContents()
        .then((values) => values.includes('ROSTER_CACHE_ONLY_CLASS')),
      true,
    );
    assert.match(await page.locator('#classHelp').textContent(), /saved roster/i);

    await page.evaluate(() => {
      localStorage.setItem('team-games-roster-connected', 'yes');
      window.dispatchEvent(new Event('student-shuffle-roster-authenticated'));
    });
    await page.waitForFunction(() =>
      document.getElementById('status')?.textContent.includes('shared class rosters loaded'));
    assert.ok(rosterGetCount > getsBeforeDisconnect);

    const viewports = [
      { width: 375, height: 812 },
      { width: 768, height: 1024 },
      { width: 1440, height: 900 },
    ];
    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForFunction(() =>
        document.getElementById('status')?.textContent.includes('shared class rosters loaded'));
      await page.screenshot({
        path: join(screenshotRoot, `team-games-page-${viewport.width}.png`),
        fullPage: true,
      });
      await page.locator('[data-team-games-sync-open]').click();
      await page.locator('.team-games-sync-dialog').waitFor({ state: 'visible' });
      const layout = await page.evaluate(() => ({
        viewport: window.innerWidth,
        pageWidth: document.documentElement.scrollWidth,
        dialogOpen: document.querySelector('.team-games-sync-dialog')?.open === true,
        actions: document.querySelectorAll('.team-games-sync-actions button').length,
        reviewVisible:
          getComputedStyle(document.querySelector('[data-team-games-sync-review]')).display !== 'none',
        conflictsVisible:
          getComputedStyle(document.querySelector('[data-team-games-sync-conflicts]')).display !== 'none',
        warning: document.querySelector('[data-team-games-storage-warning]')?.textContent || '',
        rosterAuthMode: window.StudentShuffleRosterAuth?.mode,
        rosterAuthPresent: Boolean(document.getElementById('student-shuffle-roster-auth')),
      }));
      assert.equal(layout.dialogOpen, true);
      assert.equal(layout.actions, 6);
      assert.equal(layout.reviewVisible, false);
      assert.equal(layout.conflictsVisible, false);
      assert.equal(layout.warning, '');
      assert.equal(layout.rosterAuthMode, 'roster-authentication-only');
      assert.equal(layout.rosterAuthPresent, true);
      assert.ok(layout.pageWidth <= layout.viewport, JSON.stringify({ viewport, layout }));
      await page.screenshot({
        path: join(screenshotRoot, `team-games-sync-${viewport.width}.png`),
        fullPage: true,
      });
      await page.locator('.team-games-sync-footnote').scrollIntoViewIfNeeded();
      const footnoteBox = await page.locator('.team-games-sync-footnote').boundingBox();
      assert.ok(footnoteBox && footnoteBox.y >= 0 &&
        footnoteBox.y + footnoteBox.height <= viewport.height,
      JSON.stringify({ viewport, footnoteBox }));
      await page.locator('[data-team-games-sync-close]').click();

      await page.locator('#generateGroups').click();
      await page.locator('#gameScreen:not(.screen-hidden)').waitFor();
      assert.ok(
        await page.evaluate(() =>
          document.documentElement.scrollWidth <= window.innerWidth),
        JSON.stringify(viewport),
      );
      await page.screenshot({
        path: join(screenshotRoot, `team-games-game-${viewport.width}.png`),
        fullPage: true,
      });
      await page.locator('#backToHome').click();
    }

    const evidence = await page.evaluate(async (readOutboxSource) => {
      const getOutbox = (0, eval)(`(${readOutboxSource})`);
      return {
        backup: window.TeamGamesStorage.rawBackup(),
        outbox: await getOutbox(),
        state: localStorage.getItem('camp-group-randomizer-v1'),
        selected: localStorage.getItem('team-games-selected-class-v1'),
        cache: localStorage.getItem('team-games-class-roster-cache-v1'),
        unrelated: localStorage.getItem('another-app-secret'),
      };
    }, readOutbox.toString());
    assert.deepEqual(
      Array.from(evidence.backup.records, (record) => record.key),
      ['camp-group-randomizer-v1', 'team-games-selected-class-v1'],
    );
    assert.doesNotMatch(
      JSON.stringify(evidence.backup),
      /ROSTER_CACHE_ONLY_CLASS|ROSTER_RESPONSE_ONLY_STUDENT|NEVER_EXPORT_THIS/,
    );
    assert.match(evidence.cache, /ROSTER_CACHE_ONLY_CLASS|ROSTER_RESPONSE_ONLY_STUDENT/);
    assert.equal(evidence.unrelated, 'NEVER_EXPORT_THIS');
    assert.deepEqual(
      [...new Set(evidence.outbox.map((item) => item.collection))].sort(),
      ['game-states', 'preferences'],
    );
    assert.ok(evidence.outbox
      .filter((item) => item.collection === 'game-states')
      .every((item) => /^game-[a-f0-9]{64}$/.test(item.record_id || item.recordId)));
    assert.doesNotMatch(
      JSON.stringify(evidence.outbox),
      /ROSTER_CACHE_ONLY_CLASS|ROSTER_RESPONSE_ONLY_STUDENT/,
    );
    assert.equal(rosterPutCount, 1);
    assert.equal(
      requests.some((url) => /durable-storage\.js|github-pages-origin-v1/.test(url)),
      false,
    );
    assert.equal(errors.length, 0, errors.join('\n'));
    process.stdout.write(
      'Team Games headless smoke: real client, authenticated roster GET/PUT, disconnected cache, two-key backup, hashed per-class records, persistence, 375/768/1440 home+game+dialog, zero_open PASS\n',
    );
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
