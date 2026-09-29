'use strict';
/*
 * Unit tests for src/parsers/facebook.js.
 * Fixtures: tests/fixtures/facebook (regenerate with `node tests/fixtures/facebook/generate.js`);
 * expected.json holds the outcome every fixture must produce.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const JSZip = require('jszip');

const PARSER_FILE = path.join(__dirname, '../../src/parsers/facebook.js');
const fb = require(PARSER_FILE);
const { large, T0 } = require('../fixtures/facebook/generate.js');

const FIX = path.join(__dirname, '../fixtures/facebook');
const expected = JSON.parse(fs.readFileSync(path.join(FIX, 'expected.json'), 'utf8'));

/* ------------------------------------------------------------------ helpers */

/**
 * Minimal stand-in for UT.files' FileSet: normalises separators like ut-files.js does, but on
 * purpose keeps __MACOSX/._ entries and BOMs so the parser's own defences are exercised.
 */
function fileSetFromMap(map, sourceNames = []) {
  const byPath = new Map();
  for (const [p, content] of Object.entries(map)) byPath.set(p.replace(/\\/g, '/').replace(/^\.\//, ''), content);
  return {
    paths: [...byPath.keys()],
    sourceNames,
    read: async (p) => {
      if (!byPath.has(p)) throw new Error('not found: ' + p);
      const c = await byPath.get(p);
      return typeof c === 'string' ? c : Buffer.from(c).toString('utf8');
    },
  };
}

async function fileSetFromZip(file) {
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const map = {};
  zip.forEach((p, entry) => { if (!entry.dir) map[p] = entry.async('string'); });
  return fileSetFromMap(map, [path.basename(file)]);
}

async function fileSetFor(name) {
  const file = path.join(FIX, name);
  if (/\.zip$/i.test(name)) return fileSetFromZip(file);
  return fileSetFromMap({ [path.basename(name)]: fs.readFileSync(file, 'utf8') }, [path.basename(name)]);
}

function detectBand(score) {
  if (score >= 0.9) return 'high';
  if (score >= 0.5) return 'medium';
  if (score >= 0.2) return 'weak';
  if (score > 0) return 'low';
  return 'none';
}

async function rejectsWith(promise, code, params) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.name, 'UTError');
    assert.equal(err.code, code);
    if (params) assert.deepEqual(err.params, params);
    return true;
  });
}

const viewById = (views, id) => views.find((v) => v.id === id);
const names = (entries) => entries.map((e) => e.name);
const entry = (name, ts = null) => ({ key: fb._internal.nameKey(name), username: null, name, url: null, ts });

/* --------------------------------------------------------- fixture outcomes */

for (const [name, exp] of Object.entries(expected)) {
  test(`fixture ${name}`, async () => {
    const fileSet = await fileSetFor(name);
    assert.equal(detectBand(fb.detect(fileSet.paths)), exp.detect, 'detect score band');

    if (exp.error) {
      await rejectsWith(fb.parse(fileSet), exp.error.code, exp.error.params);
      return;
    }
    const result = await fb.parse(fileSet);
    assert.equal(result.platform, 'facebook');
    if ('owner' in exp) assert.equal(result.owner, exp.owner);
    if (exp.warnings) assert.deepEqual(result.warnings, exp.warnings);
    assert.ok(result.files.length > 0 && result.files.every((f) => fileSet.paths.includes(f)));

    const views = fb.views(result);
    assert.deepEqual(views.map((v) => v.id).sort(), Object.keys(exp.views).sort(), 'view ids');
    assert.deepEqual(views.filter((v) => v.primary).map((v) => v.id), [exp.primary], 'exactly one primary view');
    for (const [id, want] of Object.entries(exp.views)) {
      const v = viewById(views, id);
      if (Array.isArray(want)) assert.deepEqual(names(v.entries).sort(), [...want].sort(), `view ${id}`);
      else assert.equal(v.entries.length, want, `view ${id} count`);
    }

    // Entry invariants: names only, never a link, stable lowercase keys, ms timestamps.
    for (const list of Object.values(result.lists)) {
      const keys = new Set();
      for (const e of list) {
        assert.deepEqual(Object.keys(e).sort(), ['key', 'name', 'ts', 'url', 'username']);
        assert.equal(e.url, null);
        assert.equal(e.username, null);
        assert.ok(e.key && e.key === e.key.toLowerCase(), 'lowercase key');
        assert.ok(!keys.has(e.key), 'unique key ' + e.key);
        keys.add(e.key);
        assert.ok(!/[\x00-\x1f\x7f-\x9f]/.test(e.name), 'no control chars');
        assert.ok(e.ts === null || (Number.isInteger(e.ts) && e.ts > Date.UTC(2004, 0, 1) && e.ts < Date.UTC(2030, 0, 1)), 'ts in ms');
      }
    }
  });
}

