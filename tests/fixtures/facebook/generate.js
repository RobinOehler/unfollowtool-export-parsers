#!/usr/bin/env node
/*
 * Generates the Facebook "Download your information" fixtures in this folder and expected.json,
 * which describes the outcome every fixture must produce. Deterministic: rerunning gives
 * byte-identical files.
 *
 *   node tests/fixtures/facebook/generate.js
 *
 * Shapes mirror real Meta exports (see src/parsers/facebook.js for the full list):
 *   2023+   connections/friends/your_friends.json            {"friends_v2":[{"name","timestamp"}]}
 *           connections/friends/removed_friends.json         {"deleted_friends_v2":[…]}
 *           connections/friends/sent_friend_requests.json    {"sent_requests_v2":[…]}
 *           connections/friends/received_friend_requests.json {"received_requests_v2":[…]}
 *           connections/friends/rejected_friend_requests.json {"rejected_requests_v2":[…]}
 *           connections/followers/who_you've_followed.json   {"following_v3":[{"name","timestamp"}]}
 *           connections/followers/people_who_followed_you_N.json  [{"title","media_list_data","string_list_data":[{"value","timestamp"}]}]
 *   2020-22 friends_and_followers/{friends,removed_friends,friend_requests_sent,friend_requests_received,following,followers}.json
 *   2018-19 friends/friends.json {"friends"}, following_and_followers/{following,followers}.json {"following"}/{"followers"}
 *   HTML    same file names with .html; rows are div._a6-g (2022+) or div.uiBoxWhite with ._2lel/._2lem (older)
 * Meta JSON escapes every UTF-8 byte as \u00XX ("mojibake"); fbJson() reproduces that exactly.
 * Facebook exports never contain usernames or profile URLs for people – only display names.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

const OUT = __dirname;
const FIXED_DATE = new Date('2025-09-01T10:00:00Z'); // stable ZIP timestamps → reproducible bytes
const T0 = 1_700_000_000; // 2023-11-14T22:13:20Z, unix seconds as in the export

// ---------------------------------------------------------------- content helpers

/** Meta's encoding: UTF-8 bytes as latin-1 code points, then every non-ASCII char as \u00XX. */
const mojibake = (s) => Buffer.from(s, 'utf8').toString('latin1');
const asciiEscape = (json) => json.replace(/[^\x00-\x7e]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const fbJson = (value) => asciiEscape(JSON.stringify(deepMojibake(value), null, 2));

function deepMojibake(v) {
  if (typeof v === 'string') return mojibake(v);
  if (Array.isArray(v)) return v.map(deepMojibake);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deepMojibake(x)]));
  return v;
}

const people = (names, step = 86400, start = T0) => names.map((name, i) => ({ name, timestamp: start - i * step }));
const stringList = (names, step = 60, start = T0) =>
  names.map((value, i) => ({ title: '', media_list_data: [], string_list_data: [{ value, timestamp: start - i * step }] }));

const escHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');

/** 2022+ HTML list page. rows: [name, dateText] */
function html2023(title, rows) {
  const body = rows.map(([name, date]) =>
    `<div class="pam _3-95 _2ph- _a6-g uiBoxWhite noborder"><div class="_3-95 _2pim _a6-h _a6-i">${escHtml(name)}</div>` +
    '<div class="_3-95 _a6-p"><div><div></div><div></div></div></div>' +
    `<div class="_3-94 _a6-o"><a href="#"><div class="_a72d">${escHtml(date)}</div></a></div></div>`).join('');
  return '<!DOCTYPE html><html><head><meta charset="utf-8" /><title>' + escHtml(title) + '</title>' +
    '<style>._a6-g{padding:8px}</style><base href="../../" /></head><body class="_5vb_ _2yq _a7o5">' +
    '<div class="clearfix _ikh"><div class="_4bl9"><div class="_li"><div class="_a705">' +
    '<div class="_a70a"><a href="index.html">Back to your information</a>' +
    `<div class="_a70e">${escHtml(title)}</div></div><div class="_a706" role="main">${body}</div></div></div></div></div></body></html>`;
}

