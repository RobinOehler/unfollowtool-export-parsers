'use strict';
/*
 * Unit tests for src/parsers/x.js (X/Twitter archive parser).
 * Fixtures: tests/fixtures/x (regenerate with `node tests/fixtures/x/generate.js`); expected.json
 * holds the outcome every fixture must produce.
 *
 * The FileSet helper below is intentionally dumber than ut-files.js: it keeps __MACOSX/._ entries and
 * UTF-8 BOMs so these tests prove the parser's own defences. It does normalize backslashes and a
 * leading "./", which the FileSet contract guarantees.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const JSZip = require('jszip');

const PARSER_PATH = path.join(__dirname, '../../src/parsers/x.js');
const X = require(PARSER_PATH);
const FIX = path.join(__dirname, '../fixtures/x');
const EXPECTED = JSON.parse(fs.readFileSync(path.join(FIX, 'expected.json'), 'utf8'));
const URL_RE = /^https:\/\/x\.com\/i\/user\/[1-9]\d{0,19}$/;

// ---------------------------------------------------------------- helpers

const normalize = (p) => p.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');

/** files: { path: string | Error | () => Promise<string> } → FileSet */
function memFileSet(files) {
  const map = new Map(Object.entries(files).map(([p, c]) => [normalize(p), c]));
  return {
    paths: [...map.keys()],
    async read(p) {
      if (!map.has(p)) throw new Error('ENOENT ' + p);
      const c = map.get(p);
      if (c instanceof Error) throw c;
      return typeof c === 'function' ? c() : c;
    },
    has: (re) => [...map.keys()].filter((p) => re.test(p)),
    sourceNames: ['test'],
    totalBytes: 0,
  };
}

async function fixtureFileSet(name) {
  if (name.startsWith('loose/')) {
    return memFileSet(Object.fromEntries(name.split('+').map((p) => [path.basename(p), fs.readFileSync(path.join(FIX, p), 'utf8')])));
  }
  const zip = await JSZip.loadAsync(fs.readFileSync(path.join(FIX, name)));
  const files = {};
  zip.forEach((rel, entry) => { if (!entry.dir) files[rel] = () => entry.async('string'); });
  return memFileSet(files);
}

const ytd = (type, part, rows) => `window.YTD.${type}.part${part} = ${JSON.stringify(rows, null, 2)}`;
const rows = (kind, ids) => ids.map((id) => ({ [kind]: { accountId: String(id), userLink: `https://twitter.com/intent/user?user_id=${id}` } }));
const keys = (entries) => entries.map((e) => e.key);
const viewMap = (result) => Object.fromEntries(X.views(result).map((v) => [v.id, v]));

async function rejectsWith(promise, code, params) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof Error, 'is an Error');
    assert.equal(err.code, code);
    if (params) assert.deepEqual(err.params, params);
    return true;
  });
}

// ---------------------------------------------------------------- module shape

test('exports the parser contract', () => {
  assert.equal(X.id, 'x');
  for (const fn of ['detect', 'parse', 'views']) assert.equal(typeof X[fn], 'function');
});

test('attaches to window.UT.parsers.x when loaded as a classic script', () => {
  const window = { UT: { parsers: { instagram: {} } } };
  vm.runInNewContext(fs.readFileSync(PARSER_PATH, 'utf8'), { window });
  assert.equal(window.UT.parsers.x.id, 'x');
  assert.ok(window.UT.parsers.instagram, 'keeps other parsers');
  const fresh = {};
  vm.runInNewContext(fs.readFileSync(PARSER_PATH, 'utf8'), { window: fresh });
  assert.equal(typeof fresh.UT.parsers.x.parse, 'function');
});

// ---------------------------------------------------------------- detect

