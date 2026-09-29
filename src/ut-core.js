/*!
 * unfollowtool.com – runtime core (window.UT)
 *
 * Shared, DOM-free helpers used by every other runtime file:
 *   UT.UTError           error with a stable code → runtime.json "error.<CODE>"
 *   UT.PLATFORMS         per-platform profile hosts and URL builders
 *   UT.safeProfileUrl()  validates a profile URL (https + the platform's own host only)
 *   UT.profileUrl()      builds a profile URL from a username / account id
 *   UT.csv               RFC 4180 CSV with spreadsheet-formula neutralisation
 *   UT.debounce()
 *
 * UMD: in the browser this creates/extends window.UT; in Node it is module.exports, and the
 * other ut-*.js files require() it so that they all share one UT object.
 */
(function (root, factory) {
  'use strict';
  var UT = factory(root.UT || {});
  if (typeof module === 'object' && module.exports) module.exports = UT;
  else root.UT = UT;
})(typeof self !== 'undefined' ? self : globalThis, function (UT) {
  'use strict';

  /* ------------------------------------------------------------------ errors */

  /**
   * Error with a machine-readable code. The UI shows t('error.' + code, params).
   * @param {string} code   e.g. 'CORRUPT_ZIP'
   * @param {object} [params] placeholder values for the message
   */
  class UTError extends Error {
    constructor(code, params = {}) {
      super(code);
      this.name = 'UTError';
      this.code = code;
      this.params = params || {};
    }
  }

  /** True for UTError instances and for shape-compatible errors thrown by parsers without core. */
  function isUTError(err) {
    return !!err && (err instanceof UTError || (err.name === 'UTError' && typeof err.code === 'string'));
  }

  /* ------------------------------------------------------------------ platforms */

  // Profile links are only ever created for these hosts (see README.md → Security).
  var PLATFORMS = {
    instagram: {
      hosts: ['instagram.com', 'www.instagram.com', 'm.instagram.com'],
      handle: /^[a-z0-9._]{1,30}$/i,
      build: function (h) { return 'https://www.instagram.com/' + h + '/'; }
    },
    tiktok: {
      hosts: ['tiktok.com', 'www.tiktok.com', 'm.tiktok.com'],
      handle: /^[a-z0-9._]{1,24}$/i,
      build: function (h) { return 'https://www.tiktok.com/@' + h; }
    },
    x: {
      hosts: ['x.com', 'www.x.com', 'mobile.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com'],
      handle: /^[a-z0-9_]{1,15}$/i,
      id: /^\d{1,20}$/,
      build: function (h) { return 'https://x.com/' + h; },
      buildId: function (id) { return 'https://x.com/i/user/' + id; }
    },
    facebook: {
      hosts: ['facebook.com', 'www.facebook.com', 'm.facebook.com'],
      handle: /^[a-z0-9.]{5,50}$/i,
      build: function (h) { return 'https://www.facebook.com/' + h; }
    }
  };

  /**
   * Returns the URL as a normalized string when it is an https URL on the platform's own host
   * without credentials; otherwise null (the UI then shows no link).
   */
  function safeProfileUrl(platform, url) {
    var p = PLATFORMS[platform];
    if (!p || typeof url !== 'string' || !url) return null;
    var u;
    try { u = new URL(url); } catch (e) { return null; }
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
    if (p.hosts.indexOf(u.hostname.toLowerCase()) === -1) return null;
    return u.href;
  }

  /**
   * Builds a profile URL for a username (or, for X, a numeric account id). Returns null when the
   * value does not look like a valid handle, so garbage never becomes a link.
   */
  function profileUrl(platform, handle) {
    var p = PLATFORMS[platform];
    if (!p || handle == null) return null;
    var h = String(handle).replace(/^@/, '');
    if (p.id && p.id.test(h)) return p.buildId(h);
    return p.handle.test(h) ? p.build(h) : null;
  }

  /* ------------------------------------------------------------------ csv */

  // Cells starting with one of these are interpreted as formulas by Excel/LibreOffice/Sheets.
  var FORMULA_START = /^[=+\-@\t\r]/;

  /** One CSV cell: formula-neutralised with a leading apostrophe, always quoted (RFC 4180). */
  function csvCell(value) {
    var s = value == null ? '' : String(value);
    if (FORMULA_START.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }

  /**
   * Builds a complete CSV document: UTF-8 BOM (so Excel detects UTF-8), CRLF line endings.
   * @param {string[]} header
   * @param {Array<Array<*>>} rows
   */
  function csvBuild(header, rows) {
    var lines = [header.map(csvCell).join(',')];
    for (var i = 0; i < rows.length; i++) lines.push(rows[i].map(csvCell).join(','));
    return '\uFEFF' + lines.join('\r\n') + '\r\n';
  }

  /* ------------------------------------------------------------------ misc */

  function debounce(fn, ms) {
    var timer = null;
    return function () {
      var self = this, args = arguments;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }

  UT.UTError = UTError;
  UT.isUTError = isUTError;
  UT.PLATFORMS = PLATFORMS;
  UT.safeProfileUrl = safeProfileUrl;
  UT.profileUrl = profileUrl;
  UT.csv = { cell: csvCell, build: csvBuild };
  UT.debounce = debounce;
  UT.parsers = UT.parsers || {};
  return UT;
});