/** 2019-2021 HTML list page. rows: [name, dateText] */
function html2019(title, rows) {
  const body = rows.map(([name, date]) =>
    `<div class="pam _3-95 _2pi0 _2lej uiBoxWhite noborder"><div class="_3-96 _2pio _2lek _2lel">${escHtml(name)}</div>` +
    `<div class="_3-94 _2lem">${escHtml(date)}</div></div>`).join('');
  return '<!DOCTYPE html><html><head><meta charset="utf-8" /><title>' + escHtml(title) + '</title></head><body class="_5vb_ _2yq _4yic">' +
    '<div class="clearfix _ikh"><div class="_4bl9"><div class="_li"><div class="_3a_u"><div class="_4t5n" role="main">' +
    `<div class="_3-8y _3-95 _3b0a"><div class="_3b0d">${escHtml(title)}</div></div>${body}</div></div></div></div></div></body></html>`;
}

// ---------------------------------------------------------------- canonical data set

const FRIENDS = ['Anna Schmidt', 'Jürgen Müller', 'José Álvarez', 'Zoë 🌸 Dupont', 'Mark Taylor', 'Ali Yılmaz', 'Łukasz Wójcik', 'John Smith', 'John Smith'];
const FOLLOWING = ['Anna Schmidt', 'Mark Taylor', 'Some Brand Page', 'Famous Person', 'Local Bakery',
  '<img src=x onerror=alert(1)>', 'javascript:alert(1)', '=HYPERLINK("http://evil.example","x")', 'Random Follower'];
const FOLLOWERS = ['Anna Schmidt', 'Random Follower', 'Fan Only', 'Famous Person'];

// following − followers − friends / followers − following − friends / following ∩ followers
const NFB = ['Some Brand Page', 'Local Bakery', '<img src=x onerror=alert(1)>', 'javascript:alert(1)', '=HYPERLINK("http://evil.example","x")'];
const FANS = ['Fan Only'];
const MUTUAL = ['Anna Schmidt', 'Famous Person', 'Random Follower'];

const friendsRows = () => people(FRIENDS).map((p, i) => (i === 8 ? { ...p, timestamp: T0 - 400 * 86400 } : p));
const extras = {
  removed: people(['Old Friend'], 1, T0 - 900000),
  sent: people(['Pending Person'], 1, T0 - 5000),
  received: people(['Someone Asking'], 1, T0 - 6000),
  rejected: people(['Spam Account'], 1, T0 - 7000),
};
// who_you've_followed entries carry hostile extra fields that must never become a link.
const followingRows = () => people(FOLLOWING, 3600).map((p, i) =>
  (i === 6 ? { ...p, href: 'javascript:alert(document.domain)' } : i === 5 ? { ...p, uri: 'data:text/html,<script>alert(1)</script>' } : p));

function modern(prefix = '') {
  return {
    [prefix + 'connections/friends/your_friends.json']: fbJson({ friends_v2: friendsRows() }),
    [prefix + 'connections/friends/removed_friends.json']: fbJson({ deleted_friends_v2: extras.removed }),
    [prefix + 'connections/friends/sent_friend_requests.json']: fbJson({ sent_requests_v2: extras.sent }),
    [prefix + 'connections/friends/received_friend_requests.json']: fbJson({ received_requests_v2: extras.received }),
    [prefix + 'connections/friends/rejected_friend_requests.json']: fbJson({ rejected_requests_v2: extras.rejected }),
    [prefix + 'connections/friends/people_you_may_know.json']: fbJson({ people_you_may_know_v2: people(['Stranger Suggestion']) }),
    [prefix + "connections/followers/who_you've_followed.json"]: fbJson({ following_v3: followingRows() }),
    // Real exports split long lists; part 2 repeats the last entry of part 1 (must be deduplicated).
    [prefix + 'connections/followers/people_who_followed_you_1.json']: fbJson(stringList(FOLLOWERS.slice(0, 2))),
    [prefix + 'connections/followers/people_who_followed_you_2.json']: fbJson(stringList(FOLLOWERS.slice(1), 60, T0 - 60)),
    [prefix + 'your_facebook_activity/posts/your_posts__check_ins__photos_and_videos_1.json']: fbJson([{ timestamp: T0, data: [{ post: 'Hello' }] }]),
    [prefix + 'your_facebook_activity/posts/media/Mobileuploads_123/1.jpg']: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  };
}

