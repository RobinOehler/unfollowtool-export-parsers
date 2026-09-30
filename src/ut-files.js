/*!
 * unfollowtool.com – upload reader (UT.files)
 *
 *   UT.files.fromFileList(FileList | File[], { onProgress }?) → Promise<FileSet>
 *   FileSet = { paths, read(path) → Promise<string>, has(re) → string[], sourceNames, totalBytes,
 *               skipped }   (skipped = names of uploaded files that were ignored, e.g. photos)
 *
 * Accepts any mix of ZIP archives and loose .json/.js/.html/.txt/.csv files (several ZIPs, e.g. a
 * multi-part export, are merged into one FileSet). Inside archives only text files are listed;
 * photos/videos and other media are skipped without ever being read. A ZIP inside the uploaded
 * ZIP (users sometimes re-zip their export) is unpacked one level deep.
 *
 * ZIP reading strategy
 *  1. Native reader (default): parses the ZIP central directory with Blob.slice() and inflates
 *     only the entries a parser actually asks for, via DecompressionStream('deflate-raw').
 *     Nothing else is read into memory, so multi-GB exports that include media work, and ZIP64
 *     is supported.
 *  2. JSZip 3.10.1 fallback, lazy-loaded with a <script> tag the first time it is needed: for
 *     browsers without DecompressionStream('deflate-raw') and for archives the native reader
 *     rejects. JSZip needs the whole archive in one ArrayBuffer, hence the 2 GB limit there.
 *
 * Paths are normalized: forward slashes, Unicode NFC (macOS writes NFD), no leading "./" or "/",
 * no "."/".." segments; __MACOSX/, "._*", .DS_Store, Thumbs.db and desktop.ini are dropped.
 * Text is decoded as UTF-8 (UTF-16 when it starts with a UTF-16 BOM) and the BOM is removed.
 *
 * Errors (UT.UTError): EMPTY_UPLOAD, UNSUPPORTED_FILE {name}, CORRUPT_ZIP {name},
 * TOO_LARGE {name}, READ_FAILED {name}, LOAD_FAILED.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./ut-core.js'), root);
  else factory(root.UT, root);
})(typeof self !== 'undefined' ? self : globalThis, function (UT, root) {
  'use strict';

  var UTError = UT.UTError;

  var TEXT_EXT = /\.(json|js|html?|txt|csv)$/i;
  var ZIP_EXT = /\.zip$/i;
  var JUNK_BASENAME = /^(\._.*|\.DS_Store|Thumbs\.db|desktop\.ini)$/i;

  var GB = 1024 * 1024 * 1024;
  var MAX_TEXT_BYTES = 256 * 1024 * 1024;   // a single JSON/HTML/TXT file; larger ones would crash the tab
  var MAX_JSZIP_BYTES = 2 * GB;             // browsers cannot hand JSZip a larger ArrayBuffer
  var MAX_NESTED_ZIP_BYTES = 2 * GB;        // an inner ZIP is materialized as a Blob
  var MOBILE_WARN_BYTES = 1.5 * GB;         // phones often run out of memory on uploads this big

  var SIG_LOCAL = 0x04034b50;
  var SIG_CENTRAL = 0x02014b50;
  var SIG_EOCD = 0x06054b50;
  var SIG_EOCD64 = 0x06064b50;
  var SIG_EOCD64_LOCATOR = 0x07064b50;

  // Where to load JSZip from: next to this script, in vendor/ (the page may override it).
  var scriptBase = (function () {
    var cs = root.document && root.document.currentScript;
    return cs && cs.src ? cs.src.replace(/[^/]*$/, '') : '/assets/js/';
  })();

  /* ------------------------------------------------------------------ helpers */

  /** Normalizes an archive/relative path; returns null for directories and OS junk entries. */
  function normalizePath(raw) {
    var segments = String(raw).replace(/\\/g, '/').normalize('NFC').split('/')
      .filter(function (s) { return s !== '' && s !== '.' && s !== '..'; });
    if (!segments.length || segments.indexOf('__MACOSX') !== -1) return null;
    if (JUNK_BASENAME.test(segments[segments.length - 1])) return null;
    return segments.join('/');
  }

  /** True for names this tool can use (text files and ZIPs), used to skip media early. */
  function isRelevantName(name) {
    var base = String(name).split(/[\\/]/).pop();
    return !JUNK_BASENAME.test(base) && (TEXT_EXT.test(base) || ZIP_EXT.test(base));
  }

  /** Bytes → string. UTF-8 by default, UTF-16 LE/BE when a UTF-16 BOM is present; BOM removed. */
  function decodeText(bytes) {
    var enc = 'utf-8', start = 0;
    if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) start = 3;
    else if (bytes[0] === 0xFF && bytes[1] === 0xFE) { enc = 'utf-16le'; start = 2; }
    else if (bytes[0] === 0xFE && bytes[1] === 0xFF) { enc = 'utf-16be'; start = 2; }
    var text = new TextDecoder(enc).decode(bytes.subarray(start));
    return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  }

  var utf8Strict = new TextDecoder('utf-8', { fatal: true });
  var legacyNames = new TextDecoder('windows-1252');

  /** ZIP entry names: UTF-8 when flagged or valid, otherwise the legacy single-byte charset. */
  function decodeName(bytes, utf8Flag) {
    if (utf8Flag) return new TextDecoder('utf-8').decode(bytes);
    try { return utf8Strict.decode(bytes); } catch (e) { return legacyNames.decode(bytes); }
  }

  /** A failed ArrayBuffer allocation ("Array buffer allocation failed") means: out of memory. */
  function isOutOfMemory(err) {
    return !!err && (err.name === 'RangeError' || /allocation failed|out of memory/i.test(String(err.message || '')));
  }

  /** Maps browser read failures (file moved, cloud placeholder, …) to READ_FAILED, memory exhaustion to TOO_LARGE. */
  function wrapRead(promise, name) {
    return promise.catch(function (err) {
      if (UT.isUTError(err)) throw err;
      if (isOutOfMemory(err)) throw new UTError('TOO_LARGE', { name: name });
      throw new UTError('READ_FAILED', { name: name });
    });
  }

  function readBytes(blob, start, end, name) {
    return wrapRead(blob.slice(start, end).arrayBuffer(), name).then(function (buf) {
      return new Uint8Array(buf);
    });
  }

  function view(bytes) {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  function corrupt(name) {
    return new UTError('CORRUPT_ZIP', { name: name });
  }

  var nativeSupport = null;
  function nativeZipSupported() {
    if (nativeSupport === null) {
      try {
        nativeSupport = typeof root.Blob === 'function' && typeof root.Blob.prototype.stream === 'function' &&
          typeof root.Response === 'function' && typeof root.DecompressionStream === 'function' &&
          !!new root.DecompressionStream('deflate-raw');
      } catch (e) {
        nativeSupport = false;
      }
    }
    return nativeSupport;
  }

  /* ------------------------------------------------------------------ native ZIP reader */

  /**
   * Reads the central directory. Returns [{ name, dir, size, blob() , bytes() }] where
   * bytes() inflates the entry on demand and blob() returns it as a Blob (for nested ZIPs).
   */
  async function openZipNative(blob, label) {
    var size = blob.size;
    if (size < 22) throw corrupt(label);

    // End of central directory: in the last 22 + 65535 (max comment) bytes.
    var tailStart = Math.max(0, size - (22 + 0xFFFF));
    var tail = await readBytes(blob, tailStart, size, label);
    var tv = view(tail);
    var eocd = -1;
    for (var i = tail.length - 22; i >= 0; i--) {
      if (tv.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
    }
    if (eocd < 0) throw corrupt(label); // typically an interrupted download

    var count = tv.getUint16(eocd + 10, true);
    var cdSize = tv.getUint32(eocd + 12, true);
    var cdOffset = tv.getUint32(eocd + 16, true);
    var cdEnd = tailStart + eocd;

    // ZIP64: the locator sits directly before the classic EOCD record.
    var loc = eocd - 20;
    var isZip64 = loc >= 0 && tv.getUint32(loc, true) === SIG_EOCD64_LOCATOR;
    if (!isZip64 && (cdSize === 0xFFFFFFFF || cdOffset === 0xFFFFFFFF)) throw corrupt(label);
    if (isZip64) {
      var rec64At = Number(tv.getBigUint64(loc + 8, true));
      var rec64 = await readBytes(blob, rec64At, rec64At + 56, label);
      var rv = view(rec64);
      if (rec64.length < 56 || rv.getUint32(0, true) !== SIG_EOCD64) throw corrupt(label);
      count = Number(rv.getBigUint64(32, true));
      cdSize = Number(rv.getBigUint64(40, true));
      cdOffset = Number(rv.getBigUint64(48, true));
      cdEnd = rec64At;
    }

    // Data prepended to the archive (self-extractors) shifts every stored offset.
    var shift = cdEnd - (cdOffset + cdSize);
    if (shift < 0 || cdOffset + shift + cdSize > size) throw corrupt(label);

    var cd = await readBytes(blob, cdOffset + shift, cdOffset + shift + cdSize, label);
    var cv = view(cd);
    var entries = [];
    var p = 0;
    while (p + 46 <= cd.length && cv.getUint32(p, true) === SIG_CENTRAL) {
      var flags = cv.getUint16(p + 8, true);
      var method = cv.getUint16(p + 10, true);
      var compSize = cv.getUint32(p + 20, true);
      var uncompSize = cv.getUint32(p + 24, true);
      var nameLen = cv.getUint16(p + 28, true);
      var extraLen = cv.getUint16(p + 30, true);
      var commentLen = cv.getUint16(p + 32, true);
      var offset = cv.getUint32(p + 42, true);
      var nameBytes = cd.subarray(p + 46, p + 46 + nameLen);
      var name = null;

      // Extra fields: ZIP64 sizes/offset (0x0001) and Info-ZIP Unicode path (0x7075).
      var x = p + 46 + nameLen, xEnd = x + extraLen;
      while (x + 4 <= xEnd) {
        var id = cv.getUint16(x, true), len = cv.getUint16(x + 2, true), d = x + 4;
        if (id === 0x0001) {
          if (uncompSize === 0xFFFFFFFF && d + 8 <= x + 4 + len) { uncompSize = Number(cv.getBigUint64(d, true)); d += 8; }
          if (compSize === 0xFFFFFFFF && d + 8 <= x + 4 + len) { compSize = Number(cv.getBigUint64(d, true)); d += 8; }
          if (offset === 0xFFFFFFFF && d + 8 <= x + 4 + len) { offset = Number(cv.getBigUint64(d, true)); }
        } else if (id === 0x7075 && len > 5) {
          name = new TextDecoder('utf-8').decode(cd.subarray(d + 5, x + 4 + len));
        }
        x += 4 + len;
      }
      if (name === null) name = decodeName(nameBytes, (flags & 0x800) !== 0);

      entries.push(nativeEntry(blob, label, {
        name: name, flags: flags, method: method, compSize: compSize,
        size: uncompSize, offset: offset + shift
      }));
      p += 46 + nameLen + extraLen + commentLen;
    }
    if (count > 0 && !entries.length) throw corrupt(label);
    return entries;
  }

  function nativeEntry(blob, label, e) {
    /** The entry's stored (possibly compressed) bytes as a Blob slice. */
    async function stored() {
      if (e.flags & 1) throw corrupt(label);                 // encrypted entry
      if (e.method !== 0 && e.method !== 8) throw corrupt(label); // deflate64/bzip2/lzma: unsupported
      var lh = await readBytes(blob, e.offset, e.offset + 30, label);
      if (lh.length < 30 || view(lh).getUint32(0, true) !== SIG_LOCAL) throw corrupt(label);
      var lv = view(lh);
      var start = e.offset + 30 + lv.getUint16(26, true) + lv.getUint16(28, true);
      var data = blob.slice(start, start + e.compSize);
      if (data.size !== e.compSize) throw corrupt(label);    // truncated archive
      return data;
    }

    /** Inflates (or passes through) the entry and returns it as 'blob' or 'arrayBuffer'. */
    async function extract(as) {
      var data = await stored();
      if (e.method === 0) return as === 'blob' ? data : wrapRead(data.arrayBuffer(), label);
      try {
        var out = new root.Response(data.stream().pipeThrough(new root.DecompressionStream('deflate-raw')));
        return await (as === 'blob' ? out.blob() : out.arrayBuffer());
      } catch (err) {
        if (err && err.name === 'NotReadableError') throw new UTError('READ_FAILED', { name: label });
        if (isOutOfMemory(err)) throw new UTError('TOO_LARGE', { name: label });
        throw corrupt(label);
      }
    }

    return {
      name: e.name,
      dir: /[\\/]$/.test(e.name),
      size: e.size,
      blob: function () { return extract('blob'); },
      bytes: function () { return extract('arrayBuffer').then(function (buf) { return new Uint8Array(buf); }); }
    };
  }

  /* ------------------------------------------------------------------ JSZip fallback */

  var jszipPromise = null;

  function loadJSZip() {
    if (root.JSZip) return Promise.resolve(root.JSZip);
    if (jszipPromise) return jszipPromise;
    var doc = root.document;
    if (!doc) return Promise.reject(new UTError('LOAD_FAILED'));
    jszipPromise = new Promise(function (resolve, reject) {
      var s = doc.createElement('script');
      s.src = api.jszipUrl;
      s.async = true;
      s.onload = function () { if (root.JSZip) resolve(root.JSZip); else fail(); };
      s.onerror = fail;
      function fail() {
        jszipPromise = null; // allow a retry on the next upload
        s.remove();
        reject(new UTError('LOAD_FAILED'));
      }
      doc.head.appendChild(s);
    });
    return jszipPromise;
  }

  async function openZipJSZip(blob, label) {
    if (blob.size > MAX_JSZIP_BYTES) throw new UTError('TOO_LARGE', { name: label });
    var JSZip = await loadJSZip();
    var buf = await wrapRead(blob.arrayBuffer(), label);
    var zip;
    try { zip = await JSZip.loadAsync(buf); } catch (e) {
      throw isOutOfMemory(e) ? new UTError('TOO_LARGE', { name: label }) : corrupt(label);
    }
    var entries = [];
    zip.forEach(function (relPath, f) {
      entries.push({
        name: f.name,
        dir: f.dir,
        size: null, // JSZip exposes no public uncompressed size
        bytes: function () {
          return f.async('uint8array').catch(function (e) {
            throw isOutOfMemory(e) ? new UTError('TOO_LARGE', { name: label }) : corrupt(label);
          });
        },
        blob: function () {
          return f.async('uint8array').then(function (u8) { return new root.Blob([u8]); }, function () { throw corrupt(label); });
        }
      });
    });
    return entries;
  }

  /**
   * Rescue for archives whose end is missing (typically an interrupted download of a big export with media): the
   * central directory at the end is gone, but the local file headers at the start are intact. Walks them from the
   * front and returns every entry that arrived completely. Only used after the normal reader failed, so intact ZIPs
   * never pay for it. Stops at the first entry that was cut off or whose size is only known after its data (flag 8).
   */
  async function openZipSalvage(blob, label) {
    var size = blob.size, entries = [], off = 0;
    while (off + 30 <= size && entries.length < 200000) {
      var head = await readBytes(blob, off, Math.min(size, off + 30 + 1024), label);
      if (head.length < 30) break;
      var hv = view(head);
      if (hv.getUint32(0, true) !== SIG_LOCAL) break;
      var flags = hv.getUint16(6, true), method = hv.getUint16(8, true);
      var compSize = hv.getUint32(18, true), uncompSize = hv.getUint32(22, true);
      var nameLen = hv.getUint16(26, true), extraLen = hv.getUint16(28, true);
      if (flags & 8) break;
      if (30 + nameLen + extraLen > head.length) {
        head = await readBytes(blob, off, off + 30 + nameLen + extraLen, label);
        if (head.length < 30 + nameLen + extraLen) break;
        hv = view(head);
      }
      var name = null, x = 30 + nameLen, xEnd = x + extraLen;
      while (x + 4 <= xEnd) {
        var id = hv.getUint16(x, true), len = hv.getUint16(x + 2, true), d = x + 4;
        if (id === 0x0001) {
          if (uncompSize === 0xFFFFFFFF && d + 8 <= x + 4 + len) { uncompSize = Number(hv.getBigUint64(d, true)); d += 8; }
          if (compSize === 0xFFFFFFFF && d + 8 <= x + 4 + len) { compSize = Number(hv.getBigUint64(d, true)); }
        } else if (id === 0x7075 && len > 5) {
          name = new TextDecoder('utf-8').decode(head.subarray(d + 5, x + 4 + len));
        }
        x += 4 + len;
      }
      if (name === null) name = decodeName(head.subarray(30, 30 + nameLen), (flags & 0x800) !== 0);
      var dataEnd = off + 30 + nameLen + extraLen + compSize;
      if (dataEnd > size) break; // this entry was cut off: everything after it is missing too
      entries.push(nativeEntry(blob, label, {
        name: name, flags: flags, method: method, compSize: compSize, size: uncompSize, offset: off
      }));
      off = dataEnd;
    }
    return entries;
  }

  /** Lists a ZIP's entries; an archive the readers reject is handed to the rescue reader (openZipSalvage). */
  async function openZip(blob, label, backend) {
    try {
      return await openZipIntact(blob, label, backend);
    } catch (err) {
      if (!UT.isUTError(err) || err.code !== 'CORRUPT_ZIP' || !nativeZipSupported()) throw err;
      var rescued = null;
      try { rescued = await openZipSalvage(blob, label); } catch (e) { rescued = null; }
      if (!rescued || !rescued.some(function (e) { return !e.dir; })) throw err;
      rescued.salvaged = true;
      return rescued;
    }
  }

  /** Lists a ZIP's entries, natively when possible and via JSZip otherwise. */
  async function openZipIntact(blob, label, backend) {
    if (backend === 'jszip' || !nativeZipSupported()) return openZipJSZip(blob, label);
    try {
      return await openZipNative(blob, label);
    } catch (err) {
      // Give unusual-but-valid archives a second chance with JSZip; keep the original error
      // when that fails as well (or cannot run because of the size limit).
      if (!UT.isUTError(err) || err.code !== 'CORRUPT_ZIP' || blob.size > MAX_JSZIP_BYTES) throw err;
      try { return await openZipJSZip(blob, label); } catch (e2) { throw err; }
    }
  }

  /* ------------------------------------------------------------------ FileSet */

  var pathCollator = new Intl.Collator('en', { numeric: true });

  function createFileSet() {
    var map = new Map();
    var sources = [];
    var skipped = [];
    var recovered = []; // ZIPs read by the rescue reader (their end was missing)
    var totalBytes = 0;

    /** Adds a file; a same-path/same-size duplicate (same export uploaded twice) is ignored. */
    function add(path, size, bytes, sourceName) {
      var existing = map.get(path);
      if (existing) {
        if (existing.size === size) return;
        var base = sourceName.replace(/\.zip$/i, '') + '/' + path;
        path = base;
        for (var n = 2; map.has(path); n++) path = base + ' (' + n + ')';
      }
      map.set(path, { size: size, bytes: bytes });
    }

    function build() {
      var paths = Array.from(map.keys()).sort(pathCollator.compare);
      return {
        paths: paths,
        sourceNames: sources.slice(),
        totalBytes: totalBytes,
        skipped: skipped.slice(),
        recovered: recovered.slice(),
        has: function (re) {
          return paths.filter(function (p) { re.lastIndex = 0; return re.test(p); });
        },
        read: function (path) {
          var f = map.get(path);
          if (!f) return Promise.reject(new UTError('CORRUPT_FILE', { file: path }));
          if (f.size != null && f.size > MAX_TEXT_BYTES) return Promise.reject(new UTError('TOO_LARGE', { name: path }));
          return f.bytes().then(function (bytes) {
            if (bytes.length > MAX_TEXT_BYTES) throw new UTError('TOO_LARGE', { name: path });
            return decodeText(bytes);
          });
        }
      };
    }

    return {
      add: add, build: build,
      source: function (name, size) { sources.push(name); totalBytes += size; },
      skip: function (name) { skipped.push(name); },
      recover: function (name) { recovered.push(name); },
      get size() { return map.size; }
    };
  }

  /**
   * 'zip' | 'text' | null: ZIP magic bytes or a .zip name (the reader then decides whether it
   * really is one, which also covers self-extracting archives), else a text file extension.
   */
  async function sniff(file) {
    var head = await readBytes(file, 0, 4, file.name);
    if (head[0] === 0x50 && head[1] === 0x4B && (head[2] === 3 || head[2] === 5 || head[2] === 7)) return 'zip';
    if (ZIP_EXT.test(file.name)) return 'zip';
    return TEXT_EXT.test(file.name) ? 'text' : null;
  }

  async function addZip(set, blob, label, sourceName, nested, backend, onProgress) {
    onProgress({ stage: 'zip', name: label });
    var entries = await openZip(blob, label, backend);
    if (entries.salvaged) set.recover(label);
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (e.dir) continue;
      var path = normalizePath(e.name);
      if (!path) continue;
      if (ZIP_EXT.test(path)) {
        if (nested) continue; // only one level of ZIP-in-ZIP
        if (e.size != null && e.size > MAX_NESTED_ZIP_BYTES) throw new UTError('TOO_LARGE', { name: path });
        await addZip(set, await e.blob(), path, sourceName, true, backend, onProgress);
      } else if (TEXT_EXT.test(path)) {
        set.add(path, e.size, e.bytes, sourceName);
      }
    }
  }

  /**
   * @param {FileList|File[]} list
   * @param {{onProgress?: function({stage:'file'|'zip', name:string}), backend?: 'native'|'jszip'}} [opts]
   *        backend forces a ZIP implementation (tests); leave it unset in production.
   * @returns {Promise<FileSet>}
   */
  async function fromFileList(list, opts) {
    opts = opts || {};
    var onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : function () {};
    var files = Array.prototype.slice.call(list || []).filter(function (f) { return f && f.size > 0; });
    if (!files.length) throw new UTError('EMPTY_UPLOAD');

    var set = createFileSet();
    var sawZip = false;
    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      // Files collected from a dropped folder carry their relative path (see ut-app.js).
      var rel = file.utRelativePath || file.webkitRelativePath || file.name;
      set.source(file.name, file.size);
      // Photos, videos etc. are skipped unread. Files without an extension are sniffed, because
      // some mobile browsers save the export ZIP without ".zip".
      if (!isRelevantName(rel) && /\.[a-z0-9]{1,5}$/i.test(file.name)) { set.skip(file.name); continue; }
      onProgress({ stage: 'file', name: file.name });
      var kind = await sniff(file);
      if (kind === 'zip') {
        sawZip = true;
        await addZip(set, file, file.name, file.name, false, opts.backend, onProgress);
      } else if (kind === 'text') {
        var path = normalizePath(rel);
        if (path) set.add(path, file.size, readWhole(file), file.name);
      } else {
        set.skip(file.name);
      }
    }
    if (!set.size && !sawZip) {
      var skippedName = set.build().skipped[0];
      if (skippedName) throw new UTError('UNSUPPORTED_FILE', { name: skippedName });
    }
    return set.build();
  }

  function readWhole(file) {
    return function () { return readBytes(file, 0, file.size, file.name); };
  }

  /** True on phones and tablets (small memory budget per tab). */
  function isMobileDevice() {
    var nav = root.navigator || {};
    if (nav.userAgentData && nav.userAgentData.mobile) return true;
    var ua = String(nav.userAgent || '');
    if (/Android|iPhone|iPad|iPod|Mobi/i.test(ua)) return true;
    if (/Macintosh/.test(ua) && nav.maxTouchPoints > 1) return true; // iPadOS reports a Mac UA
    try { return !!(root.matchMedia && root.matchMedia('(pointer: coarse)').matches && nav.maxTouchPoints > 0); } catch (e) { return false; }
  }

  /**
   * Total size of the selection when it is big enough to warn about before reading it
   * (> 1.5 GB on a mobile device), else 0.
   */
  function largeUploadBytes(list, mobile) {
    var total = 0;
    Array.prototype.forEach.call(list || [], function (f) { total += (f && f.size) || 0; });
    return mobile && total > MOBILE_WARN_BYTES ? total : 0;
  }

  var api = {
    fromFileList: fromFileList,
    isMobileDevice: isMobileDevice,
    largeUploadBytes: largeUploadBytes,
    MOBILE_WARN_BYTES: MOBILE_WARN_BYTES,
    MAX_JSZIP_BYTES: MAX_JSZIP_BYTES,
    isRelevantName: isRelevantName,
    jszipUrl: scriptBase + 'vendor/jszip.min.js?v=3.10.1',
    // Exposed for unit tests only.
    _internal: { normalizePath: normalizePath }
  };
  UT.files = api;
  return api;
});
