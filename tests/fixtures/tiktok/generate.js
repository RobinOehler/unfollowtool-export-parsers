#!/usr/bin/env node
/*
 * Generates the TikTok export fixtures in this folder plus expected.json (the single source of
 * truth for unit and e2e tests).
 *
 *   node tests/fixtures/tiktok/generate.js
 *
 * The layouts mirror real "Download your data" exports as far as they are publicly documented
 * (TikTok data-portability docs, open-source research parsers such as d3i-infra's, and the
 * 2026-09 audit in _audit/tiktok and _audit2/tiktok). Output is deterministic (fixed ZIP dates).
 *
 * Kinds: "zip" = one uploaded ZIP · "file" = one uploaded raw file · "dir" = several raw files
 * uploaded together (all files of that folder).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

const OUT = __dirname;
const FIXED_DATE = new Date('2026-01-01T00:00:00Z');

/* ------------------------------------------------------------------ base data */
// followers: alice.m bob_22 carol dave.k Mia_Fit
// following: alice.m bob_22 eve.cooks frank__ grace.x mia_fit
// → notFollowingBack 3 (eve.cooks frank__ grace.x) · fans 2 (carol dave.k) · mutual 3
const FOLLOWERS = ['alice.m', 'bob_22', 'carol', 'dave.k', 'Mia_Fit'];
const FOLLOWING = ['alice.m', 'bob_22', 'eve.cooks', 'frank__', 'grace.x', 'mia_fit'];
const BASE_COUNTS = { followers: 5, following: 6, notFollowingBack: 3, fans: 2, mutual: 3 };

const pad = (n) => String(n).padStart(2, '0');
// JSON exports: "YYYY-MM-DD HH:MM:SS" (UTC, no zone suffix)
const jsonDate = (i, month) => `2024-${pad(month)}-${pad(i + 1)} ${pad(8 + i)}:15:00`;
// TXT exports: "YYYY-MM-DD HH:MM:SS UTC"
const txtDate = (i, month) => `2023-${pad(month)}-${pad(i + 10)} 06:18:18 UTC`;

const jsonList = (names, month, userKey = 'UserName') => names.map((n, i) => ({ Date: jsonDate(i, month), [userKey]: n }));
const FANS = jsonList(FOLLOWERS, 3);
const FOLLOWS = jsonList(FOLLOWING, 5);

function txtList(names, month, { eol = '\n', dateLabel = 'Date', userLabel = 'Username' } = {}) {
  return names.map((n, i) => `${dateLabel}: ${txtDate(i, month)}${eol}${userLabel}: ${n}${eol}`).join(eol);
}

const PROFILE_MAP = {
  PlatformInfo: [],
  bioDescription: 'just vibes',
  birthDate: '01-Jan-2000',
  emailAddress: '',
  followerCount: 5,
  followingCount: 6,
  likesReceived: '120',
  profilePhoto: 'https://p16-sign.tiktokcdn.com/avatar.jpeg',
  telephoneNumber: '',
  userName: 'me_myself'
};
const WATCH = { VideoList: [{ Date: '2024-06-01 12:00:00', Link: 'https://www.tiktokv.com/share/video/7300000000000000001/' }] };

/* ------------------------------------------------------------------ documents */
// Current layout (TikTok data-portability "Profile and Settings" category, 2025+)
const DOC_PROFILE_AND_SETTINGS = {
  'Ads and data': { 'Ad Interests': { AdInterestCategories: null } },
  'App Settings': { Settings: { SettingsMap: { 'Allow DownloadVideo': 'Everyone' } } },
  Comment: { Comments: { CommentsList: [] } },
  'Direct Message': { 'Direct Messages': { ChatHistory: {} } },
  'Profile And Settings': {
    'Profile Info': { ProfileMap: PROFILE_MAP },
    Follower: { FansList: FANS },
    Following: { Following: FOLLOWS },
    'Block List': { BlockList: [] }
  },
  'Your Activity': { 'Watch History': WATCH, Searches: { SearchList: [] }, 'Like List': { ItemFavoriteList: [] } },
  Video: { Videos: { VideoList: [] } }
};

// 2024 layout ("Your Activity" holds the lists, profile under "Profile"."Profile Information")
const DOC_YOUR_ACTIVITY = {
  Profile: { 'Profile Information': { ProfileMap: PROFILE_MAP } },
  'Your Activity': {
    Follower: { FansList: FANS },
    Following: { Following: FOLLOWS },
    'Watch History': WATCH,
    Hashtag: { HashtagList: null }
  }
};