test('detect scores X archives high and other exports low', () => {
  const cases = [
    [['Your archive.html', 'data/manifest.js', 'data/follower.js', 'data/following.js'], 0.99],
    [['follower.js', 'following.js'], 0.95],
    [['twitter-2026/data/follower-part1.js', 'twitter-2026/data/following.js', 'twitter-2026/data/account.js'], 0.99],
    [['DATA/FOLLOWER.JS', 'DATA/FOLLOWING.JS'], 0.95],
    [['data/following.js', 'data/account.js'], 0.9],
    [['data/follower.js'], 0.8],
    [['data/account.js', 'data/tweets.js', 'data/tweets_media/1-a.jpg'], 0.6],
    [['tweets.csv', 'data/js/tweets/2014_01.js'], 0.5],
    [['connections/followers_and_following/followers_1.json', 'connections/followers_and_following/following.json'], 0],
    [['connections/friends/your_friends.json', 'connections/followers/people_who_followed_you_1.json'], 0],
    [['user_data_tiktok.json'], 0],
    [['Your Activity/Follower.txt', 'Your Activity/Following.txt'], 0],
    [['__MACOSX/data/._follower.js', '__MACOSX/data/._following.js'], 0],
    [[], 0],
  ];
  for (const [paths, score] of cases) assert.equal(X.detect(paths), score, paths.join(', '));
  assert.equal(X.detect(null), 0);
  assert.equal(X.detect([42, null]), 0);
});

// ---------------------------------------------------------------- fixtures (expected.json)

for (const [name, exp] of Object.entries(EXPECTED)) {
  test(`fixture ${name}`, async () => {
    const fileSet = await fixtureFileSet(name);
    if (exp.error) {
      await rejectsWith(X.parse(fileSet), exp.error, exp.params);
      if (exp.error === 'WRONG_PLATFORM') assert.ok(X.detect(fileSet.paths) < 0.1, 'detect rejects other platforms');
      return;
    }
    assert.ok(X.detect(fileSet.paths) >= 0.9, 'detect accepts X archives');
    const result = await X.parse(fileSet);
    assert.equal(result.platform, 'x');
    assert.equal(result.lists.followers.length, exp.followers);
    assert.equal(result.lists.following.length, exp.following);
    if ('owner' in exp) assert.equal(result.owner, exp.owner);
    if (exp.exportedAt) assert.equal(result.exportedAt, Date.parse(exp.exportedAt));
    assert.deepEqual(result.warnings, exp.warnings || []);
    for (const p of result.files) assert.ok(fileSet.paths.includes(p), `files[] lists real paths (${p})`);

    const views = viewMap(result);
    for (const id of ['notFollowingBack', 'fans', 'mutual']) {
      const got = views[id].entries;
      if (Array.isArray(exp[id])) assert.deepEqual(keys(got), exp[id], id);
      else assert.equal(got.length, exp[id], id);
    }
    for (const e of [...result.lists.followers, ...result.lists.following]) {
      assert.match(e.url, URL_RE);
      assert.equal(e.url, 'https://x.com/i/user/' + e.key);
      assert.equal(e.username, null);
      assert.equal(e.name, null);
      assert.equal(e.ts, null);
    }
  });
}

test('every fixture in the folder is covered by expected.json', () => {
  const onDisk = fs.readdirSync(FIX).filter((f) => /\.zip$/i.test(f));
  for (const f of onDisk) assert.ok(f in EXPECTED, f);
});

// ---------------------------------------------------------------- set logic & views

test('views: set logic, archive order, primary flag, no dateKey, shared entries', async () => {
  const result = await X.parse(memFileSet({
    'data/follower.js': ytd('follower', 0, rows('follower', [1, 2, 3, 4])),
    'data/following.js': ytd('following', 0, rows('following', [9, 3, 8, 1, 7])),
  }));
  const views = X.views(result);
  assert.deepEqual(views.map((v) => v.id), ['notFollowingBack', 'fans', 'mutual']);
  assert.deepEqual(views.map((v) => v.primary === true), [true, false, false]);
  for (const v of views) assert.equal(v.dateKey, undefined);
  assert.deepEqual(keys(views[0].entries), ['9', '8', '7']);
  assert.deepEqual(keys(views[1].entries), ['2', '4']);
  assert.deepEqual(keys(views[2].entries), ['3', '1']);
  const [followers1] = result.lists.followers;
  assert.equal(views[2].entries[1], followers1, 'entries are shared, not copied');
  assert.equal(result.lists.following.length, 5, 'views do not mutate lists');
});

