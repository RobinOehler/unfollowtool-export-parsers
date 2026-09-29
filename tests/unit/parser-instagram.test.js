'use strict';
/**
 * Unit tests for src/parsers/instagram.js.
 * Fixtures: tests/fixtures/instagram (regenerate with `node tests/fixtures/instagram/generate.js`);
 * the expected outcome of every fixture is in tests/fixtures/instagram/expected.json.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

const ig = require('../../src/parsers/instagram.js');

const FIX = path.join(__dirname, '..', 'fixtures', 'instagram');
const EXPECTED = JSON.parse(fs.readFileSync(path.join(FIX, 'expected.json'), 'utf8'));
const TS = 1735732800; // base timestamp of the fixtures (seconds)
const DAY = 86400;
const RE_SAFE_URL = /^https:\/\/www\.instagram\.com\/[A-Za-z0-9._]{1,30}\/$/;

/* ------------------------------------------------------------------ in-memory FileSet */

/**
 * Minimal FileSet as specified in README.md (ut-files.js is not used here): forward slashes,
 * no leading "./", __MACOSX/ and "._" entries removed, read() returns UTF-8 with the BOM stripped.
 * `raw: true` keeps the BOM to test the parser's own tolerance.
 */
function makeFileSet(entries, { sourceNames = [], raw = false } = {}) {
  const files = new Map();
  for (const [name, text] of entries) {
    const p = name.replace(/\\/g, '/').replace(/^(\.\/)+/, '');
    if (/(^|\/)__MACOSX\//i.test(p) || /(^|\/)\._[^/]*$/.test(p) || p.endsWith('/')) continue;
    files.set(p, text);
  }
  return {
    paths: Array.from(files.keys()),
    read: async (p) => {
      if (!files.has(p)) throw new Error('not in FileSet: ' + p);
      const t = files.get(p);
      return raw ? t : t.replace(/^\uFEFF/, '');
    },
    has: (re) => Array.from(files.keys()).filter((p) => re.test(p)),
    sourceNames,
    totalBytes: Array.from(files.values()).reduce((n, t) => n + t.length, 0)
  };
}

const fromObject = (obj, opts) => makeFileSet(Object.entries(obj), opts);

async function fromZip(name, opts = {}) {
  const zip = await JSZip.loadAsync(fs.readFileSync(path.join(FIX, name)));
  const entries = [];
  for (const f of Object.values(zip.files)) if (!f.dir) entries.push([f.name, await f.async('string')]);
  return makeFileSet(entries, Object.assign({ sourceNames: [name] }, opts));
}

function fromDir(dir) {
  const abs = path.join(FIX, dir);
  return makeFileSet(fs.readdirSync(abs).map((f) => [f, fs.readFileSync(path.join(abs, f), 'utf8')]), { sourceNames: fs.readdirSync(abs) });
}

const load = (name) => (name.endsWith('/') ? Promise.resolve(fromDir(name.slice(0, -1))) : fromZip(name));
const viewsById = (result) => Object.fromEntries(ig.views(result).map((v) => [v.id, v]));
const keys = (entries) => entries.map((e) => e.key).sort();

async function rejectsWith(promise, code, params) {
  await assert.rejects(promise, (e) => {
    assert.equal(e.name, 'UTError');
    assert.equal(e.code, code);
    if (params) assert.deepEqual(e.params, params);
    return true;
  });
}

/** Every entry must satisfy the Entry contract and carry only a safe profile URL. */
function assertEntries(entries) {
  for (const e of entries) {
    assert.equal(typeof e.key, 'string');
    assert.equal(e.key, e.key.toLowerCase());
    assert.equal(e.key, e.username.toLowerCase());
    assert.equal(e.name, null);
    assert.ok(e.url === null || RE_SAFE_URL.test(e.url), 'unsafe url ' + e.url);
    if (e.url) assert.equal(e.url, 'https://www.instagram.com/' + e.username + '/');
    assert.ok(e.ts === null || (Number.isInteger(e.ts) && e.ts > 0));
  }
}

/* ------------------------------------------------------------------ all fixtures */

test('module shape (UMD export, contract fields)', () => {
  assert.equal(ig.id, 'instagram');
  for (const fn of ['detect', 'parse', 'views']) assert.equal(typeof ig[fn], 'function');
});

for (const [name, exp] of Object.entries(EXPECTED)) {
  test('fixture ' + name, async () => {
    const fileSet = await load(name);
    if (exp.error) {
      await rejectsWith(ig.parse(fileSet), exp.error, exp.params);
      return;
    }
    const result = await ig.parse(fileSet);
    assert.equal(result.platform, 'instagram');
    const counts = Object.fromEntries(Object.entries(result.lists).map(([k, v]) => [k, v.length]));
    assert.deepEqual(counts, exp.lists);
    Object.values(result.lists).forEach(assertEntries);
    const views = viewsById(result);
    for (const [id, n] of Object.entries(exp.views)) assert.equal(views[id].entries.length, n, 'view ' + id);
    assert.equal(result.owner, exp.owner);
    assert.deepEqual(result.warnings, exp.warnings);
    assert.ok(result.files.length > 0);
    result.files.forEach((f) => assert.ok(fileSet.paths.includes(f), 'unknown file ' + f));
  });
}

/* ------------------------------------------------------------------ detect */

test('detect: Instagram exports score high, other platforms low', async () => {
  for (const name of Object.keys(EXPECTED)) {
    const fileSet = await load(name);
    const score = ig.detect(fileSet.paths);
    assert.ok(score >= 0 && score <= 1);
    if (name.startsWith('foreign_')) assert.ok(score <= 0.05, name + ' scored ' + score);
    else if (name === 'loose/') assert.equal(score, 0.6);
    else if (name === 'ig_legacy_2020_connections.zip') assert.equal(score, 0.5);
    else if (name === 'ig_no_relevant.zip') assert.ok(score > 0.2 && score < 0.5, name + ' scored ' + score);
    else assert.ok(score >= 0.9, name + ' scored ' + score);
  }
  assert.equal(ig.detect([]), 0);
  assert.equal(ig.detect(['photo.jpg', 'notes.txt']), 0);
  assert.equal(ig.detect(['CONNECTIONS/Followers_And_Following/FOLLOWERS_1.JSON']), 0.95);
  // Threads' own followers files are not an Instagram follower export.
  assert.equal(ig.detect(['your_instagram_activity/threads/followers.json']), 0.4);
  // Facebook 2019 layout (same file names as Instagram) and Instagram paths mixed with Facebook files.
  assert.equal(ig.detect(['friends/friends.json', 'following_and_followers/followers.json', 'following_and_followers/following.json']), 0.05);
  assert.equal(ig.detect(['connections/followers_and_following/followers.json', 'personal_information/profile_information/profile_information.json']), 0.5);
});

test('Instagram-looking paths with Facebook files and a missing list → WRONG_PLATFORM', async () => {
  await rejectsWith(ig.parse(fromObject({
    'connections/followers_and_following/followers.json': JSON.stringify([]),
    'personal_information/profile_information/profile_information.json': '{}'
  })), 'WRONG_PLATFORM', { platform: 'facebook' });
});

/* ------------------------------------------------------------------ current format details */

test('2025 export: set logic, timestamps, owner, Threads and hashtags ignored', async () => {
  const result = await ig.parse(await fromZip('ig_2025_json.zip'));
  const v = viewsById(result);
  assert.deepEqual(keys(v.notFollowingBack.entries), ['gina.art', 'hugo_cooks', 'ivy.designs', 'jonas.dev']);
  assert.deepEqual(keys(v.fans.entries), ['fan.one', 'fan_two']);
  assert.deepEqual(keys(v.mutual.entries), ['anna.schmidt', 'ben_travel', 'carla.photo', 'david.k', 'emma_runs', 'felix.music']);
  assert.ok(!result.lists.followers.some((e) => e.key === 'threads.only'));
  assert.ok(!result.files.some((f) => /threads|hashtags|hide_story|favorited|recent_follow_requests/.test(f)));

  const gina = v.notFollowingBack.entries.find((e) => e.key === 'gina.art');
  assert.deepEqual(gina, { key: 'gina.art', username: 'gina.art', name: null, url: 'https://www.instagram.com/gina.art/', ts: (TS + 6 * DAY) * 1000 });
  // Lists are ordered newest first.
  assert.deepEqual(result.lists.following.slice(0, 2).map((e) => e.key), ['jonas.dev', 'ivy.designs']);
  // Mutual: the later of both follow dates.
  const david = v.mutual.entries.find((e) => e.key === 'david.k');
  assert.equal(david.ts, (TS + 3 * DAY) * 1000);

  assert.deepEqual(ig.views(result).map((x) => [x.id, x.dateKey || null, !!x.primary]), [
    ['notFollowingBack', 'followedSince', true],
    ['fans', 'followsYouSince', false],
    ['mutual', 'friendsSince', false],
    ['following', 'followedSince', false],
    ['followers', 'followsYouSince', false],
    ['pendingRequests', 'requestedOn', false],
    ['recentlyUnfollowed', 'unfollowedOn', false],
    ['receivedRequests', 'requestedOn', false],
    ['closeFriends', null, false],
    ['restricted', null, false],
    ['blocked', null, false],
    ['removedSuggestions', 'removedOn', false]
  ]);
  assert.deepEqual(keys(result.lists.pendingRequests), ['pending.one', 'pending.two']);
  assert.deepEqual(keys(result.lists.blocked), ['spam.bot.123']);
  assert.equal(result.lists.recentlyUnfollowed[0].ts, (TS + 2 * DAY) * 1000);
});

test('views: set logic invariants and optional views only when non-empty', () => {
  const e = (u, ts = null) => ({ key: u.toLowerCase(), username: u, name: null, url: null, ts });
  const result = {
    platform: 'instagram',
    lists: {
      followers: [e('a', 5), e('b'), e('fan')],
      following: [e('a', 9), e('b', 3), e('c', 1)],
      pendingRequests: [],
      closeFriends: [e('a')]
    },
    files: [], warnings: [], owner: null
  };
  const v = viewsById(result);
  assert.deepEqual(Object.keys(v), ['notFollowingBack', 'fans', 'mutual', 'following', 'followers', 'closeFriends']);
  assert.deepEqual(keys(v.notFollowingBack.entries), ['c']);
  assert.deepEqual(keys(v.fans.entries), ['fan']);
  assert.deepEqual(v.mutual.entries.map((x) => [x.key, x.ts]), [['a', 9], ['b', 3]]);
  // notFollowingBack ∪ mutual = following, fans ∪ mutual = followers, all disjoint.
  assert.equal(v.notFollowingBack.entries.length + v.mutual.entries.length, result.lists.following.length);
  assert.equal(v.fans.entries.length + v.mutual.entries.length, result.lists.followers.length);
  // Views never alias the result arrays.
  v.following.entries.pop();
  assert.equal(result.lists.following.length, 3);
  assert.deepEqual(ig.views({ lists: {} }).map((x) => x.entries.length), [0, 0, 0, 0, 0]);
});

/* ------------------------------------------------------------------ HTML */

for (const name of ['ig_html.zip', 'ig_html_de.zip']) {
  test('HTML export ' + name + ': profile anchors only, localized dates', async () => {
    const result = await ig.parse(await fromZip(name));
    const f = result.lists.following.find((e) => e.key === 'gina.art');
    assert.equal(f.url, 'https://www.instagram.com/gina.art/');
    assert.equal(f.ts, new Date(2025, 1, 7, 21, 16).getTime());
    const fan = result.lists.followers.find((e) => e.key === 'fan_two');
    assert.equal(fan.ts, new Date(2025, 0, 8, 10, 7).getTime());
    assert.ok(result.lists.followers.every((e) => e.ts !== null));
    // Page chrome links (help.instagram.com, instagram.com/, /accounts/login/) are no users.
    const all = Object.values(result.lists).flat().map((e) => e.key);
    for (const bad of ['accounts', 'www.instagram.com', '181231772500920', 'help']) assert.ok(!all.includes(bad), bad);
    assert.ok(result.files.every((p) => p.endsWith('.html')));
  });
}

test('JSON wins over HTML for the same list; lists may mix formats', async () => {
  const result = await ig.parse(await fromZip('ig_mixed_json_html.zip'));
  assert.ok(!result.lists.followers.some((e) => e.key === 'html.only.user'));
  assert.deepEqual(result.files.map((p) => path.posix.basename(p)).sort(), ['followers_1.json', 'following.html']);
});

/* ------------------------------------------------------------------ security */

test('crafted JSON: markup and javascript: never become links', async () => {
  const result = await ig.parse(await fromZip('ig_xss_json.zip'));
  const byUser = Object.fromEntries(result.lists.following.map((e) => [e.username, e]));
  assert.equal(byUser['<img src=x onerror=alert(1)>'].url, null);
  assert.equal(byUser['javascript:alert(document.domain)'].url, null);
  assert.equal(byUser['"><svg onload=alert(1)>'].url, null);
  // A valid profile href beats a markup title / a formula value.
  assert.equal(byUser['real.user'].url, 'https://www.instagram.com/real.user/');
  assert.equal(byUser.y.url, 'https://www.instagram.com/y/');
  const urls = Object.values(result.lists).flat().map((e) => e.url).filter(Boolean);
  assert.ok(urls.every((u) => RE_SAFE_URL.test(u)));
});

test('crafted HTML: only real instagram.com profile anchors count', async () => {
  const result = await ig.parse(await fromZip('ig_xss_html.zip'));
  assert.deepEqual(keys(result.lists.following), ['entity.user', 'normal_user', 'single.quoted']);
  const sq = result.lists.following.find((e) => e.key === 'single.quoted');
  assert.equal(sq.ts, new Date(2025, 0, 5, 13, 0).getTime());
  assertEntries(result.lists.following);
});

test('keys like __proto__ / constructor are plain entries', async () => {
  const result = await ig.parse(fromObject({
    'followers_1.json': JSON.stringify([{ string_list_data: [{ value: '__proto__', timestamp: 1 }] }]),
    'following.json': JSON.stringify({ relationships_following: [{ title: 'constructor', string_list_data: [{ href: '', timestamp: 1 }] }, { title: '__proto__' }] })
  }));
  assert.deepEqual(keys(result.lists.following), ['__proto__', 'constructor']);
  assert.deepEqual(keys(viewsById(result).mutual.entries), ['__proto__']);
});

/* ------------------------------------------------------------------ robustness */

test('BOM is tolerated even when the FileSet does not strip it', async () => {
  const zip = await JSZip.loadAsync(fs.readFileSync(path.join(FIX, 'ig_bom.zip')));
  const entries = [];
  for (const f of Object.values(zip.files)) if (!f.dir) entries.push([f.name, await f.async('string')]);
  const result = await ig.parse(makeFileSet(entries, { raw: true }));
  assert.equal(result.lists.following.length, 10);
});

test('case-insensitive paths, loose browser copies, duplicates merged', async () => {
  const followers = fs.readFileSync(path.join(FIX, 'loose', 'followers_1.json'), 'utf8');
  const following = fs.readFileSync(path.join(FIX, 'loose', 'following.json'), 'utf8');
  const result = await ig.parse(fromObject({
    'Export/CONNECTIONS/Followers_And_Following/FOLLOWERS_1.JSON': followers,
    'Export/CONNECTIONS/Followers_And_Following/Following.Json': following,
    'Export/CONNECTIONS/Followers_And_Following/following (1).json': following
  }));
  assert.equal(result.lists.followers.length, 8);
  assert.equal(result.lists.following.length, 10);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.files.length, 2);
});

