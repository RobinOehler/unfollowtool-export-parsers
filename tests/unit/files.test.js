'use strict';
// Unit tests for src/ut-files.js. ZIPs are generated in memory with JSZip; both the
// native reader (DecompressionStream) and the JSZip fallback are exercised.
const test = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');
const UT = require('../../src/ut-core.js');
require('../../src/ut-files.js');

globalThis.JSZip = JSZip; // the fallback normally lazy-loads it with a <script> tag

const BACKENDS = ['native', 'jszip'];
const enc = (s) => new TextEncoder().encode(s);

async function zipFile(name, entries, opts = {}) {
  const zip = new JSZip();
  for (const [p, content] of Object.entries(entries)) {
    if (content === null) zip.folder(p);
    else zip.file(p, content, opts.fileOpts);
  }
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: opts.compression || 'DEFLATE' });
  return new File([opts.prefix ? Buffer.concat([opts.prefix, bytes]) : bytes], name);
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, (e) => { assert.equal(e.code, code, e.stack); return true; });
}

const IG = {
  'connections/followers_and_following/followers_1.json': '[{"string_list_data":[{"value":"a"}]}]',
  'connections/followers_and_following/following.json': '{"relationships_following":[]}',
  'media/posts/202401/photo.jpg': new Uint8Array([0xff, 0xd8, 0xff]),
  'your_instagram_activity/': null
};

for (const backend of BACKENDS) {
  test(`[${backend}] reads a ZIP, lists text files only and decodes them`, async () => {
    const fs = await UT.files.fromFileList([await zipFile('instagram-x.zip', IG)], { backend });
    assert.deepEqual(fs.paths, [
      'connections/followers_and_following/followers_1.json',
      'connections/followers_and_following/following.json'
    ]);
    assert.equal(await fs.read('connections/followers_and_following/following.json'), '{"relationships_following":[]}');
    assert.deepEqual(fs.has(/followers_\d+\.json$/g), ['connections/followers_and_following/followers_1.json']);
    assert.deepEqual(fs.has(/followers_\d+\.json$/g), ['connections/followers_and_following/followers_1.json'], 'global regex reusable');
    assert.deepEqual(fs.sourceNames, ['instagram-x.zip']);
    assert.ok(fs.totalBytes > 0);
  });

  test(`[${backend}] strips __MACOSX, ._ files, .DS_Store, leading ./ and wrapper folders stay`, async () => {
    const f = await zipFile('re-zipped.zip', {
      'export/connections/followers_and_following/followers_1.json': '[]',
      '__MACOSX/export/connections/._followers_1.json': 'junk',
      'export/._following.json': 'junk',
      'export/.DS_Store': 'junk',
      './export/data.txt': 'hello'
    });
    const fs = await UT.files.fromFileList([f], { backend });
    assert.deepEqual(fs.paths, ['export/connections/followers_and_following/followers_1.json', 'export/data.txt']);
  });

  test(`[${backend}] strips UTF-8 BOM and decodes UTF-16 with BOM`, async () => {
    const utf16 = new Uint8Array([0xff, 0xfe, ...Buffer.from('Hi ü', 'utf16le')]);
    const f = await zipFile('bom.zip', {
      'a.json': new Uint8Array([0xef, 0xbb, 0xbf, ...enc('{"x":"ä"}')]),
      'b.txt': utf16
    });
    const fs = await UT.files.fromFileList([f], { backend });
    assert.equal(await fs.read('a.json'), '{"x":"ä"}');
    assert.equal(await fs.read('b.txt'), 'Hi ü');
  });

  test(`[${backend}] unpacks a ZIP inside the ZIP one level deep`, async () => {
    const inner = await zipFile('inner.zip', { 'data/follower.js': 'window.YTD.follower.part0 = []' });
    const innermost = await zipFile('deeper.zip', { 'deep.json': '{}' });
    const inner2 = await zipFile('inner2.zip', { 'x/deeper.zip': new Uint8Array(await innermost.arrayBuffer()) });
    const outer = await zipFile('outer.zip', {
      'twitter-archive.zip': new Uint8Array(await inner.arrayBuffer()),
      'nested/second.zip': new Uint8Array(await inner2.arrayBuffer()),
      'readme.txt': 'x'
    });
    const fs = await UT.files.fromFileList([outer], { backend });
    assert.deepEqual(fs.paths, ['data/follower.js', 'readme.txt']);
    assert.equal(await fs.read('data/follower.js'), 'window.YTD.follower.part0 = []');
  });

  test(`[${backend}] stored (uncompressed) entries`, async () => {
    const f = await zipFile('stored.zip', { 'a/b.json': '{"stored":true}' }, { compression: 'STORE' });
    const fs = await UT.files.fromFileList([f], { backend });
    assert.equal(await fs.read('a/b.json'), '{"stored":true}');
  });
}