const profile = (uri) => fbJson({ profile_v2: { name: { full_name: 'Jane Doe', first_name: 'Jane', middle_name: '', last_name: 'Doe' }, profile_uri: uri } });

const FULL_VIEWS = {
  notFollowingBack: NFB, fans: FANS, mutual: MUTUAL, friends: 9, removedFriends: 1, sentRequests: 1, receivedRequests: 1,
  rejectedRequests: 1, following: 9, followers: 4,
};
const FOLLOW_VIEWS = { notFollowingBack: NFB, fans: FANS, mutual: MUTUAL, friends: 9, following: 9, followers: 4 };

// ---------------------------------------------------------------- fixtures

/**
 * name → { files: {path: string|Buffer}, expect }
 * expect: { detect: 'high' (>=0.9) | 'medium' (0.5-0.9) | 'weak' (0.2-0.5) | 'low' (<0.1, other platform) | 'none' (0), owner?, error?: {code, params}, primary?, views?: {id: count|names[]}, warnings? }
 */
const fixtures = {};
const add = (name, files, expect) => { fixtures[name] = { files, expect }; };

add('fb_2025_json.zip', {
  ...modern(),
  'personal_information/profile_information/profile_information.json': profile('https://www.facebook.com/jane.doe'),
}, { detect: 'high', owner: 'janedoe', primary: 'notFollowingBack', views: FULL_VIEWS, warnings: [] });

{
  // Unzipped and re-zipped on macOS: wrapper folder, __MACOSX resource forks, ._ files, one file with BOM.
  const f = modern('facebook-janedoe-2025-09-01-AbCdEfGh/');
  f['facebook-janedoe-2025-09-01-AbCdEfGh/connections/friends/your_friends.json'] = '﻿' + fbJson({ friends_v2: friendsRows() });
  f["__MACOSX/facebook-janedoe-2025-09-01-AbCdEfGh/connections/followers/._who_you've_followed.json"] = Buffer.from([0, 5, 22, 7, 0, 2, 0, 0]);
  f['facebook-janedoe-2025-09-01-AbCdEfGh/connections/friends/._your_friends.json'] = Buffer.from([0, 5, 22, 7]);
  add('fb_2025_json_macos_rezip.zip', f, { detect: 'high', owner: 'janedoe', primary: 'notFollowingBack', views: FULL_VIEWS, warnings: [] });
}