// 2020–2023 layout (user_data.json, "Activity" with "Follower List"/"Following List")
const DOC_LEGACY = {
  Activity: {
    'Follower List': { FansList: FANS },
    'Following List': { Following: FOLLOWS },
    'Video Browsing History': { VideoList: [] },
    'Like List': { ItemFavoriteList: [] }
  },
  Profile: { 'Profile Information': { ProfileMap: PROFILE_MAP } }
};

const DOC_PROFILE_VARIANT = { Profile: { Follower: { FansList: FANS }, Following: { Following: FOLLOWS } } };
const ya = (fans, follows, extra = {}) => ({ 'Your Activity': Object.assign({ Follower: { FansList: fans }, Following: { Following: follows } }, extra) });

/* ------------------------------------------------------------------ fixtures */
const F = []; // { name, kind, files: {path: string|Buffer}, expect }
const add = (name, kind, files, expect) => F.push({ name, kind, files, expect });
const ok = (extra = {}) => Object.assign({ counts: BASE_COUNTS, owner: null, warnings: [] }, extra);
const utf16le = (s) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s.replace(/\n/g, '\r\n'), 'utf16le')]);

add('json_profile_and_settings.zip', 'zip',
  { 'TikTok_Data_1758000000/user_data_tiktok.json': JSON.stringify(DOC_PROFILE_AND_SETTINGS, null, 2) },
  ok({ detectMin: 0.9, owner: 'me_myself', format: 'json' }));

add('json_your_activity.zip', 'zip',
  { 'user_data_tiktok.json': JSON.stringify(DOC_YOUR_ACTIVITY) },
  ok({ detectMin: 0.9, owner: 'me_myself', format: 'json' }));

add('json_legacy_activity_user_data.zip', 'zip',
  { 'user_data.json': JSON.stringify(DOC_LEGACY) },
  ok({ detectMin: 0.7, owner: 'me_myself', format: 'json' }));

add('json_profile_variant.zip', 'zip',
  { 'export/user_data_tiktok.json': JSON.stringify(DOC_PROFILE_VARIANT) },
  ok({ detectMin: 0.9, format: 'json' }));

// Field-name variants, "@" prefixes, epoch dates, lowercase keys
add('json_field_variants.zip', 'zip', {
  'user_data_tiktok.json': JSON.stringify({
    'profile and settings': {
      follower: { fanslist: [
        { Date: '2024-03-01 08:15:00', Username: 'alice.m' },
        { date: '2024-03-02 09:15:00', username: '@bob_22' },
        { Date: 1709456100, uniqueId: 'carol' },
        { Date: '2024-03-04T11:15:00Z', userName: 'dave.k' },
        { Date: '2024-03-05 12:15:00', 'User Name': 'Mia_Fit' }
      ] },
      following: { following: jsonList(FOLLOWING, 5, 'Username') }
    }
  })
}, ok({ detectMin: 0.9, format: 'json', dates: { carol: '2024-03-03T08:55:00.000Z', 'dave.k': '2024-03-04T11:15:00.000Z' } }));

// BOM + macOS Finder re-zip (__MACOSX/ AppleDouble files)
add('json_bom_macos_rezip.zip', 'zip', {
  'TikTok_Data_1758000000/user_data_tiktok.json': '\uFEFF' + JSON.stringify(DOC_PROFILE_AND_SETTINGS),
  '__MACOSX/TikTok_Data_1758000000/._user_data_tiktok.json': Buffer.from([0, 5, 22, 7, 0, 2, 0, 0, 77, 97, 99, 32, 79, 83, 32, 88]),
  'TikTok_Data_1758000000/.DS_Store': Buffer.from([0, 0, 0, 1, 66, 117, 100, 49])
}, ok({ detectMin: 0.9, owner: 'me_myself', format: 'json' }));

// Duplicates and case differences collapse to one entry per key
add('json_duplicates_case.zip', 'zip', {
  'user_data_tiktok.json': JSON.stringify(ya(
    jsonList(['Alice.M', 'alice.m', 'bob_22'], 3),
    jsonList(['alice.m', 'eve.cooks', 'EVE.COOKS', 'eve.cooks', 'frank__', 'BOB_22'], 5)
  ))
}, { counts: { followers: 2, following: 4, notFollowingBack: 2, fans: 0, mutual: 2 }, owner: null, warnings: [], format: 'json' });

