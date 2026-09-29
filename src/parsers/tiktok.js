/*!
 * unfollowtool.com – TikTok export parser (UT.parsers.tiktok)
 *
 * Pure logic, no DOM. UMD: in the browser it registers itself as window.UT.parsers.tiktok,
 * in Node it is module.exports. Contract: see README.md ("Parser contract").
 *
 * Supported export variants (TikTok "Download your data", delivered as a ZIP):
 *  JSON  user_data_tiktok.json / user_data.json (any folder depth, browser copies like
 *        "user_data_tiktok (1).json", BOM tolerated). Sections are looked up case-, space- and
 *        underscore-insensitively in this order:
 *          "Profile And Settings" → Follower.FansList / Following.Following   (current, 2025+)
 *          "Your Activity"        → Follower.FansList / Following.Following   (2024)
 *          "Activity"             → "Follower List".FansList / "Following List".Following (2020–2023)
 *          "Profile"              → Follower / "Follower List" (seen in third-party parsers)
 *          document root, then a bounded deep search as last resort.
 *        Entry fields: UserName | Username | userName | username | uniqueId (+ Date).
 *        Owner: ProfileMap.userName anywhere in the profile section.
 *        JSON keys are English in every app language, so no localisation is needed there.
 *  TXT   Follower.txt / Following.txt in any folder ("Profile and Settings/", "Your Activity/",
 *        "Activity/", or none), legacy "Follower List.txt" / "Following List.txt", localized file
 *        names (Dutch "Volger.txt"/"Volgend.txt" is confirmed; other languages use TikTok's UI
 *        labels and are best effort), numbered parts ("Following_2.txt") are merged.
 *        Blocks of "Date: …" + "Username: …" lines; labels may be localized ("Datum:",
 *        "Gebruikersnaam:") – unknown labels are resolved structurally (the date-valued label is
 *        the date, the single remaining label is the username). CRLF, BOM and files re-saved as
 *        UTF-16 ("Unicode" in Windows Notepad) are handled.
 *  TikTok offers no HTML export, so HTML_EXPORT_UNSUPPORTED is never thrown here.
 *
 * Dates: TikTok writes UTC wall-clock times ("2023-08-23 06:18:18 UTC" / "2024-05-01 10:00:00").
 * They are parsed with a regex + Date.UTC because Safari's JavaScriptCore returns Invalid Date for
 * the " UTC" form and every engine would otherwise treat the JSON form as local time.
 *
 * Usernames: TikTok usernames are ASCII (letters, digits, "_" and "."), so there is no mojibake
 * repair (TikTok writes real UTF-8, unlike Facebook/Instagram's \u00XX-escaped bytes). Keys are
 * NFC + lowercase (TikTok handles are case-insensitive). A profile URL is only produced for
 * usernames made of letters, digits, "_" and "." – anything else (HTML, "javascript:", spaces)
 * gets url:null and is shown as plain text only.
 *
 * Errors: thrown as UT.UTError(code, params) when ut-core.js is loaded. Without it (Node unit
 * tests, or a page that forgot ut-core.js) a plain Error with name "UTError", .code and .params is
 * thrown, which is shape-compatible with UTError.
 *   NO_RELEVANT_FILES · WRONG_PLATFORM {platform} · MISSING_LIST {list} · CORRUPT_FILE {file} ·
 *   EMPTY_LISTS
 * Warnings (Result.warnings): LIST_EMPTY {list} · ENTRIES_SKIPPED {list, count} ·
 *   MULTIPLE_EXPORTS {file}
 */
