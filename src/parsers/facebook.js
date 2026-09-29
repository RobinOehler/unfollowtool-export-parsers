/*
 * unfollowtool.com – Facebook "Download your information" parser.
 *
 * Contract (README.md): UT.parsers.facebook = { id, detect(paths), parse(fileSet), views(result) }.
 * Pure logic, no DOM. Classic script in the browser (attaches to window.UT.parsers.facebook),
 * CommonJS in Node (module.exports) for unit tests.
 *
 * Supported export generations (JSON and HTML format, any wrapper folder, numbered parts _1, _2 …):
 *   2023+   connections/friends/{your_friends, removed_friends, sent_friend_requests,
 *                               received_friend_requests, rejected_friend_requests}.json
 *           connections/followers/{who_you've_followed, people_who_followed_you(_N)}.json
 *   2020-22 friends_and_followers/{friends, removed_friends, friend_requests_sent,
 *                                  friend_requests_received, following, followers}.json
 *   2018-19 friends/{friends, removed_friends, sent_friend_requests, received_friend_requests}.json
 *           following_and_followers/{following, followers}.json
 *
 * Facebook exports contain display names only – no usernames, ids or profile URLs for people.
 * Therefore Entry.key is the normalised display name, Entry.username and Entry.url are always null
 * (profile URLs are never guessed from names). Homonyms inside one list are disambiguated by
 * appending "#<unix seconds>" (or "#<n>" without a timestamp) to the key of every further occurrence.
 *
 * Errors: thrown as UT.UTError(code, params) when ut-core.js is loaded; otherwise (Node tests) as a
 * plain Error whose .message and .code are the code and whose .params holds the params.
 */