test('duplicates keep the latest timestamp; every string_list_data item counts', async () => {
  const result = await ig.parse(await fromZip('ig_duplicates_multi.zip'));
  assert.equal(result.lists.followers.find((e) => e.key === 'anna.schmidt').ts, (TS + 30 * DAY) * 1000);
  assert.equal(result.lists.following.find((e) => e.key === 'jonas.dev').ts, (TS + 40 * DAY) * 1000);
  assert.ok(result.lists.following.some((e) => e.key === 'multi_b'));
});

test('usernames: case, whitespace, "@" and mojibake', async () => {
  const result = await ig.parse(await fromZip('ig_unicode_case.zip'));
  const cafe = result.lists.following.find((e) => e.username === 'café_bär');
  assert.ok(cafe, 'mojibake repaired');
  assert.equal(cafe.url, null);
  assert.ok(result.lists.followers.some((e) => e.username === 'ben_travel'));
  assert.ok(result.lists.followers.some((e) => e.username === 'carla.photo'));
  assert.equal(result.owner, 'demo.user');
});

test('owner falls back to Meta\'s download name', async () => {
  const followers = fs.readFileSync(path.join(FIX, 'loose', 'followers_1.json'), 'utf8');
  const following = fs.readFileSync(path.join(FIX, 'loose', 'following.json'), 'utf8');
  const fileSet = fromObject({ 'followers_1.json': followers, 'following.json': following },
    { sourceNames: ['instagram-Some.Person_1-2026-09-20-xYz12AbC.zip'] });
  assert.equal((await ig.parse(fileSet)).owner, 'some.person_1');
});