// Null / unusable items inside a list are skipped with a warning (null itself is ignored silently)
add('json_null_items.zip', 'zip', {
  'user_data_tiktok.json': JSON.stringify(ya([...FANS.slice(0, 2), null, {}, ...FANS.slice(2)], FOLLOWS))
}, ok({ warnings: ['ENTRIES_SKIPPED'], format: 'json' }));

// Account follows nobody: "Following": null
add('json_following_null.zip', 'zip', {
  'user_data_tiktok.json': JSON.stringify({ 'Your Activity': { Follower: { FansList: FANS }, Following: null } })
}, { counts: { followers: 5, following: 0, notFollowingBack: 0, fans: 5, mutual: 0 }, owner: null, warnings: ['LIST_EMPTY'], format: 'json' });

// Account without followers: "FansList": null
add('json_fanslist_null.zip', 'zip', {
  'user_data_tiktok.json': JSON.stringify(ya(null, FOLLOWS))
}, { counts: { followers: 0, following: 6, notFollowingBack: 6, fans: 0, mutual: 0 }, owner: null, warnings: ['LIST_EMPTY'], format: 'json' });

add('json_missing_follower_section.zip', 'zip', {
  'user_data_tiktok.json': JSON.stringify({ 'Profile And Settings': { Following: { Following: FOLLOWS }, 'Profile Info': { ProfileMap: PROFILE_MAP } } })
}, { error: { code: 'MISSING_LIST', params: { list: 'followers' } } });

// Export requested without "Profile and Settings": only activity data
add('json_no_lists.zip', 'zip', {
  'TikTok_Data_1758000000/user_data_tiktok.json': JSON.stringify({ 'Your Activity': { 'Watch History': WATCH, Searches: { SearchList: [] } } })
}, { error: { code: 'MISSING_LIST', params: { list: 'following' } } });

add('json_truncated.zip', 'zip', {
  'user_data_tiktok.json': JSON.stringify(DOC_PROFILE_AND_SETTINGS).slice(0, 300)
}, { error: { code: 'CORRUPT_FILE', params: { file: 'user_data_tiktok.json' } } });

add('json_unknown_entry_fields.zip', 'zip', {
  'user_data_tiktok.json': JSON.stringify(ya(FOLLOWERS.map((n) => ({ Handle: n, When: '2024-01-01' })), FOLLOWS))
}, { error: { code: 'CORRUPT_FILE', params: { file: 'user_data_tiktok.json' } } });

add('json_empty_lists.zip', 'zip', {
  'user_data_tiktok.json': JSON.stringify(ya([], []))
}, { error: { code: 'EMPTY_LISTS', params: {} } });

// Two exports in one upload: the newer one (latest follow date) is used, with a warning
add('json_multiple_exports.zip', 'zip', {
  'old/user_data_tiktok.json': JSON.stringify(ya(jsonList(['old_fan'], 1).map((e) => ({ ...e, Date: '2022-01-01 10:00:00' })), jsonList(['old_follow'], 1).map((e) => ({ ...e, Date: '2022-01-02 10:00:00' })))),
  'new/user_data_tiktok (1).json': JSON.stringify(DOC_PROFILE_AND_SETTINGS)
}, ok({ owner: 'me_myself', warnings: ['MULTIPLE_EXPORTS'], usedFile: 'new/user_data_tiktok (1).json', format: 'json' }));

// XSS / URL-injection attempts: must stay inert text, never become a link
const EVIL = ['<img src=x onerror=alert(1)>', 'javascript:alert(1)', '"><svg/onload=alert(2)>', "x' onmouseover='alert(3)", 'a&quot;b', ' spaced name ', '\u202Eevil\u202C', 'ok.user_1'];
add('json_xss_usernames.zip', 'zip', {
  'user_data_tiktok.json': JSON.stringify(ya([], EVIL.map((u, i) => ({ Date: jsonDate(i % 9, 1), UserName: u }))))
}, { counts: { followers: 0, following: 8, notFollowingBack: 8, fans: 0, mutual: 0 }, owner: null, warnings: ['LIST_EMPTY'], format: 'json', urlFor: ['evil', 'ok.user_1'] });

