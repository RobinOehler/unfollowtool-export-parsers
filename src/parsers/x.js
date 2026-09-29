/*!
 * unfollowtool.com – X (Twitter) archive parser.
 *
 * Contract (README.md): UT.parsers.x = { id, detect(paths), parse(fileSet), views(result) }.
 * Pure logic, no DOM. Loads as a classic script (attaches to window.UT.parsers.x) and as a CommonJS
 * module for the Node unit tests (module.exports).
 *
 * Input: X's "Download an archive of your data" ZIP (or the loose .js files from it):
 *   data/follower.js   window.YTD.follower.part0  = [ { "follower"  : { "accountId", "userLink" } } ]
 *   data/following.js  window.YTD.following.part0 = [ { "following" : { "accountId", "userLink" } } ]
 *   data/follower-part1.js … (window.YTD.follower.part1 …) when X splits a large list
 *   data/manifest.js   window.__THAR_CONFIG = { userInfo, archiveInfo.generationDate, dataTypes.<type>.files[] }
 *   data/account.js    window.YTD.account.part0 = [ { "account" : { "username", "accountId", … } } ]
 * The follow lists hold numeric account IDs only: no usernames, no names, no dates. Every Entry
 * therefore has username/name/ts = null, key = the account ID, and a profile URL rebuilt from the ID
 * (https://x.com/i/user/<id> redirects to the profile). The archive's userLink is never used as a URL.
 * X lists follows newest first; that order is preserved in the lists and views.
 *
 * Errors are thrown as UT.UTError(code, params) when ut-core.js is loaded. Without it (Node tests,
 * standalone use) they are plain Errors with the same shape: name 'UTError', message = code,
 * .code and .params. Codes: NO_RELEVANT_FILES {reason?}, WRONG_PLATFORM {platform},
 * MISSING_LIST {list, file?}, CORRUPT_FILE {file}, EMPTY_LISTS. Errors thrown by fileSet.read()
 * that already carry a string .code (e.g. CORRUPT_ZIP from ut-files.js) are passed through unchanged.
 *
 * Result extras beyond the contract: exportedAt (ms epoch of the archive's generationDate, or null).
 * Warnings: SKIPPED_ENTRIES {count}, MULTIPLE_EXPORTS {count, used}.
 */