(function (root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.UT = root.UT || {};
    root.UT.parsers = root.UT.parsers || {};
    root.UT.parsers.facebook = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  /* ------------------------------------------------------------------ errors */

  function fail(code, params) {
    params = params || {};
    var UT = root.UT;
    if (UT && typeof UT.UTError === 'function') return new UT.UTError(code, params);
    var err = new Error(code);
    err.name = 'UTError';
    err.code = code;
    err.params = params;
    return err;
  }

  /* ----------------------------------------------------------- text helpers */

  var utf8 = typeof TextDecoder === 'function' ? new TextDecoder('utf-8', { fatal: true }) : null;
  var HAS_HIGH_LATIN1 = /[\u0080-\u00ff]/;
  var BEYOND_LATIN1 = /[^\u0000-\u00ff]/;

  /**
   * Meta writes every UTF-8 byte of a string as its own \u00XX escape, so "Jürgen" arrives as
   * "JÃ¼rgen". If a string only contains code points <= U+00FF and those bytes form valid UTF-8,
   * decode them; otherwise (e.g. a genuine "Café") keep the string unchanged.
   */
  function fixMojibake(s) {
    if (!HAS_HIGH_LATIN1.test(s) || BEYOND_LATIN1.test(s)) return s;
    if (utf8) {
      var bytes = new Uint8Array(s.length);
      for (var i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
      try { return utf8.decode(bytes); } catch (e) { return s; }
    }
    try { return decodeURIComponent(escape(s)); } catch (e) { return s; }
  }

  // C0/C1 controls, line/paragraph separators and bidi embedding/override/isolate controls are
  // removed from names: they are never meaningful in a display name and can be used for spoofing.
  var UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
  var ZERO_WIDTH = /[\u200b-\u200d\u2060\ufeff]/g;

  function cleanName(s) {
    return s.replace(UNSAFE_CHARS, ' ').replace(/\s+/g, ' ').trim();
  }

  /** Matching key for a display name: NFC, zero-width chars removed, whitespace collapsed, lowercase. */
  function nameKey(name) {
    return name.normalize('NFC').replace(ZERO_WIDTH, '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  /** Unix seconds (or ms) → ms epoch; anything implausible → null. */
  function toMs(v) {
    var n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    if (typeof n !== 'number' || !isFinite(n) || n <= 0) return null;
    return Math.round(n < 1e11 ? n * 1000 : n);
  }

  function stripBom(text) {
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  }

  /* ----------------------------------------------------- file classification */

  var BASE_KINDS = [
    // FB-specific file names: recognised in any folder.
    { kind: 'friends', re: /^your_friends$/ },
    { kind: 'removedFriends', re: /^(removed|deleted)_friends$/ },
    { kind: 'sentRequests', re: /^(sent_friend_requests|friend_requests_sent)$/ },
    { kind: 'receivedRequests', re: /^(received_friend_requests|friend_requests_received)$/ },
    { kind: 'rejectedRequests', re: /^(rejected|declined)_friend_requests$/ },
    { kind: 'following', re: /^who_you(?:'|\u2019|%27|_)?ve_followed$|^who_you_follow$/ },
    { kind: 'followers', re: /^people_who_(?:followed|follow)_you$/ },
    // Generic names: only inside a Facebook connections folder, or uploaded as a bare file.
    { kind: 'friends', re: /^friends$/, generic: true },
    { kind: 'following', re: /^following$/, generic: true },
    { kind: 'followers', re: /^followers$/, generic: true }
  ];
  // Folders that hold connection lists in the three export generations. Instagram's
  // "followers_and_following" is deliberately NOT listed (FB 2018-19 used "following_and_followers").
  var FB_LIST_DIR = /(^|\/)(connections\/(friends|followers)|friends_and_followers|friends|following_and_followers)$/;
  var IGNORED = /(^|\/)__macosx\/|(^|\/)\._/;
  var PROFILE_FILE = /(^|\/)profile_information\/profile_information\.json$/;

  var FB_MARKERS = /(^|\/)(connections\/(friends|followers)|friends_and_followers|following_and_followers|your_facebook_activity|logged_information|apps_and_websites_off_of_facebook|facebook_marketplace|profile_information)\//;
  var IG_MARKERS = /(^|\/)(followers_and_following|your_instagram_activity|instagram_[a-z_]+)\/|(^|\/)instagram-[^/]*\//;
  var TIKTOK_MARKERS = /(^|\/)user_data(_tiktok)?\.json$|(^|\/)tiktok[^/]*\//;
  var X_MARKERS = /(^|\/)data\/(follower|following|account|manifest)\.js$/;

  /** @returns {{kind:string, ext:'json'|'html', generic:boolean}|null} */
  function classify(path) {
    var p = String(path).replace(/\\/g, '/').toLowerCase();
    if (IGNORED.test(p)) return null;
    var m = /(?:^|\/)([^/]+)\.(json|html)$/.exec(p);
    if (!m) return null;
    var base = m[1].replace(/_\d+$/, '');
    var slash = p.lastIndexOf('/');
    var dir = slash === -1 ? '' : p.slice(0, slash);
    for (var i = 0; i < BASE_KINDS.length; i++) {
      var k = BASE_KINDS[i];
      if (!k.re.test(base)) continue;
      if (k.generic && dir !== '' && !FB_LIST_DIR.test(dir)) return null;
      return { kind: k.kind, ext: m[2], generic: !!k.generic };
    }
    return null;
  }

  function otherPlatform(lowerPaths) {
    for (var i = 0; i < lowerPaths.length; i++) {
      var p = lowerPaths[i];
      if (IGNORED.test(p)) continue;
      if (IG_MARKERS.test(p)) return 'instagram';
      if (TIKTOK_MARKERS.test(p)) return 'tiktok';
      if (X_MARKERS.test(p)) return 'x';
    }
    return null;
  }

  /**
   * How likely the given paths are a Facebook export (0..1).
   * 0.97 FB list files · 0.6 FB export without connection lists · 0.35 only bare generic names
   * (friends.json …) · 0.02 other platform's export · 0 anything else.
   */
  function detect(paths) {
    var lower = (paths || []).map(function (p) { return String(p).replace(/\\/g, '/').toLowerCase(); });
    var strong = false, weak = false, marker = false;
    for (var i = 0; i < lower.length; i++) {
      var p = lower[i];
      if (IGNORED.test(p)) continue;
      var c = classify(p);
      if (c && (!c.generic || p.indexOf('/') !== -1)) strong = true;
      else if (c) weak = true;
      if (FB_MARKERS.test(p)) marker = true;
    }
    if (strong) return 0.97;
    var other = otherPlatform(lower);
    if (marker && !other) return 0.6;
    if (other) return 0.02;
    if (weak) return 0.35;
    return 0;
  }

  /* ------------------------------------------------------------ JSON lists */

  var JSON_KEYS = {
    friends: ['friends_v2', 'friends'],
    removedFriends: ['deleted_friends_v2', 'deleted_friends', 'removed_friends_v2', 'removed_friends'],
    sentRequests: ['sent_requests_v2', 'sent_requests'],
    receivedRequests: ['received_requests_v2', 'received_requests'],
    rejectedRequests: ['rejected_requests_v2', 'rejected_requests'],
    following: ['following_v3', 'following_v2', 'following'],
    followers: ['followers_v3', 'followers_v2', 'followers']
  };

  function isInstagramHref(href) {
    return typeof href === 'string' && /^https?:\/\/(www\.)?instagram\.com\//i.test(href);
  }

  /** Extracts {name, ts} from every item shape seen in Meta exports. */
  function rawPerson(item) {
    if (typeof item === 'string') return { name: item, ts: null };
    if (!item || typeof item !== 'object') return null;
    var name = typeof item.name === 'string' ? item.name : null;
    var ts = item.timestamp;
    var sld = Array.isArray(item.string_list_data) ? item.string_list_data[0] : null;
    if (sld && typeof sld === 'object') {
      if (name === null && typeof sld.value === 'string') name = sld.value;
      if (ts == null) ts = sld.timestamp;
    }
    if (name === null && Array.isArray(item.label_values)) {
      // 2024+ "label_values" records: [{label:'Name', value:'…'}, …]
      for (var i = 0; i < item.label_values.length; i++) {
        var lv = item.label_values[i];
        if (lv && typeof lv.value === 'string' && /^(name|full name)$/i.test(String(lv.label || ''))) { name = lv.value; break; }
      }
    }
    if (name === null && typeof item.title === 'string') name = item.title;
    if (name === null && typeof item.value === 'string') name = item.value;
    return name === null ? null : { name: name, ts: ts };
  }

  function findArray(data, kind) {
    if (Array.isArray(data)) return data;
    if (!data || typeof data !== 'object') return null;
    var keys = JSON_KEYS[kind];
    for (var i = 0; i < keys.length; i++) if (Array.isArray(data[keys[i]])) return data[keys[i]];
    // Unknown key: accept the object only if it holds exactly one array.
    var found = null;
    for (var k in data) {
      if (!Object.prototype.hasOwnProperty.call(data, k) || !Array.isArray(data[k])) continue;
      if (found) return null;
      found = data[k];
    }
    return found;
  }

  function looksLikeInstagramJson(data, arr) {
    if (data && !Array.isArray(data) && typeof data === 'object') {
      for (var k in data) if (/^relationships_/.test(k)) return true;
    }
    for (var i = 0; i < arr.length && i < 5; i++) {
      var it = arr[i];
      var sld = it && Array.isArray(it.string_list_data) ? it.string_list_data[0] : null;
      if (sld && isInstagramHref(sld.href)) return true;
    }
    return false;
  }

  function parseJsonList(text, kind, path) {
    var data;
    try { data = JSON.parse(stripBom(text)); } catch (e) { throw fail('CORRUPT_FILE', { file: path }); }
    var arr = findArray(data, kind);
    if (!arr) throw fail('CORRUPT_FILE', { file: path });
    if (looksLikeInstagramJson(data, arr)) throw fail('WRONG_PLATFORM', { platform: 'instagram' });
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var p = rawPerson(arr[i]);
      if (p) out.push({ name: fixMojibake(p.name), ts: toMs(p.ts) });
      else out.push({ name: '', ts: null }); // counted as unnamed later
    }
    return out;
  }

  /* ------------------------------------------------------------ HTML lists */

  var ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

  function decodeEntities(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, function (m, e) {
      var lower = e.toLowerCase();
      if (lower.charAt(0) === '#') {
        var cp = lower.charAt(1) === 'x' ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
        return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
      }
      return Object.prototype.hasOwnProperty.call(ENTITIES, lower) ? ENTITIES[lower] : m;
    });
  }

  function htmlText(fragment) {
    return decodeEntities(fragment.replace(/<[^>]*>/g, ' '));
  }

  function hasClass(openTag, cls) {
    var m = /\bclass\s*=\s*("([^"]*)"|'([^']*)')/i.exec(openTag);
    if (!m) return false;
    return (' ' + (m[2] || m[3] || '').replace(/\s+/g, ' ') + ' ').indexOf(' ' + cls + ' ') !== -1;
  }

  /** Text of the first <div> in `chunk` carrying one of the classes (or any div when classes is null). */
  function divText(chunk, classes) {
    var re = /<div\b[^>]*>/gi, m;
    while ((m = re.exec(chunk))) {
      if (classes && !classes.some(function (c) { return hasClass(m[0], c); })) continue;
      var end = chunk.indexOf('</div>', re.lastIndex);
      var text = htmlText(chunk.slice(re.lastIndex, end === -1 ? chunk.length : end)).replace(/\s+/g, ' ').trim();
      if (text || classes) return text;
    }
    return '';
  }

  /** Splits a document into row chunks starting at every opening tag that satisfies isRow. */
  function rowChunks(html, tagRe, isRow) {
    var starts = [], m;
    while ((m = tagRe.exec(html))) if (isRow(m[0])) starts.push(m.index);
    var out = [];
    for (var i = 0; i < starts.length; i++) out.push(html.slice(starts[i], i + 1 < starts.length ? starts[i + 1] : html.length));
    return out;
  }

  /**
   * Facebook HTML exports:
   *   2022+  <div class="… _a6-g uiBoxWhite …"><div class="… _a6-h …">Name</div>…<div class="… _a6-o">Date</div></div>
   *   ≤2021  <div class="… uiBoxWhite …"><div class="… _2lel">Name</div><div class="… _2lem">Date</div></div>
   * Names are plain text; links in the page are navigation and are never used.
   */
  function parseHtmlList(html) {
    var body = html.replace(/<(script|style|head)\b[\s\S]*?<\/\1\s*>/gi, '');
    var divRe = function () { return /<div\b[^>]*>/gi; };
    var chunks = rowChunks(body, divRe(), function (t) { return hasClass(t, '_a6-g'); });
    if (!chunks.length) chunks = rowChunks(body, divRe(), function (t) { return hasClass(t, 'uiBoxWhite'); });
    var out = [];
    for (var i = 0; i < chunks.length; i++) {
      var chunk = chunks[i];
      var name = divText(chunk, ['_a6-h', '_2lel']) || divText(chunk.replace(/^<div\b[^>]*>/i, ''), null);
      if (!name) continue;
      out.push({ name: name, ts: parseHtmlDate(divText(chunk, ['_a6-o', '_2lem'])) });
    }
    if (!chunks.length) {
      // Very old/unknown markup: one person per list item.
      var li = /<li\b[^>]*>([\s\S]*?)<\/li>/gi, m;
      while ((m = li.exec(body))) {
        var n = htmlText(m[1]).replace(/\s+/g, ' ').trim();
        if (n) out.push({ name: n, ts: null });
      }
    }
    return out;
  }

  // Month name prefixes for the export languages we serve (en de es fr it nl pl pt), accents removed.
  var MONTHS = {
    jan: 0, ene: 0, gen: 0, sty: 0,
    feb: 1, fev: 1, lut: 1,
    mar: 2, mrt: 2, maar: 2,
    apr: 3, abr: 3, avr: 3, kwi: 3,
    may: 4, mai: 4, mag: 4, mei: 4, maj: 4,
    jun: 5, juin: 5, giu: 5, cze: 5,
    jul: 6, juil: 6, lug: 6, lip: 6,
    aug: 7, ago: 7, aou: 7, sie: 7,
    sep: 8, set: 8, wrz: 8,
    oct: 9, okt: 9, ott: 9, out: 9, paz: 9,
    nov: 10, lis: 10,
    dec: 11, dez: 11, dic: 11, gru: 11
  };

  // Weekday names that would otherwise match a month prefix (fr mardi, es martes, it martedi).
  var WEEKDAY = /^(mardi|martes|martedi)$/;

  function monthOf(word) {
    if (WEEKDAY.test(word)) return null;
    if (word.length >= 4 && Object.prototype.hasOwnProperty.call(MONTHS, word.slice(0, 4))) return MONTHS[word.slice(0, 4)];
    var p = word.slice(0, 3);
    if (p === 'jui') return null; // French juin/juil are only distinguishable by 4 letters
    return Object.prototype.hasOwnProperty.call(MONTHS, p) ? MONTHS[p] : null;
  }

  /**
   * Parses the date strings Facebook prints in HTML exports ("Nov 14, 2023 10:13:20 pm",
   * "14. Nov. 2023, 22:13", "2023-11-14T22:13:20", "14.11.2023"). Interpreted as local time.
   * Returns ms epoch or null.
   */
  function parseHtmlDate(text) {
    if (!text) return null;
    var s = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    var y, mo, d, h = 0, mi = 0, sec = 0, m;
    var tm = /(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/.exec(s);
    if (tm) {
      h = +tm[1]; mi = +tm[2]; sec = tm[3] ? +tm[3] : 0;
      if (tm[4]) { var pm = tm[4].charAt(0) === 'p'; if (h === 12) h = 0; if (pm) h += 12; }
      s = s.slice(0, tm.index) + ' ' + s.slice(tm.index + tm[0].length);
    }
    if ((m = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s))) { y = +m[1]; mo = +m[2] - 1; d = +m[3]; }
    else if ((m = /\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/.exec(s))) { d = +m[1]; mo = +m[2] - 1; y = +m[3]; }
    else {
      var ym = /\b(19|20)\d{2}\b/.exec(s);
      if (!ym) return null;
      y = +ym[0];
      s = s.slice(0, ym.index) + ' ' + s.slice(ym.index + 4);
      var words = s.match(/[a-z]{3,}/g) || [];
      mo = null;
      for (var i = 0; i < words.length && mo === null; i++) mo = monthOf(words[i]);
      var dm = /\b(\d{1,2})\b/.exec(s);
      if (mo === null || !dm) return null;
      d = +dm[1];
    }
    if (mo < 0 || mo > 11 || d < 1 || d > 31 || h > 23 || mi > 59 || sec > 59) return null;
    var date = new Date(y, mo, d, h, mi, sec);
    return date.getDate() === d ? date.getTime() : null;
  }

  /* ---------------------------------------------------------------- entries */

  /**
   * Turns raw {name, ts} records into Entries: cleans names, drops unnamed records, removes exact
   * duplicates (same name and same or missing timestamp, e.g. overlap between numbered parts) and
   * gives genuine homonyms distinct, stable keys.
   */
  function toEntries(raw) {
    var groups = new Map();
    var used = new Set();
    var out = [];
    var unnamed = 0;
    for (var i = 0; i < raw.length; i++) {
      var name = typeof raw[i].name === 'string' ? cleanName(raw[i].name) : '';
      var base = name ? nameKey(name) : '';
      if (!base) { unnamed++; continue; }
      var ts = raw[i].ts;
      var group = groups.get(base);
      if (!group) {
        var first = { key: base, username: null, name: name, url: null, ts: ts };
        groups.set(base, [first]);
        used.add(base);
        out.push(first);
        continue;
      }
      var dup = null;
      for (var j = 0; j < group.length; j++) {
        if (group[j].ts === ts || group[j].ts === null || ts === null) { dup = group[j]; break; }
      }
      if (dup) { if (dup.ts === null && ts !== null) dup.ts = ts; continue; }
      var key = base + '#' + Math.floor(ts / 1000);
      for (var n = 2; used.has(key); n++) key = base + '#' + Math.floor(ts / 1000) + '#' + n;
      var entry = { key: key, username: null, name: name, url: null, ts: ts };
      group.push(entry);
      used.add(key);
      out.push(entry);
    }
    return { entries: out, unnamed: unnamed };
  }

  /* ------------------------------------------------------------------ owner */

  function ownerSlug(s) {
    var slug = String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return slug || null;
  }

  function ownerFromProfile(text) {
    var data;
    try { data = JSON.parse(stripBom(text)); } catch (e) { return null; }
    var p = data && (data.profile_v2 || data.profile);
    if (!p || typeof p !== 'object') return null;
    if (typeof p.username === 'string' && p.username) return ownerSlug(p.username);
    var uri = typeof p.profile_uri === 'string' ? p.profile_uri : '';
    var m = /^https:\/\/(?:www\.|m\.)?facebook\.com\/(?:profile\.php\?id=(\d+)|([A-Za-z0-9.]+))/.exec(uri);
    return m ? ownerSlug(m[1] || m[2]) : null;
  }

  // Meta names downloads "facebook-<username>-<yyyy>-<mm>-<dd>-<random>.zip"; an extracted and
  // re-zipped export keeps that name as its top-level folder.
  function ownerFromName(name) {
    var m = /^(?:__macosx\/)?facebook-([a-z0-9.]+)-\d{4}-\d{2}-\d{2}/i.exec(String(name || ''));
    return m ? ownerSlug(m[1]) : null;
  }

  /* ------------------------------------------------------------------ parse */

  var CORE_LISTS = /^(friends|following|followers)$/;
  var LIST_ORDER = ['friends', 'following', 'followers', 'removedFriends', 'sentRequests', 'receivedRequests', 'rejectedRequests'];

  /**
   * @param {{paths:string[], read:(path:string)=>Promise<string>, sourceNames?:string[]}} fileSet
   * @returns {Promise<{platform:'facebook', lists:Object, files:string[], warnings:Array, owner:string|null}>}
   */
  async function parse(fileSet) {
    var paths = (fileSet && fileSet.paths) || [];
    var byKind = {};
    var profilePath = null;
    for (var i = 0; i < paths.length; i++) {
      var c = classify(paths[i]);
      if (c) (byKind[c.kind] = byKind[c.kind] || []).push({ path: paths[i], ext: c.ext });
      else if (!profilePath && PROFILE_FILE.test(paths[i].toLowerCase()) && !IGNORED.test(paths[i].toLowerCase())) profilePath = paths[i];
    }
    var kinds = LIST_ORDER.filter(function (k) { return byKind[k]; });
    if (!kinds.length) {
      var other = otherPlatform(paths.map(function (p) { return p.toLowerCase(); }));
      throw other ? fail('WRONG_PLATFORM', { platform: other }) : fail('NO_RELEVANT_FILES');
    }

    var lists = {};
    var files = [];
    var warnings = [];
    var unnamed = 0;
    var htmlOnly = true;
    for (var k = 0; k < kinds.length; k++) {
      var kind = kinds[k];
      var group = byKind[kind];
      // If both formats of a list were uploaded, prefer JSON (exact timestamps, no markup guessing).
      var json = group.filter(function (f) { return f.ext === 'json'; });
      var chosen = (json.length ? json : group).slice().sort(function (a, b) { return partOrder(a.path, b.path); });
      if (json.length) htmlOnly = false;
      var raw = [];
      for (var f = 0; f < chosen.length; f++) {
        var file = chosen[f];
        var text;
        try { text = await fileSet.read(file.path); } catch (e) { throw fail('CORRUPT_FILE', { file: file.path }); }
        if (typeof text !== 'string') throw fail('CORRUPT_FILE', { file: file.path });
        var part = file.ext === 'json' ? parseJsonList(text, kind, file.path) : parseHtmlList(stripBom(text));
        // Facebook omits empty lists instead of writing empty HTML pages, so a core HTML list without
        // rows means markup we cannot read – never compare against a silently empty list.
        if (file.ext === 'html' && !part.length && CORE_LISTS.test(kind)) throw fail('HTML_EXPORT_UNSUPPORTED');
        for (var r = 0; r < part.length; r++) raw.push(part[r]);
        files.push(file.path);
      }
      var res = toEntries(raw);
      lists[kind] = res.entries;
      unnamed += res.unnamed;
    }

    var total = kinds.reduce(function (n, kk) { return n + lists[kk].length; }, 0);
    if (!total) throw htmlOnly ? fail('HTML_EXPORT_UNSUPPORTED') : fail('EMPTY_LISTS');

    // Refuse to present a one-sided follow comparison: with only one of the two follow lists and no
    // friends list there is nothing trustworthy to show.
    var hasFollowing = !!lists.following, hasFollowers = !!lists.followers;
    if (hasFollowing !== hasFollowers) {
      var missing = hasFollowing ? 'followers' : 'following';
      if (!lists.friends) throw fail('MISSING_LIST', { list: missing });
      warnings.push({ code: 'MISSING_LIST', params: { list: missing } });
    } else if (!hasFollowing && !lists.friends) {
      throw fail('MISSING_LIST', { list: 'friends' });
    }
    if (unnamed) warnings.push({ code: 'SKIPPED_UNNAMED', params: { count: unnamed } });

    // Owner (history key): profile username/id, else the export's file/folder name. Never the full
    // name – it is not unique and changes more often.
    var owner = null;
    if (profilePath) {
      try { owner = ownerFromProfile(await fileSet.read(profilePath)); } catch (e) { owner = null; }
      if (owner) files.push(profilePath);
    }
    var sources = (fileSet.sourceNames || []).concat(paths);
    for (var s = 0; !owner && s < sources.length; s++) owner = ownerFromName(sources[s]);

    return { platform: 'facebook', lists: lists, files: files, warnings: warnings, owner: owner };
  }

  /** Orders numbered parts naturally (…_2 before …_10); unnumbered files first. */
  function partOrder(a, b) {
    var na = /_(\d+)\.[a-z]+$/i.exec(a), nb = /_(\d+)\.[a-z]+$/i.exec(b);
    var sa = a.replace(/_\d+(\.[a-z]+)$/i, '$1'), sb = b.replace(/_\d+(\.[a-z]+)$/i, '$1');
    if (sa !== sb) return sa < sb ? -1 : 1;
    return (na ? +na[1] : 0) - (nb ? +nb[1] : 0);
  }

  /* ------------------------------------------------------------------ views */

  /** Name key of an entry without its homonym suffix (a key without "#" is the name key itself). */
  function baseKey(e) {
    return e.key.indexOf('#') === -1 ? e.key : nameKey(e.name);
  }

  /** Counts of base keys so cross-list matching works as a multiset (homonyms matched pairwise). */
  function nameCounts(list) {
    var m = new Map();
    for (var i = 0; i < list.length; i++) {
      var b = baseKey(list[i]);
      m.set(b, (m.get(b) || 0) + 1);
    }
    return m;
  }

  /** Entries of `list` not matched by name in `other` (multiset difference), minus names in `exclude`. */
  function difference(list, other, exclude) {
    var counts = nameCounts(other);
    return list.filter(function (e) {
      var b = baseKey(e);
      if (exclude && exclude.has(b)) return false;
      var n = counts.get(b);
      if (n) { counts.set(b, n - 1); return false; }
      return true;
    });
  }

  function intersection(list, other) {
    var counts = nameCounts(other);
    return list.filter(function (e) {
      var b = baseKey(e);
      var n = counts.get(b);
      if (!n) return false;
      counts.set(b, n - 1);
      return true;
    });
  }

  /**
   * Views for a parse() result. The follow comparison excludes friends on both sides: on Facebook
   * friends follow each other implicitly and are listed inconsistently in the follow files, so a
   * friend would otherwise show up as "not following back".
   */
  function views(result) {
    var L = (result && result.lists) || {};
    var out = [];
    var hasPair = !!(L.following && L.followers);
    if (hasPair) {
      var friendNames = new Set((L.friends || []).map(baseKey));
      out.push({ id: 'notFollowingBack', entries: difference(L.following, L.followers, friendNames), primary: true, dateKey: 'followedSince' });
      out.push({ id: 'fans', entries: difference(L.followers, L.following, friendNames), dateKey: 'followsYouSince' });
      out.push({ id: 'mutual', entries: intersection(L.following, L.followers), dateKey: 'followedSince' });
    }
    if (L.friends) out.push({ id: 'friends', entries: L.friends, primary: !hasPair, dateKey: 'friendsSince' });
    if (L.removedFriends) out.push({ id: 'removedFriends', entries: L.removedFriends, dateKey: 'removedOn' });
    if (L.sentRequests) out.push({ id: 'sentRequests', entries: L.sentRequests, dateKey: 'requestedOn' });
    if (L.receivedRequests) out.push({ id: 'receivedRequests', entries: L.receivedRequests, dateKey: 'requestedOn' });
    if (L.rejectedRequests) out.push({ id: 'rejectedRequests', entries: L.rejectedRequests, dateKey: 'requestedOn' });
    if (L.following) out.push({ id: 'following', entries: L.following, dateKey: 'followedSince' });
    if (L.followers) out.push({ id: 'followers', entries: L.followers, dateKey: 'followsYouSince' });
    if (!out.some(function (v) { return v.primary; }) && out.length) out[0].primary = true;
    return out;
  }

  return {
    id: 'facebook',
    detect: detect,
    parse: parse,
    views: views,
    // Exposed for unit tests; not part of the runtime contract.
    _internal: { fixMojibake: fixMojibake, nameKey: nameKey, classify: classify, parseHtmlList: parseHtmlList, parseHtmlDate: parseHtmlDate }
  };
});
