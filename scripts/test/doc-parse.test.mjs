import test from 'node:test';
import assert from 'node:assert/strict';
import { driftIssueBody } from '../drift-issue-body.mjs';
import { parsePipeTables, parseLayoutTables, parseTables, parseDocMeta, splitVariants, looksLikeDefault, platformsFromLabel } from '../lib/doc-parse.mjs';

const TRACKED = ['em/initial_size_MB', 'em/max_size_MB', 'ztta/roll_extension', 'abap/heap_area_total', 'rdisp/PG_SHM', 'abap/heap_area_nondia', 'PHYS_MEMSIZE'];
const sorted = (a) => [...a].sort().join('/');

test('looksLikeDefault: formulas and numbers yes, prose no', () => {
  for (const ok of ['(min(512000, $(PHYS_MEMSIZE) * 0.7))', '4000000000', '[PM] * 1.5', '$(PHYS_MEMSIZE) * 1024 * 1024', '20000 (100000 on 64 bit)', '0'])
    assert.ok(looksLikeDefault(ok), ok);
  for (const no of ['Specifies the size of the EM', 'Size of the main memory (RAM)', '', 'see note 88416']) assert.ok(!looksLikeDefault(no), no);
});

test('splitVariants: <br> pieces and adjacent parenthesised groups', () => {
  assert.deepEqual(splitVariants('4000000000 <br> 2000000000'), ['4000000000', '2000000000']);
  assert.deepEqual(splitVariants('(min(512000, $(PHYS_MEMSIZE) * 1.5)) ($(em/initial_size_MB))'), ['(min(512000, $(PHYS_MEMSIZE) * 1.5))', '($(em/initial_size_MB))']);
  assert.deepEqual(splitVariants('Specifies how much'), []);
});

test('pipe table: 5 columns, multiple variants, restriction groups aligned; "*" operators survive', () => {
  const md = `| Profile Parameter | Description | Default value | Unit | Restrictions |
|---|---|---|---|---|
| em/initial_size_MB | **Initial** size | (min(512000, $(PHYS_MEMSIZE) * 0.7)) | MB | |
| ztta/roll_extension | EM quota | 4000000000 <br> 2000000000 | bytes | Linux <br> UNIX, Windows, AIX |
| abap/heap_area_nondia | priv | 2000000000 <br> 0 | bytes | UNIX, Linux, AIX <br> Windows |
| rdisp/PG_SHM | paging | (min(1000+40*max(5,floor(($(PHYS_MEMSIZE)-128)/20)),256000)) | 8K | |
| PHYS_MEMSIZE | prose only | Size of the main memory (RAM) | MB | |
| some/untracked | x | 123 | | |`;
  const rows = Object.fromEntries(parsePipeTables(md, TRACKED).map((r) => [r.param, r.variants]));
  assert.equal(rows['em/initial_size_MB'][0].expr, '(min(512000, $(PHYS_MEMSIZE) * 0.7))');
  assert.equal(rows['rdisp/PG_SHM'][0].expr, '(min(1000+40*max(5,floor(($(PHYS_MEMSIZE)-128)/20)),256000))');
  assert.deepEqual(rows['ztta/roll_extension'].map((v) => [v.expr, sorted(v.platforms)]), [['4000000000', 'linux'], ['2000000000', 'aix/unix/windows']]);
  assert.deepEqual(rows['abap/heap_area_nondia'].map((v) => [v.expr, sorted(v.platforms)]), [['2000000000', 'aix/linux/unix'], ['0', 'windows']]);
  assert.ok(!rows['PHYS_MEMSIZE'], 'prose default is not a value'); assert.ok(!rows['some/untracked']);
});

test('pipe table: label groups that cannot be aligned with the variants stay UNLABELED (never guessed)', () => {
  const md = `| Profile Parameter | Description | Default value | Unit | Restrictions |
|---|---|---|---|---|
| ztta/roll_extension | q | 4000000000 <br> 2000000000 | bytes | Linux <br> UNIX <br> Windows <br> AIX |`;
  const [r] = parsePipeTables(md, TRACKED);
  assert.equal(r.variants.length, 2);
  assert.ok(r.variants.every((v) => v.platforms.length === 0));
});

test('pipe table: legacy 3-column table (param | default | unit) still works', () => {
  const md = `| Profile Parameter | Default Value | Unit |
|---|---|---|
| em/initial_size_MB | [PM] | Megabyte |
| rdisp/PG_SHM | [BE] * 50 | 8 KB block |`;
  const rows = parsePipeTables(md, TRACKED);
  assert.deepEqual(rows.map((r) => [r.param, r.variants[0].expr]), [['em/initial_size_MB', '[PM]'], ['rdisp/PG_SHM', '[BE] * 50']]);
});