/* ------------------------------------------------------------- JSON variants */

test('current JSON export: mojibake repaired, timestamps in ms, homonyms kept apart', async () => {
  const r = await fb.parse(await fileSetFor('fb_2025_json.zip'));
  const friends = names(r.lists.friends);
  for (const n of ['Jürgen Müller', 'José Álvarez', 'Zoë 🌸 Dupont', 'Ali Yılmaz', 'Łukasz Wójcik']) assert.ok(friends.includes(n), n);
  assert.equal(r.lists.friends[0].ts, T0 * 1000);
  const smiths = r.lists.friends.filter((e) => e.name === 'John Smith');
  assert.deepEqual(smiths.map((e) => e.key), ['john smith', `john smith#${T0 - 400 * 86400}`]);
  // people_who_followed_you_1 + _2 overlap by one entry
  assert.equal(r.lists.followers.length, 4);
  assert.deepEqual(r.lists.removedFriends.map((e) => e.name), ['Old Friend']);
  assert.ok(r.files.includes('personal_information/profile_information/profile_information.json'));
  assert.ok(!r.files.some((f) => /people_you_may_know|your_posts/.test(f)), 'unrelated files are not read');
});

test('view date keys follow the contract', async () => {
  const views = fb.views(await fb.parse(await fileSetFor('fb_2025_json.zip')));
  const dateKeys = Object.fromEntries(views.map((v) => [v.id, v.dateKey]));
  assert.deepEqual(dateKeys, {
    notFollowingBack: 'followedSince', fans: 'followsYouSince', mutual: 'followedSince', friends: 'friendsSince',
    removedFriends: 'removedOn', sentRequests: 'requestedOn', receivedRequests: 'requestedOn', rejectedRequests: 'requestedOn',
    following: 'followedSince', followers: 'followsYouSince',
  });
  assert.equal(views[0].id, 'notFollowingBack');
});

test('macOS re-zip: wrapper folder, __MACOSX and ._ files ignored, BOM stripped, owner from folder name', async () => {
  const fs1 = await fileSetFor('fb_2025_json_macos_rezip.zip');
  assert.ok(fs1.paths.some((p) => p.startsWith('__MACOSX/')));
  const r = await fb.parse(fs1);
  assert.ok(!r.files.some((f) => /__MACOSX|\/\._/.test(f)));
  assert.equal(r.owner, 'janedoe');
});

test('numbered parts are merged in natural order and deduplicated', async () => {
  const r = await fb.parse(await fileSetFor('fb_multipart.zip'));
  assert.equal(r.lists.following.length, 9);
  assert.deepEqual(r.files.filter((f) => /people_who_followed_you/.test(f)).map((f) => path.basename(f)),
    ['people_who_followed_you_1.json', 'people_who_followed_you_2.json', 'people_who_followed_you_10.json']);
});

test('JSON wins over HTML when both formats of a list are uploaded', async () => {
  const r = await fb.parse(await fileSetFor('fb_mixed_json_html.zip'));
  assert.ok(!names(r.lists.friends).includes('Only In Html'));
  assert.ok(!r.files.some((f) => f.endsWith('.html')));
});

test('owner falls back to sourceNames and ignores unrelated names', async () => {
  const map = { 'connections/friends/your_friends.json': JSON.stringify({ friends_v2: [{ name: 'A', timestamp: T0 }] }) };
  assert.equal((await fb.parse(fileSetFromMap(map, ['facebook-max.mustermann-2025-01-02-XyZ.zip']))).owner, 'maxmustermann');
  assert.equal((await fb.parse(fileSetFromMap(map, ['my-export.zip']))).owner, null);
});

