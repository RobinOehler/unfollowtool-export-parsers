/*!
 * unfollowtool.com – Instagram export parser (UT.parsers.instagram)
 *
 * Pure logic, no DOM. UMD: in the browser it registers itself as window.UT.parsers.instagram,
 * in Node it is module.exports. Contract: see README.md ("Parser contract").
 *
 * Supported export variants (Accounts Center → "Export your information", JSON or HTML):
 *  current (2022+)  connections/followers_and_following/followers_1.json … followers_N.json
 *                   (bare array of {title, string_list_data:[{href, value, timestamp}]}) and
 *                   following.json / following_1.json … ({"relationships_following":[…]}).
 *                   2024+ entries may carry the username only in `title`, with an href of the
 *                   form https://www.instagram.com/_u/<user> and no `value`.
 *  legacy (2021/22) followers_and_following/followers.json {"relationships_followers":[…]}.
 *  legacy (≤2020)   connections.json {"followers":{"user":"ISO date"}, "following":{…}, …}.
 *  HTML export      the same file names with .html. Parsed with a tolerant tokenizer (no
 *                   DOMParser in Node): only anchors to instagram.com/<user> or /_u/<user> count,
 *                   the first text after the anchor is read as the (localized) date.
 *  optional lists   pending_follow_requests, recently_unfollowed_profiles,
 *                   follow_requests_you've_received, close_friends, blocked_profiles,
 *                   restricted_profiles, removed_suggestions (JSON or HTML).
 *  owner            personal_information/(personal_information/)personal_information.json
 *                   (Username field, localized key names tolerated), else the Meta file name
 *                   "instagram-<user>-YYYY-MM-DD-…" of the ZIP or its top folder.
 *
 * Robustness: matching is case-insensitive and independent of an extra top-level folder;
 * __MACOSX/, "._*" and Threads files are ignored; numbered parts are merged; browser copies
 * ("following (1).json") are treated as the same file; if the same file exists in several folders
 * (a re-zipped export plus a copy) only one copy is used, and MULTIPLE_EXPORTS is reported when
 * the copies differ. Entries are de-duplicated by lowercase username (latest timestamp wins).
 * Meta escapes every UTF-8 byte of non-ASCII text as \u00XX; such mojibake is repaired.
 *
 * Security: Entry.url is only ever built by this file as https://www.instagram.com/<user>/ and only
 * for real Instagram usernames ([A-Za-z0-9._], max 30). Anything else (markup, "javascript:",
 * spaces) keeps its text but gets url:null. Links to other hosts never create entries.
 *
 * Errors: thrown as UT.UTError(code, params) when ut-core.js is loaded. Without it (Node unit
 * tests) a plain Error with name "UTError", .code and .params is thrown (shape-compatible).
 *   NO_RELEVANT_FILES · WRONG_PLATFORM {platform} · MISSING_LIST {list, file} ·
 *   CORRUPT_FILE {file} · EMPTY_LISTS
 * Warnings (Result.warnings): LIST_EMPTY {list} · MISSING_PARTS {list, parts} ·
 *   MULTIPLE_EXPORTS {file} · OPTIONAL_FILE_UNREADABLE {file}
 */