test('a Facebook file uploaded loose is reported as WRONG_PLATFORM', async () => {
  await rejectsWith(ig.parse(fromObject({
    'followers.json': JSON.stringify({ followers_v2: [{ name: 'Jane', timestamp: 1 }] }),
    'following.json': JSON.stringify({ following_v3: [{ name: 'Page', timestamp: 1 }] })
  })), 'WRONG_PLATFORM', { platform: 'facebook' });
});

test('errors use UT.UTError when ut-core.js is loaded', async () => {
  class UTError extends Error {
    constructor(code, params = {}) { super(code); this.name = 'UTError'; this.code = code; this.params = params; }
  }
  globalThis.UT = { UTError };
  try {
    await assert.rejects(ig.parse(await fromZip('ig_empty_lists.zip')), (e) => e instanceof UTError && e.code === 'EMPTY_LISTS');
  } finally {
    delete globalThis.UT;
  }
  await rejectsWith(ig.parse(fromObject({})), 'NO_RELEVANT_FILES', {});
});

/* ------------------------------------------------------------------ helpers */

test('fixMojibake', () => {
  const { fixMojibake } = ig._internal;
  assert.equal(fixMojibake('caf\u00c3\u00a9'), 'caf\u00e9');
  assert.equal(fixMojibake('\u00f0\u009f\u0098\u0080'), '\u{1f600}');
  assert.equal(fixMojibake('caf\u00e9'), 'caf\u00e9'); // real Latin-1 text, not valid UTF-8 bytes
  assert.equal(fixMojibake('\u65e5\u672c'), '\u65e5\u672c');
  assert.equal(fixMojibake('plain'), 'plain');
});