/* TXT exports */
add('txt_profile_and_settings_crlf.zip', 'zip', {
  'TikTok_Data_1758000000/Profile and Settings/Follower.txt': txtList(FOLLOWERS, 8, { eol: '\r\n' }),
  'TikTok_Data_1758000000/Profile and Settings/Following.txt': txtList(FOLLOWING, 9, { eol: '\r\n' }),
  'TikTok_Data_1758000000/Profile and Settings/Profile Info.txt': 'Username: me_myself\r\nBio: just vibes\r\n',
  'TikTok_Data_1758000000/Your Activity/Watch History.txt': 'Date: 2023-01-01 00:00:00 UTC\r\nLink: https://www.tiktokv.com/share/video/1/\r\n'
}, ok({ detectMin: 0.9, format: 'txt', dates: { 'alice.m': '2023-08-10T06:18:18.000Z' } }));

add('txt_your_activity.zip', 'zip', {
  'Your Activity/Follower.txt': txtList(FOLLOWERS, 8),
  'Your Activity/Following.txt': txtList(FOLLOWING, 9),
  'Your Activity/Searches.txt': 'Date: 2023-01-01 00:00:00 UTC\nSearch Term: cats\n'
}, ok({ detectMin: 0.85, format: 'txt' }));

add('txt_legacy_list_names.zip', 'zip', {
  'Activity/Follower List.txt': txtList(FOLLOWERS, 8),
  'Activity/Following List.txt': txtList(FOLLOWING, 9)
}, ok({ detectMin: 0.85, format: 'txt' }));

// Dutch app language: translated file names and labels (confirmed by d3i-infra's parser)
add('txt_dutch.zip', 'zip', {
  'TikTok_Data_1758000000/Profiel/Volger.txt': txtList(FOLLOWERS, 8, { dateLabel: 'Datum', userLabel: 'Gebruikersnaam' }),
  'TikTok_Data_1758000000/Profiel/Volgend.txt': txtList(FOLLOWING, 9, { dateLabel: 'Datum', userLabel: 'Gebruikersnaam' })
}, ok({ detectMin: 0.85, format: 'txt' }));

// German-style labels the parser does not know by name ("Nutzername") → resolved structurally
add('txt_unknown_labels.zip', 'zip', {
  'Profil/Follower.txt': txtList(FOLLOWERS, 8, { dateLabel: 'Datum', userLabel: 'Nutzername' }),
  'Profil/Folge ich.txt': txtList(FOLLOWING, 9, { dateLabel: 'Datum', userLabel: 'Nutzername' })
}, ok({ detectMin: 0.85, format: 'txt' }));

add('txt_numbered_parts.zip', 'zip', {
  'Profile and Settings/Follower.txt': txtList(FOLLOWERS, 8),
  'Profile and Settings/Following_1.txt': txtList(FOLLOWING.slice(0, 3), 9),
  'Profile and Settings/Following_2.txt': txtList(FOLLOWING.slice(3), 10)
}, ok({ detectMin: 0.85, format: 'txt' }));

add('txt_missing_follower_file.zip', 'zip', {
  'Your Activity/Following.txt': txtList(FOLLOWING, 9)
}, { error: { code: 'MISSING_LIST', params: { list: 'followers' } }, detectMin: 0.6 });

add('txt_empty_follower_file.zip', 'zip', {
  'Your Activity/Follower.txt': '',
  'Your Activity/Following.txt': txtList(FOLLOWING, 9)
}, { counts: { followers: 0, following: 6, notFollowingBack: 6, fans: 0, mutual: 0 }, owner: null, warnings: ['LIST_EMPTY'], format: 'txt' });

// Re-saved in Windows Notepad as "Unicode" (UTF-16LE with BOM, CRLF)
add('txt_utf16le.zip', 'zip', {
  'Your Activity/Follower.txt': utf16le(txtList(FOLLOWERS, 8)),
  'Your Activity/Following.txt': utf16le(txtList(FOLLOWING, 9))
}, ok({ format: 'txt' }));

add('txt_garbage.zip', 'zip', {
  'Your Activity/Follower.txt': 'This file was edited by hand and has no records at all.\nJust some text.\n',
  'Your Activity/Following.txt': txtList(FOLLOWING, 9)
}, { error: { code: 'CORRUPT_FILE', params: { file: 'Your Activity/Follower.txt' } } });