{
  // Windows "Send to → Compressed folder" of an extracted export on old .NET: backslash separators.
  const f = {};
  for (const [p, v] of Object.entries(modern())) f[p.replace(/\//g, '\\')] = v;
  add('fb_windows_backslash.zip', f, { detect: 'high', primary: 'notFollowingBack', views: FULL_VIEWS });
}

{
  // Current HTML-format export. Dates as Facebook prints them for an English account.
  const d = (i) => `Nov ${14 - (i % 9)}, 2023 10:13:20 pm`;
  add('fb_2025_html.zip', {
    'connections/friends/your_friends.html': html2023('Your friends', FRIENDS.map((n, i) => [n, i === 8 ? 'Oct 10, 2022 9:05:00 am' : d(i)])),
    'connections/friends/removed_friends.html': html2023('Removed friends', [['Old Friend', 'Nov 1, 2023 8:00:00 am']]),
    'connections/friends/sent_friend_requests.html': html2023('Sent friend requests', [['Pending Person', 'Nov 13, 2023 1:00:00 pm']]),
    "connections/followers/who_you've_followed.html": html2023("Who you've followed", FOLLOWING.map((n, i) => [n, d(i)])),
    'connections/followers/people_who_followed_you.html': html2023('People who followed you', FOLLOWERS.map((n, i) => [n, d(i)])),
    'index.html': '<html><body><a href="connections/friends/your_friends.html">Friends</a></body></html>',
  }, {
    detect: 'high', primary: 'notFollowingBack',
    views: { notFollowingBack: NFB, fans: FANS, mutual: MUTUAL, friends: 9, removedFriends: 1, sentRequests: 1, following: 9, followers: 4 },
  });
}

add('fb_2021_json.zip', {
  'friends_and_followers/friends.json': fbJson({ friends_v2: friendsRows() }),
  'friends_and_followers/removed_friends.json': fbJson({ deleted_friends_v2: extras.removed }),
  'friends_and_followers/friend_requests_sent.json': fbJson({ sent_requests_v2: extras.sent }),
  'friends_and_followers/friend_requests_received.json': fbJson({ received_requests_v2: extras.received }),
  'friends_and_followers/following.json': fbJson({ following_v2: followingRows() }),
  // Followers without timestamps, plus a deactivated account without a name (skipped with a warning).
  'friends_and_followers/followers.json': fbJson({ followers_v2: FOLLOWERS.map((name) => ({ name })).concat([{ name: '' }]) }),
  'profile_information/profile_information.json': fbJson({ profile: { name: { full_name: 'Jane Doe' }, profile_uri: 'https://www.facebook.com/profile.php?id=100004242424242' } }),
}, {
  detect: 'high', owner: '100004242424242', primary: 'notFollowingBack',
  views: { notFollowingBack: NFB, fans: FANS, mutual: MUTUAL, friends: 9, removedFriends: 1, sentRequests: 1, receivedRequests: 1, following: 9, followers: 4 },
  warnings: [{ code: 'SKIPPED_UNNAMED', params: { count: 1 } }],
});

add('fb_2019_json.zip', {
  'friends/friends.json': fbJson({ friends: friendsRows() }),
  'friends/removed_friends.json': fbJson({ deleted_friends: extras.removed }),
  'friends/sent_friend_requests.json': fbJson({ sent_requests: extras.sent }),
  'following_and_followers/following.json': fbJson({ following: followingRows() }),
  'following_and_followers/followers.json': fbJson({ followers: FOLLOWERS.map((name) => ({ name })) }),
  'following_and_followers/followed_pages.json': fbJson({ pages_followed: people(['Some Page']) }),
}, {
  detect: 'high', primary: 'notFollowingBack',
  views: { notFollowingBack: NFB, fans: FANS, mutual: MUTUAL, friends: 9, removedFriends: 1, sentRequests: 1, following: 9, followers: 4 },
});

add('fb_2019_html.zip', {
  'friends/friends.html': html2019('Friends', FRIENDS.map((n, i) => [n, `Mar ${i + 1}, 2019 2:05pm`])),
  'following_and_followers/following.html': html2019('Following', FOLLOWING.map((n, i) => [n, `Mar ${i + 1}, 2019 2:05pm`])),
  'following_and_followers/followers.html': html2019('Followers', FOLLOWERS.map((n) => [n, ''])),
}, { detect: 'high', primary: 'notFollowingBack', views: FOLLOW_VIEWS });

{
  // German account, current HTML layout, localized dates.
  add('fb_2025_html_de.zip', {
    'connections/friends/your_friends.html': html2023('Deine Freunde', [['Anna Schmidt', '14. Nov. 2023, 22:13'], ['Jürgen Müller', '3. März 2021, 08:05']]),
  }, { detect: 'high', primary: 'friends', views: { friends: 2 } });
}

add('fb_multipart.zip', {
  "connections/followers/who_you've_followed_1.json": fbJson({ following_v3: followingRows().slice(0, 5) }),
  "connections/followers/who_you've_followed_2.json": fbJson({ following_v3: followingRows().slice(4) }),
  'connections/followers/people_who_followed_you_1.json': fbJson(stringList(FOLLOWERS.slice(0, 1))),
  'connections/followers/people_who_followed_you_2.json': fbJson(stringList(FOLLOWERS.slice(1, 3), 60, T0 - 60)),
  'connections/followers/people_who_followed_you_10.json': fbJson(stringList(FOLLOWERS.slice(3), 60, T0 - 180)),
  'connections/friends/your_friends.json': fbJson({ friends_v2: friendsRows() }),
}, { detect: 'high', primary: 'notFollowingBack', views: FOLLOW_VIEWS });

add('fb_followers_v2_objects.zip', {
  // Alternative people_who_followed_you shape (object with followers_v2) seen in some exports.
  "connections/followers/who_you've_followed.json": fbJson({ following_v2: followingRows() }),
  'connections/followers/people_who_followed_you.json': fbJson({ followers_v2: people(FOLLOWERS, 60) }),
  'connections/friends/your_friends.json': fbJson({ friends_v2: friendsRows() }),
}, { detect: 'high', primary: 'notFollowingBack', views: FOLLOW_VIEWS });

add('fb_label_values.zip', {
  // Defensive: Meta's newer generic record format ("label_values").
  'connections/friends/your_friends.json': fbJson({
    friends_v2: FRIENDS.slice(0, 3).map((n, i) => ({ timestamp: T0 - i, label_values: [{ label: 'Name', value: n }] })),
  }),
}, { detect: 'high', primary: 'friends', views: { friends: 3 } });

add('fb_friends_only.zip', {
  'connections/friends/your_friends.json': fbJson({ friends_v2: friendsRows() }),
  'connections/friends/removed_friends.json': fbJson({ deleted_friends_v2: extras.removed }),
}, { detect: 'high', primary: 'friends', views: { friends: 9, removedFriends: 1 }, warnings: [] });

add('fb_friends_and_following.zip', {
  'connections/friends/your_friends.json': fbJson({ friends_v2: friendsRows() }),
  "connections/followers/who_you've_followed.json": fbJson({ following_v3: followingRows() }),
}, {
  detect: 'high', primary: 'friends', views: { friends: 9, following: 9 },
  warnings: [{ code: 'MISSING_LIST', params: { list: 'followers' } }],
});

add('fb_following_only.zip', {
  "connections/followers/who_you've_followed.json": fbJson({ following_v3: followingRows() }),
}, { detect: 'high', error: { code: 'MISSING_LIST', params: { list: 'followers' } } });

add('fb_requests_only.zip', {
  'connections/friends/sent_friend_requests.json': fbJson({ sent_requests_v2: extras.sent }),
}, { detect: 'high', error: { code: 'MISSING_LIST', params: { list: 'friends' } } });

{
  const good = fbJson({ following_v3: followingRows() });
  add('fb_truncated.zip', {
    'connections/friends/your_friends.json': fbJson({ friends_v2: friendsRows() }),
    "connections/followers/who_you've_followed.json": good.slice(0, Math.floor(good.length / 2)),
    'connections/followers/people_who_followed_you_1.json': fbJson(stringList(FOLLOWERS)),
  }, { detect: 'high', error: { code: 'CORRUPT_FILE', params: { file: "connections/followers/who_you've_followed.json" } } });
}

add('fb_unknown_structure.zip', {
  'connections/friends/your_friends.json': fbJson({ something_else: 1, note: 'no list here' }),
}, { detect: 'high', error: { code: 'CORRUPT_FILE', params: { file: 'connections/friends/your_friends.json' } } });

add('fb_empty_lists.zip', {
  'connections/friends/your_friends.json': fbJson({ friends_v2: [] }),
  "connections/followers/who_you've_followed.json": fbJson({ following_v3: [] }),
  'connections/followers/people_who_followed_you_1.json': fbJson([]),
}, { detect: 'high', error: { code: 'EMPTY_LISTS', params: {} } });

add('fb_html_unknown_markup.zip', {
  'connections/friends/your_friends.html': '<html><body><table><tr><td>Anna Schmidt</td></tr></table></body></html>',
}, { detect: 'high', error: { code: 'HTML_EXPORT_UNSUPPORTED', params: {} } });

add('fb_no_connections.zip', {
  'your_facebook_activity/posts/your_posts__check_ins__photos_and_videos_1.json': fbJson([{ timestamp: T0 }]),
  'personal_information/profile_information/profile_information.json': profile('https://www.facebook.com/jane.doe'),
}, { detect: 'medium', error: { code: 'NO_RELEVANT_FILES', params: {} } });

add('fb_mixed_json_html.zip', {
  // JSON and HTML export of the same account uploaded together: JSON wins, nothing counted twice.
  ...modern(),
  'connections/friends/your_friends.html': html2023('Your friends', [['Only In Html', 'Nov 1, 2023 8:00:00 am']]),
}, { detect: 'high', primary: 'notFollowingBack', views: FULL_VIEWS });

add('fb_xss.zip', {
  "connections/followers/who_you've_followed.json": fbJson({
    following_v3: [
      { name: '<img src=x onerror=alert(1)>', timestamp: T0, href: 'javascript:alert(1)' },
      { name: '<script>alert(2)</script>', timestamp: T0 - 1, uri: 'https://evil.example/' },
      { name: 'javascript:alert(3)', timestamp: T0 - 2 },
      { name: '"><svg onload=alert(4)>', timestamp: T0 - 3, profile_uri: 'data:text/html,<script>alert(5)</script>' },
      { name: 'Right‮Override', timestamp: T0 - 4 },
    ],
  }),
  'connections/followers/people_who_followed_you_1.json': fbJson(stringList(['Nobody Else'])),
  'connections/friends/your_friends.html': html2023('Your friends', [['<b onmouseover=alert(6)>Bold</b>', 'Nov 1, 2023 8:00:00 am']])
    .replace('<a href="#">', '<a href="javascript:alert(7)">'),
}, {
  detect: 'high', primary: 'notFollowingBack',
  views: {
    notFollowingBack: ['<img src=x onerror=alert(1)>', '<script>alert(2)</script>', 'javascript:alert(3)', '"><svg onload=alert(4)>', 'Right Override'],
    fans: ['Nobody Else'], mutual: [], friends: ['<b onmouseover=alert(6)>Bold</b>'], following: 5, followers: 1,
  },
});

// ---- other platforms / not an export
const igItem = (u) => ({ title: '', media_list_data: [], string_list_data: [{ href: `https://www.instagram.com/${u}`, value: u, timestamp: T0 }] });
add('wrong_instagram.zip', {
  'connections/followers_and_following/followers_1.json': JSON.stringify([igItem('alice'), igItem('bob')]),
  'connections/followers_and_following/following.json': JSON.stringify({ relationships_following: [{ title: 'carol', string_list_data: [{ href: 'https://www.instagram.com/_u/carol', timestamp: T0 }] }] }),
  'your_instagram_activity/likes/liked_posts.json': '{}',
}, { detect: 'low', error: { code: 'WRONG_PLATFORM', params: { platform: 'instagram' } } });
add('wrong_instagram_nested.zip', {
  'instagram-jdoe-2025-09-01-AbCd/connections/followers_and_following/followers_1.json': JSON.stringify([igItem('alice')]),
  'instagram-jdoe-2025-09-01-AbCd/connections/followers_and_following/following.json': JSON.stringify({ relationships_following: [] }),
}, { detect: 'low', error: { code: 'WRONG_PLATFORM', params: { platform: 'instagram' } } });
add('wrong_tiktok.zip', {
  'user_data_tiktok.json': JSON.stringify({ Profile: { 'Profile Info': { ProfileMap: { userName: 'tt' } } } }),
}, { detect: 'low', error: { code: 'WRONG_PLATFORM', params: { platform: 'tiktok' } } });
add('wrong_x.zip', {
  'data/follower.js': 'window.YTD.follower.part0 = []',
  'data/following.js': 'window.YTD.following.part0 = []',
  'data/account.js': 'window.YTD.account.part0 = []',
}, { detect: 'low', error: { code: 'WRONG_PLATFORM', params: { platform: 'x' } } });
add('not_an_export.zip', {
  'readme.txt': 'hello',
  'photos/1.jpg': Buffer.from([0xff, 0xd8, 0xff]),
}, { detect: 'none', error: { code: 'NO_RELEVANT_FILES', params: {} } });

// ---- loose files (iOS auto-extract, user picks single files)
const loose = {
  'your_friends.json': { content: fbJson({ friends_v2: friendsRows() }), expect: { detect: 'high', primary: 'friends', views: { friends: 9 } } },
  "who_you've_followed.json": { content: fbJson({ following_v3: followingRows() }), expect: { detect: 'high', error: { code: 'MISSING_LIST', params: { list: 'followers' } } } },
  // An Instagram following.json picked by hand: bare generic name, identified by its content.
  'following.json': {
    content: JSON.stringify({ relationships_following: [{ title: 'carol', string_list_data: [{ href: 'https://www.instagram.com/_u/carol', timestamp: T0 }] }] }),
    expect: { detect: 'weak', error: { code: 'WRONG_PLATFORM', params: { platform: 'instagram' } } },
  },
};

// ---- large list (performance / 100k rendering)
function large(n = 100_000) {
  const following = [];
  const followers = [];
  for (let i = 0; i < n; i++) {
    following.push({ name: `Person ${i} Ä`, timestamp: T0 - i });
    if (i % 2 === 0) followers.push({ title: '', media_list_data: [], string_list_data: [{ value: `Person ${i} Ä`, timestamp: T0 - i }] });
  }
  return {
    "connections/followers/who_you've_followed.json": fbJson({ following_v3: following }),
    'connections/followers/people_who_followed_you_1.json': fbJson(followers),
    'connections/friends/your_friends.json': fbJson({ friends_v2: people(['Person 1 Ä', 'Person 3 Ä']) }),
  };
}
add('fb_big_100k.zip', large(), {
  detect: 'high', primary: 'notFollowingBack',
  views: { notFollowingBack: 49_998, fans: 0, mutual: 50_000, friends: 2, following: 100_000, followers: 50_000 },
});

// ---------------------------------------------------------------- writer

async function zipBuffer(files) {
  const zip = new JSZip();
  for (const [p, content] of Object.entries(files)) zip.file(p, content, { date: FIXED_DATE, createFolders: false });
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 }, platform: 'UNIX' });
}

async function main() {
  const expected = {};
  for (const [name, { files, expect }] of Object.entries(fixtures)) {
    fs.writeFileSync(path.join(OUT, name), await zipBuffer(files));
    expected[name] = expect;
  }
  fs.mkdirSync(path.join(OUT, 'loose'), { recursive: true });
  for (const [name, { content, expect }] of Object.entries(loose)) {
    fs.writeFileSync(path.join(OUT, 'loose', name), content);
    expected['loose/' + name] = expect;
  }
  fs.writeFileSync(path.join(OUT, 'expected.json'), JSON.stringify(expected, null, 2) + '\n');
  console.log(`wrote ${Object.keys(expected).length} fixtures to ${OUT}`);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { fixtures, loose, large, T0 };