test('usernameFromUrl', () => {
  const { usernameFromUrl: u } = ig._internal;
  assert.equal(u('https://www.instagram.com/some.user'), 'some.user');
  assert.equal(u('https://www.instagram.com/_u/some.user/'), 'some.user');
  assert.equal(u('http://instagram.com/Some_User?igsh=abc'), 'Some_User');
  assert.equal(u('https://m.instagram.com/x'), 'x');
  for (const bad of ['javascript:alert(1)', 'https://evil.example/u', 'https://www.instagram.com.evil.example/u',
    'https://www.instagram.com/', 'https://www.instagram.com/explore/tags/cats', 'https://www.instagram.com/accounts',
    'https://www.instagram.com/%3Cscript%3E', 'https://www.instagram.com/..', 'https://www.instagram.com/a b',
    'https://www.instagram.com/' + 'x'.repeat(31), 'https://www.instagram.com/%E0%A4%A']) {
    assert.equal(u(bad), '', bad);
  }
});

test('parseLooseDate: formats of the HTML export in several languages', () => {
  const { parseLooseDate: d } = ig._internal;
  const at = (y, m, day, h = 0, mi = 0) => new Date(y, m, day, h, mi).getTime();
  assert.equal(d('Jan 01, 2025 10:00 am'), at(2025, 0, 1, 10));
  assert.equal(d('Jan 01, 2025, 12:05 am'), at(2025, 0, 1, 0, 5));
  assert.equal(d('Dec 31, 2024 12:30 pm'), at(2024, 11, 31, 12, 30));
  assert.equal(d('01.02.2025, 21:10'), at(2025, 1, 1, 21, 10));
  assert.equal(d('1 févr. 2025 22:15'), at(2025, 1, 1, 22, 15));
  assert.equal(d('5 juil. 2023'), at(2023, 6, 5));
  assert.equal(d('3 juin 2023'), at(2023, 5, 3));
  assert.equal(d('15 de março de 2025 3:04 pm'), at(2025, 2, 15, 15, 4));
  assert.equal(d('12 paź 2024 08:00'), at(2024, 9, 12, 8));
  assert.equal(d('7 mag 2024'), at(2024, 4, 7));
  assert.equal(d('2025-01-02 10:00'), at(2025, 0, 2, 10));
  assert.equal(d('2025年1月2日 10:00'), at(2025, 0, 2, 10));
  for (const bad of ['', 'u02', 'gina.art', 'https://www.instagram.com/_u/u02', 'Feb 30, 2025', 'Jan 2025', 'x'.repeat(100)]) {
    assert.equal(d(bad), null, bad);
  }
});