(function (factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (typeof window !== 'undefined') {
    const UT = (window.UT = window.UT || {});
    (UT.parsers = UT.parsers || {}).x = api;
  }
})(function () {
  'use strict';

  const PLATFORM = 'x';
  const LISTS = { follower: 'followers', following: 'following' }; // file kind → Result.lists key

  // follower.js, following.js, follower-part1.js (X's split naming); follower_1.js / follower-1.js tolerated.
  const LIST_FILE_RE = /(?:^|\/)(follower|following)(?:[-_]part(\d+)|[-_](\d+))?\.js$/i;
  // Any other X data file: data/<type>.js, root-level manifest.js/account.js, viewer page, media folder.
  const X_MARKER_RE = /(?:^|\/)(?:data\/[a-z0-9-]+|manifest|account)\.js$|(?:^|\/)your archive\.html$|(?:^|\/)data\/tweets_media\//i;
  // Pre-2018 "Grailbird" archive: tweets only, never follow lists.
  const LEGACY_RE = /(?:^|\/)data\/js\/tweets\/[^/]+\.js$|(?:^|\/)tweets\.csv$/i;
  const JUNK_RE = /(?:^|\/)__MACOSX(?:\/|$)|(?:^|\/)\._[^/]*$/i;

  const ID_RE = /^[1-9]\d{0,19}$/; // uint64 account ID, as a decimal string
  // The only userLink shapes X writes; used just to recover a missing accountId, never as a URL.
  const INTENT_LINK_RE = /^https:\/\/(?:www\.|mobile\.)?(?:twitter|x)\.com\/intent\/user\?user_id=([1-9]\d{0,19})$/i;
  const USERNAME_RE = /^[A-Za-z0-9_]{1,50}$/; // X handles are ≤15 chars; tolerate legacy/odd lengths

  // Signatures of the other supported platforms' exports (order matters: Facebook before Instagram,
  // because recent Facebook exports also contain followers_and_following/).
  const OTHER_PLATFORMS = [
    ['facebook', /(?:^|\/)(?:connections\/friends\/|friends_and_followers\/|friends\/)|(?:^|\/)(?:your_friends|people_who_followed_you(?:_\d+)?|who_you've_followed)\.(?:json|html)$/i],
    ['instagram', /(?:^|\/)followers_and_following\/|(?:^|\/)(?:followers(?:_\d+)?|following(?:_\d+)?)\.(?:json|html)$/i],
    ['tiktok', /(?:^|\/)user_data(?:_tiktok)?\.json$|(?:^|\/)follow(?:er|ing)(?: list)?\.txt$|tiktok/i],
  ];

  // ---------------------------------------------------------------- errors

  function fail(code, params) {
    const root = typeof window !== 'undefined' ? window : globalThis;
    const UTError = root.UT && root.UT.UTError;
    if (typeof UTError === 'function') return new UTError(code, params || {});
    const err = new Error(code);
    err.name = 'UTError';
    err.code = code;
    err.params = params || {};
    return err;
  }

  async function readText(fileSet, path) {
    try {
      return String(await fileSet.read(path));
    } catch (err) {
      if (err && typeof err.code === 'string') throw err; // already a UTError (e.g. CORRUPT_ZIP)
      throw fail('CORRUPT_FILE', { file: path });
    }
  }

  // ---------------------------------------------------------------- file discovery

  const isJunk = (p) => JUNK_RE.test(p);
  const dirOf = (p) => p.slice(0, p.lastIndexOf('/') + 1); // "" for root, else with trailing "/"

  /** Groups follower/following files by folder: Map<lowercased dir, {dir, follower[], following[]}>. */
  function findListFiles(paths) {
    const groups = new Map();
    for (const path of paths) {
      const m = LIST_FILE_RE.exec(path);
      if (!m) continue;
      const dir = dirOf(path);
      const key = dir.toLowerCase();
      if (!groups.has(key)) groups.set(key, { dir, follower: [], following: [] });
      groups.get(key)[m[1].toLowerCase()].push({ path, part: Number(m[2] || m[3] || 0) });
    }
    for (const g of groups.values()) {
      for (const kind of Object.keys(LISTS)) g[kind].sort((a, b) => a.part - b.part || (a.path < b.path ? -1 : 1));
    }
    return [...groups.values()];
  }

  function sniffOtherPlatform(paths) {
    for (const [platform, re] of OTHER_PLATFORMS) if (paths.some((p) => re.test(p))) return platform;
    return null;
  }

  // ---------------------------------------------------------------- JS/JSON decoding

  /**
   * Parses "window.YTD.<type>.partN = <json>" / "window.__THAR_CONFIG = <json>" / plain JSON.
   * Returns { type, data } where type is the YTD type name (or null).
   */
  function parseAssignment(text, file) {
    let start = text.charCodeAt(0) === 0xfeff ? 1 : 0;
    let type = null;
    const head = /^\s*window\.(?:YTD\.([\w$]+)\.part\d+|__THAR_CONFIG)\s*=\s*/.exec(text.slice(start, start + 200));
    if (head) {
      start += head[0].length;
      type = head[1] || null;
    }
    let end = text.length; // drop a trailing ";" and whitespace without regex-scanning the whole text
    while (end > start && /[\s;]/.test(text[end - 1])) end--;
    try {
      return { type, data: JSON.parse(text.slice(start, end)) };
    } catch (err) {
      throw fail('CORRUPT_FILE', { file });
    }
  }

  /** Account ID from a follower/following record, or null. Numbers are accepted only when exact. */
  function accountIdOf(rec) {
    const raw = rec.accountId;
    if (raw === undefined || raw === null || raw === '') {
      // No ID at all: recover it from a genuine intent link, otherwise give up.
      const m = typeof rec.userLink === 'string' ? INTENT_LINK_RE.exec(rec.userLink.trim()) : null;
      return m ? m[1] : null;
    }
    if (typeof raw === 'number') return Number.isSafeInteger(raw) && raw > 0 ? String(raw) : null;
    if (typeof raw !== 'string') return null;
    const id = raw.trim();
    return ID_RE.test(id) ? id : null;
  }

  // ---------------------------------------------------------------- manifest / owner

  async function readOptional(fileSet, path) {
    if (!path) return null;
    try {
      return parseAssignment(await fileSet.read(path), path).data;
    } catch (err) {
      return null; // manifest.js / account.js are optional extras, never fatal
    }
  }

  const cleanUsername = (u) => (typeof u === 'string' && USERNAME_RE.test(u.trim()) ? u.trim().toLowerCase() : null);

  function manifestFiles(manifest, kind) {
    const files = manifest && manifest.dataTypes && manifest.dataTypes[kind] && manifest.dataTypes[kind].files;
    return Array.isArray(files) ? files.map((f) => f && f.fileName).filter((n) => typeof n === 'string' && n) : [];
  }

  function generationDate(manifest) {
    const iso = manifest && manifest.archiveInfo && manifest.archiveInfo.generationDate;
    const ms = typeof iso === 'string' ? Date.parse(iso) : NaN;
    return Number.isFinite(ms) ? ms : null;
  }

  // ---------------------------------------------------------------- public API

  /** Likelihood (0..1) that the paths are an X archive. ≥0.5: X (maybe incomplete); <0.1: not X. */
  function detect(paths) {
    if (!Array.isArray(paths)) return 0;
    const lists = { follower: false, following: false };
    let marker = false;
    let legacy = false;
    for (const p of paths) {
      if (typeof p !== 'string' || isJunk(p)) continue;
      const m = LIST_FILE_RE.exec(p);
      if (m) lists[m[1].toLowerCase()] = true;
      else if (X_MARKER_RE.test(p)) marker = true;
      else if (LEGACY_RE.test(p)) legacy = true;
    }
    if (lists.follower && lists.following) return marker ? 0.99 : 0.95;
    if (lists.follower || lists.following) return marker ? 0.9 : 0.8;
    if (marker) return 0.6; // X archive without follow lists → parse() explains what is missing
    if (legacy) return 0.5;
    return 0;
  }

  /** @returns {Promise<{platform, lists:{followers, following}, files, warnings, owner, exportedAt}>} */
  async function parse(fileSet) {
    if (!fileSet || !Array.isArray(fileSet.paths) || typeof fileSet.read !== 'function') throw fail('NO_RELEVANT_FILES');
    const paths = fileSet.paths.filter((p) => typeof p === 'string' && !isJunk(p));
    const byLower = new Map(paths.map((p) => [p.toLowerCase(), p]));
    const lookup = (dir, name) => byLower.get((dir + name).toLowerCase()) || null;
    const warnings = [];
    const manifests = new Map(); // dir → parsed manifest.js (or null), read at most once

    const manifestIn = async (dir) => {
      if (!manifests.has(dir)) manifests.set(dir, await readOptional(fileSet, lookup(dir, 'manifest.js')));
      return manifests.get(dir);
    };

    // 1. Locate the follower and following files.
    const groups = findListFiles(paths);
    if (!groups.length) {
      const other = sniffOtherPlatform(paths);
      if (other) throw fail('WRONG_PLATFORM', { platform: other });
      if (paths.some((p) => LEGACY_RE.test(p))) throw fail('NO_RELEVANT_FILES', { reason: 'legacyArchive' });
      throw fail('NO_RELEVANT_FILES');
    }

    const complete = groups.filter((g) => g.follower.length && g.following.length);
    let sources; // { follower: group, following: group }
    if (complete.length) {
      // Several archives in one upload (old + new export): never mix them, use the newest one.
      let best = complete[0];
      if (complete.length > 1) {
        const ranked = await Promise.all(complete.map(async (g) => ({ g, date: generationDate(await manifestIn(g.dir)) })));
        ranked.sort((a, b) => (b.date ?? -Infinity) - (a.date ?? -Infinity) || (a.g.dir < b.g.dir ? 1 : -1));
        best = ranked[0].g;
        warnings.push({ code: 'MULTIPLE_EXPORTS', params: { count: complete.length, used: best.dir.replace(/\/$/, '') } });
      }
      sources = { follower: best, following: best };
    } else {
      // The two lists sit in different folders (e.g. files picked from two places): combine them.
      const f = groups.find((g) => g.follower.length);
      const g = groups.find((x) => x.following.length);
      if (!f) throw fail('MISSING_LIST', { list: 'followers' });
      if (!g) throw fail('MISSING_LIST', { list: 'following' });
      sources = { follower: f, following: g };
    }

    // 2. When manifest.js is present, every part it announces must be present too.
    for (const kind of Object.keys(LISTS)) {
      const group = sources[kind];
      const manifest = await manifestIn(group.dir);
      const have = new Set(group[kind].map((x) => x.path.slice(group.dir.length).toLowerCase()));
      for (const fileName of manifestFiles(manifest, kind)) {
        const base = fileName.slice(fileName.lastIndexOf('/') + 1).toLowerCase();
        if (!have.has(base)) throw fail('MISSING_LIST', { list: LISTS[kind], file: fileName });
      }
    }

    // 3. Parse, validate and merge all parts; one shared Entry object per account ID.
    const entries = new Map();
    const entryFor = (id) => {
      let e = entries.get(id);
      if (!e) {
        e = { key: id, username: null, name: null, url: 'https://x.com/i/user/' + id, ts: null };
        entries.set(id, e);
      }
      return e;
    };
    const lists = {};
    const files = [];
    let skipped = 0;
    for (const kind of Object.keys(LISTS)) {
      const parts = sources[kind][kind];
      const texts = await Promise.all(parts.map((x) => readText(fileSet, x.path)));
      const seen = new Set();
      const out = [];
      parts.forEach(({ path }, i) => {
        const { type, data } = parseAssignment(texts[i], path);
        // A renamed file (following data saved as follower.js) would silently invert the result.
        if (!Array.isArray(data) || (type && type.toLowerCase() !== kind)) throw fail('CORRUPT_FILE', { file: path });
        let valid = 0;
        for (const item of data) {
          const rec = item && typeof item === 'object' ? item[kind] : null;
          const id = rec && typeof rec === 'object' ? accountIdOf(rec) : null;
          if (!id) { skipped++; continue; }
          valid++;
          if (!seen.has(id)) { seen.add(id); out.push(entryFor(id)); }
        }
        if (data.length && !valid) throw fail('CORRUPT_FILE', { file: path }); // nothing usable: wrong format
        files.push(path);
      });
      lists[LISTS[kind]] = out;
    }
    if (!lists.followers.length && !lists.following.length) throw fail('EMPTY_LISTS');
    if (skipped) warnings.push({ code: 'SKIPPED_ENTRIES', params: { count: skipped } });

    // 4. Owner and export date (optional; data/account.js next to the lists, else manifest userInfo).
    const home = sources.following.dir;
    const manifest = await manifestIn(home);
    const accountPath = lookup(home, 'account.js');
    const account = await readOptional(fileSet, accountPath);
    const accRec = Array.isArray(account) && account[0] && account[0].account;
    const owner = cleanUsername(accRec && accRec.username)
      || cleanUsername(manifest && manifest.userInfo && manifest.userInfo.userName);
    if (accRec) files.push(accountPath);
    if (manifest) files.push(lookup(home, 'manifest.js'));

    return { platform: PLATFORM, lists, files, warnings, owner, exportedAt: generationDate(manifest) };
  }

  /** notFollowingBack (primary), fans, mutual. X has no follow dates, so views carry no dateKey. */
  function views(result) {
    const lists = (result && result.lists) || {};
    const followers = lists.followers || [];
    const following = lists.following || [];
    const followerKeys = new Set(followers.map((e) => e.key));
    const followingKeys = new Set(following.map((e) => e.key));
    return [
      { id: 'notFollowingBack', primary: true, entries: following.filter((e) => !followerKeys.has(e.key)) },
      { id: 'fans', entries: followers.filter((e) => !followingKeys.has(e.key)) },
      { id: 'mutual', entries: following.filter((e) => followerKeys.has(e.key)) },
    ];
  }

  return { id: PLATFORM, detect, parse, views };
});
