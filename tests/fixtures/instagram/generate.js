#!/usr/bin/env node
/**
 * Generates the Instagram export fixtures in this folder (ZIPs, loose files, expected.json).
 *
 *   node tests/fixtures/instagram/generate.js
 *
 * Shapes mirror Meta's "Export your information" output (Accounts Center, 2021–2026), see the
 * header of src/parsers/instagram.js. JSON is written the way Meta writes it: indented,
 * every non-ASCII character \u-escaped, and non-ASCII text as mojibake (each UTF-8 byte its own
 * \u00XX escape). The output is deterministic (fixed ZIP entry dates), so re-running the script only
 * changes files whose definition changed.
 *
 * Base dataset (most fixtures):
 *   following = 10 accounts, followers = 8 accounts (6 of them mutual + 2 fans)
 *   → notFollowingBack 4 (gina.art, hugo_cooks, ivy.designs, jonas.dev), fans 2, mutual 6
 */
'use strict';

const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

const OUT = __dirname;
const FF = 'connections/followers_and_following/';
const TS = 1735732800; // 2025-01-01T12:00:00Z, Unix seconds like the export
const DAY = 86400;
const ZIP_DATE = new Date('2026-09-01T00:00:00Z');

const FOLLOWING = ['anna.schmidt', 'ben_travel', 'carla.photo', 'david.k', 'emma_runs', 'felix.music',
  'gina.art', 'hugo_cooks', 'ivy.designs', 'jonas.dev'];
const FOLLOWERS = FOLLOWING.slice(0, 6).concat(['fan.one', 'fan_two']);
const BASE_EXPECT = { followers: 8, following: 10, notFollowingBack: 4, fans: 2, mutual: 6 };

/* ---------------------------------------------------------------- encoders */

/** UTF-8 text as Meta's JSON writes it: one U+00XX code point per byte. */
const mojibake = (s) => Buffer.from(s, 'utf8').toString('latin1');

/** JSON.stringify with Meta's formatting: indent 2, all non-ASCII as \uXXXX. */
const metaJson = (value) => JSON.stringify(value, null, 2)
  .replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

/* ---------------------------------------------------------------- JSON records */

// followers_N.json (2022–2026): empty title, username in value.
const follower = (u, i = 0) => ({
  title: '', media_list_data: [],
  string_list_data: [{ href: `https://www.instagram.com/${u}`, value: u, timestamp: TS + i * DAY }]
});
// following.json 2024/2025+: username only in title, href via /_u/, no value.
const following2025 = (u, i = 0) => ({
  title: u,
  string_list_data: [{ href: `https://www.instagram.com/_u/${u}`, timestamp: TS + i * DAY }]
});
// following.json 2022–2024 and most optional lists: same shape as a follower record.
const following2023 = follower;

const rel = (key, records) => ({ [key]: records });
const followersFile = (users) => users.map((u, i) => follower(u, i));
const followingFile = (users, make = following2025) =>
  rel('relationships_following', users.map((u, i) => make(u, i)));

/** The optional lists that sit next to followers/following in a real export. */
function optionalLists(prefix = FF) {
  return {
    [prefix + 'pending_follow_requests.json']: rel('relationships_follow_requests_sent',
      [following2023('pending.one', 3), following2023('pending.two', 4)]),
    [prefix + 'recently_unfollowed_profiles.json']: rel('relationships_unfollowed_users', [following2023('old.friend', 2)]),
    [prefix + "follow_requests_you've_received.json"]: rel('relationships_follow_requests_received', [following2023('wants.in', 5)]),
    [prefix + 'close_friends.json']: rel('relationships_close_friends', [following2023('anna.schmidt')]),
    [prefix + 'blocked_profiles.json']: rel('relationships_blocked_users', [following2025('spam.bot.123', 1)]),
    [prefix + 'restricted_profiles.json']: rel('relationships_restricted_users', [following2023('rude.guy')]),
    [prefix + 'removed_suggestions.json']: rel('relationships_dismissed_suggested_users', [following2023('random.brand', 6)]),
    // Present in real exports but not analyzed:
    [prefix + 'hide_story_from.json']: rel('relationships_hide_stories_from', [following2023('mom.account')]),
    [prefix + 'recent_follow_requests.json']: rel('relationships_permanent_follow_requests', [following2023('pending.one')]),
    [prefix + "profiles_you've_favorited.json"]: rel('relationships_feed_favorites', [following2023('ben_travel')]),
    [prefix + 'following_hashtags.json']: rel('relationships_following_hashtags', [{
      title: '', string_list_data: [{ href: 'https://www.instagram.com/explore/tags/cats', value: 'cats', timestamp: TS }]
    }])
  };
}