test('views tolerate missing lists', () => {
  for (const v of X.views({ lists: {} })) assert.deepEqual(v.entries, []);
  for (const v of X.views(null)) assert.deepEqual(v.entries, []);
  const e = { key: '5', username: null, name: null, url: 'https://x.com/i/user/5', ts: null };
  assert.deepEqual(keys(X.views({ lists: { following: [e] } })[0].entries), ['5']);
});

// ---------------------------------------------------------------- variants

test('merges numbered parts in part order and dedupes across parts', async () => {
  const result = await X.parse(memFileSet({
    'data/follower-part2.js': ytd('follower', 2, rows('follower', [5, 1])),
    'data/follower.js': ytd('follower', 0, rows('follower', [1, 2])),
    'data/follower-part1.js': ytd('follower', 1, rows('follower', [3, 4])),
    'data/following_2.js': ytd('following', 1, rows('following', [7])),
    'data/following_1.js': ytd('following', 0, rows('following', [6])),
  }));
  assert.deepEqual(keys(result.lists.followers), ['1', '2', '3', '4', '5']);
  assert.deepEqual(keys(result.lists.following), ['6', '7']);
  assert.deepEqual(result.files.slice(0, 3), ['data/follower.js', 'data/follower-part1.js', 'data/follower-part2.js']);
});

test('matches paths case-insensitively and reads the original path', async () => {
  const result = await X.parse(memFileSet({
    'Twitter-Export/DATA/Follower.JS': ytd('follower', 0, rows('follower', [1])),
    'Twitter-Export/DATA/FOLLOWING-PART1.js': ytd('following', 1, rows('following', [2])),
    'Twitter-Export/DATA/Following.js': ytd('following', 0, rows('following', [1])),
    'Twitter-Export/DATA/Account.JS': ytd('account', 0, [{ account: { username: 'MixedCase_1', accountId: '10' } }]),
  }));
  assert.deepEqual(keys(result.lists.following), ['1', '2']);
  assert.equal(result.owner, 'mixedcase_1');
  assert.ok(result.files.includes('Twitter-Export/DATA/Account.JS'));
});

test('accepts plain JSON content without the window.YTD prefix', async () => {
  const result = await X.parse(memFileSet({
    'follower.js': JSON.stringify(rows('follower', [1])),
    'following.js': '﻿' + JSON.stringify(rows('following', [1, 2])) + ' ;\n',
  }));
  assert.deepEqual(keys(X.views(result)[0].entries), ['2']);
});

test('combines lists found in two different folders', async () => {
  const result = await X.parse(memFileSet({
    'a/follower.js': ytd('follower', 0, rows('follower', [1])),
    'b/data/following.js': ytd('following', 0, rows('following', [1, 2])),
  }));
  assert.deepEqual(keys(X.views(result)[0].entries), ['2']);
  assert.deepEqual(result.warnings, []);
});

test('several exports: prefers the newest manifest, then the last folder name', async () => {
  const archive = (dir, ids) => ({
    [dir + 'follower.js']: ytd('follower', 0, rows('follower', ids)),
    [dir + 'following.js']: ytd('following', 0, rows('following', ids)),
  });
  const result = await X.parse(memFileSet({ ...archive('twitter-2025-01-01/data/', [1]), ...archive('twitter-2026-02-02/data/', [2, 3]) }));
  assert.deepEqual(keys(result.lists.followers), ['2', '3']);
  assert.deepEqual(result.warnings, [{ code: 'MULTIPLE_EXPORTS', params: { count: 2, used: 'twitter-2026-02-02/data' } }]);
});

