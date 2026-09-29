'use strict';
// Unit tests for src/ut-core.js (errors, URL validation, debounce).
const test = require('node:test');
const assert = require('node:assert/strict');
const UT = require('../../src/ut-core.js');

test('UTError carries code and params and is an Error', () => {
  const e = new UT.UTError('CORRUPT_FILE', { file: 'a.json' });
  assert.ok(e instanceof Error);
  assert.ok(e instanceof UT.UTError);
  assert.equal(e.name, 'UTError');
  assert.equal(e.code, 'CORRUPT_FILE');
  assert.deepEqual(e.params, { file: 'a.json' });
  assert.deepEqual(new UT.UTError('EMPTY_UPLOAD').params, {});
});

test('isUTError accepts shape-compatible errors from parsers loaded without core', () => {
  const plain = Object.assign(new Error('X'), { name: 'UTError', code: 'EMPTY_LISTS' });
  assert.equal(UT.isUTError(plain), true);
  assert.equal(UT.isUTError(new Error('boom')), false);
  assert.equal(UT.isUTError(null), false);
});

test('safeProfileUrl only allows https on the platform host', () => {
  assert.equal(UT.safeProfileUrl('instagram', 'https://www.instagram.com/abc'), 'https://www.instagram.com/abc');
  assert.equal(UT.safeProfileUrl('instagram', 'https://instagram.com/_u/abc'), 'https://instagram.com/_u/abc');
  assert.equal(UT.safeProfileUrl('x', 'https://twitter.com/intent/user?user_id=1'), 'https://twitter.com/intent/user?user_id=1');
  assert.equal(UT.safeProfileUrl('tiktok', 'https://www.tiktok.com/@a.b'), 'https://www.tiktok.com/@a.b');
  const bad = [
    ['instagram', 'http://www.instagram.com/abc'],
    ['instagram', 'javascript:alert(1)'],
    ['instagram', 'https://evil.example/instagram.com'],
    ['instagram', 'https://www.instagram.com.evil.example/x'],
    ['instagram', 'https://user:pw@www.instagram.com/x'],
    ['instagram', 'https://www.instagram.com:8443/x'],
    ['instagram', 'https://www.tiktok.com/@abc'],   // wrong platform
    ['facebook', 'https://evil.example/login'],
    ['facebook', ''],
    ['facebook', null],
    ['nope', 'https://www.instagram.com/abc']
  ];
  for (const [p, u] of bad) assert.equal(UT.safeProfileUrl(p, u), null, `${p} ${u}`);
});

test('profileUrl builds links only from valid handles', () => {
  assert.equal(UT.profileUrl('instagram', 'john.doe_1'), 'https://www.instagram.com/john.doe_1/');
  assert.equal(UT.profileUrl('tiktok', '@dancer'), 'https://www.tiktok.com/@dancer');
  assert.equal(UT.profileUrl('x', '12345'), 'https://x.com/i/user/12345');
  assert.equal(UT.profileUrl('x', 'jack'), 'https://x.com/jack');
  assert.equal(UT.profileUrl('instagram', '<img src=x>'), null);
  assert.equal(UT.profileUrl('instagram', 'a/../b'), null);
  assert.equal(UT.profileUrl('facebook', 'John Smith'), null);
  assert.equal(UT.profileUrl('instagram', null), null);
});

test('debounce calls once with the last arguments', async () => {
  const calls = [];
  const fn = UT.debounce((v) => calls.push(v), 20);
  fn(1); fn(2); fn(3);
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(calls, [3]);
});

test('UT.parsers registry exists', () => {
  assert.equal(typeof UT.parsers, 'object');
});