function personalInfo(username, extra = {}) {
  return {
    profile_user: [{
      media_map_data: { 'Profile Photo': { uri: 'media/profile/202501/photo.jpg', creation_timestamp: TS, title: '' } },
      string_map_data: Object.assign({
        Email: { href: '', value: 'demo@example.com', timestamp: 0 },
        'Phone Confirmed': { href: '', value: 'False', timestamp: 0 },
        Username: { href: '', value: username, timestamp: 0 },
        Name: { href: '', value: mojibake('Demo Müller'), timestamp: 0 }
      }, extra)
    }]
  };
}

function standard(prefix = FF, opts = {}) {
  return {
    [prefix + 'followers_1.json']: followersFile(opts.followers || FOLLOWERS),
    [prefix + 'following.json']: followingFile(opts.following || FOLLOWING, opts.makeFollowing)
  };
}

/* ---------------------------------------------------------------- HTML (Meta DYI template) */

const htmlPage = (title, blocks) => '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + title +
  '</title></head><body class="_5vb_ _2yq _a7o5"><div class="clearfix _ikh"><div class="_4bl9"><div class="_li">' +
  '<div class="_a705"><div class="_a706" role="main">' + blocks.join('\n') + '</div></div>' +
  '<div class="_a6-o">Generated by Instagram · <a href="https://help.instagram.com/181231772500920">Learn more</a>' +
  ' · <a href="https://www.instagram.com/">Instagram</a> · <a href="https://www.instagram.com/accounts/login/">Log in</a></div>' +
  '</div></div></div></body></html>';

const monthsEn = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const enDate = (d) => `${monthsEn[d.m]} ${String(d.d).padStart(2, '0')}, ${d.y} ${((d.h + 11) % 12) + 1}:${String(d.mi).padStart(2, '0')} ${d.h < 12 ? 'am' : 'pm'}`;
const deDate = (d) => `${String(d.d).padStart(2, '0')}.${String(d.m + 1).padStart(2, '0')}.${d.y}, ${d.h}:${String(d.mi).padStart(2, '0')}`;
// Deterministic wall-clock dates for HTML entries: Jan (i+1), 2025, 10:0i / Feb (i+1), 2025, 21:1i.
const htmlDate = (i, following) => following
  ? { y: 2025, m: 1, d: i + 1, h: 21, mi: 10 + (i % 10) }
  : { y: 2025, m: 0, d: i + 1, h: 10, mi: i % 10 };

// Followers page: the link text is the username, the date follows in the next <div>.
const htmlFollower = (u, date) => '<div class="pam _3-95 _2ph- _a6-g uiBoxWhite noborder"><div class="_a6-p"><div><div>' +
  `<a target="_blank" href="https://www.instagram.com/${u}">${u}</a></div><div>${date}</div></div></div></div>`;
// Following page (2025): username in <h2>, the link text is the /_u/ URL.
const htmlFollowing = (u, date) => `<div class="pam _3-95 _2ph- _a6-g uiBoxWhite noborder"><h2 class="_3-95 _2pim _a6-h _a6-i">${u}</h2>` +
  '<div class="_3-95 _a6-p"><div><div>' +
  `<a target="_blank" href="https://www.instagram.com/_u/${u}">https://www.instagram.com/_u/${u}</a></div><div>${date}</div></div></div></div>`;

