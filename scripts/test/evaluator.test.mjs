import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadToolCode } from '../update-knowledge.mjs';

const HTML = await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'index.html'), 'utf8');
const tool = loadToolCode(HTML);                       // the REAL calcZAMM + evalDocExpr from index.html
const PM = 129024;
const calc = tool.calcZAMM(PM, 'linux', 'current');
const lookup = (n) => (n.toLowerCase() === 'phys_memsize' ? PM : calc[Object.keys(calc).find((k) => k.toLowerCase() === n.toLowerCase())]);
const ev = (e) => tool.evalDocExpr(e, lookup);

test('documented formulas evaluate to the hand-computed values', () => {
  assert.equal(ev('(min(512000, $(PHYS_MEMSIZE) * 0.7))').value, 129024 * 0.7);
  assert.equal(ev('[PM] * 1.5').value, 193536);
  assert.equal(ev('(min(1000+40*max(5,floor(($(PHYS_MEMSIZE)-128)/20)),256000))').value, 256000);
  assert.equal(ev('(max(min(1000+40*max(5,floor(($(PHYS_MEMSIZE)-128)*25/128)),16384),1024))').value, 16384);
  assert.equal(ev('(ceil($(em/initial_size_MB) * 1024 / 100000 / 4096) * 4096)').value, 4096);
  assert.ok(Math.abs(ev('max($(PHYS_MEMSIZE)*1024*1024 * 0.1, $(abap/heap_area_dia) * 2)').value - 13529146982.4) < 1e-3);
  assert.equal(ev('(min(ceil($(em/initial_size_MB)*1024*0.2/4096)*4096, ceil(sqrt($(PHYS_MEMSIZE)/1024)*1024*1024)))').value, calc['abap/buffersize']);
  assert.equal(ev('-3 + 10 / 4').value, -0.5);
});

test('evaluator agrees with plain JavaScript on a generated corpus', () => {
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 300; i++) {
    const a = Math.floor(rnd() * 9000) + 1, b = Math.floor(rnd() * 90) + 1, c = Math.floor(rnd() * 5) + 1;
    const forms = [[`(${a} + ${b}) * ${c}`, (a + b) * c], [`min(${a}, ${b} * ${c})`, Math.min(a, b * c)], [`max(${a} / ${c}, ${b})`, Math.max(a / c, b)],
                   [`floor(${a} / ${b}) + ceil(${b} / ${c})`, Math.floor(a / b) + Math.ceil(b / c)], [`sqrt(${a}) * ${c} - ${b}`, Math.sqrt(a) * c - b]];
    for (const [expr, expected] of forms) assert.ok(Math.abs(ev(expr).value - expected) < 1e-9, expr);
  }
});

test('hostile / malformed input is rejected, never executed', () => {
  globalThis.__pwned = false;
  const bad = ['constructor', '$(PHYS_MEMSIZE) ; process.exit(1)', ');globalThis.__pwned=true;(', 'this', '__proto__', 'alert(1)', 'min()', 'floor(1,2)', '1/0', '2**3', '1e9', '$(no/such_param)', '$()', '[BE] * 50',
               'Math.max(1,2)', "'a'+'b'", '`x`', '1 2', '(1', '1)', '', '   ', 'min(1,', '$(PHYS_MEMSIZE', 'x'.repeat(500), '('.repeat(300) + '1' + ')'.repeat(300), '1+'.repeat(250) + '1'];
  for (const b of bad) { const r = ev(b); assert.equal(r.ok, false, `must reject: ${b.slice(0, 40)}`); assert.equal(typeof r.reason, 'string'); }
  assert.equal(globalThis.__pwned, false);
});

test('[PM]-style legacy tokens: [PM] resolves, [BE] (per-user value) does not', () => {
  assert.equal(ev('[PM]').value, PM);
  assert.equal(ev('[BE]').ok, false);
});

test('loadToolCode exposes calcZAMM that equals the page behaviour for both bases', () => {
  assert.equal(tool.calcZAMM(PM, 'linux', 'current')['rdisp/PG_SHM'], 256000);
  assert.equal(tool.calcZAMM(PM, 'linux', 'nw740')['rdisp/PG_SHM'], 16384);
  assert.throws(() => loadToolCode('<html>no markers</html>'), /marker/);
});