/* ------------------------------------------------------------------ performance */

test('performance: 100k followers + 100k following parse and views in < 1.5 s', async () => {
  const N = 100000;
  const followers = [];
  const following = [];
  for (let i = 0; i < N; i++) {
    const a = 'user_' + String(i + N / 2).padStart(6, '0');
    const b = 'user_' + String(i).padStart(6, '0');
    followers.push({ title: '', media_list_data: [], string_list_data: [{ href: 'https://www.instagram.com/' + a, value: a, timestamp: TS + i }] });
    following.push({ title: b, string_list_data: [{ href: 'https://www.instagram.com/_u/' + b, timestamp: TS + i }] });
  }
  const fileSet = fromObject({
    'connections/followers_and_following/followers_1.json': JSON.stringify(followers, null, 2),
    'connections/followers_and_following/following.json': JSON.stringify({ relationships_following: following }, null, 2)
  });
  const t0 = performance.now();
  const result = await ig.parse(fileSet);
  const v = viewsById(result);
  const ms = performance.now() - t0;
  assert.equal(v.notFollowingBack.entries.length, N / 2);
  assert.equal(v.mutual.entries.length, N / 2);
  assert.equal(v.fans.entries.length, N / 2);
  assert.ok(ms < 1500, 'took ' + Math.round(ms) + ' ms');
});