test('unknown single-array key, BOM and string items are tolerated', async () => {
  const r = await fb.parse(fileSetFromMap({
    'connections/friends/your_friends.json': '﻿' + JSON.stringify({ friends_v9: [{ name: 'A', timestamp: T0 }, 'B'] }),
  }));
  assert.deepEqual(names(r.lists.friends), ['A', 'B']);
  assert.equal(r.lists.friends[1].ts, null);
});

test('several arrays under unknown keys are ambiguous → CORRUPT_FILE', async () => {
  await rejectsWith(fb.parse(fileSetFromMap({
    'connections/friends/your_friends.json': JSON.stringify({ a: [{ name: 'A' }], b: [{ name: 'B' }] }),
  })), 'CORRUPT_FILE', { file: 'connections/friends/your_friends.json' });
});

test('unreadable file → CORRUPT_FILE', async () => {
  const set = fileSetFromMap({ 'connections/friends/your_friends.json': '{}' });
  set.read = async () => { throw new Error('boom'); };
  await rejectsWith(fb.parse(set), 'CORRUPT_FILE', { file: 'connections/friends/your_friends.json' });
});

test('empty and non-object items are skipped with a SKIPPED_UNNAMED warning', async () => {
  const r = await fb.parse(fileSetFromMap({
    'connections/friends/your_friends.json': JSON.stringify({ friends_v2: [{ name: 'A' }, { name: '   ' }, 42, null, { name: 7 }] }),
  }));
  assert.deepEqual(names(r.lists.friends), ['A']);
  assert.deepEqual(r.warnings, [{ code: 'SKIPPED_UNNAMED', params: { count: 4 } }]);
});

test('Instagram content inside a Facebook-looking file name → WRONG_PLATFORM', async () => {
  const ig = [{ title: '', string_list_data: [{ href: 'https://www.instagram.com/alice', value: 'alice', timestamp: T0 }] }];
  await rejectsWith(fb.parse(fileSetFromMap({ 'followers_1.json': JSON.stringify(ig), 'following.json': '{"following_v3":[]}' })),
    'WRONG_PLATFORM', { platform: 'instagram' });
});

/* ------------------------------------------------------------- HTML variants */

test('current HTML export: names from rows only, entities decoded, local dates parsed', async () => {
  const r = await fb.parse(await fileSetFor('fb_2025_html.zip'));
  assert.ok(!names(r.lists.friends).includes('Back to your information'));
  assert.ok(!names(r.lists.friends).includes('Your friends'));
  assert.equal(r.lists.friends[0].name, 'Anna Schmidt');
  assert.equal(r.lists.friends[0].ts, new Date(2023, 10, 14, 22, 13, 20).getTime());
  assert.ok(names(r.lists.following).includes('=HYPERLINK("http://evil.example","x")'));
  assert.ok(names(r.lists.following).includes('<img src=x onerror=alert(1)>'));
});

test('legacy HTML export (uiBoxWhite / _2lel / _2lem)', async () => {
  const r = await fb.parse(await fileSetFor('fb_2019_html.zip'));
  assert.equal(r.lists.friends[0].ts, new Date(2019, 2, 1, 14, 5).getTime());
  assert.ok(r.lists.followers.every((e) => e.ts === null));
});

test('German HTML dates', async () => {
  const r = await fb.parse(await fileSetFor('fb_2025_html_de.zip'));
  assert.deepEqual(r.lists.friends.map((e) => [e.name, e.ts]), [
    ['Anna Schmidt', new Date(2023, 10, 14, 22, 13).getTime()],
    ['Jürgen Müller', new Date(2021, 2, 3, 8, 5).getTime()],
  ]);
});

