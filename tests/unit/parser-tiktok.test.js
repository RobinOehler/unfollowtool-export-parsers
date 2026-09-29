'use strict';
// Unit tests for src/parsers/tiktok.js
// Fixtures + expectations: tests/fixtures/tiktok (regenerate with `node tests/fixtures/tiktok/generate.js`).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

const ROOT = path.join(__dirname, '..', '..');
const FIX = path.join(ROOT, 'tests', 'fixtures', 'tiktok');
const tiktok = require(path.join(ROOT, 'src', 'parsers', 'tiktok.js'));
const MANIFEST = JSON.parse(fs.readFileSync(path.join(FIX, 'expected.json'), 'utf8'));

/* ------------------------------------------------------------------ FileSet helpers
 * Minimal in-memory FileSet following the README.md contract (normalized forward-slash
 * paths, __MACOSX/ and "._" entries removed, UTF-8 text with BOM stripped). Deliberately
 * independent of ut-files.js. */
const normalizePath = (p) => p.replace(/\\/g, '/').replace(/^\.\//, '');
const junk = (p) => /(^|\/)__MACOSX\//.test(p) || /(^|\/)\._/.test(p);

function fileSetFromMap(map, { stripBom = true } = {}) {
  const store = new Map();
  for (const [p, c] of Object.entries(map)) {
    const np = normalizePath(p);
    if (!junk(np)) store.set(np, Buffer.isBuffer(c) ? c.toString('utf8') : String(c));
  }
  return {
    paths: [...store.keys()],
    read: async (p) => {
      if (!store.has(p)) throw new Error('no such file ' + p);
      const s = store.get(p);
      return stripBom ? s.replace(/^\uFEFF/, '') : s;
    },
    has: (re) => [...store.keys()].filter((p) => re.test(p)),
    sourceNames: ['test'],
    totalBytes: 0
  };
}

async function fileSetFromZip(file) {
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const map = {};
  for (const [p, entry] of Object.entries(zip.files)) {
    if (!entry.dir) map[p] = await entry.async('nodebuffer');
  }
  return fileSetFromMap(map);
}

async function loadFixture(fx) {
  if (fx.kind === 'zip') return fileSetFromZip(path.join(FIX, fx.file));
  if (fx.kind === 'file') return fileSetFromMap({ [fx.file]: fs.readFileSync(path.join(FIX, fx.file)) });
  const dir = path.join(FIX, fx.file);
  const map = {};
  for (const name of fs.readdirSync(dir)) map[name] = fs.readFileSync(path.join(dir, name)); // multi-file upload: bare names
  return fileSetFromMap(map);
}

const counts = (result) => {
  const v = Object.fromEntries(tiktok.views(result).map((view) => [view.id, view.entries.length]));
  return { followers: result.lists.followers.length, following: result.lists.following.length, notFollowingBack: v.notFollowingBack, fans: v.fans, mutual: v.mutual };
};

async function expectError(promise, code, params) {
  await assert.rejects(promise, (e) => {
    assert.equal(e.code, code, `expected ${code}, got ${e.code} (${e.message})`);
    assert.equal(e.name, 'UTError');
    if (params) assert.deepEqual(e.params, params);
    return true;
  });
}

const SAFE_URL = /^https:\/\/www\.tiktok\.com\/@[A-Za-z0-9._%]+$/;

/* ------------------------------------------------------------------ fixtures */
test('contract surface', () => {
  assert.equal(tiktok.id, 'tiktok');
  for (const fn of ['detect', 'parse', 'views']) assert.equal(typeof tiktok[fn], 'function');
});

for (const fx of MANIFEST) {
  test(`fixture ${fx.file}`, async () => {
    const fileSet = await loadFixture(fx);
    const score = tiktok.detect(fileSet.paths);
    assert.ok(score >= 0 && score <= 1);
    if (fx.detectMin != null) assert.ok(score >= fx.detectMin, `detect ${score} < ${fx.detectMin}`);
    if (fx.detectMax != null) assert.ok(score <= fx.detectMax, `detect ${score} > ${fx.detectMax}`);

    if (fx.error) return expectError(tiktok.parse(fileSet), fx.error.code, fx.error.params);

    const result = await tiktok.parse(fileSet);
    assert.equal(result.platform, 'tiktok');
    assert.deepEqual(counts(result), fx.counts);
    assert.equal(result.owner, fx.owner);
    assert.deepEqual(result.warnings.map((w) => w.code).sort(), [...fx.warnings].sort());
    for (const w of result.warnings) assert.equal(typeof w.params, 'object');
    assert.ok(result.files.length > 0 && result.files.every((f) => fileSet.paths.includes(f)));
    if (fx.format) assert.ok(result.files.every((f) => f.toLowerCase().endsWith('.' + fx.format)), `files ${result.files} not ${fx.format}`);
    if (fx.usedFile) assert.deepEqual(result.files, [fx.usedFile]);

    const all = [...result.lists.followers, ...result.lists.following];
    for (const e of all) {
      assert.deepEqual(Object.keys(e).sort(), ['key', 'name', 'ts', 'url', 'username']);
      assert.equal(e.key, e.username.toLowerCase());
      assert.equal(e.name, null);
      assert.ok(e.url === null || SAFE_URL.test(e.url), `unsafe url ${e.url}`);
      assert.ok(e.ts === null || Number.isFinite(e.ts));
    }
    if (fx.dates) {
      for (const [key, iso] of Object.entries(fx.dates)) {
        const e = all.find((x) => x.key === key);
        assert.ok(e, `missing ${key}`);
        assert.equal(new Date(e.ts).toISOString(), iso);
      }
    }
    if (fx.urlFor) {
      assert.deepEqual(all.filter((e) => e.url).map((e) => e.username).sort(), [...fx.urlFor].sort());
    }
  });
}

test('base fixtures produce the exact expected view members', async () => {
  const result = await tiktok.parse(await fileSetFromZip(path.join(FIX, 'json_profile_and_settings.zip')));
  const v = Object.fromEntries(tiktok.views(result).map((x) => [x.id, x.entries.map((e) => e.key).sort()]));
  assert.deepEqual(v.notFollowingBack, ['eve.cooks', 'frank__', 'grace.x']);
  assert.deepEqual(v.fans, ['carol', 'dave.k']);
  assert.deepEqual(v.mutual, ['alice.m', 'bob_22', 'mia_fit']);
  const eve = result.lists.following.find((e) => e.key === 'eve.cooks');
  assert.equal(eve.url, 'https://www.tiktok.com/@eve.cooks');
  assert.equal(new Date(eve.ts).toISOString(), '2024-05-03T10:15:00.000Z'); // UTC, not local time
});

test('XSS and javascript: usernames never become links and stay verbatim text', async () => {
  const result = await tiktok.parse(await fileSetFromZip(path.join(FIX, 'json_xss_usernames.zip')));
  const byName = new Map(result.lists.following.map((e) => [e.username, e]));
  for (const evil of ['<img src=x onerror=alert(1)>', 'javascript:alert(1)', '"><svg/onload=alert(2)>', "x' onmouseover='alert(3)", 'a&quot;b']) {
    assert.ok(byName.has(evil), `missing ${evil}`);
    assert.equal(byName.get(evil).url, null);
  }
  assert.ok(byName.has('spaced name'), 'surrounding whitespace is trimmed');
  assert.equal(byName.get('spaced name').url, null);
  assert.ok(byName.has('evil'), 'bidi override characters are stripped');
});

/* ------------------------------------------------------------------ variants inline */
test('case-insensitive file names and TikTok TXT with CR-only line endings', async () => {
  const fs1 = fileSetFromMap({ 'EXPORT/USER_DATA_TIKTOK.JSON': JSON.stringify({ 'Your Activity': { Follower: { FansList: [{ UserName: 'a' }] }, Following: { Following: [{ UserName: 'b' }] } } }) });
  assert.ok(tiktok.detect(fs1.paths) > 0.9);
  assert.equal((await tiktok.parse(fs1)).lists.following[0].username, 'b');

  const txt = (u) => `Date: 2023-01-01 00:00:00 UTC\rUsername: ${u}\r\r`;
  const fs2 = fileSetFromMap({ 'FOLLOWER.TXT': txt('a'), 'FOLLOWING.TXT': txt('b') });
  const r2 = await tiktok.parse(fs2);
  assert.equal(r2.lists.followers[0].username, 'a');
  assert.equal(r2.lists.following[0].ts, Date.UTC(2023, 0, 1));
});

test('TXT records without blank lines and in reversed label order', () => {
  const { parseTxt } = tiktok._internal;
  assert.deepEqual(parseTxt('Date: 2023-01-01 00:00:00 UTC\nUsername: a\nDate: 2023-01-02 00:00:00 UTC\nUsername: b\n'),
    [{ user: 'a', date: '2023-01-01 00:00:00 UTC' }, { user: 'b', date: '2023-01-02 00:00:00 UTC' }]);
  assert.deepEqual(parseTxt('Username: a\nDate: 2023-01-01 00:00:00 UTC\n\nUsername: b\nDate: 2023-01-02 00:00:00 UTC'),
    [{ user: 'a', date: '2023-01-01 00:00:00 UTC' }, { user: 'b', date: '2023-01-02 00:00:00 UTC' }]);
  assert.deepEqual(parseTxt('Username: only\n'), [{ user: 'only', date: null }]);
});

test('JSON with BOM is accepted even if the FileSet did not strip it', async () => {
  const doc = { 'Profile And Settings': { Follower: { FansList: [{ UserName: 'a' }] }, Following: { Following: [{ UserName: 'b' }] } } };
  const r = await tiktok.parse(fileSetFromMap({ 'user_data_tiktok.json': '\uFEFF' + JSON.stringify(doc) }, { stripBom: false }));
  assert.equal(r.lists.followers.length, 1);
});

test('lists as bare arrays and deep-nested unknown sections are found', async () => {
  const r1 = await tiktok.parse(fileSetFromMap({ 'user_data.json': JSON.stringify({ Follower: [{ UserName: 'a' }], Following: [{ UserName: 'b' }] }) }));
  assert.deepEqual([r1.lists.followers.length, r1.lists.following.length], [1, 1]);
  const r2 = await tiktok.parse(fileSetFromMap({ 'user_data_tiktok.json': JSON.stringify({ Something: { Deeper: { FansList: [{ UserName: 'a' }], 'Following List': [{ Username: 'b' }, { Username: 'c' }] } } }) }));
  assert.deepEqual([r2.lists.followers.length, r2.lists.following.length], [1, 2]);
});

test('an unrelated "List" array never counts as a follower list', async () => {
  const doc = { 'Your Activity': { Following: { Following: [{ UserName: 'b' }] }, 'Block List': { List: [] } } };
  await expectError(tiktok.parse(fileSetFromMap({ 'user_data_tiktok.json': JSON.stringify(doc) })), 'MISSING_LIST', { list: 'followers' });
});

test('dates: Safari-safe UTC parsing, epochs and invalid values', () => {
  const { parseDate } = tiktok._internal;
  assert.equal(parseDate('2023-08-23 06:18:18 UTC'), Date.UTC(2023, 7, 23, 6, 18, 18));
  assert.equal(parseDate('2024-05-01 10:00:00'), Date.UTC(2024, 4, 1, 10));
  assert.equal(parseDate('2024-05-01'), Date.UTC(2024, 4, 1));
  assert.equal(parseDate(1700000000), 1700000000000);
  assert.equal(parseDate('1700000000000'), 1700000000000);
  for (const bad of [null, '', 'N/A', 'yesterday-ish', 0, -5, NaN]) assert.equal(parseDate(bad), null);
});

/* ------------------------------------------------------------------ errors */
test('errors use UT.UTError when ut-core.js is loaded', async () => {
  class UTError extends Error {
    constructor(code, params = {}) { super(code); this.name = 'UTError'; this.code = code; this.params = params; }
  }
  globalThis.UT = { UTError };
  try {
    await assert.rejects(tiktok.parse(fileSetFromMap({ 'readme.txt': 'x' })), (e) => e instanceof UTError && e.code === 'NO_RELEVANT_FILES');
  } finally {
    delete globalThis.UT;
  }
});

test('empty and junk-only uploads', async () => {
  await expectError(tiktok.parse(fileSetFromMap({})), 'NO_RELEVANT_FILES');
  await expectError(tiktok.parse({ paths: ['__MACOSX/._user_data_tiktok.json'], read: async () => '' }), 'NO_RELEVANT_FILES');
  assert.equal(tiktok.detect([]), 0);
  assert.equal(tiktok.detect(['__MACOSX/x/._user_data_tiktok.json']), 0);
  assert.equal(tiktok.detect(undefined), 0);
});

test('detect ranks TikTok far above other platforms', () => {
  const ig = ['connections/followers_and_following/followers_1.json', 'connections/followers_and_following/following.json'];
  const fb = ['connections/friends/your_friends.json', "connections/followers/who_you've_followed.json"];
  const x = ['data/follower.js', 'data/following.js', 'data/account.js'];
  for (const p of [ig, fb, x]) assert.ok(tiktok.detect(p) <= 0.05, p.join());
  assert.ok(tiktok.detect(['TikTok_Data_1/user_data_tiktok.json']) > 0.95);
  assert.ok(tiktok.detect(['Profile and Settings/Follower.txt', 'Profile and Settings/Following.txt']) >= 0.9);
  assert.ok(tiktok.detect(['my_export.json']) < 0.5, 'unknown single JSON is only a weak hint');
});

test('a bare JSON file with unknown content is not accepted', async () => {
  await expectError(tiktok.parse(fileSetFromMap({ 'data.json': JSON.stringify({ hello: 'world' }) })), 'NO_RELEVANT_FILES');
  await expectError(tiktok.parse(fileSetFromMap({ 'data.json': JSON.stringify({ friends_v2: [] }) })), 'WRONG_PLATFORM', { platform: 'facebook' });
});

/* ------------------------------------------------------------------ views */
function entry(key, ts) {
  return { key, username: key, name: null, url: 'https://www.tiktok.com/@' + key, ts };
}

test('views: set logic, primary flag, date keys and ordering', () => {
  const result = {
    platform: 'tiktok', files: [], warnings: [], owner: null,
    lists: {
      followers: [entry('a', 500), entry('b', 100), entry('c', null)],
      following: [entry('a', 300), entry('b', 200), entry('d', 400), entry('e', null)]
    }
  };
  const views = tiktok.views(result);
  assert.deepEqual(views.map((v) => v.id), ['notFollowingBack', 'fans', 'mutual', 'following', 'followers']);
  assert.deepEqual(views.filter((v) => v.primary).map((v) => v.id), ['notFollowingBack']);
  const by = Object.fromEntries(views.map((v) => [v.id, v]));
  assert.equal(by.notFollowingBack.dateKey, 'followedSince');
  assert.equal(by.fans.dateKey, 'followsYouSince');
  assert.equal(by.mutual.dateKey, 'friendsSince');
  assert.deepEqual(by.notFollowingBack.entries.map((e) => e.key), ['d', 'e']);
  assert.deepEqual(by.fans.entries.map((e) => e.key), ['c']);
  // friendsSince = the later of the two follow dates; newest first
  assert.deepEqual(by.mutual.entries.map((e) => [e.key, e.ts]), [['a', 500], ['b', 200]]);
  // input entries are not mutated
  assert.equal(result.lists.following[0].ts, 300);
});

test('views: property check on random data (partition + no duplicates)', () => {
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let round = 0; round < 20; round++) {
    const pool = Array.from({ length: 60 }, (_, i) => 'u' + i);
    const followers = pool.filter(() => rnd() < 0.5).map((k) => entry(k, Math.floor(rnd() * 1e6)));
    const following = pool.filter(() => rnd() < 0.5).map((k) => entry(k, Math.floor(rnd() * 1e6)));
    const by = Object.fromEntries(tiktok.views({ lists: { followers, following } }).map((v) => [v.id, new Set(v.entries.map((e) => e.key))]));
    const F = new Set(followers.map((e) => e.key));
    const G = new Set(following.map((e) => e.key));
    for (const k of by.notFollowingBack) assert.ok(G.has(k) && !F.has(k));
    for (const k of by.fans) assert.ok(F.has(k) && !G.has(k));
    for (const k of by.mutual) assert.ok(F.has(k) && G.has(k));
    assert.equal(by.notFollowingBack.size + by.mutual.size, G.size);
    assert.equal(by.fans.size + by.mutual.size, F.size);
  }
});

