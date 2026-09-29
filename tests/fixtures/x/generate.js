#!/usr/bin/env node
/*
 * Generates the X (Twitter) archive fixtures in this folder and expected.json, which describes the
 * outcome every fixture must produce. Deterministic: rerunning gives byte-identical files.
 *
 *   node tests/fixtures/x/generate.js
 *
 * Layout of a real "Download an archive of your data" ZIP (format unchanged 2019-2026):
 *   Your archive.html            offline viewer
 *   assets/…                     viewer JS/CSS/images
 *   data/manifest.js             window.__THAR_CONFIG = { userInfo, archiveInfo, readmeInfo, dataTypes }
 *   data/account.js              window.YTD.account.part0 = [ { "account" : { username, accountId, … } } ]
 *   data/follower.js             window.YTD.follower.part0 = [ { "follower" : { accountId, userLink } } ]
 *   data/following.js            window.YTD.following.part0 = [ { "following" : { accountId, userLink } } ]
 *   data/follower-part1.js …     window.YTD.follower.part1 = […]   (large lists are split)
 *   data/tweets.js, data/like.js, data/tweets_media/… and many more
 * The follow lists contain numeric account IDs only (no usernames, no dates). X writes JSON with
 * " : " separators and 2-space indentation, which the helpers below reproduce.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

const OUT = __dirname;
const FIXED_DATE = new Date('2026-09-01T10:00:00Z'); // stable ZIP timestamps → reproducible bytes
const ARCHIVE_DIR = 'twitter-2026-09-01-8f3a2c1b9e7d4f60a1b2c3d4e5f6a7b8/';

// ---------------------------------------------------------------- content helpers

const xJson = (value) => JSON.stringify(value, null, 2).replace(/^(\s*"(?:[^"\\]|\\.)*"): /gm, '$1 : ');
const intentLink = (id) => `https://twitter.com/intent/user?user_id=${id}`;
const ytd = (name, part, rows) => `window.YTD.${name}.part${part} = ${xJson(rows)}`;
const relRows = (kind, ids) => ids.map((id) => ({ [kind]: { accountId: String(id), userLink: intentLink(id) } }));

function accountJs(username = 'sample_owner', accountId = '1203948576102938475') {
  return ytd('account', 0, [{
    account: {
      email: 'owner@example.test',
      createdVia: 'web',
      username,
      accountId,
      createdAt: '2019-12-09T08:15:30.000Z',
      accountDisplayName: 'Sample Owner',
    },
  }]);
}

/** data/manifest.js; parts = { follower: [count, …], following: [count, …] }. */
function manifestJs({ parts, generationDate = '2026-09-01T09:58:12.345Z', userName = 'sample_owner' }) {
  const files = (type) => parts[type].map((count, i) => ({
    fileName: i === 0 ? `data/${type}.js` : `data/${type}-part${i}.js`,
    globalName: `YTD.${type}.part${i}`,
    count: String(count),
  }));
  return 'window.__THAR_CONFIG = ' + xJson({
    userInfo: { accountId: '1203948576102938475', userName, displayName: 'Sample Owner' },
    archiveInfo: { sizeBytes: '48213', generationDate, isPartialArchive: false, maxPartSizeBytes: '53687091200' },
    readmeInfo: { fileName: 'data/README.txt', directory: 'data/', name: 'README.txt' },
    dataTypes: {
      account: { files: [{ fileName: 'data/account.js', globalName: 'YTD.account.part0', count: '1' }] },
      follower: { files: files('follower') },
      following: { files: files('following') },
      like: { files: [{ fileName: 'data/like.js', globalName: 'YTD.like.part0', count: '1' }] },
      tweets: { mediaDirectory: 'data/tweets_media', files: [{ fileName: 'data/tweets.js', globalName: 'YTD.tweets.part0', count: '1' }] },
    },
  });
}