test('parseHtmlDate formats', () => {
  const p = fb._internal.parseHtmlDate;
  const at = (...a) => new Date(...a).getTime();
  assert.equal(p('Nov 14, 2023 10:13:20 pm'), at(2023, 10, 14, 22, 13, 20));
  assert.equal(p('Nov 14, 2023 12:05:00 am'), at(2023, 10, 14, 0, 5, 0));
  assert.equal(p('Nov 14, 2023 12:05 PM'), at(2023, 10, 14, 12, 5, 0));
  assert.equal(p('November 14, 2023 at 10:13 PM'), at(2023, 10, 14, 22, 13));
  assert.equal(p('14 nov. 2023, 22:13'), at(2023, 10, 14, 22, 13));
  assert.equal(p('14 de nov. de 2023 22:13'), at(2023, 10, 14, 22, 13));
  assert.equal(p('mardi 14 juin 2022'), at(2022, 5, 14));
  assert.equal(p('14 juil. 2022'), at(2022, 6, 14));
  assert.equal(p('14 października 2022, 09:00'), at(2022, 9, 14, 9, 0));
  assert.equal(p('14 mrt 2022'), at(2022, 2, 14));
  assert.equal(p('2023-11-14T22:13:20'), at(2023, 10, 14, 22, 13, 20));
  assert.equal(p('14.11.2023 22:13'), at(2023, 10, 14, 22, 13));
  assert.equal(p('Feb 30, 2023'), null);
  assert.equal(p('yesterday'), null);
  assert.equal(p(''), null);
});

test('parseHtmlList ignores scripts, styles and navigation links', () => {
  const html = '<html><head><script>var x="<div class=\\"_a6-g\\"><div class=\\"_a6-h\\">Evil</div></div>"</script></head><body>' +
    '<a href="javascript:alert(1)">Nav</a><div class="_a6-g"><div class="_a6-h">Anna &amp; Bob &#8211; &#x1F338;</div></div></body></html>';
  assert.deepEqual(fb._internal.parseHtmlList(html), [{ name: 'Anna & Bob – \u{1F338}', ts: null }]);
});

/* ---------------------------------------------------------------- set logic */

test('views: friends excluded from notFollowingBack and fans, homonyms matched as a multiset', () => {
  const result = {
    platform: 'facebook', files: [], warnings: [], owner: null,
    lists: {
      friends: [entry('Friend F')],
      following: [entry('A'), entry('Friend F'), entry('John Smith', 1), { ...entry('John Smith', 2), key: 'john smith#0' }, entry('Page P')],
      followers: [entry('A'), entry('john  SMITH'), entry('Fan'), entry('Friend F')],
    },
  };
  const v = fb.views(result);
  assert.deepEqual(names(viewById(v, 'notFollowingBack').entries), ['John Smith', 'Page P']);
  assert.equal(viewById(v, 'notFollowingBack').entries[0].ts, 2, 'the unmatched homonym is reported');
  assert.deepEqual(names(viewById(v, 'fans').entries), ['Fan']);
  assert.deepEqual(names(viewById(v, 'mutual').entries), ['A', 'Friend F', 'John Smith']);
  assert.equal(viewById(v, 'notFollowingBack').primary, true);
  assert.ok(!viewById(v, 'friends').primary);
});

test('views: without both follow lists the friends view is primary and no comparison is shown', () => {
  const v = fb.views({ lists: { friends: [entry('A')], following: [entry('B')] } });
  assert.deepEqual(v.map((x) => x.id), ['friends', 'following']);
  assert.equal(viewById(v, 'friends').primary, true);
});

test('views: empty lists produce empty views, not missing ones', () => {
  const v = fb.views({ lists: { following: [], followers: [entry('A')] } });
  assert.equal(viewById(v, 'notFollowingBack').entries.length, 0);
  assert.deepEqual(names(viewById(v, 'fans').entries), ['A']);
});

test('name matching normalises case, whitespace, NFC and zero-width characters', () => {
  const k = fb._internal.nameKey;
  assert.equal(k('  Anna   SCHMIDT '), 'anna schmidt');
  assert.equal(k('Zoë'), k('Zoë'));
  assert.equal(k('Ann​a'), 'anna');
});

/* ------------------------------------------------------------------ helpers */

test('fixMojibake repairs Meta escapes and leaves real text alone', () => {
  const fix = fb._internal.fixMojibake;
  const moji = (s) => Buffer.from(s, 'utf8').toString('latin1');
  assert.equal(fix(moji('Jürgen Müller 🌸')), 'Jürgen Müller 🌸');
  assert.equal(fix('Café'), 'Café');
  assert.equal(fix('Jürgen'), 'Jürgen');
  assert.equal(fix('Zoë 🌸'), 'Zoë 🌸');
  assert.equal(fix(String.fromCharCode(0xc3)), String.fromCharCode(0xc3));
});