test('owner falls back to manifest userInfo; exportedAt from generationDate', async () => {
  const result = await X.parse(memFileSet({
    'data/manifest.js': 'window.__THAR_CONFIG = ' + JSON.stringify({
      userInfo: { accountId: '10', userName: 'From_Manifest', displayName: 'x' },
      archiveInfo: { generationDate: '2026-03-04T05:06:07.000Z' },
      dataTypes: { follower: { files: [{ fileName: 'data/follower.js' }] }, following: { files: [{ fileName: 'data/following.js' }] } },
    }),
    'data/follower.js': ytd('follower', 0, rows('follower', [1])),
    'data/following.js': ytd('following', 0, rows('following', [1])),
  }));
  assert.equal(result.owner, 'from_manifest');
  assert.equal(result.exportedAt, Date.parse('2026-03-04T05:06:07.000Z'));
  assert.deepEqual(result.files, ['data/follower.js', 'data/following.js', 'data/manifest.js']);
});

test('broken optional files (account.js, manifest.js) are ignored', async () => {
  const result = await X.parse(memFileSet({
    'data/manifest.js': 'window.__THAR_CONFIG = {',
    'data/account.js': new Error('read failed'),
    'data/follower.js': ytd('follower', 0, rows('follower', [1])),
    'data/following.js': ytd('following', 0, rows('following', [2])),
  }));
  assert.equal(result.owner, null);
  assert.equal(result.exportedAt, null);
  assert.deepEqual(result.files, ['data/follower.js', 'data/following.js']);
});

test('never trusts userLink: URLs are rebuilt from validated IDs', async () => {
  const result = await X.parse(memFileSet({
    'follower.js': ytd('follower', 0, [
      { follower: { accountId: '42', userLink: 'javascript:alert(1)' } },
      { follower: { userLink: 'https://x.com/intent/user?user_id=43' } },
      { follower: { userLink: 'http://twitter.com/intent/user?user_id=44' } },
      { follower: { userLink: 'https://twitter.com.evil.example/intent/user?user_id=45' } },
      { follower: { accountId: '<svg onload=alert(1)>', userLink: 'https://twitter.com/intent/user?user_id=46' } },
      { follower: { accountId: ['47'] } },
      { follower: { accountId: -48 } },
      { follower: 'javascript:alert(1)' },
    ]),
    'following.js': ytd('following', 0, rows('following', [42])),
  }));
  assert.deepEqual(keys(result.lists.followers), ['42', '43']);
  for (const e of result.lists.followers) assert.match(e.url, URL_RE);
  assert.deepEqual(result.warnings, [{ code: 'SKIPPED_ENTRIES', params: { count: 6 } }]);
});

test('owner names that are not valid X handles are dropped', async () => {
  for (const username of ['<img src=x onerror=alert(1)>', 'javascript:alert(1)', '', 42, 'a'.repeat(51)]) {
    const result = await X.parse(memFileSet({
      'data/account.js': ytd('account', 0, [{ account: { username } }]),
      'data/follower.js': ytd('follower', 0, rows('follower', [1])),
      'data/following.js': ytd('following', 0, rows('following', [1])),
    }));
    assert.equal(result.owner, null, String(username));
  }
});

// ---------------------------------------------------------------- errors

test('CORRUPT_FILE for unparsable, non-array, swapped or unusable list files', async () => {
  const other = ytd('following', 0, rows('following', [1]));
  const cases = {
    'window.YTD.follower.part0 = [ { "follower" : ': 'data/follower.js',
    'window.YTD.follower.part0 = { "follower" : {} }': 'data/follower.js',
    [ytd('following', 0, rows('following', [1]))]: 'data/follower.js', // following data saved as follower.js
    [ytd('follower', 0, [{ foo: 1 }, { following: { accountId: '1' } }])]: 'data/follower.js',
    '': 'data/follower.js',
  };
  for (const [text, file] of Object.entries(cases)) {
    await rejectsWith(X.parse(memFileSet({ 'data/follower.js': text, 'data/following.js': other })), 'CORRUPT_FILE', { file });
  }
});