test('merges several ZIPs; identical duplicates collapse, conflicting paths are prefixed', async () => {
  const p1 = await zipFile('part1.zip', { 'connections/followers_1.json': '[1]', 'shared/info.json': '{"same":1}' });
  const p2 = await zipFile('part2.zip', { 'connections/followers_2.json': '[2]', 'shared/info.json': '{"same":1}', 'x/conflict.json': 'AAAA' });
  const p3 = await zipFile('part3.zip', { 'x/conflict.json': 'BB' });
  const fs = await UT.files.fromFileList([p1, p2, p3]);
  assert.deepEqual(fs.paths, [
    'connections/followers_1.json', 'connections/followers_2.json', 'part3/x/conflict.json', 'shared/info.json', 'x/conflict.json'
  ]);
  assert.equal(await fs.read('part3/x/conflict.json'), 'BB');
  assert.equal(await fs.read('x/conflict.json'), 'AAAA');
  assert.deepEqual(fs.sourceNames, ['part1.zip', 'part2.zip', 'part3.zip']);
});

test('paths are sorted naturally (followers_2 before followers_10)', async () => {
  const f = await zipFile('n.zip', { 'f/followers_10.json': '[]', 'f/followers_2.json': '[]', 'f/followers_1.json': '[]' });
  assert.deepEqual((await UT.files.fromFileList([f])).paths, ['f/followers_1.json', 'f/followers_2.json', 'f/followers_10.json']);
});

test('loose JSON/JS/HTML/TXT files, Windows paths and folder-relative paths', async () => {
  const a = new File(['\uFEFF[]'], 'followers_1.json');
  const b = new File(['{}'], 'following.json');
  const c = new File(['x'], 'follower.js');
  c.utRelativePath = 'my export\\data\\follower.js';
  const photo = new File([new Uint8Array([1, 2, 3])], 'IMG_0001.JPG');
  const fs = await UT.files.fromFileList([a, b, c, photo]);
  assert.deepEqual(fs.paths, ['followers_1.json', 'following.json', 'my export/data/follower.js']);
  assert.equal(await fs.read('followers_1.json'), '[]');
  assert.deepEqual(fs.skipped, ['IMG_0001.JPG']);
});

test('a ZIP without .zip extension is recognized by its magic bytes', async () => {
  const z = await zipFile('instagram-export', { 'a.json': '{}' });
  const fs = await UT.files.fromFileList([new File([await z.arrayBuffer()], 'instagram-export')]);
  assert.deepEqual(fs.paths, ['a.json']);
});

test('media files are skipped without being read', async () => {
  const video = new File([new Uint8Array(10)], 'clip.mp4');
  video.slice = () => { throw new Error('media must not be read'); };
  const json = new File(['{}'], 'a.json');
  const fs = await UT.files.fromFileList([video, json]);
  assert.deepEqual(fs.paths, ['a.json']);
});

test('macOS NFD file names are normalized to NFC', async () => {
  const f = await zipFile('nfd.zip', { ['Me\u0301dia/a.json']: '{}' });
  assert.deepEqual((await UT.files.fromFileList([f])).paths, ['M\u00e9dia/a.json']);
});

test('normalizePath', () => {
  const n = UT.files._internal.normalizePath;
  assert.equal(n('.\\a\\b\\c.json'), 'a/b/c.json');
  assert.equal(n('/a//b/./c.json'), 'a/b/c.json');
  assert.equal(n('../../etc/passwd'), 'etc/passwd');
  assert.equal(n('__MACOSX/a/b.json'), null);
  assert.equal(n('a/._b.json'), null);
  assert.equal(n('a/Thumbs.db'), null);
  assert.equal(n('dir/'), 'dir');
  assert.equal(n(''), null);
});