// JSON is broken but the TXT variant of the same export is there too → TXT is used
add('mixed_json_corrupt_txt_ok.zip', 'zip', {
  'TikTok_Data_1758000000/user_data_tiktok.json': '{"Your Activity": {"Follower": ',
  'TikTok_Data_1758000000/Your Activity/Follower.txt': txtList(FOLLOWERS, 8),
  'TikTok_Data_1758000000/Your Activity/Following.txt': txtList(FOLLOWING, 9)
}, ok({ format: 'txt' }));

/* Raw uploads (iOS / Safari auto-extracts ZIPs) */
add('raw_user_data_tiktok (1).json', 'file', { 'raw_user_data_tiktok (1).json': JSON.stringify(DOC_PROFILE_AND_SETTINGS) },
  ok({ owner: 'me_myself', format: 'json' }));
add('raw_txt', 'dir', {
  'raw_txt/Follower.txt': txtList(FOLLOWERS, 8),
  'raw_txt/Following.txt': txtList(FOLLOWING, 9)
}, ok({ detectMin: 0.85, format: 'txt' }));

/* Other platforms and junk */
const igItem = (n) => ({ title: '', media_list_data: [], string_list_data: [{ href: `https://www.instagram.com/${n}`, value: n, timestamp: 1700000000 }] });
add('instagram_export.zip', 'zip', {
  'instagram-me_myself-2026-09-01-AbCdEf/connections/followers_and_following/followers_1.json': JSON.stringify(['alice'].map(igItem)),
  'instagram-me_myself-2026-09-01-AbCdEf/connections/followers_and_following/following.json': JSON.stringify({ relationships_following: ['alice', 'eve'].map(igItem) })
}, { error: { code: 'WRONG_PLATFORM', params: { platform: 'instagram' } }, detectMax: 0.05 });

add('instagram_following_raw.json', 'file', {
  'instagram_following_raw.json': JSON.stringify({ relationships_following: ['alice', 'eve'].map(igItem) })
}, { error: { code: 'WRONG_PLATFORM', params: { platform: 'instagram' } }, detectMax: 0.3 });

add('facebook_export.zip', 'zip', {
  'facebook-me-2026-09-01/connections/friends/your_friends.json': JSON.stringify({ friends_v2: [{ name: 'Alice', timestamp: 1700000000 }] }),
  "facebook-me-2026-09-01/connections/followers/who_you've_followed.json": JSON.stringify({ following_v3: [] })
}, { error: { code: 'WRONG_PLATFORM', params: { platform: 'facebook' } }, detectMax: 0.05 });

add('x_export.zip', 'zip', {
  'twitter-2026-09-01-1a2b3c/data/follower.js': 'window.YTD.follower.part0 = []',
  'twitter-2026-09-01-1a2b3c/data/following.js': 'window.YTD.following.part0 = []',
  'twitter-2026-09-01-1a2b3c/Your archive.html': '<html></html>'
}, { error: { code: 'WRONG_PLATFORM', params: { platform: 'x' } }, detectMax: 0.05 });

add('unrelated.zip', 'zip', { 'readme.txt': 'hello', 'photos/a.jpg': 'jpg' },
  { error: { code: 'NO_RELEVANT_FILES', params: {} }, detectMax: 0.05 });

/* ------------------------------------------------------------------ write */
async function writeFixture(fx) {
  if (fx.kind === 'zip') {
    const zip = new JSZip();
    for (const [p, c] of Object.entries(fx.files)) zip.file(p, c, { date: FIXED_DATE, createFolders: false });
    fs.writeFileSync(path.join(OUT, fx.name), await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  } else {
    for (const [p, c] of Object.entries(fx.files)) {
      fs.mkdirSync(path.dirname(path.join(OUT, p)), { recursive: true });
      fs.writeFileSync(path.join(OUT, p), c);
    }
  }
}

(async () => {
  for (const fx of F) await writeFixture(fx);
  const manifest = F.map((fx) => Object.assign({ file: fx.name, kind: fx.kind }, fx.expect));
  fs.writeFileSync(path.join(OUT, 'expected.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`wrote ${F.length} TikTok fixtures + expected.json to ${path.relative(process.cwd(), OUT) || '.'}`);
})().catch((e) => { console.error(e); process.exit(1); });