test('read failures: plain errors become CORRUPT_FILE, coded errors pass through', async () => {
  const other = ytd('following', 0, rows('following', [1]));
  await rejectsWith(X.parse(memFileSet({ 'data/follower.js': new Error('boom'), 'data/following.js': other })),
    'CORRUPT_FILE', { file: 'data/follower.js' });
  const coded = Object.assign(new Error('CORRUPT_ZIP'), { code: 'CORRUPT_ZIP', params: {} });
  await assert.rejects(X.parse(memFileSet({ 'data/follower.js': coded, 'data/following.js': other })), (err) => err === coded);
});

test('MISSING_LIST names the missing list', async () => {
  await rejectsWith(X.parse(memFileSet({ 'data/following.js': ytd('following', 0, rows('following', [1])), 'data/account.js': '[]' })),
    'MISSING_LIST', { list: 'followers' });
  await rejectsWith(X.parse(memFileSet({ 'follower.js': ytd('follower', 0, rows('follower', [1])) })),
    'MISSING_LIST', { list: 'following' });
});

test('NO_RELEVANT_FILES for X archives without follow lists and for unknown uploads', async () => {
  await rejectsWith(X.parse(memFileSet({ 'data/account.js': '[]', 'data/tweets.js': '[]' })), 'NO_RELEVANT_FILES', {});
  await rejectsWith(X.parse(memFileSet({})), 'NO_RELEVANT_FILES', {});
  await rejectsWith(X.parse(memFileSet({ '__MACOSX/data/._follower.js': 'x', '__MACOSX/data/._following.js': 'x' })), 'NO_RELEVANT_FILES');
  await rejectsWith(X.parse(null), 'NO_RELEVANT_FILES');
  await rejectsWith(X.parse({ paths: ['follower.js'] }), 'NO_RELEVANT_FILES');
});

test('EMPTY_LISTS when both lists are empty', async () => {
  await rejectsWith(X.parse(memFileSet({ 'follower.js': 'window.YTD.follower.part0 = [ ]', 'following.js': 'window.YTD.following.part0 = []' })), 'EMPTY_LISTS');
});

test('errors are plain Errors with code/params without ut-core.js', async () => {
  await assert.rejects(X.parse(memFileSet({})), (err) => {
    assert.equal(err.name, 'UTError');
    assert.equal(err.message, 'NO_RELEVANT_FILES');
    assert.deepEqual(err.params, {});
    return true;
  });
});

test('errors use UT.UTError when ut-core.js is loaded', async () => {
  class UTError extends Error {
    constructor(code, params = {}) { super(code); this.code = code; this.params = params; }
  }
  globalThis.UT = { UTError };
  try {
    await assert.rejects(X.parse(memFileSet({ 'follower.js': '[]' })), (err) => {
      assert.ok(err instanceof UTError);
      assert.equal(err.code, 'MISSING_LIST');
      assert.deepEqual(err.params, { list: 'following' });
      return true;
    });
  } finally {
    delete globalThis.UT;
  }
});

// ---------------------------------------------------------------- performance

test('100k following / 60k followers: parse + views under 1.5 s', async () => {
  const following = Array.from({ length: 100000 }, (_, i) => String(1500000000000000000n + BigInt(i * 7919)));
  const followers = following.filter((_, i) => i % 3 === 0).concat(Array.from({ length: 26666 }, (_, i) => String(1000000 + i)));
  const fileSet = memFileSet({
    'data/follower.js': ytd('follower', 0, rows('follower', followers)),
    'data/following.js': ytd('following', 0, rows('following', following)),
  });
  const t0 = performance.now();
  const result = await X.parse(fileSet);
  const views = X.views(result);
  const ms = performance.now() - t0;
  assert.equal(views[0].entries.length, 100000 - 33334);
  assert.equal(views[1].entries.length, 26666);
  assert.equal(views[2].entries.length, 33334);
  assert.ok(ms < 1500, `took ${ms.toFixed(0)} ms`);
});