test('views tolerate a result with missing lists', () => {
  const views = tiktok.views({ lists: {} });
  assert.ok(views.every((v) => Array.isArray(v.entries) && v.entries.length === 0));
});

/* ------------------------------------------------------------------ performance */
test('100k entries: parse + views under 1.5 s (JSON and TXT)', async () => {
  const N = 100000;
  const d = (i) => `2024-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')} 10:00:00`;
  const following = Array.from({ length: N }, (_, i) => ({ Date: d(i), UserName: 'user_' + i }));
  const fans = following.filter((_, i) => i % 2 === 0).map((e) => ({ Date: e.Date, UserName: e.UserName.toUpperCase() }));
  const json = JSON.stringify({ 'Profile And Settings': { Follower: { FansList: fans }, Following: { Following: following } } });

  let t0 = performance.now();
  const r = await tiktok.parse(fileSetFromMap({ 'user_data_tiktok.json': json }));
  const v = tiktok.views(r);
  const jsonMs = performance.now() - t0;
  assert.equal(v[0].entries.length, N / 2);
  assert.equal(v[2].entries.length, N / 2);
  assert.ok(jsonMs < 1500, `JSON took ${jsonMs.toFixed(0)} ms`);

  const txt = (list) => list.map((e) => `Date: ${e.Date} UTC\nUsername: ${e.UserName}\n`).join('\n');
  t0 = performance.now();
  const r2 = await tiktok.parse(fileSetFromMap({ 'Follower.txt': txt(fans), 'Following.txt': txt(following) }));
  tiktok.views(r2);
  const txtMs = performance.now() - t0;
  assert.equal(r2.lists.following.length, N);
  assert.ok(txtMs < 1500, `TXT took ${txtMs.toFixed(0)} ms`);
});