const VIEWER = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Your archive</title>'
  + '<script src="assets/js/main.js"></script></head><body><div id="root"></div></body></html>';
const README = 'Twitter archive\n\nThis archive contains the data associated with your account.\n';
const TWEETS = ytd('tweets', 0, [{ tweet: { id_str: '1830000000000000001', full_text: 'hello', created_at: 'Mon Sep 01 10:00:00 +0000 2025', entities: { user_mentions: [], hashtags: [], urls: [] } } }]);
const LIKE = ytd('like', 0, [{ like: { tweetId: '1830000000000000002', fullText: 'liked', expandedUrl: 'https://twitter.com/i/web/status/1830000000000000002' } }]);

/** A complete archive (paths relative to the ZIP root). Pass split lists to create -partN files. */
function archive({ followers, following, prefix = '', manifest = true, generationDate, account = true }) {
  const asParts = (list) => (Array.isArray(list[0]) ? list : [list]);
  const fParts = asParts(followers);
  const gParts = asParts(following);
  const files = {
    'Your archive.html': VIEWER,
    'assets/js/main.js': '/* archive viewer */',
    'data/README.txt': README,
    'data/tweets.js': TWEETS,
    'data/like.js': LIKE,
    'data/tweets_media/1830000000000000001-a1B2c3D4.jpg': Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]),
  };
  if (account) files['data/account.js'] = accountJs();
  fParts.forEach((ids, i) => { files[i ? `data/follower-part${i}.js` : 'data/follower.js'] = ytd('follower', i, relRows('follower', ids)); });
  gParts.forEach((ids, i) => { files[i ? `data/following-part${i}.js` : 'data/following.js'] = ytd('following', i, relRows('following', ids)); });
  if (manifest) {
    files['data/manifest.js'] = manifestJs({ parts: { follower: fParts.map((p) => p.length), following: gParts.map((p) => p.length) }, generationDate });
  }
  const out = {};
  for (const [p, c] of Object.entries(files)) out[prefix + p] = c;
  return out;
}

// ---------------------------------------------------------------- IDs (made up, realistic mix of lengths)

const F = ['1432874569021935616', '98765432', '1203000000000000017', '1511223344556677889', '3141592653']; // followers
const G = ['1203000000000000017', '1511223344556677889', '3141592653', // mutual
  '1788990011223344556', '271828182', '1600000000000000042', '1111111111111111111', '1234567']; // not following back
const BASIC_EXPECT = {
  owner: 'sample_owner', followers: 5, following: 8,
  notFollowingBack: G.slice(3), fans: F.slice(0, 2), mutual: G.slice(0, 3),
};

// ---------------------------------------------------------------- writers

async function writeZip(name, files) {
  const zip = new JSZip();
  for (const [p, content] of Object.entries(files)) zip.file(p, content, { date: FIXED_DATE, createFolders: false });
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 }, platform: 'UNIX' });
  fs.writeFileSync(path.join(OUT, name), buf);
}