test('errors: empty upload, unsupported file, corrupt ZIP, fake .zip, truncated ZIP', async () => {
  await rejectsCode(UT.files.fromFileList([]), 'EMPTY_UPLOAD');
  await rejectsCode(UT.files.fromFileList(null), 'EMPTY_UPLOAD');
  await rejectsCode(UT.files.fromFileList([new File([], 'empty.zip')]), 'EMPTY_UPLOAD');
  await rejectsCode(UT.files.fromFileList([new File(['%PDF-1.4'], 'doc.pdf')]), 'UNSUPPORTED_FILE');
  await rejectsCode(UT.files.fromFileList([new File(['<html>error</html>'], 'download.zip')]), 'CORRUPT_ZIP');

  const good = new Uint8Array(await (await zipFile('t.zip', { 'a.json': '{"a":1}'.repeat(500) })).arrayBuffer());
  await rejectsCode(UT.files.fromFileList([new File([good.slice(0, good.length - 40)], 't.zip')]), 'CORRUPT_ZIP');
  await rejectsCode(UT.files.fromFileList([new File([good.slice(0, 60)], 't.zip')]), 'CORRUPT_ZIP');
});

test('a damaged deflate stream fails on read with CORRUPT_ZIP', async () => {
  const noisy = Array.from({ length: 4000 }, (_, i) => String.fromCharCode(97 + ((i * 7919) % 26))).join('');
  const bytes = new Uint8Array(await (await zipFile('d.zip', { 'a.json': JSON.stringify({ v: noisy }) })).arrayBuffer());
  for (let i = 60; i < 90; i++) bytes[i] ^= 0xff; // inside the compressed data of the only entry
  const fs = await UT.files.fromFileList([new File([bytes], 'd.zip')]);
  await rejectsCode(fs.read('a.json'), 'CORRUPT_ZIP');
  await rejectsCode(fs.read('does/not/exist.json'), 'CORRUPT_FILE');
});

test('an archive with data prepended (self-extractor) still opens natively', async () => {
  const f = await zipFile('sfx.zip', { 'a.json': '{"sfx":1}' }, { prefix: Buffer.alloc(1000, 7) });
  const fs = await UT.files.fromFileList([f], { backend: 'native' });
  assert.equal(await fs.read('a.json'), '{"sfx":1}');
});

test('ZIP64 archives are read by the native reader', async () => {
  const fs = await UT.files.fromFileList([new File([zip64Stored('data/following.js', 'window.YTD.following.part0 = []')], 'big.zip')], { backend: 'native' });
  assert.deepEqual(fs.paths, ['data/following.js']);
  assert.equal(await fs.read('data/following.js'), 'window.YTD.following.part0 = []');
});

test('reads failing at the OS level surface as READ_FAILED', async () => {
  const f = new File(['{}'], 'a.json');
  f.slice = () => ({ arrayBuffer: () => Promise.reject(Object.assign(new Error('gone'), { name: 'NotReadableError' })) });
  await rejectsCode(UT.files.fromFileList([f]), 'READ_FAILED');
});

test('onProgress reports files and ZIPs', async () => {
  const seen = [];
  await UT.files.fromFileList([await zipFile('p.zip', { 'a.json': '{}' })], { onProgress: (p) => seen.push(p.stage + ':' + p.name) });
  assert.deepEqual(seen, ['file:p.zip', 'zip:p.zip']);
});

test('isRelevantName', () => {
  assert.equal(UT.files.isRelevantName('a/b/followers_1.json'), true);
  assert.equal(UT.files.isRelevantName('Your archive.html'), true);
  assert.equal(UT.files.isRelevantName('export.ZIP'), true);
  assert.equal(UT.files.isRelevantName('photo.heic'), false);
  assert.equal(UT.files.isRelevantName('._followers_1.json'), false);
});