function htmlExport(fmt) {
  return {
    'start_here.html': '<html><body><a href="connections/followers_and_following/followers_1.html">Followers</a></body></html>',
    [FF + 'followers_1.html']: htmlPage('Followers', FOLLOWERS.map((u, i) => htmlFollower(u, fmt(htmlDate(i, false))))),
    [FF + 'following.html']: htmlPage('Following', FOLLOWING.map((u, i) => htmlFollowing(u, fmt(htmlDate(i, true))))),
    [FF + 'pending_follow_requests.html']: htmlPage('Pending follow requests', [htmlFollower('pending.one', fmt(htmlDate(3, false)))]),
    [FF + 'recently_unfollowed_profiles.html']: htmlPage('Recently unfollowed profiles', [htmlFollower('old.friend', fmt(htmlDate(2, false)))])
  };
}

/* ---------------------------------------------------------------- writers */

const expected = {};

async function writeZip(name, files, expect) {
  const zip = new JSZip();
  for (const [p, content] of Object.entries(files)) {
    const data = typeof content === 'string' || Buffer.isBuffer(content) ? content : metaJson(content);
    zip.file(p, data, { date: ZIP_DATE, createFolders: false });
  }
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', platform: 'UNIX' });
  fs.writeFileSync(path.join(OUT, name), buf);
  expected[name] = expect;
}

function writeLoose(dir, files, expect) {
  fs.mkdirSync(path.join(OUT, dir), { recursive: true });
  for (const [p, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(OUT, dir, p), typeof content === 'string' ? content : metaJson(content));
  }
  expected[dir + '/'] = expect;
}

const APPLE_DOUBLE = Buffer.concat([Buffer.from([0, 5, 22, 7, 0, 2, 0, 0]), Buffer.from('Mac OS X        '), Buffer.alloc(40)]);
const ALL_OPTIONAL = { pendingRequests: 2, recentlyUnfollowed: 1, receivedRequests: 1, closeFriends: 1, blocked: 1, restricted: 1, removedSuggestions: 1 };

/* ---------------------------------------------------------------- fixtures */