async function main() {
  const expected = {};
  const add = async (name, files, expect) => { await writeZip(name, files); expected[name] = expect; };

  // Current format, complete archive with manifest and account.js.
  await add('x_basic.zip', archive({ followers: F, following: G }), { ...BASIC_EXPECT, exportedAt: '2026-09-01T09:58:12.345Z' });

  // Same archive with an upper-case extension (Windows/download managers). Parser sees the same paths.
  await add('x_upper_ext.ZIP', archive({ followers: F, following: G }), BASIC_EXPECT);

  // Large lists are split into <type>-partN.js; manifest.js lists every part. One ID occurs in two parts.
  const mpFollowers = [F.slice(0, 2), F.slice(2, 4), [F[4], F[0]]];
  const mpFollowing = [G.slice(0, 5), G.slice(5)];
  await add('x_multipart.zip', archive({ followers: mpFollowers, following: mpFollowing }), BASIC_EXPECT);
  await add('x_multipart_no_manifest.zip', archive({ followers: mpFollowers, following: mpFollowing, manifest: false }), BASIC_EXPECT);

  // The manifest announces follower-part1.js, but the file is missing → list incomplete.
  const missingPart = archive({ followers: [F.slice(0, 3), F.slice(3)], following: G });
  delete missingPart['data/follower-part1.js'];
  await add('x_missing_part.zip', missingPart, { error: 'MISSING_LIST', params: { list: 'followers', file: 'data/follower-part1.js' } });

  // Safari/Finder auto-extract and re-compress: extra top-level folder, __MACOSX resource forks, .DS_Store.
  await add('x_nested_folder.zip', archive({ followers: F, following: G, prefix: ARCHIVE_DIR }), BASIC_EXPECT);
  const mac = archive({ followers: F, following: G, prefix: ARCHIVE_DIR });
  const fork = Buffer.from([0x00, 0x05, 0x16, 0x07, 0x00, 0x02, 0x00, 0x00, 0x4d, 0x61, 0x63, 0x20, 0x4f, 0x53, 0x20, 0x58]);
  mac[`__MACOSX/${ARCHIVE_DIR}data/._follower.js`] = fork;
  mac[`__MACOSX/${ARCHIVE_DIR}data/._following.js`] = fork;
  mac[`${ARCHIVE_DIR}.DS_Store`] = Buffer.from([0, 0, 0, 1, 0x42, 0x75, 0x64, 0x31]);
  await add('x_macos_rezip.zip', mac, BASIC_EXPECT);

  // Only the data/ folder zipped, or the *contents* of data/ zipped (files at the ZIP root).
  const full = archive({ followers: F, following: G });
  const dataOnly = Object.fromEntries(Object.entries(full).filter(([p]) => p.startsWith('data/')));
  await add('x_data_folder_only.zip', dataOnly, BASIC_EXPECT);
  const rootFiles = Object.fromEntries(Object.entries(dataOnly).map(([p, c]) => [p.slice(5), c]));
  await add('x_root_files.zip', rootFiles, BASIC_EXPECT);

  // Windows zippers (PowerShell 5 Compress-Archive) store backslash separators; FileSet normalizes them.
  const backslash = Object.fromEntries(Object.entries(full).map(([p, c]) => [p.replace(/\//g, '\\'), c]));
  await add('x_backslash_paths.zip', backslash, BASIC_EXPECT);

  // BOM, CRLF line endings and a trailing semicolon (files re-saved by Windows editors).
  const crlf = archive({ followers: F, following: G });
  for (const p of ['data/follower.js', 'data/following.js', 'data/account.js']) crlf[p] = '﻿' + crlf[p].replace(/\n/g, '\r\n') + ';\r\n';
  await add('x_bom_crlf.zip', crlf, BASIC_EXPECT);

  // Duplicates, numeric IDs, unsafe numbers, missing accountId with a valid intent link, junk rows.
  const messy = archive({ followers: [], following: [] });
  messy['data/follower.js'] = 'window.YTD.follower.part0 = ' + xJson([
    { follower: { accountId: 98765432, userLink: intentLink(98765432) } }, // numeric (converter re-saved)
    { follower: { accountId: '3141592653' } }, // no userLink
    { follower: { accountId: '3141592653', userLink: intentLink('3141592653') } }, // duplicate
  ]);
  messy['data/following.js'] = 'window.YTD.following.part0 = ' + xJson([
    { following: { accountId: '98765432', userLink: intentLink('98765432') } },
    { following: { accountId: ' 1788990011223344556 ', userLink: intentLink('1788990011223344556') } }, // whitespace
    { following: { accountId: '1788990011223344556', userLink: intentLink('1788990011223344556') } }, // duplicate
    { following: { userLink: 'https://x.com/intent/user?user_id=271828182' } }, // id only in the (valid) link
    { following: {} }, // empty
    null,
    { follower: { accountId: '999' } }, // wrong kind of row
  ]).replace('[\n', '[\n  { "following" : { "accountId" : 1600000000000000042 } },\n'); // > 2^53: precision lost → skipped
  await add('x_dupes_numeric.zip', messy, {
    followers: 2, following: 3, notFollowingBack: ['1788990011223344556', '271828182'], fans: ['3141592653'], mutual: ['98765432'],
    warnings: [{ code: 'SKIPPED_ENTRIES', params: { count: 4 } }],
  });

  // Crafted "export": script/HTML in IDs, javascript:/data:/foreign links, hostile owner name.
  const xss = archive({ followers: ['1511223344556677889'], following: [] });
  xss['data/account.js'] = accountJs('<img src=x onerror=alert(1)>', '1203948576102938475');
  xss['data/manifest.js'] = manifestJs({ parts: { follower: [1], following: [7] }, userName: 'javascript:alert(1)' });
  xss['data/following.js'] = ytd('following', 0, [
    { following: { accountId: '1511223344556677889', userLink: 'javascript:alert(document.domain)' } },
    { following: { accountId: '1600000000000000042', userLink: 'data:text/html,<script>alert(1)</script>' } },
    { following: { accountId: '271828182', userLink: 'https://evil.example/intent/user?user_id=271828182' } },
    { following: { accountId: '<img src=x onerror=alert(1)>', userLink: intentLink(1) } },
    { following: { accountId: '123 onmouseover=alert(1)' } },
    { following: { userLink: 'javascript:alert(1)//https://twitter.com/intent/user?user_id=5' } },
    { following: { userLink: 'https://twitter.com/intent/user?user_id=77&next=javascript:alert(1)' } },
  ]);
  await add('x_xss.zip', xss, {
    owner: null, followers: 1, following: 3,
    notFollowingBack: ['1600000000000000042', '271828182'], fans: [], mutual: ['1511223344556677889'],
    warnings: [{ code: 'SKIPPED_ENTRIES', params: { count: 4 } }],
  });

  // Set-logic edge cases.
  await add('x_all_mutual.zip', archive({ followers: G.slice(0, 3), following: G.slice(0, 3) }),
    { followers: 3, following: 3, notFollowingBack: [], fans: [], mutual: G.slice(0, 3) });
  await add('x_following_empty.zip', archive({ followers: F.slice(0, 3), following: [] }),
    { followers: 3, following: 0, notFollowingBack: [], fans: F.slice(0, 3), mutual: [] });
  await add('x_empty_both.zip', archive({ followers: [], following: [] }), { error: 'EMPTY_LISTS' });

  // Incomplete or damaged archives must fail loudly instead of producing a wrong list.
  const noFollower = archive({ followers: F, following: G, manifest: false });
  delete noFollower['data/follower.js'];
  await add('x_missing_follower.zip', noFollower, { error: 'MISSING_LIST', params: { list: 'followers' } });
  const noFollowing = archive({ followers: F, following: G, manifest: false });
  delete noFollowing['data/following.js'];
  await add('x_missing_following.zip', noFollowing, { error: 'MISSING_LIST', params: { list: 'following' } });
  const corrupt = archive({ followers: F, following: G });
  corrupt['data/follower.js'] = 'window.YTD.follower.part0 = [ {\n    "follower" : {\n      "accountId" : "1432874569021935616",\n      "userLink" : "https://twitter';
  await add('x_corrupt_json.zip', corrupt, { error: 'CORRUPT_FILE', params: { file: 'data/follower.js' } });

  // Two archives in one upload (old + new): the newest (manifest generationDate) is used.
  const older = archive({ followers: F.slice(0, 1), following: G.slice(0, 1), prefix: 'twitter-2025-01-10-aaaa/', generationDate: '2025-01-10T08:00:00.000Z' });
  const newer = archive({ followers: F, following: G, prefix: 'twitter-2024-12-31-zzzz/', generationDate: '2026-09-01T09:58:12.345Z' });
  await add('x_two_exports.zip', { ...older, ...newer }, {
    ...BASIC_EXPECT, warnings: [{ code: 'MULTIPLE_EXPORTS', params: { count: 2, used: 'twitter-2024-12-31-zzzz/data' } }],
  });

  // Pre-2018 "Grailbird" archive: tweets only, no follow lists at all.
  await add('x_legacy_grailbird.zip', {
    'index.html': '<!DOCTYPE html><html><head><title>Your Twitter archive</title></head><body></body></html>',
    'tweets.csv': '"tweet_id","in_reply_to_status_id","in_reply_to_user_id","timestamp","source","text"\n"1","","","2014-01-01 00:00:00 +0000","web","hello"\n',
    'data/js/tweet_index.js': 'var tweet_index = [ { "file_name" : "data/js/tweets/2014_01.js", "year" : 2014, "var_name" : "tweets_2014_01", "tweet_count" : 1, "month" : 1 } ]',
    'data/js/user_details.js': 'var user_details = { "screen_name" : "sample_owner", "id" : "1203948576102938475" }',
    'data/js/tweets/2014_01.js': 'Grailbird.data.tweets_2014_01 = [ ]',
  }, { error: 'NO_RELEVANT_FILES', params: { reason: 'legacyArchive' } });

  // Other platforms' exports uploaded to the X tool.
  await add('wrong_instagram.zip', {
    'connections/followers_and_following/followers_1.json': '[{"title":"","media_list_data":[],"string_list_data":[{"href":"https://www.instagram.com/someone","value":"someone","timestamp":1700000000}]}]',
    'connections/followers_and_following/following.json': '{"relationships_following":[]}',
    'personal_information/personal_information/personal_information.json': '{"profile_user":[]}',
  }, { error: 'WRONG_PLATFORM', params: { platform: 'instagram' } });
  await add('wrong_tiktok.zip', { 'TikTok_Data_1758000000/user_data_tiktok.json': '{"Profile And Settings":{}}' },
    { error: 'WRONG_PLATFORM', params: { platform: 'tiktok' } });
  await add('wrong_facebook.zip', {
    'connections/friends/your_friends.json': '{"friends_v2":[]}',
    'connections/followers/people_who_followed_you_1.json': '[]',
  }, { error: 'WRONG_PLATFORM', params: { platform: 'facebook' } });
  await add('not_an_export.zip', { 'photos/IMG_0001.jpg': Buffer.from([0xff, 0xd8, 0xff]), 'notes.txt': 'hello' },
    { error: 'NO_RELEVANT_FILES' });

  // 100k following / 60k followers: 50k not following back, 10k fans, 50k mutual.
  const big = (n, offset) => Array.from({ length: n }, (_, i) => String(1500000000000000000n + BigInt((i + offset) * 7919)));
  const bigFollowing = big(100000, 0);
  const bigFollowers = bigFollowing.filter((_, i) => i % 2 === 0).concat(big(10000, 200000));
  await add('x_big_100k.zip', archive({ followers: bigFollowers, following: bigFollowing }),
    { followers: 60000, following: 100000, notFollowingBack: 50000, fans: 10000, mutual: 50000 });

  // Loose files (browser auto-extracted the ZIP; user uploads the two .js files).
  fs.mkdirSync(path.join(OUT, 'loose'), { recursive: true });
  fs.writeFileSync(path.join(OUT, 'loose', 'follower.js'), full['data/follower.js']);
  fs.writeFileSync(path.join(OUT, 'loose', 'following.js'), full['data/following.js']);
  expected['loose/follower.js+loose/following.js'] = { ...BASIC_EXPECT, owner: null };

  fs.writeFileSync(path.join(OUT, 'expected.json'), JSON.stringify(expected, null, 2) + '\n');
  console.log(`wrote ${Object.keys(expected).length} fixtures to ${path.relative(process.cwd(), OUT) || '.'}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