/* layout text, built the way pdftotext -layout lays out the Help Portal tables */
function layout(rows, { restr = true, heading = [] } = {}) {
  const W = { p: 34, d: 22, e: 84, u: 10 };
  const line = (p, d, e, u, r) => '    ' + p.padEnd(W.p) + d.padEnd(W.d) + e.padEnd(W.e) + u.padEnd(W.u) + (restr ? r : '');
  const out = [...heading, line('Profile Parameter', 'Description', 'Default value', 'Unit', 'Restrictions')];
  for (const r of rows) r.forEach((l, i) => out.push(line(i === 0 ? r.name : '', l.d || '', l.e || '', l.u || '', l.r || '')));
  return out.join('\n');
}
test('layout table: wrapped formulas are re-joined, variants split on blank default-column lines, labels aligned vertically', () => {
  const rows = [
    Object.assign([{ d: 'Specifies how', e: '4000000000', u: 'bytes', r: 'Linux' }, { d: 'much EM can be' }, { d: 'assigned to a user' },
                   { d: 'context.', e: '2000000000', u: 'bytes', r: 'UNIX' }, { d: 'The value' }, { d: 'is the default', r: 'Windows' }, { d: 'for dia', r: 'AIX' }], { name: 'ztta/roll_extension' }),
    Object.assign([{ d: 'Specifies the', e: '$(PHYS_MEMSIZE) * 1024 * 1024', u: 'byt', r: 'Windows' }, { d: 'max PRIV' },
                   { d: 'memory', e: 'max($(PHYS_MEMSIZE)*1024*1024 * 0.1, $(abap/heap_area_dia) *', u: 'byt', r: 'UNIX' }, { d: 'dialog', e: '2)', r: 'Linux' }], { name: 'abap/heap_area_total' }),
    Object.assign([{ d: 'untracked row', e: '99999' }], { name: 'abap/other' })
  ];
  const parsed = Object.fromEntries(parseLayoutTables(layout(rows), TRACKED).map((r) => [r.param, r.variants]));
  assert.deepEqual(parsed['ztta/roll_extension'].map((v) => [v.expr, sorted(v.platforms)]), [['4000000000', 'linux'], ['2000000000', 'aix/unix/windows']]);
  assert.equal(parsed['abap/heap_area_total'][1].expr, 'max($(PHYS_MEMSIZE)*1024*1024 * 0.1, $(abap/heap_area_dia) * 2)');
  assert.deepEqual(parsed['abap/heap_area_total'].map((v) => sorted(v.platforms)), ['windows', 'linux/unix']);
  assert.ok(!parsed['abap/other']);
});

test('layout table without Restrictions column: only an explicit "...for <OS>" heading labels the table; prose never does', () => {
  const rows = [Object.assign([{ e: '2000000000', d: 'x', u: 'Bytes' }], { name: 'abap/heap_area_nondia' })];
  const withHeading = parseLayoutTables(layout(rows, { restr: false, heading: ['   Overview of Profile parameters for Windows', ''] }), TRACKED);
  assert.deepEqual(withHeading[0].variants[0].platforms, ['windows']); assert.ok(withHeading[0].variants[0].inferred);
  const prose = parseLayoutTables(layout(rows, { restr: false, heading: ['   Caution: On AIX there are some platform-specific differences.', ''] }), TRACKED);
  assert.deepEqual(prose[0].variants[0].platforms, [], 'a note mentioning AIX must not label the table');
});

test('page footers / headers of PDF exports are ignored', () => {
  const t = layout([Object.assign([{ e: '150000000', d: 'x' }], { name: 'abap/heap_area_total' })]) +
    '\n10/8/26, 4:54 AM\nThis is custom documentation. For more information, please visit SAP Help Portal. 31\n';
  assert.equal(parseLayoutTables(t, TRACKED).length, 1);
});

test('parseTables merges parsers and de-duplicates', () => {
  const md = '| Profile Parameter | Default Value | Unit |\n|---|---|---|\n| rdisp/PG_SHM | 1200 | 8K |';
  assert.equal(parseTables(md + '\n' + md, TRACKED).length, 1);
});

test('parseDocMeta: product / release / portal version', () => {
  assert.deepEqual(parseDocMeta('ABAP platform | 2025 FPS02 (Oct 2026)\nGenerated on: 2026\nOriginal content: https://help.sap.com/docs/X?version=202510.002&locale=en'),
    { product: 'ABAP platform', release: '2025 FPS02 (Oct 2026)', version: '202510.002' });
  assert.equal(parseDocMeta('SAP NetWeaver 7.4 | SPS31\nfoo').release, 'SPS31');
  assert.deepEqual(parseDocMeta('nothing here'), { product: '', release: '', version: '' });
});

test('platformsFromLabel', () => {
  assert.deepEqual(platformsFromLabel('UNIX, Linux, AIX').sort(), ['aix', 'linux', 'unix']);
  assert.deepEqual(platformsFromLabel('Windows'), ['windows']);
  assert.deepEqual(platformsFromLabel('IBM i'), ['ibmi']);
  assert.deepEqual(platformsFromLabel(''), []);
});

test('drift issue body: empty without drift, readable list with drift, no markup injection beyond code spans', () => {
  assert.equal(driftIssueBody({ toolCheck: { drift: [] } }), '');
  assert.equal(driftIssueBody({}), '');
  const body = driftIssueBody({ run: { seeds: [{ id: 'abap-platform', via: 'tavily', rows: 13 }] }, toolCheck: { ranAt: '2026-10-12T03:17:00Z', drift: [
    { param: 'ztta/roll_extension', basis: 'current', failing: 4, total: 16, os: ['linux'], examples: [{ os: 'linux', ramGB: 128, tool: 4000000000, documented: [8000000000, 2000000000] }] }] } });
  assert.match(body, /`ztta\/roll_extension` \[current\] - 4 of 16 checks differ \(OS: linux\)/);
  assert.match(body, /calculator 4000000000 vs documented 8000000000 or 2000000000/);
  assert.match(body, /abap-platform \(tavily, 13 rows\)/);
});