async function main() {
  // Current export (2025/26) with every sibling file, personal info and Threads data.
  await writeZip('ig_2025_json.zip', Object.assign(
    { 'start_here.html': '<html><body>Start here</body></html>' },
    standard(), optionalLists(),
    {
      'personal_information/personal_information/personal_information.json': personalInfo('demo.user'),
      // Threads followers live in the same export and must not be mixed in.
      'your_instagram_activity/threads/followers.json': rel('text_post_app_text_post_app_followers', [follower('threads.only'), follower('gina.art')]),
      'your_instagram_activity/threads/following.json': rel('text_post_app_text_post_app_following', [following2023('threads.follow')]),
      'your_instagram_activity/likes/liked_posts.json': rel('likes_media_likes', [])
    }),
  { lists: Object.assign({ followers: 8, following: 10 }, ALL_OPTIONAL), views: BASE_EXPECT, owner: 'demo.user', warnings: [] });

  // 2022–2024: following records carry value + href (no /_u/).
  await writeZip('ig_2023_json.zip', standard(FF, { makeFollowing: following2023 }),
    { lists: { followers: 8, following: 10 }, views: BASE_EXPECT, owner: null, warnings: [] });

  // 2021/22: no connections/ prefix, followers.json wrapped in relationships_followers.
  await writeZip('ig_legacy_2021.zip', {
    'followers_and_following/followers.json': rel('relationships_followers', followersFile(FOLLOWERS)),
    'followers_and_following/following.json': followingFile(FOLLOWING, following2023),
    'followers_and_following/pending_follow_requests.json': rel('relationships_follow_requests_sent', [following2023('pending.one')])
  }, { lists: { followers: 8, following: 10, pendingRequests: 1 }, views: BASE_EXPECT, owner: null, warnings: [] });

  // ≤2020: one connections.json with {username: ISO date} maps.
  const isoMap = (users) => Object.fromEntries(users.map((u, i) => [u, new Date((TS + i * DAY) * 1000).toISOString().replace('.000Z', '+00:00')]));
  await writeZip('ig_legacy_2020_connections.zip', {
    'connections.json': {
      blocked_users: isoMap(['spam.bot.123']), restricted_users: {}, follow_requests_sent: isoMap(['pending.one']),
      following: isoMap(FOLLOWING), followers: isoMap(FOLLOWERS), following_hashtags: { cats: '2019-01-01T10:00:00+00:00' },
      dismissed_suggested_users: {}, close_friends: {}
    },
    'profile.json': { username: 'demo.user' }
  }, { lists: { followers: 8, following: 10, pendingRequests: 1, blocked: 1, restricted: 0, removedSuggestions: 0, closeFriends: 0 }, views: BASE_EXPECT, owner: null, warnings: [] });

  // Large account: followers split 3/3/2, following split 5/5.
  await writeZip('ig_split_parts.zip', {
    [FF + 'followers_1.json']: followersFile(FOLLOWERS.slice(0, 3)),
    [FF + 'followers_2.json']: followersFile(FOLLOWERS.slice(3, 6)),
    [FF + 'followers_3.json']: followersFile(FOLLOWERS.slice(6)),
    [FF + 'following_1.json']: followingFile(FOLLOWING.slice(0, 5)),
    [FF + 'following_2.json']: followingFile(FOLLOWING.slice(5))
  }, { lists: { followers: 8, following: 10 }, views: BASE_EXPECT, owner: null, warnings: [] });

  // followers_2.json is missing → result with a MISSING_PARTS warning (david.k … felix.music absent).
  await writeZip('ig_missing_part.zip', {
    [FF + 'followers_1.json']: followersFile(FOLLOWERS.slice(0, 3)),
    [FF + 'followers_3.json']: followersFile(FOLLOWERS.slice(6)),
    [FF + 'following.json']: followingFile(FOLLOWING)
  }, { lists: { followers: 5, following: 10 }, views: { followers: 5, following: 10, notFollowingBack: 7, fans: 2, mutual: 3 }, owner: null,
    warnings: [{ code: 'MISSING_PARTS', params: { list: 'followers', parts: '2' } }] });

  // HTML export (English dates) incl. generic instagram.com links in the page chrome.
  await writeZip('ig_html.zip', htmlExport(enDate),
    { lists: { followers: 8, following: 10, pendingRequests: 1, recentlyUnfollowed: 1 }, views: BASE_EXPECT, owner: null, warnings: [] });

  // HTML export of a German-language account (dd.mm.yyyy, 24 h).
  await writeZip('ig_html_de.zip', htmlExport(deDate),
    { lists: { followers: 8, following: 10, pendingRequests: 1, recentlyUnfollowed: 1 }, views: BASE_EXPECT, owner: null, warnings: [] });

  // JSON followers + HTML following, and an HTML copy of followers that must be ignored (JSON wins).
  await writeZip('ig_mixed_json_html.zip', {
    [FF + 'followers_1.json']: followersFile(FOLLOWERS),
    [FF + 'followers_1.html']: htmlPage('Followers', [htmlFollower('html.only.user', enDate(htmlDate(0, false)))]),
    [FF + 'following.html']: htmlExport(enDate)[FF + 'following.html']
  }, { lists: { followers: 8, following: 10 }, views: BASE_EXPECT, owner: null, warnings: [] });

  // macOS re-zip: extra top folder named like Meta's download, AppleDouble files and an identical copy.
  const top = 'instagram-demo.user-2026-09-01-AbCdEf/';
  const mac = {};
  for (const [p, c] of Object.entries(standard())) {
    mac[top + p] = c;
    mac['__MACOSX/' + top + path.posix.dirname(p) + '/._' + path.posix.basename(p)] = APPLE_DOUBLE;
    mac['instagram-demo.user-2026-09-01-AbCdEf copy/' + p] = c;
  }
  await writeZip('ig_nested_macos.zip', mac, { lists: { followers: 8, following: 10 }, views: BASE_EXPECT, owner: 'demo.user', warnings: [] });

  // Two different exports in one upload → one is used (the folder with more files) + MULTIPLE_EXPORTS.
  await writeZip('ig_two_exports.zip', Object.assign({},
    standard('export_2026/' + FF), optionalLists('export_2026/' + FF),
    standard('export_2025/' + FF, { following: FOLLOWING.slice(0, 7) })
  ), { lists: Object.assign({ followers: 8, following: 10 }, ALL_OPTIONAL), views: BASE_EXPECT, owner: null,
    warnings: [{ code: 'MULTIPLE_EXPORTS', params: { file: 'following.json' } }] });

  // Windows-created ZIP with backslash separators (FileSet normalizes them to "/").
  const win = {};
  for (const [p, c] of Object.entries(standard('Instagram Export\\' + FF.replace(/\//g, '\\')))) win[p] = c;
  await writeZip('ig_windows_backslash.zip', win, { lists: { followers: 8, following: 10 }, views: BASE_EXPECT, owner: null, warnings: [] });

  // Case, whitespace and "@" differences between the lists, non-ASCII (mojibake) text,
  // a Polish-language personal information file.
  await writeZip('ig_unicode_case.zip', {
    [FF + 'followers_1.json']: followersFile(['Anna.Schmidt', 'ben_travel ', '@carla.photo', 'DAVID.K', 'emma_runs', 'felix.music', 'fan.one', 'fan_two']),
    [FF + 'following.json']: rel('relationships_following', FOLLOWING.map((u, i) => following2025(u, i)).concat([
      { title: mojibake('café_bär'), string_list_data: [{ href: '', timestamp: TS }] }
    ])),
    'personal_information/personal_information/personal_information.json': {
      profile_user: [{ string_map_data: { [mojibake('Nazwa użytkownika')]: { href: '', value: 'Demo.User', timestamp: 0 } } }]
    }
  }, { lists: { followers: 8, following: 11 }, views: { followers: 8, following: 11, notFollowingBack: 5, fans: 2, mutual: 6 }, owner: 'demo.user', warnings: [] });

  // Duplicated records, the same user in several parts, records with several string_list_data items.
  await writeZip('ig_duplicates_multi.zip', {
    [FF + 'followers_1.json']: followersFile(FOLLOWERS).concat([follower('anna.schmidt', 30)]),
    [FF + 'followers_2.json']: followersFile(['fan_two', 'ben_travel']),
    [FF + 'following.json']: rel('relationships_following', FOLLOWING.map((u, i) => following2025(u, i)).concat([
      following2025('jonas.dev', 40),
      { title: '', string_list_data: [
        { href: 'https://www.instagram.com/multi_a', value: 'multi_a', timestamp: TS },
        { href: 'https://www.instagram.com/multi_b', value: 'multi_b', timestamp: TS }] }
    ]))
  }, { lists: { followers: 8, following: 12 }, views: { followers: 8, following: 12, notFollowingBack: 6, fans: 2, mutual: 6 }, owner: null, warnings: [] });

  // Crafted JSON: markup / javascript: / foreign hosts must never become links.
  const XSS = '<img src=x onerror=alert(1)>';
  await writeZip('ig_xss_json.zip', {
    [FF + 'followers_1.json']: followersFile(['normal_user']),
    [FF + 'following.json']: rel('relationships_following', [
      following2025('normal_user'),
      { title: XSS, string_list_data: [{ href: 'javascript:alert(1)', timestamp: TS }] },
      { title: '', string_list_data: [{ href: 'https://evil.example/steal', value: 'javascript:alert(document.domain)', timestamp: TS }] },
      { title: '"><svg onload=alert(1)>', string_list_data: [{ href: 'https://www.instagram.com/_u/%3Cscript%3E', timestamp: TS }] },
      { title: '', string_list_data: [{ href: 'https://www.instagram.com/y', value: '=HYPERLINK("http://evil.example","click")', timestamp: TS }] },
      { title: XSS, string_list_data: [{ href: 'https://www.instagram.com/_u/real.user', timestamp: TS }] }
    ])
  }, { lists: { followers: 1, following: 6 }, views: { followers: 1, following: 6, notFollowingBack: 5, fans: 0, mutual: 1 }, owner: null,
    warnings: [] });

  // Crafted HTML: only real instagram.com profile anchors count.
  await writeZip('ig_xss_html.zip', {
    [FF + 'followers_1.html']: htmlPage('Followers', [htmlFollower('normal_user', enDate(htmlDate(0, false)))]),
    [FF + 'following.html']: htmlPage('Following', [
      htmlFollowing('normal_user', enDate(htmlDate(0, true))),
      '<div><a href="javascript:alert(1)">javascript:alert(1)</a><div>Jan 01, 2025 10:00 am</div></div>',
      '<div><a href="https://www.instagram.com/<img src=x onerror=alert(1)>">bad</a></div>',
      '<div><a href="https://evil.example/instagram.com/evil_user">evil_user</a></div>',
      '<div><a href="https://www.instagram.com.evil.example/fake_user">fake_user</a></div>',
      "<div><a target='_blank' href='https://www.instagram.com/single.quoted'>single.quoted</a><div>Jan 05, 2025 1:00 pm</div></div>",
      '<div><a data-x="a>b" href="https://www.instagram.com/_u/entity&#46;user?igsh=abc&amp;x=1">x</a></div>'
    ])
  }, { lists: { followers: 1, following: 3 }, views: { followers: 1, following: 3, notFollowingBack: 2, fans: 0, mutual: 1 }, owner: null, warnings: [] });

  // BOM before following.json (re-saved with Windows Notepad).
  await writeZip('ig_bom.zip', {
    [FF + 'followers_1.json']: '\ufeff' + metaJson(followersFile(FOLLOWERS)),
    [FF + 'following.json']: '\ufeff' + metaJson(followingFile(FOLLOWING))
  }, { lists: { followers: 8, following: 10 }, views: BASE_EXPECT, owner: null, warnings: [] });

  // Error cases.
  await writeZip('ig_empty_lists.zip', { [FF + 'followers_1.json']: [], [FF + 'following.json']: rel('relationships_following', []) },
    { error: 'EMPTY_LISTS' });
  await writeZip('ig_only_following.zip', { [FF + 'following.json']: followingFile(FOLLOWING) },
    { error: 'MISSING_LIST', params: { list: 'followers', file: 'followers_1.json' } });
  // Followers without following: a partial result (followers + optional lists) with a LIST_MISSING warning.
  await writeZip('ig_only_followers.zip', Object.assign({ [FF + 'followers_1.json']: followersFile(FOLLOWERS) }, optionalLists()), {
    lists: { followers: 8, pendingRequests: 2, recentlyUnfollowed: 1, receivedRequests: 1, closeFriends: 1, blocked: 1, restricted: 1, removedSuggestions: 1 },
    views: { followers: 8, pendingRequests: 2, recentlyUnfollowed: 1, receivedRequests: 1, closeFriends: 1, restricted: 1, blocked: 1, removedSuggestions: 1 },
    owner: null,
    warnings: [{ code: 'LIST_MISSING', params: { list: 'following', file: 'following.json' } }]
  });
  await writeZip('ig_broken_json.zip', {
    [FF + 'followers_1.json']: followersFile(FOLLOWERS),
    [FF + 'following.json']: '{\n  "relationships_following": [\n    {\n      "title": "anna.schmidt",\n      "string_list_'
  }, { error: 'CORRUPT_FILE', params: { file: 'following.json' } });
  await writeZip('ig_wrong_structure.zip', {
    [FF + 'followers_1.json']: { error: 'Please try again later' },
    [FF + 'following.json']: followingFile(FOLLOWING)
  }, { error: 'CORRUPT_FILE', params: { file: 'followers_1.json' } });
  await writeZip('ig_no_relevant.zip', {
    'personal_information/personal_information/personal_information.json': personalInfo('demo.user'),
    'your_instagram_activity/messages/inbox/friend_123/message_1.json': { participants: [], messages: [] }
  }, { error: 'NO_RELEVANT_FILES' });

  // A damaged optional file must not block the analysis.
  await writeZip('ig_broken_optional.zip', Object.assign(standard(), {
    [FF + 'pending_follow_requests.json']: '{"relationships_follow_requests_sent": [',
    [FF + 'close_friends.json']: rel('relationships_close_friends', [following2023('anna.schmidt')])
  }), { lists: { followers: 8, following: 10, closeFriends: 1 }, views: BASE_EXPECT, owner: null,
    warnings: [{ code: 'OPTIONAL_FILE_UNREADABLE', params: { file: 'pending_follow_requests.json' } }] });

  // Other platforms' exports.
  await writeZip('foreign_tiktok.zip', { 'user_data_tiktok.json': { 'Profile And Settings': { Follower: { FansList: [{ Date: '2025-01-01 10:00:00', UserName: 'abc' }] } } } },
    { error: 'WRONG_PLATFORM', params: { platform: 'tiktok' } });
  await writeZip('foreign_x.zip', {
    'data/manifest.js': 'window.__THAR_CONFIG = {}',
    'data/follower.js': 'window.YTD.follower.part0 = [{"follower":{"accountId":"1","userLink":"https://twitter.com/intent/user?user_id=1"}}]',
    'data/following.js': 'window.YTD.following.part0 = []'
  }, { error: 'WRONG_PLATFORM', params: { platform: 'x' } });
  await writeZip('foreign_facebook.zip', {
    'connections/followers/people_who_followed_you_1.json': [{ string_list_data: [{ value: mojibake('Jörg Example'), timestamp: TS }] }],
    "connections/followers/who_you've_followed.json": { following_v3: [{ name: 'Some Page', timestamp: TS }] },
    'connections/friends/your_friends.json': { friends_v2: [{ name: 'Friend One', timestamp: TS }] },
    'your_facebook_activity/posts/your_posts_1.json': []
  }, { error: 'WRONG_PLATFORM', params: { platform: 'facebook' } });
  // Facebook 2021 layout: its followers.json / following.json share Instagram's file names.
  await writeZip('foreign_facebook_2021.zip', {
    'friends_and_followers/followers.json': { followers_v2: [{ name: 'Jane Doe', timestamp: TS }] },
    'friends_and_followers/following.json': { following_v3: [{ name: 'Some Page', timestamp: TS }] },
    'friends_and_followers/friends.json': { friends_v2: [{ name: 'Friend One', timestamp: TS }] }
  }, { error: 'WRONG_PLATFORM', params: { platform: 'facebook' } });

  // Loose files, as uploaded after iOS/Safari auto-extracted the ZIP.
  writeLoose('loose', {
    'followers_1.json': followersFile(FOLLOWERS),
    'following.json': followingFile(FOLLOWING)
  }, { lists: { followers: 8, following: 10 }, views: BASE_EXPECT, owner: null, warnings: [] });

  fs.writeFileSync(path.join(OUT, 'expected.json'), JSON.stringify(expected, null, 2) + '\n');
  console.log('Instagram fixtures written to', path.relative(process.cwd(), OUT) || '.', '(' + Object.keys(expected).length + ' cases)');
}

main().catch((e) => { console.error(e); process.exit(1); });