(function (root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined' && root === window) {
    root.UT = root.UT || {};
    root.UT.parsers = root.UT.parsers || {};
    root.UT.parsers.instagram = api;
  }
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';

  var PROFILE_BASE = 'https://www.instagram.com/';

  /* ------------------------------------------------------------------ errors */

  function fail(code, params) {
    var UT = root.UT;
    if (UT && typeof UT.UTError === 'function') throw new UT.UTError(code, params || {});
    var e = new Error(code);
    e.name = 'UTError';
    e.code = code;
    e.params = params || {};
    throw e;
  }

  /* ------------------------------------------------------------------ usernames */

  // Instagram usernames: letters, digits, "." and "_", 1–30 chars (not only dots).
  var RE_USERNAME = /^[A-Za-z0-9._]{1,30}$/;
  function isUsername(s) {
    return RE_USERNAME.test(s) && /[A-Za-z0-9_]/.test(s);
  }

  // First path segments on instagram.com that are pages, not profiles.
  var RESERVED = new Set(['accounts', 'explore', 'about', 'legal', 'developer', 'direct', 'p', 'reel',
    'reels', 'stories', 'tv', 'web', 'privacy', 'help', 'emails', 'session', 'challenge', 'terms']);

  // https://www.instagram.com/<user>, /_u/<user>, optional trailing slash / query / fragment.
  var RE_PROFILE_URL = /^https?:\/\/(?:www\.|m\.)?instagram\.com\/(?:_u\/)?([^\/?#\s]+)\/?(?:[?#]\S*)?$/i;

  /** Username from a profile URL, or '' when the URL is not an Instagram profile link. */
  function usernameFromUrl(href) {
    var m = RE_PROFILE_URL.exec(href);
    if (!m) return '';
    var seg;
    try { seg = decodeURIComponent(m[1]); } catch (e) { return ''; }
    return isUsername(seg) && !RESERVED.has(seg.toLowerCase()) ? seg : '';
  }

  var utf8 = typeof TextDecoder === 'function' ? new TextDecoder('utf-8', { fatal: true }) : null;

  /**
   * Repairs Meta's JSON mojibake: every UTF-8 byte is written as its own \u00XX code point
   * ("cafÃ©" → "café"). Only strings made purely of U+0000–U+00FF that decode as valid UTF-8 are
   * touched, so genuine Latin-1 text and correct Unicode are left as they are.
   */
  function fixMojibake(s) {
    if (!utf8 || !/[\u0080-\u00ff]/.test(s) || /[^\u0000-\u00ff]/.test(s)) return s;
    var bytes = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
    try { return utf8.decode(bytes); } catch (e) { return s; }
  }

  function cleanName(v) {
    if (typeof v !== 'string') return '';
    return fixMojibake(v).replace(/\s+/g, ' ').trim().replace(/^@/, '');
  }

  /** Picks the username of one export record: a valid username wins over display text. */
  function pickUsername(candidates) {
    var fallback = '';
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      if (!c) continue;
      if (isUsername(c)) return c;
      if (!fallback) fallback = c;
    }
    return fallback;
  }

  /* ------------------------------------------------------------------ dates */

  /** Export timestamps are Unix seconds; tolerate milliseconds. Returns ms or null. */
  function toMs(v) {
    var n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    if (typeof n !== 'number' || !isFinite(n) || n <= 0) return null;
    return Math.round(n < 1e11 ? n * 1000 : n);
  }

  // Month names/abbreviations of the 8 site languages, keyed by their first 3 letters
  // (accents stripped). "juin"/"juil" are handled separately because both start with "jui".
  var MONTHS = {
    jan: 0, sty: 0, ene: 0, gen: 0,
    feb: 1, fev: 1, lut: 1,
    mar: 2, mrt: 2,
    apr: 3, abr: 3, avr: 3, kwi: 3,
    may: 4, mai: 4, mag: 4, mei: 4, maj: 4,
    jun: 5, giu: 5, cze: 5,
    jul: 6, lug: 6, lip: 6,
    aug: 7, ago: 7, aou: 7, sie: 7,
    sep: 8, set: 8, wrz: 8,
    oct: 9, okt: 9, ott: 9, out: 9, paz: 9,
    nov: 10, lis: 10,
    dec: 11, dic: 11, dez: 11, gru: 11
  };

  function monthOf(word) {
    var w = word.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    if (w.length < 3) return -1;
    if (w.lastIndexOf('juin', 0) === 0) return 5;
    if (w.lastIndexOf('juil', 0) === 0) return 6;
    var m = MONTHS[w.slice(0, 3)];
    return m === undefined ? -1 : m;
  }

  /**
   * Parses the human-readable date of the HTML export in the account's language, e.g.
   * "Jan 01, 2025, 10:00 am", "01. Jan. 2025, 10:00", "1 janv. 2025 22:15", "2025-01-01 10:00",
   * "01.01.2025 10:00", "2025年1月1日". Interpreted as local time (the export writes local wall-clock time).
   * Returns ms or null when the text is not a recognizable date.
   */
  function parseLooseDate(text) {
    if (!text || text.length > 80) return null;
    var s = text;
    var h = 0, mi = 0;
    var tm = /(\d{1,2}):(\d{2})(?::\d{2})?(?:\s*([ap])\.?\s*m\b\.?)?/i.exec(s);
    if (tm) {
      h = +tm[1];
      mi = +tm[2];
      if (tm[3]) h = (h % 12) + (tm[3].toLowerCase() === 'p' ? 12 : 0);
      s = s.slice(0, tm.index) + ' ' + s.slice(tm.index + tm[0].length);
    }
    var y, mo, d, m;
    // Year first: 2025-01-01, 2025/1/1, 2025年1月1日 (CJK account languages).
    if ((m = /(\d{4})\s*[-\/.\u5e74]\s*(\d{1,2})\s*[-\/.\u6708]\s*(\d{1,2})/.exec(s))) {
      y = +m[1]; mo = +m[2] - 1; d = +m[3];
    } else if ((m = /(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(s))) {
      d = +m[1]; mo = +m[2] - 1; y = +m[3];
    } else {
      var words = s.match(/\p{L}+/gu) || [];
      mo = -1;
      for (var i = 0; i < words.length && mo < 0; i++) mo = monthOf(words[i]);
      var nums = s.match(/\d+/g) || [];
      for (var j = 0; j < nums.length; j++) {
        if (nums[j].length === 4 && y === undefined) y = +nums[j];
        else if (nums[j].length <= 2 && d === undefined) d = +nums[j];
      }
      if (mo < 0) return null;
    }
    if (y === undefined || d === undefined || y < 2000 || y > 2100 || h > 23 || mi > 59) return null;
    var date = new Date(y, mo, d, h, mi);
    return date.getMonth() === mo && date.getDate() === d ? date.getTime() : null;
  }

  /* ------------------------------------------------------------------ list builder */

  /** Collects entries of one list, de-duplicated by lowercase username (latest timestamp wins). */
  function ListBuilder() {
    this.map = new Map();
  }
  ListBuilder.prototype.add = function (username, ts) {
    if (!username) return;
    var key = username.toLowerCase();
    var prev = this.map.get(key);
    if (prev) {
      if (ts != null && (prev.ts == null || ts > prev.ts)) prev.ts = ts;
      return;
    }
    this.map.set(key, {
      key: key,
      username: username,
      name: null, // the Instagram export contains no display names
      url: isUsername(username) ? PROFILE_BASE + username + '/' : null,
      ts: ts
    });
  };
  ListBuilder.prototype.entries = function () {
    return Array.from(this.map.values()).sort(byNewest);
  };

  /** Newest first (unknown dates last), then by key – stable output for UI and tests. */
  function byNewest(a, b) {
    if (a.ts !== b.ts) {
      if (a.ts == null) return 1;
      if (b.ts == null) return -1;
      return b.ts - a.ts;
    }
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  }

  /* ------------------------------------------------------------------ JSON */

  /**
   * Returns the record array of a list file: a bare array, or every "relationships_*" array of a
   * wrapper object. null when the structure is not an Instagram list.
   */
  function recordsOf(data) {
    if (Array.isArray(data)) return data;
    if (!data || typeof data !== 'object') return null;
    var found = null;
    Object.keys(data).forEach(function (k) {
      if (k.lastIndexOf('relationships_', 0) === 0 && Array.isArray(data[k])) {
        found = found ? found.concat(data[k]) : data[k];
      }
    });
    return found;
  }

  /**
   * Username of a 2025+ "label_values" record (pending requests, blocked, restricted, favorited):
   * [{label:'URL'}, {label:'Name'}, {label:'Username'}] with localized labels ("Benutzername"),
   * so fields are identified by value shape and position, never by label: a profile URL wins,
   * then the third value, then (other layouts) the last username-shaped value that is not in the
   * display-name slot. '' when none qualifies.
   */
  function labelValuesUsername(lv) {
    var values = lv.map(function (x) {
      if (!x || typeof x !== 'object') return '';
      return cleanName(typeof x.value === 'string' && x.value ? x.value : x.href);
    });
    for (var i = 0; i < values.length; i++) {
      var fromUrl = usernameFromUrl(values[i]);
      if (fromUrl) return fromUrl;
    }
    if (isUsername(values[2] || '')) return values[2];
    for (var j = values.length - 1; j >= 0; j--) if (j !== 1 && isUsername(values[j])) return values[j];
    return '';
  }

  /** Adds one JSON record (all string_list_data items; nested arrays are flattened). */
  function addRecord(builder, rec) {
    if (typeof rec === 'string') { builder.add(cleanName(rec), null); return; }
    if (Array.isArray(rec)) { rec.forEach(function (r) { addRecord(builder, r); }); return; }
    if (!rec || typeof rec !== 'object') return;
    if (Array.isArray(rec.label_values) && !Array.isArray(rec.string_list_data)) {
      builder.add(labelValuesUsername(rec.label_values), toMs(rec.timestamp));
      return;
    }
    var items = Array.isArray(rec.string_list_data) && rec.string_list_data.length ? rec.string_list_data : [rec];
    // `title` names the account only when the record describes exactly one account.
    var title = items.length === 1 ? cleanName(rec.title) : '';
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it || typeof it !== 'object') continue;
      var href = typeof it.href === 'string' ? it.href.trim() : '';
      var username = pickUsername([cleanName(it.value), usernameFromUrl(href), title]);
      builder.add(username, toMs(it.timestamp != null ? it.timestamp : rec.timestamp));
    }
  }

  // Facebook exports use "<name>_v2"/"_v3" wrapper keys – a Facebook file uploaded here.
  function looksLikeFacebook(data) {
    return !!data && typeof data === 'object' && !Array.isArray(data) &&
      Object.keys(data).some(function (k) { return /_v\d+$/.test(k); });
  }

  /* ------------------------------------------------------------------ HTML */

  // Opening <a …> tags; quoted attribute values may contain ">".
  var RE_ANCHOR = /<a\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
  var RE_HREF = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;
  var ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

  function decodeEntities(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, function (all, e) {
      if (e.charAt(0) === '#') {
        var cp = e.charAt(1) === 'x' || e.charAt(1) === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : all;
      }
      var v = ENTITIES[e.toLowerCase()];
      return v === undefined ? all : v;
    });
  }

  /**
   * First non-blank text node after the anchor that starts at `from` (skipping the anchor's own
   * text), stopping at the next anchor or heading, i.e. the next entry.
   */
  function dateTextAfter(html, from) {
    var close = html.indexOf('</a', from);
    if (close < 0 || close - from > 500) return '';
    var end = Math.min(html.length, close + 600);
    var i = html.indexOf('>', close) + 1;
    while (i > 0 && i < end) {
      var lt = html.indexOf('<', i);
      var stop = lt < 0 || lt > end ? end : lt;
      var text = html.slice(i, stop).trim();
      if (text) return decodeEntities(text).replace(/\s+/g, ' ');
      if (stop === end || /^<(a|h\d)\b/i.test(html.slice(lt, lt + 3))) return '';
      i = html.indexOf('>', lt) + 1;
    }
    return '';
  }

  function addHtml(builder, html) {
    RE_ANCHOR.lastIndex = 0;
    var m;
    while ((m = RE_ANCHOR.exec(html))) {
      var hm = RE_HREF.exec(m[1]);
      if (!hm) continue;
      var username = usernameFromUrl(decodeEntities(hm[1] != null ? hm[1] : hm[2] != null ? hm[2] : hm[3]).trim());
      if (username) builder.add(username, parseLooseDate(dateTextAfter(html, RE_ANCHOR.lastIndex)));
    }
  }

  /* ------------------------------------------------------------------ paths */

  var LISTS = [
    { id: 'followers', re: /^followers(?:_(\d+))?$/, required: true, file: 'followers_1.json' },
    { id: 'following', re: /^following(?:_(\d+))?$/, required: true, file: 'following.json' },
    { id: 'pendingRequests', re: /^pending_follow_requests$/ },
    { id: 'recentlyUnfollowed', re: /^recently_unfollowed_(?:profiles|accounts)$/ },
    { id: 'receivedRequests', re: /^follow_requests_you['\u2019]?ve_received$/ },
    { id: 'closeFriends', re: /^close_friends$/ },
    { id: 'blocked', re: /^blocked_(?:profiles|accounts|users)$/ },
    { id: 'restricted', re: /^restricted_(?:profiles|accounts|users)$/ },
    { id: 'removedSuggestions', re: /^removed_suggestions$/ }
  ];

  // Keys of the ≤2020 connections.json and the list each one feeds.
  var LEGACY_KEYS = {
    followers: 'followers', following: 'following', follow_requests_sent: 'pendingRequests',
    close_friends: 'closeFriends', blocked_users: 'blocked', restricted_users: 'restricted',
    dismissed_suggested_users: 'removedSuggestions'
  };

  var RE_FF_DIR = /(?:^|\/)(?:connections\/)?followers_and_following$/;
  var RE_PERSONAL = /(?:^|\/)(?:personal_information|account_information)\/(?:[^\/]+\/)?personal_information\.json$/;
  var RE_IG_MARKER = /(?:^|\/)(?:your_instagram_activity|followers_and_following|ads_information\/instagram_ads_and_businesses)\//;
  var RE_META_NAME = /(?:^|\/)instagram-([a-z0-9._]{1,30})-\d{4}-\d{2}-\d{2}/i;

  // Markers of other platforms' exports (lowercased paths): WRONG_PLATFORM when no Instagram list
  // files exist, or when Instagram-looking paths lack a required list.
  var OTHER_PLATFORMS = [
    ['facebook', new RegExp([
      '(?:^|/)(?:your_facebook_activity|friends_and_followers|following_and_followers|connections/friends|connections/followers)/',
      "(?:^|/)(?:your_friends|people_who_followed_you(?:_\\d+)?|who_you've_followed)\\.(?:json|html)$",
      '(?:^|/)friends/(?:friends|removed_friends|sent_friend_requests|received_friend_requests)\\.(?:json|html)$',
      '(?:^|/)profile_information/profile_information\\.(?:json|html)$'
    ].join('|'))],
    ['tiktok', /(?:^|\/)user_data(?:_tiktok)?\.json$|(?:^|\/)(?:follower|following)(?: list)?\.txt$/],
    ['x', /(?:^|\/)data\/(?:follower|following|account|manifest)\.js$|(?:^|\/)(?:follower|following|manifest)\.js$/]
  ];

  function ignored(lower) {
    return /(?:^|\/)__macosx\//.test(lower) || /(?:^|\/)\._[^\/]*$/.test(lower) ||
      // Threads data lives inside the Instagram export and has its own followers files.
      /(?:^|\/)(?:threads|text_post_app[^\/]*)\//.test(lower);
  }

  /** Classifies the upload: candidate list files, legacy connections.json, markers. */
  function scan(paths) {
    var out = { files: [], legacy: [], personal: [], strong: false, loose: false, marker: false, other: null };
    paths.forEach(function (path) {
      var lower = String(path).toLowerCase();
      if (RE_IG_MARKER.test(lower)) out.marker = true;
      if (ignored(lower)) return;
      var slash = lower.lastIndexOf('/');
      var dir = slash < 0 ? '' : lower.slice(0, slash);
      var base = lower.slice(slash + 1);
      if (RE_PERSONAL.test(lower)) { out.personal.push(path); out.marker = true; }
      var em = /^(.*?)(?: ?\(\d+\))?\.(json|html?)$/.exec(base);
      if (!em) return;
      var stem = em[1];
      var fmt = em[2] === 'json' ? 'json' : 'html';
      if (stem === 'connections' && fmt === 'json') { out.legacy.push(path); return; }
      for (var i = 0; i < LISTS.length; i++) {
        var lm = LISTS[i].re.exec(stem);
        if (!lm) continue;
        var inFF = RE_FF_DIR.test(dir);
        if (LISTS[i].required) {
          if (inFF) out.strong = true;
          else out.loose = true;
        }
        out.files.push({
          path: path,
          list: LISTS[i].id,
          part: lm[1] ? +lm[1] : null,
          fmt: fmt,
          root: dir.replace(RE_FF_DIR, ''),
          rel: stem + '.' + fmt
        });
        return;
      }
    });
    var lowerPaths = paths.map(function (p) { return String(p).toLowerCase(); });
    for (var i = 0; i < OTHER_PLATFORMS.length && !out.other; i++) {
      var re = OTHER_PLATFORMS[i][1];
      if (lowerPaths.some(function (p) { return re.test(p); })) out.other = OTHER_PLATFORMS[i][0];
    }
    return out;
  }

  /* ------------------------------------------------------------------ detect */

  /**
   * Likelihood (0..1) that the paths are an Instagram export. 0.95: files in
   * followers_and_following/ (0.5 when another platform's files are present too). 0.6: loose
   * followers_N/following files. 0.5: ≤2020 connections.json. 0.4: other Instagram files only.
   * 0.05: another platform's export. 0: nothing usable.
   */
  function detect(paths) {
    var s = scan(paths || []);
    if (s.strong) return s.other ? 0.5 : 0.95;
    if (s.other) return 0.05;
    if (s.loose) return 0.6;
    if (s.legacy.length) return 0.5;
    if (s.marker) return 0.4;
    return 0;
  }

  /* ------------------------------------------------------------------ parse */

  function baseName(path) {
    return path.slice(path.lastIndexOf('/') + 1);
  }

  async function readText(fileSet, path) {
    var text = await fileSet.read(path);
    return String(text).replace(/^\ufeff/, '');
  }

  /**
   * Keeps one copy per file name across folders. `rootRank` counts the list files of each folder
   * in the whole upload: the fullest folder wins, then the shortest path, then the name that sorts
   * last (Meta's folder names contain the export date, so the newer export wins a tie).
   * Complementary parts from different folders (multi-part ZIPs) are all kept.
   */
  function pickCopies(files, rootRank) {
    var byRel = new Map();
    files.forEach(function (f) {
      if (!byRel.has(f.rel)) byRel.set(f.rel, []);
      byRel.get(f.rel).push(f);
    });
    var chosen = [];
    byRel.forEach(function (group) {
      group.sort(function (a, b) {
        return (rootRank.get(b.root) - rootRank.get(a.root)) || (a.path.length - b.path.length) ||
          (a.path < b.path ? 1 : a.path > b.path ? -1 : 0);
      });
      chosen.push({ file: group[0], copies: group.slice(1) });
    });
    return chosen;
  }

  /** Reads and parses one list from its chosen files. Throws a UTError-shaped error on failure. */
  async function readList(fileSet, picks, used, warnings) {
    var builder = new ListBuilder();
    for (var i = 0; i < picks.length; i++) {
      var f = picks[i].file;
      var text = await readText(fileSet, f.path);
      for (var c = 0; c < picks[i].copies.length; c++) {
        if ((await readText(fileSet, picks[i].copies[c].path)) !== text) {
          // One notice per upload is enough; it names the first differing file.
          var seen = warnings.some(function (w) { return w.code === 'MULTIPLE_EXPORTS'; });
          if (!seen) warnings.push({ code: 'MULTIPLE_EXPORTS', params: { file: baseName(f.path) } });
          break;
        }
      }
      if (f.fmt === 'html') {
        addHtml(builder, text);
      } else {
        var data;
        try { data = JSON.parse(text); } catch (e) { fail('CORRUPT_FILE', { file: baseName(f.path) }); }
        var records = recordsOf(data);
        if (!records) {
          if (looksLikeFacebook(data)) fail('WRONG_PLATFORM', { platform: 'facebook' });
          fail('CORRUPT_FILE', { file: baseName(f.path) });
        }
        for (var r = 0; r < records.length; r++) addRecord(builder, records[r]);
      }
      used.push(f.path);
    }
    return builder.entries();
  }

  /** Numbers missing from a part sequence, e.g. followers_1 + followers_3 → "2". */
  function missingParts(picks) {
    var nums = picks.map(function (p) { return p.file.part; }).filter(function (n) { return n != null; });
    if (!nums.length) return '';
    var have = new Set(nums);
    var gaps = [];
    for (var n = 1; n < Math.max.apply(null, nums); n++) if (!have.has(n)) gaps.push(n);
    return gaps.join(', ');
  }

  /** ≤2020 connections.json: {"followers": {"user": "2019-01-01T10:00:00+00:00"}, …}. */
  function parseLegacy(text, file) {
    var data;
    try { data = JSON.parse(text); } catch (e) { fail('CORRUPT_FILE', { file: file }); }
    if (!data || typeof data !== 'object' || typeof data.followers !== 'object' || typeof data.following !== 'object' ||
        !data.followers || !data.following) {
      fail('CORRUPT_FILE', { file: file });
    }
    var lists = {};
    Object.keys(LEGACY_KEYS).forEach(function (k) {
      var obj = data[k];
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
      var b = new ListBuilder();
      Object.keys(obj).forEach(function (user) {
        var t = Date.parse(obj[user]);
        b.add(cleanName(user), isNaN(t) ? null : t);
      });
      lists[LEGACY_KEYS[k]] = b.entries();
    });
    return lists;
  }

  var USERNAME_KEYS = new Set(['username', 'user name', 'benutzername', 'nombre de usuario',
    "nom d'utilisateur", 'nome utente', 'gebruikersnaam', 'nazwa u\u017cytkownika', 'nome de usu\u00e1rio',
    'nome de utilizador']);

  /** Account owner (lowercase username) or null. Only the Username field is read. */
  async function readOwner(fileSet, personal, paths) {
    for (var i = 0; i < personal.length; i++) {
      try {
        var data = JSON.parse(await readText(fileSet, personal[i]));
        var profiles = (data && data.profile_user) || [];
        for (var p = 0; p < profiles.length; p++) {
          var map = (profiles[p] && profiles[p].string_map_data) || {};
          var keys = Object.keys(map);
          for (var k = 0; k < keys.length; k++) {
            if (!USERNAME_KEYS.has(fixMojibake(keys[k]).trim().toLowerCase())) continue;
            var v = map[keys[k]] && cleanName(map[keys[k]].value);
            if (v && isUsername(v)) return v.toLowerCase();
          }
        }
      } catch (e) { /* unreadable personal info: fall back to the file name */ }
    }
    var names = paths.concat(fileSet.sourceNames || []);
    for (var n = 0; n < names.length; n++) {
      var m = RE_META_NAME.exec(names[n]);
      if (m && isUsername(m[1])) return m[1].toLowerCase();
    }
    return null;
  }

  /**
   * Parses an Instagram export. Resolves to a Result (README.md), rejects with a UTError.
   * followers and following are required; the optional lists appear in Result.lists only when
   * their file exists (an unreadable optional file becomes an OPTIONAL_FILE_UNREADABLE warning).
   */
  async function parse(fileSet) {
    var paths = (fileSet && fileSet.paths) || [];
    var s = scan(paths);
    var warnings = [];
    var used = [];
    var lists = {};

    var byList = {};
    var rootRank = new Map();
    s.files.forEach(function (f) {
      (byList[f.list] = byList[f.list] || []).push(f);
      rootRank.set(f.root, (rootRank.get(f.root) || 0) + 1);
    });
    var hasFollowers = !!byList.followers;
    var hasFollowing = !!byList.following;

    if (!s.strong && s.other) fail('WRONG_PLATFORM', { platform: s.other });
    // Instagram-looking paths next to another platform's files: only the content can tell, so a
    // missing list means the upload is most likely the other platform's export.
    var missing = s.other ? function () { fail('WRONG_PLATFORM', { platform: s.other }); } : fail;

    if (!hasFollowers && !hasFollowing && s.legacy.length) {
      var legacyPath = s.legacy[0];
      lists = parseLegacy(await readText(fileSet, legacyPath), baseName(legacyPath));
      used.push(legacyPath);
    } else {
      if (!hasFollowers && !hasFollowing) missing('NO_RELEVANT_FILES');
      // Followers alone still answer "who unfollowed me" (with a saved earlier result), so a missing following list
      // only warns. Without followers there is nothing useful to show (and a comparison would count everyone as lost).
      LISTS.forEach(function (def) {
        if (!def.required || byList[def.id]) return;
        // Only for a ZIP that really lacks the file: a single loose followers file gets the error (and its
        // "Add the missing file" button) instead, because one more file gives the full comparison.
        var fromZip = (fileSet.sourceNames || []).some(function (n) { return /\.zip$/i.test(n); });
        if (def.id === 'following' && hasFollowers && !s.other && fromZip) {
          warnings.push({ code: 'LIST_MISSING', params: { list: 'following', file: def.file } });
          return;
        }
        missing('MISSING_LIST', { list: def.id, file: def.file });
      });

      for (var i = 0; i < LISTS.length; i++) {
        var def = LISTS[i];
        var files = byList[def.id];
        if (!files) continue;
        // JSON is authoritative; HTML is only used when a list has no JSON file.
        if (files.some(function (f) { return f.fmt === 'json'; })) {
          files = files.filter(function (f) { return f.fmt === 'json'; });
        }
        var picks = pickCopies(files, rootRank).sort(function (a, b) {
          return (a.file.part || 0) - (b.file.part || 0) || (a.file.path < b.file.path ? -1 : 1);
        });
        if (def.required) {
          lists[def.id] = await readList(fileSet, picks, used, warnings);
          var gaps = missingParts(picks);
          if (gaps) warnings.push({ code: 'MISSING_PARTS', params: { list: def.id, parts: gaps } });
        } else {
          var mark = used.length;
          var warnMark = warnings.length;
          try {
            lists[def.id] = await readList(fileSet, picks, used, warnings);
          } catch (e) {
            used.length = mark;
            warnings.length = warnMark;
            warnings.push({ code: 'OPTIONAL_FILE_UNREADABLE', params: { file: baseName(picks[0].file.path) } });
          }
        }
      }
    }

    var followers = lists.followers || [];
    var following = lists.following || [];
    if (!followers.length && !following.length) fail('EMPTY_LISTS');
    ['followers', 'following'].forEach(function (list) {
      if (lists[list] && !lists[list].length) warnings.push({ code: 'LIST_EMPTY', params: { list: list } });
    });

    return {
      platform: 'instagram',
      lists: lists,
      files: used,
      warnings: warnings,
      owner: await readOwner(fileSet, s.personal, paths)
    };
  }

  /* ------------------------------------------------------------------ views */

  // Optional views, shown only when the export contains a non-empty list.
  var OPTIONAL_VIEWS = [
    { id: 'pendingRequests', dateKey: 'requestedOn' },
    { id: 'recentlyUnfollowed', dateKey: 'unfollowedOn' },
    { id: 'receivedRequests', dateKey: 'requestedOn' },
    { id: 'closeFriends' },
    { id: 'restricted' },
    { id: 'blocked' },
    { id: 'removedSuggestions', dateKey: 'removedOn' }
  ];

  /**
   * notFollowingBack (primary) = following − followers  · dateKey followedSince
   * fans                       = followers − following  · dateKey followsYouSince
   * mutual                     = following ∩ followers  · dateKey friendsSince (later of both follows)
   * following / followers      = the full lists
   * + the OPTIONAL_VIEWS present in the export (entries as exported).
   */
  function views(result) {
    var lists = (result && result.lists) || {};
    var followers = lists.followers || [];
    var following = lists.following || [];
    var followerByKey = new Map();
    followers.forEach(function (e) { followerByKey.set(e.key, e); });
    var followingKeys = new Set();
    following.forEach(function (e) { followingKeys.add(e.key); });

    var notFollowingBack = [];
    var mutual = [];
    following.forEach(function (e) {
      var f = followerByKey.get(e.key);
      if (!f) { notFollowingBack.push(e); return; }
      var ts = e.ts == null ? f.ts : (f.ts == null ? e.ts : Math.max(e.ts, f.ts));
      mutual.push(ts === e.ts ? e : { key: e.key, username: e.username, name: e.name, url: e.url, ts: ts });
    });
    var fans = followers.filter(function (e) { return !followingKeys.has(e.key); });

    // Partial export (following list missing, see parse): only the followers can be shown.
    var out = !lists.following && lists.followers ? [
      { id: 'followers', entries: followers.slice(), primary: true, dateKey: 'followsYouSince' }
    ] : [
      { id: 'notFollowingBack', entries: notFollowingBack, primary: true, dateKey: 'followedSince' },
      { id: 'fans', entries: fans, dateKey: 'followsYouSince' },
      { id: 'mutual', entries: mutual.sort(byNewest), dateKey: 'friendsSince' },
      { id: 'following', entries: following.slice(), dateKey: 'followedSince' },
      { id: 'followers', entries: followers.slice(), dateKey: 'followsYouSince' }
    ];
    OPTIONAL_VIEWS.forEach(function (v) {
      var list = lists[v.id];
      if (!list || !list.length) return;
      var view = { id: v.id, entries: list.slice() };
      if (v.dateKey) view.dateKey = v.dateKey;
      out.push(view);
    });
    return out;
  }

  return {
    id: 'instagram',
    detect: detect,
    parse: parse,
    views: views,
    // Exposed for unit tests; not part of the runtime contract.
    _internal: { parseLooseDate: parseLooseDate, fixMojibake: fixMojibake, usernameFromUrl: usernameFromUrl }
  };
});