(function (root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined' && root === window) {
    root.UT = root.UT || {};
    root.UT.parsers = root.UT.parsers || {};
    root.UT.parsers.tiktok = api;
  }
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';

  var PROFILE_BASE = 'https://www.tiktok.com/@';

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

  /* ------------------------------------------------------------------ paths */

  // Normalizes a key for tolerant comparison: "Profile And Settings", "profile_and_settings",
  // "ProfileAndSettings" all become "profileandsettings".
  function norm(s) {
    return String(s).toLowerCase().replace(/[\s_\-]+/g, '');
  }

  function baseName(p) {
    var i = p.lastIndexOf('/');
    return i < 0 ? p : p.slice(i + 1);
  }

  // Defensive: FileSet already drops these, but detect() may receive raw path lists.
  function usablePaths(paths) {
    return (paths || []).filter(function (p) {
      return typeof p === 'string' && p && !/(^|\/)__MACOSX\//i.test(p) && !/(^|\/)\._/.test(p) && !/\/$/.test(p);
    });
  }

  // user_data_tiktok.json, user_data.json, "user_data_tiktok (1).json", user_data_tiktok_2.json.
  // "user_data_tiktok" is distinctive enough to also match with a prefix ("my_user_data_tiktok.json").
  var RE_JSON_TIKTOK = /user_data_tiktok(\s*\(\d+\)|[_-]\d+)?\.json$/i;
  var RE_JSON_MAIN = /(^|\/)user_data(\s*\(\d+\)|[_-]\d+)?\.json$|user_data_tiktok(\s*\(\d+\)|[_-]\d+)?\.json$/i;

  // TXT list file names (lowercase, without extension and part suffix). English and Dutch are
  // confirmed from real exports; the others are TikTok's UI labels in the site's languages.
  var TXT_FOLLOWERS = ['follower', 'followers', 'follower list', 'followers list', 'fans', 'fans list',
    'volger', 'volgers', 'seguidores', 'abonn\u00E9s', 'abonnes', 'obserwuj\u0105cy', 'obserwujacy'];
  var TXT_FOLLOWING = ['following', 'following list', 'volgend', 'folge ich', 'gefolgt', 'siguiendo',
    'seguindo', 'seguiti', 'abonnements', 'obserwowani', 'obserwowane'];

  // Returns 'followers' | 'following' | null for a TXT path.
  function txtListOf(p) {
    var m = /^(.+?)(?:\s*\(\d+\)|[_\- ]\d+)?\.txt$/i.exec(baseName(p));
    if (!m) return null;
    var stem = m[1].normalize('NFC').toLowerCase().replace(/[_\s]+/g, ' ').trim();
    if (TXT_FOLLOWERS.indexOf(stem) >= 0) return 'followers';
    if (TXT_FOLLOWING.indexOf(stem) >= 0) return 'following';
    return null;
  }

  // Path signatures of the other supported platforms. Checked only after TikTok's own strong
  // signatures, so a TikTok ZIP is never misclassified.
  var OTHER_PLATFORMS = [
    ['instagram', /(^|\/)(connections\/)?followers_and_following\/|(^|\/)your_instagram_activity\/|(^|\/)followers_\d+\.(json|html)$|(^|\/)threads\/followers\.json$/i],
    ['x', /(^|\/)data\/(follower|following|account|manifest|tweets?)(-part\d+)?\.js$|(^|\/)(follower|following)(-part\d+)?\.js$|(^|\/)your archive\.html$/i],
    ['facebook', /(^|\/)(connections\/)?friends\/|(^|\/)your_facebook_activity\/|(^|\/)(your_friends|removed_friends|people_who_followed_you|who_you'?\u2019?ve_followed|sent_friend_requests|received_friend_requests)(_\d+)?\.(json|html)$/i]
  ];

  function otherPlatform(paths) {
    for (var i = 0; i < OTHER_PLATFORMS.length; i++) {
      var re = OTHER_PLATFORMS[i][1];
      for (var j = 0; j < paths.length; j++) if (re.test(paths[j])) return OTHER_PLATFORMS[i][0];
    }
    return null;
  }

  /* ------------------------------------------------------------------ detect */

  /**
   * Likelihood (0..1) that the paths belong to a TikTok export. ≥0.7: confident. 0.25: a few
   * .json files whose names say nothing (parse() sniffs their content). ≤0.05: another platform's
   * export or nothing usable.
   */
  function detect(paths) {
    var ps = usablePaths(paths);
    if (!ps.length) return 0;
    var hasTikTokName = ps.some(function (p) { return /tiktok/i.test(p); });
    if (ps.some(function (p) { return RE_JSON_TIKTOK.test(p); })) return 0.99;
    var txt = { followers: false, following: false };
    ps.forEach(function (p) { var l = txtListOf(p); if (l) txt[l] = true; });
    var txtScore = txt.followers && txt.following ? 0.9 : (txt.followers || txt.following ? 0.7 : 0);
    if (txtScore && hasTikTokName) txtScore = Math.min(0.97, txtScore + 0.07);
    if (otherPlatform(ps)) return txtScore >= 0.9 ? 0.5 : 0.02;
    if (txtScore) return txtScore;
    if (ps.some(function (p) { return RE_JSON_MAIN.test(p); })) return 0.85;
    if (hasTikTokName) return 0.5;
    if (ps.length <= 5 && ps.every(function (p) { return /\.json$/i.test(p); })) return 0.25;
    return 0;
  }

  /* ------------------------------------------------------------------ values */

  var RE_DATE = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/;

  // TikTok export time → ms epoch (UTC) or null.
  function parseDate(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return isFinite(v) && v > 0 ? (v < 1e11 ? v * 1000 : v) : null;
    var s = String(v).trim();
    if (/^\d{9,13}$/.test(s)) return parseDate(Number(s));
    var m = RE_DATE.exec(s);
    if (m) {
      var ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
      return isNaN(ms) ? null : ms;
    }
    var d = Date.parse(s);
    return isNaN(d) ? null : d;
  }

  // Invisible / control characters that must never survive into a displayed username.
  var RE_INVISIBLE = /[\u0000-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;
  var RE_SAFE_HANDLE = /^[\p{L}\p{N}_.]{1,64}$/u;

  function cleanUsername(raw) {
    if (typeof raw !== 'string' && typeof raw !== 'number') return null;
    var s = String(raw).normalize('NFC').replace(RE_INVISIBLE, '').trim().replace(/^@+/, '').trim();
    return s ? s : null;
  }

  function makeEntry(username, ts) {
    return {
      key: username.toLowerCase(),
      username: username,
      name: null,
      url: RE_SAFE_HANDLE.test(username) ? PROFILE_BASE + encodeURIComponent(username) : null,
      ts: ts
    };
  }

  var USER_FIELDS = { username: 1, uniqueid: 1, user: 1, gebruikersnaam: 1, benutzername: 1 };
  var DATE_FIELDS = { date: 1, time: 1, timestamp: 1, followdate: 1, createtime: 1, datum: 1 };

  function pickFields(item) {
    if (typeof item === 'string') return { user: item, date: null };
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    var out = { user: null, date: null };
    for (var k in item) {
      if (!Object.prototype.hasOwnProperty.call(item, k)) continue;
      var n = norm(k);
      if (out.user == null && USER_FIELDS[n]) out.user = item[k];
      else if (out.date == null && DATE_FIELDS[n]) out.date = item[k];
    }
    return out;
  }

  // Accumulates entries of one list, deduplicated by key. First occurrence wins; a missing
  // date is filled from a later duplicate.
  function ListBuilder() {
    this.map = new Map();
    this.items = 0;     // non-null items seen
    this.skipped = 0;   // items without a usable username
  }
  ListBuilder.prototype.add = function (rawUser, rawDate) {
    this.items++;
    var username = cleanUsername(rawUser);
    if (!username) { this.skipped++; return; }
    var ts = parseDate(rawDate);
    var key = username.toLowerCase();
    var prev = this.map.get(key);
    if (!prev) this.map.set(key, makeEntry(username, ts));
    else if (prev.ts == null && ts != null) prev.ts = ts;
  };
  ListBuilder.prototype.addItems = function (arr) {
    for (var i = 0; i < arr.length; i++) {
      var item = arr[i];
      if (item == null) continue;
      var f = pickFields(item);
      if (f) this.add(f.user, f.date);
      else { this.items++; this.skipped++; }
    }
  };
  // Newest first, undated last, then A–Z: a sensible default order for every view.
  ListBuilder.prototype.entries = function () {
    return sortEntries(Array.from(this.map.values()));
  };

  function sortEntries(list) {
    return list.sort(function (a, b) {
      if (a.ts !== b.ts) {
        if (a.ts == null) return 1;
        if (b.ts == null) return -1;
        return b.ts - a.ts;
      }
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });
  }

  /* ------------------------------------------------------------------ text */

  // BOM strip + repair of UTF-16 text that was decoded as UTF-8 (NUL bytes between ASCII chars).
  // TikTok usernames and labels we rely on are ASCII-compatible, so dropping NULs is lossless
  // for everything the parser uses.
  function fixText(text) {
    var s = String(text == null ? '' : text);
    var sample = s.slice(0, 2000);
    var nuls = (sample.match(/\u0000/g) || []).length;
    if (nuls > sample.length / 5) s = s.replace(/\u0000/g, '').replace(/^\uFFFD+/, '');
    return s.replace(/^\uFEFF/, '');
  }

  /* ------------------------------------------------------------------ JSON */

  var SECTIONS = ['profileandsettings', 'youractivity', 'activity', 'profile'];
  var SECTION_SETS = {};
  SECTIONS.forEach(function (n) { SECTION_SETS[n] = {}; SECTION_SETS[n][n] = 1; });
  var LIST_KEYS = {
    followers: {
      section: { follower: 1, followers: 1, followerlist: 1, followerslist: 1, fans: 1, fanslist: 1 },
      inner: { fanslist: 1, fans: 1, followerlist: 1, followerslist: 1, followers: 1, follower: 1, list: 1 }
    },
    following: {
      section: { following: 1, followinglist: 1, followings: 1 },
      inner: { following: 1, followinglist: 1, followings: 1, list: 1 }
    }
  };
  // The generic inner key "list" is only trusted inside a known section, never in the deep search.
  var DEEP_KEYS = {
    followers: { fanslist: 1, fans: 1, followerlist: 1, followerslist: 1, followers: 1, follower: 1 },
    following: { following: 1, followinglist: 1, followings: 1 }
  };

  function childByNames(obj, names) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return undefined;
    for (var k in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, k) && names[norm(k)]) return { value: obj[k] };
    }
    return undefined;
  }

  // Resolves a section value to an array. Returns [] for explicitly empty sections (null, {},
  // FansList:null), undefined when the shape is not recognizable.
  function unwrapList(v, inner, depth) {
    if (Array.isArray(v)) return v;
    if (v == null) return [];
    if (typeof v !== 'object' || depth > 2) return undefined;
    var c = childByNames(v, inner);
    if (c) return unwrapList(c.value, inner, depth + 1);
    var arrays = Object.keys(v).filter(function (k) { return Array.isArray(v[k]); });
    if (arrays.length === 1) return v[arrays[0]];
    var hasObjects = Object.keys(v).some(function (k) { return v[k] && typeof v[k] === 'object'; });
    return arrays.length === 0 && !hasObjects ? [] : undefined;
  }

  function looksLikeEntryArray(arr) {
    if (!Array.isArray(arr)) return false;
    for (var i = 0; i < arr.length && i < 20; i++) {
      var f = arr[i] != null ? pickFields(arr[i]) : null;
      if (f && f.user != null) return true;
    }
    return arr.length === 0;
  }

  // Last resort: bounded depth-first search for an array under one of the list's key names.
  function deepFind(obj, keys, depth) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj) || depth > 6) return undefined;
    for (var k in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
      var v = obj[k];
      if (keys[norm(k)] && looksLikeEntryArray(v)) return v;
    }
    for (var k2 in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, k2)) continue;
      var found = deepFind(obj[k2], keys, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  // → { followers: array|undefined, following: array|undefined }  (undefined = not in document)
  function listsFromJson(data) {
    var out = { followers: undefined, following: undefined };
    if (!data || typeof data !== 'object' || Array.isArray(data)) return out;
    var containers = [];
    SECTIONS.forEach(function (name) {
      var c = childByNames(data, SECTION_SETS[name]);
      if (c && c.value && typeof c.value === 'object') containers.push(c.value);
    });
    containers.push(data);
    ['followers', 'following'].forEach(function (list) {
      var keys = LIST_KEYS[list];
      for (var i = 0; i < containers.length && out[list] === undefined; i++) {
        var sec = childByNames(containers[i], keys.section);
        if (sec) out[list] = unwrapList(sec.value, keys.inner, 0);
      }
      if (out[list] === undefined) out[list] = deepFind(data, DEEP_KEYS[list], 0);
    });
    return out;
  }

  // ProfileMap.userName (current: "Profile And Settings"."Profile Info", legacy: Profile."Profile Information").
  function ownerFromJson(data) {
    var pm = deepFindKey(data, 'profilemap', 0);
    if (!pm || typeof pm !== 'object') return null;
    var f = childByNames(pm, { username: 1, uniqueid: 1 });
    return f ? cleanUsername(f.value) : null;
  }

  function deepFindKey(obj, key, depth) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj) || depth > 4) return undefined;
    for (var k in obj) if (Object.prototype.hasOwnProperty.call(obj, k) && norm(k) === key) return obj[k];
    for (var k2 in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, k2)) continue;
      var r = deepFindKey(obj[k2], key, depth + 1);
      if (r !== undefined) return r;
    }
    return undefined;
  }

  async function readJson(fileSet, path) {
    var text = fixText(await fileSet.read(path));
    try {
      return JSON.parse(text);
    } catch (e) {
      return fail('CORRUPT_FILE', { file: path });
    }
  }

  /* ------------------------------------------------------------------ TXT */

  var TXT_DATE_LABELS = { date: 1, datum: 1, fecha: 1, data: 1, tarih: 1, time: 1 };
  var TXT_USER_LABELS = {
    username: 1, user: 1, gebruikersnaam: 1, benutzername: 1, nombredeusuario: 1,
    "nomd'utilisateur": 1, 'nomd\u2019utilisateur': 1, nomeutente: 1, 'nomedeusu\u00E1rio': 1,
    nomedeusuario: 1, 'nazwau\u017Cytkownika': 1, nazwauzytkownika: 1, 'kullan\u0131c\u0131ad\u0131': 1
  };
  var RE_TXT_LINE = /^([^:\uFF1A]{1,40}?)\s*[:\uFF1A]\s*(.*)$/;

  // Parses "Label: value" blocks into { user, date } records. Records end at a blank line or when
  // a label repeats, so both "Date, Username" and "Username, Date" orders work.
  function parseTxt(text) {
    var lines = fixText(text).split(/\r\n|\r|\n/);
    var parsed = [];
    var labelStats = Object.create(null);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) { parsed.push(null); continue; }
      var m = RE_TXT_LINE.exec(line);
      if (!m) continue;
      var label = norm(m[1].normalize('NFC'));
      var value = m[2].trim();
      parsed.push({ label: label, value: value });
      var st = labelStats[label] || (labelStats[label] = { n: 0, dates: 0 });
      st.n++;
      if (RE_DATE.test(value)) st.dates++;
    }
    // Classify labels: known names first, then structurally for unknown (localized) labels.
    var role = Object.create(null);
    var unknown = [];
    Object.keys(labelStats).forEach(function (l) {
      var st = labelStats[l];
      if (TXT_DATE_LABELS[l] || st.dates === st.n) role[l] = 'date';
      else if (TXT_USER_LABELS[l]) role[l] = 'user';
      else unknown.push(l);
    });
    var hasUser = Object.keys(role).some(function (l) { return role[l] === 'user'; });
    if (!hasUser && unknown.length === 1) role[unknown[0]] = 'user';

    var records = [];
    var cur = { user: undefined, date: undefined };
    function flush() {
      if (cur.user !== undefined) records.push({ user: cur.user, date: cur.date === undefined ? null : cur.date });
      cur = { user: undefined, date: undefined };
    }
    for (var j = 0; j < parsed.length; j++) {
      var p = parsed[j];
      if (!p) { flush(); continue; }
      var r = role[p.label];
      if (!r) continue;
      if (cur[r] !== undefined) flush();
      cur[r] = p.value;
    }
    flush();
    return records;
  }

  /* ------------------------------------------------------------------ parse */

  function finishList(list, builder, file, warnings) {
    // Items were present but not a single username could be read: unknown format, not "0 people".
    if (builder.items > 0 && builder.map.size === 0) fail('CORRUPT_FILE', { file: file });
    if (builder.skipped > 0) warnings.push({ code: 'ENTRIES_SKIPPED', params: { list: list, count: builder.skipped } });
    return builder.entries();
  }

  // Recognizes a lone JSON file from another platform by its content (Instagram's
  // relationships_* / string_list_data, Facebook's *_v2/_v3 wrappers).
  function otherPlatformFromJson(data) {
    var probe = Array.isArray(data) ? data[0] : data;
    if (!probe || typeof probe !== 'object') return null;
    var keys = Object.keys(probe).join(' ');
    if (/(^| )(relationships_[a-z_]+|string_list_data|media_list_data)( |$)/.test(keys)) return 'instagram';
    if (/(^| )(friends|following|followers|received_requests|sent_requests|deleted_friends)_v\d+( |$)/.test(keys)) return 'facebook';
    return null;
  }

  // → export object, or { other: platform|null } when no candidate holds TikTok lists.
  async function parseJsonExport(fileSet, candidates) {
    var parsed = [];
    var firstError = null;
    var other = null;
    for (var i = 0; i < candidates.length; i++) {
      var path = candidates[i];
      try {
        var data = await readJson(fileSet, path);
        var lists = listsFromJson(data);
        if (lists.followers === undefined && lists.following === undefined) {
          other = other || otherPlatformFromJson(data);
          continue;
        }
        parsed.push({ path: path, data: data, lists: lists });
      } catch (e) {
        if (!firstError) firstError = e;
      }
    }
    if (!parsed.length) {
      if (firstError) throw firstError;
      return { other: other };
    }

    var warnings = [];
    var chosen = parsed[0];
    if (parsed.length > 1) {
      // Several exports (e.g. "user_data_tiktok.json" + "user_data_tiktok (1).json"). Mixing two
      // snapshots would hide unfollows, so use the one with the most recent follow date.
      var best = -1;
      parsed.forEach(function (p) {
        var latest = Math.max(latestDate(p.lists.following), latestDate(p.lists.followers));
        if (latest > best) { best = latest; chosen = p; }
      });
      warnings.push({ code: 'MULTIPLE_EXPORTS', params: { file: chosen.path } });
    }

    if (chosen.lists.following === undefined) fail('MISSING_LIST', { list: 'following' });
    if (chosen.lists.followers === undefined) fail('MISSING_LIST', { list: 'followers' });

    var res = { followers: null, following: null };
    ['followers', 'following'].forEach(function (list) {
      var b = new ListBuilder();
      b.addItems(chosen.lists[list]);
      res[list] = finishList(list, b, chosen.path, warnings);
    });
    return { lists: res, files: [chosen.path], warnings: warnings, owner: ownerFromJson(chosen.data) };
  }

  function latestDate(arr) {
    var max = 0;
    (arr || []).forEach(function (it) {
      var f = it != null ? pickFields(it) : null;
      var t = f ? parseDate(f.date) : null;
      if (t && t > max) max = t;
    });
    return max;
  }

  async function parseTxtExport(fileSet, groups) {
    if (!groups.following.length) fail('MISSING_LIST', { list: 'following' });
    if (!groups.followers.length) fail('MISSING_LIST', { list: 'followers' });
    var warnings = [];
    var res = {};
    for (var list of ['followers', 'following']) {
      var b = new ListBuilder();
      for (var path of groups[list]) {
        var text = await fileSet.read(path);
        var records = parseTxt(text);
        // Non-empty file without a single recognizable record → wrong or garbled file.
        if (!records.length && fixText(text).trim()) fail('CORRUPT_FILE', { file: path });
        records.forEach(function (rec) { b.add(rec.user, rec.date); });
      }
      res[list] = finishList(list, b, groups[list][0], warnings);
    }
    return { lists: res, files: groups.followers.concat(groups.following), warnings: warnings, owner: null };
  }

  // Prefer user_data_tiktok.json over user_data.json, then shallower paths.
  function rankJson(a, b) {
    var ta = RE_JSON_TIKTOK.test(a) ? 0 : 1, tb = RE_JSON_TIKTOK.test(b) ? 0 : 1;
    if (ta !== tb) return ta - tb;
    return a.split('/').length - b.split('/').length || (a < b ? -1 : 1);
  }

  /**
   * @param {{paths:string[], read:(p:string)=>Promise<string>}} fileSet
   * @returns {Promise<{platform:'tiktok', lists:{followers:Entry[], following:Entry[]}, files:string[], warnings:{code:string,params:object}[], owner:string|null}>}
   */
  async function parse(fileSet) {
    var paths = usablePaths(fileSet && fileSet.paths);
    if (!paths.length) fail('NO_RELEVANT_FILES');

    var jsonMain = paths.filter(function (p) { return RE_JSON_MAIN.test(p); }).sort(rankJson);
    var txtGroups = { followers: [], following: [] };
    paths.forEach(function (p) { var l = txtListOf(p); if (l) txtGroups[l].push(p); });
    var hasTxt = txtGroups.followers.length + txtGroups.following.length > 0;

    // A lone unrecognized .json (renamed or re-saved export) is content-sniffed as well.
    var jsonCandidates = jsonMain.length ? jsonMain
      : (!hasTxt && !otherPlatform(paths) ? paths.filter(function (p) { return /\.json$/i.test(p); }).slice(0, 5) : []);

    var out = null;
    var jsonError = null;
    var otherFromContent = null;
    if (jsonCandidates.length) {
      try {
        out = await parseJsonExport(fileSet, jsonCandidates);
        if (!out.lists) { otherFromContent = out.other; out = null; }
      } catch (e) {
        if (!hasTxt) throw e;
        jsonError = e; // a TXT export is also present – try it before giving up
      }
    }
    if (!out && hasTxt) {
      try {
        out = await parseTxtExport(fileSet, txtGroups);
      } catch (e) {
        throw jsonError || e;
      }
    }
    if (!out) {
      if (jsonMain.length) fail('MISSING_LIST', { list: 'following' });
      var other = otherPlatform(paths) || otherFromContent;
      if (other) fail('WRONG_PLATFORM', { platform: other });
      fail('NO_RELEVANT_FILES');
    }

    if (!out.lists.followers.length && !out.lists.following.length) fail('EMPTY_LISTS');
    ['followers', 'following'].forEach(function (list) {
      if (!out.lists[list].length) out.warnings.push({ code: 'LIST_EMPTY', params: { list: list } });
    });

    return {
      platform: 'tiktok',
      lists: out.lists,
      files: out.files,
      warnings: out.warnings,
      owner: out.owner
    };
  }

  /* ------------------------------------------------------------------ views */

  /**
   * notFollowingBack (primary) = following − followers  · dateKey followedSince
   * fans                       = followers − following  · dateKey followsYouSince
   * mutual                     = following ∩ followers  · dateKey friendsSince (later of both follows)
   * following / followers      = the full lists
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

    return [
      { id: 'notFollowingBack', entries: notFollowingBack, primary: true, dateKey: 'followedSince' },
      { id: 'fans', entries: fans, dateKey: 'followsYouSince' },
      { id: 'mutual', entries: sortEntries(mutual), dateKey: 'friendsSince' },
      // Copies, so a consumer sorting a view in place never reorders result.lists.
      { id: 'following', entries: following.slice(), dateKey: 'followedSince' },
      { id: 'followers', entries: followers.slice(), dateKey: 'followsYouSince' }
    ];
  }

  return {
    id: 'tiktok',
    detect: detect,
    parse: parse,
    views: views,
    // Exposed for unit tests; not part of the runtime contract.
    _internal: { parseDate: parseDate, parseTxt: parseTxt, listsFromJson: listsFromJson, txtListOf: txtListOf, fixText: fixText }
  };
});
