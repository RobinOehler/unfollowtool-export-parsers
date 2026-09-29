'use strict';
// Unit tests for UT.csv (RFC 4180 quoting + spreadsheet formula neutralisation).
const test = require('node:test');
const assert = require('node:assert/strict');
const UT = require('../../src/ut-core.js');

test('cells are always quoted and embedded quotes doubled', () => {
  assert.equal(UT.csv.cell('abc'), '"abc"');
  assert.equal(UT.csv.cell('a "b", c'), '"a ""b"", c"');
  assert.equal(UT.csv.cell('line1\nline2'), '"line1\nline2"');
  assert.equal(UT.csv.cell(null), '""');
  assert.equal(UT.csv.cell(undefined), '""');
  assert.equal(UT.csv.cell(42), '"42"');
});

test('formula-like cells get a leading apostrophe', () => {
  for (const s of ['=HYPERLINK("http://evil","x")', '+cmd|x', '-2+3', '@SUM(A1)', '\tx', '\rx']) {
    assert.equal(UT.csv.cell(s), '"\'' + s.replace(/"/g, '""') + '"', JSON.stringify(s));
  }
  // Only the first character matters.
  assert.equal(UT.csv.cell('a=b'), '"a=b"');
  assert.equal(UT.csv.cell('2024-01-01'), '"2024-01-01"');
});

test('build adds a UTF-8 BOM, a header and CRLF line endings', () => {
  const out = UT.csv.build(['Username', 'Name'], [['jürgen', '=1+1'], ['x', 'Ann "A"']]);
  assert.ok(out.startsWith('\uFEFF'));
  const lines = out.slice(1).split('\r\n');
  assert.deepEqual(lines, ['"Username","Name"', '"jürgen","\'=1+1"', '"x","Ann ""A"""', '']);
});

test('build with no rows still yields the header', () => {
  assert.equal(UT.csv.build(['A'], []), '\uFEFF"A"\r\n');
});