test('performance: 50k-entry HTML export parses in < 1.5 s', async () => {
  const N = 50000;
  const block = (u, following) => (following ? `<div class="pam"><h2>${u}</h2><div><div><div><a target="_blank" href="https://www.instagram.com/_u/${u}">https://www.instagram.com/_u/${u}</a></div>` : `<div class="pam"><div><div><div><a target="_blank" href="https://www.instagram.com/${u}">${u}</a></div>`) +
    '<div>Jan 01, 2025 10:00 am</div></div></div></div>\n';
  let fo = '<html><body>';
  let fi = '<html><body>';
  for (let i = 0; i < N; i++) { fo += block('user_' + i, true); fi += block('user_' + (i + N / 2), false); }
  const fileSet = fromObject({ 'followers_1.html': fi + '</body></html>', 'following.html': fo + '</body></html>' });
  const t0 = performance.now();
  const result = await ig.parse(fileSet);
  const ms = performance.now() - t0;
  assert.equal(viewsById(result).notFollowingBack.entries.length, N / 2);
  assert.ok(result.lists.following.every((e) => e.ts !== null));
  assert.ok(ms < 1500, 'took ' + Math.round(ms) + ' ms');
});

/* ------------------------------------------------------------------ real export (local only) */



test('label_values records (2025+ optional lists) are read by value shape, not by localized label', async () => {
  const lv = (user, name, url = '') => ({ timestamp: TS, media: [], fbid: 'f',
    label_values: [{ label: 'URL', value: url }, { label: 'Name', value: name }, { label: 'Benutzername', value: user }] });
  const follow = (u) => ({ title: '', string_list_data: [{ href: 'https://www.instagram.com/' + u, value: u, timestamp: TS }] });
  const result = await ig.parse(fromObject({
    'connections/followers_and_following/followers_1.json': JSON.stringify([follow('alice')]),
    'connections/followers_and_following/following.json': JSON.stringify({ relationships_following: [follow('bob')] }),
    'connections/followers_and_following/pending_follow_requests.json': JSON.stringify([lv('carol', 'Carol C'), lv('', 'dave', 'https://www.instagram.com/_u/dave_real')]),
    'connections/followers_and_following/blocked_profiles.json': JSON.stringify([lv('eve', 'mallory'), lv('', 'Only A Name')])
  }));
  assert.deepEqual(keys(result.lists.pendingRequests), ['carol', 'dave_real']);
  assert.deepEqual(keys(result.lists.blocked), ['eve']);
  assert.equal(result.lists.pendingRequests.find((e) => e.key === 'carol').ts, TS * 1000);
  assertEntries(result.lists.pendingRequests);
});