/** Minimal single-entry, stored ZIP64 archive (all sizes/offsets in ZIP64 fields). */
function zip64Stored(name, text) {
  const nameB = Buffer.from(name);
  const data = Buffer.from(text);
  const crc = crc32(data);
  const local = Buffer.alloc(30 + nameB.length + 20);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(45, 4); local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(0xffffffff, 18); local.writeUInt32LE(0xffffffff, 22);
  local.writeUInt16LE(nameB.length, 26); local.writeUInt16LE(20, 28); nameB.copy(local, 30);
  const lx = 30 + nameB.length;
  local.writeUInt16LE(1, lx); local.writeUInt16LE(16, lx + 2);
  local.writeBigUInt64LE(BigInt(data.length), lx + 4); local.writeBigUInt64LE(BigInt(data.length), lx + 12);

  const central = Buffer.alloc(46 + nameB.length + 28);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(45, 4); central.writeUInt16LE(45, 6);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(0xffffffff, 20); central.writeUInt32LE(0xffffffff, 24);
  central.writeUInt16LE(nameB.length, 28); central.writeUInt16LE(28, 30); central.writeUInt32LE(0xffffffff, 42);
  nameB.copy(central, 46);
  const cx = 46 + nameB.length;
  central.writeUInt16LE(1, cx); central.writeUInt16LE(24, cx + 2);
  central.writeBigUInt64LE(BigInt(data.length), cx + 4); central.writeBigUInt64LE(BigInt(data.length), cx + 12);
  central.writeBigUInt64LE(0n, cx + 20);

  const cdOffset = local.length + data.length;
  const eocd64 = Buffer.alloc(56);
  eocd64.writeUInt32LE(0x06064b50, 0); eocd64.writeBigUInt64LE(44n, 4); eocd64.writeUInt16LE(45, 12); eocd64.writeUInt16LE(45, 14);
  eocd64.writeBigUInt64LE(1n, 24); eocd64.writeBigUInt64LE(1n, 32);
  eocd64.writeBigUInt64LE(BigInt(central.length), 40); eocd64.writeBigUInt64LE(BigInt(cdOffset), 48);
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0); locator.writeBigUInt64LE(BigInt(cdOffset + central.length), 8); locator.writeUInt32LE(1, 16);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0xffff, 8); eocd.writeUInt16LE(0xffff, 10);
  eocd.writeUInt32LE(0xffffffff, 12); eocd.writeUInt32LE(0xffffffff, 16);
  return Buffer.concat([local, data, central, eocd64, locator, eocd]);
}

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

// Regression (old site: >2 GB exports failed with a generic "permission problems" error).
test('huge ZIPs and out-of-memory reads surface as TOO_LARGE, not a generic error', async () => {
  const GB = 1024 * 1024 * 1024;
  const big = await zipFile('instagram-huge.zip', { 'a.json': '{}' });
  Object.defineProperty(big, 'size', { value: 2.5 * GB });
  await rejectsCode(UT.files.fromFileList([big], { backend: 'jszip' }), 'TOO_LARGE');

  // A browser that cannot allocate the buffer throws RangeError ("Array buffer allocation failed").
  const oom = await zipFile('instagram-oom.zip', { 'a.json': '{}' });
  const realSlice = oom.slice.bind(oom);
  oom.slice = (start, end) => (end - start === 4 ? realSlice(start, end)
    : { arrayBuffer: () => Promise.reject(new RangeError('Array buffer allocation failed')) });
  oom.arrayBuffer = () => Promise.reject(new RangeError('Array buffer allocation failed')); // JSZip reads the whole file
  for (const backend of BACKENDS) await rejectsCode(UT.files.fromFileList([oom], { backend }), 'TOO_LARGE');

  const loose = new File(['{}'], 'followers_1.json');
  const looseSlice = loose.slice.bind(loose);
  loose.slice = (start, end) => (end - start === 4 ? looseSlice(start, end)
    : { arrayBuffer: () => Promise.reject(new RangeError('Array buffer allocation failed')) });
  const fs = await UT.files.fromFileList([loose]);
  await rejectsCode(fs.read('followers_1.json'), 'TOO_LARGE');
});

test('largeUploadBytes warns only on mobile above 1.5 GB', () => {
  const GB = 1024 * 1024 * 1024;
  const files = [{ size: 1 * GB }, { size: 0.6 * GB }];
  assert.equal(UT.files.largeUploadBytes(files, true), 1.6 * GB);
  assert.equal(UT.files.largeUploadBytes(files, false), 0);
  assert.equal(UT.files.largeUploadBytes([{ size: 1.4 * GB }], true), 0);
  assert.equal(UT.files.largeUploadBytes([], true), 0);
  assert.equal(typeof UT.files.isMobileDevice(), 'boolean');
});