test('classify: FB names anywhere, generic names only in FB folders, Instagram layout never', () => {
  const c = (p) => (fb._internal.classify(p) || {}).kind || null;
  assert.equal(c("wrap/connections/followers/who_you've_followed_2.json"), 'following');
  assert.equal(c('connections/followers/who_you’ve_followed.json'), 'following');
  assert.equal(c('CONNECTIONS/FRIENDS/Your_Friends.JSON'), 'friends');
  assert.equal(c('connections/friends/people_you_may_know.json'), null);
  assert.equal(c('friends_and_followers/friend_requests_received.html'), 'receivedRequests');
  assert.equal(c('connections/followers_and_following/following.json'), null);
  assert.equal(c('connections/followers_and_following/followers_1.json'), null);
  assert.equal(c('some/other/followers.json'), null);
  assert.equal(c('followers.json'), 'followers');
  assert.equal(c('__MACOSX/connections/friends/your_friends.json'), null);
  assert.equal(c('connections/friends/._your_friends.json'), null);
  assert.equal(c('connections/friends/your_friends.txt'), null);
});

test('detect: scores', () => {
  assert.ok(fb.detect(["facebook-x-2025-01-01-a/connections/followers/who_you've_followed.json"]) >= 0.9);
  assert.ok(fb.detect(['friends_and_followers/friends.json']) >= 0.9);
  assert.ok(fb.detect(['your_facebook_activity/posts/x.json']) >= 0.5);
  assert.ok(fb.detect(['connections/followers_and_following/followers_1.json', 'connections/followers_and_following/following.json']) < 0.1);
  assert.ok(fb.detect(['your_instagram_activity/likes/liked_posts.json', 'personal_information/personal_information.json']) < 0.1);
  assert.ok(fb.detect(['data/follower.js', 'data/following.js']) < 0.1);
  assert.ok(fb.detect(['user_data_tiktok.json']) < 0.1);
  assert.equal(fb.detect([]), 0);
  assert.equal(fb.detect(['readme.txt']), 0);
  assert.equal(fb.detect(undefined), 0);
});

/* -------------------------------------------------------------- error shape */

test('errors use UT.UTError when ut-core is loaded', async () => {
  class FakeUTError extends Error {
    constructor(code, params = {}) { super(code); this.name = 'UTError'; this.code = code; this.params = params; }
  }
  const prev = globalThis.UT;
  globalThis.UT = { UTError: FakeUTError };
  try {
    await assert.rejects(fb.parse(fileSetFromMap({ 'readme.txt': 'x' })), (e) => e instanceof FakeUTError && e.code === 'NO_RELEVANT_FILES');
  } finally {
    if (prev === undefined) delete globalThis.UT; else globalThis.UT = prev;
  }
});

test('without ut-core errors are plain Errors with code and params', async () => {
  await assert.rejects(fb.parse({ paths: [], read: async () => '' }), (e) =>
    e instanceof Error && e.name === 'UTError' && e.code === 'NO_RELEVANT_FILES' && e.message === 'NO_RELEVANT_FILES' && typeof e.params === 'object');
});

test('browser build attaches to window.UT.parsers.facebook without clobbering UT', () => {
  const sandbox = { TextDecoder, UT: { existing: true } };
  sandbox.window = sandbox;
  vm.runInNewContext(fs.readFileSync(PARSER_FILE, 'utf8'), sandbox);
  assert.equal(sandbox.UT.existing, true);
  assert.equal(sandbox.UT.parsers.facebook.id, 'facebook');
  assert.equal(typeof sandbox.UT.parsers.facebook.parse, 'function');
});

/* -------------------------------------------------------------- performance */

test('100k entries: parse + views < 1.5 s', async () => {
  const set = fileSetFromMap(large(100_000));
  const t = process.hrtime.bigint();
  const result = await fb.parse(set);
  const views = fb.views(result);
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  assert.equal(viewById(views, 'notFollowingBack').entries.length, 49_998);
  assert.equal(viewById(views, 'mutual').entries.length, 50_000);
  assert.ok(ms < 1500, `took ${ms.toFixed(0)} ms`);
});
