import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadToolCode } from '../update-knowledge.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tool = loadToolCode(await readFile(path.join(HERE, '..', '..', 'index.html'), 'utf8'));
const EV = JSON.parse(await readFile(path.join(HERE, 'fixtures', 'rsparam-evidence.json'), 'utf8')).systems;
const keyOf = (obj, name) => Object.keys(obj).find((k) => k.toLowerCase() === name.toLowerCase());

/* The calculator must reproduce, EXACTLY, every kernel default that a real system reveals. */
for (const [name, sys] of Object.entries(EV)) {
  test(`${name} (${sys.os}, basis "${sys.basis}"): calculator reproduces all kernel defaults shown by RSPARAM`, () => {
    const PM = Number(sys.rows.PHYS_MEMSIZE.def);
    const calc = tool.calcZAMM(PM, sys.os, sys.basis);
    let checked = 0;
    for (const [p, r] of Object.entries(sys.rows)) {
      if (!r.evidence) continue;
      const k = keyOf(calc, p);
      if (!k) continue;                                            // not calculated (PHYS_MEMSIZE, VIRT_MEMSIZE, zcsa/*, rtbb/*, roll_extension_dia ...)
      assert.equal(calc[k], Number(r.def), `${name}: ${p}`);
      checked++;
    }
    assert.ok(checked >= 10, `only ${checked} parameters compared`);
  });

  test(`${name}: the kernel's own unsubstituted formulas evaluate (with evalDocExpr) to the system's defaults`, () => {
    const num = (n) => { const k = keyOf(sys.rows, n); return k ? Number(sys.rows[k].def) : undefined; };
    let checked = 0;
    for (const [p, r] of Object.entries(sys.rows)) {
      if (!r.formula.includes('$(') || r.truncated || !r.evidence) continue;
      const ev = tool.evalDocExpr(r.formula, num);
      if (!ev.ok) continue;                                        // refers to a parameter outside the fixture
      assert.ok(Math.abs(ev.value - Number(r.def)) <= 0.5, `${name}: ${p} formula ${r.formula} -> ${ev.value}, system default ${r.def}`);
      checked++;
    }
    assert.ok(checked >= 6, `only ${checked} formulas evaluated`);
  });
}

test('documentation vs. real kernels: the evidence that justifies where the calculator deviates from the SAP Help text', () => {
  // Help (ABAP platform 2025) + Note 2085980 say rdisp/PG_MAXFS = $(rdisp/PG_SHM); all four kernels use a fixed 256000.
  for (const sys of Object.values(EV)) assert.equal(sys.rows['rdisp/PG_MAXFS'].def, '256000');
  assert.notEqual(EV.Linux_ECC.rows['rdisp/PG_SHM'].def, EV.Linux_ECC.rows['rdisp/PG_MAXFS'].def, 'PG_SHM 253600 != PG_MAXFS 256000');
  // S/4 kernels: em/initial = 0.8 * PM and em/max = VIRT_MEMSIZE - neither is in the Help documents.
  for (const n of ['Linux_S4', 'Win_S4']) {
    assert.match(EV[n].rows['em/initial_size_MB'].formula, /\* 0\.8\)/);
    assert.match(EV[n].rows['em/max_size_MB'].formula, /VIRT_MEMSIZE/);
    assert.ok(!('em/blocksize_KB' in EV[n].rows), 'em/blocksize_KB does not exist on S/4 kernels');
  }
  for (const n of ['Linux_ECC', 'Win_ECC']) assert.match(EV[n].rows['em/initial_size_MB'].formula, /\* 0\.7\)/);
});

test('fixture contains no system identifiers or paths', async () => {
  const raw = await readFile(path.join(HERE, 'fixtures', 'rsparam-evidence.json'), 'utf8');
  assert.ok(!/usr\/sap|sapmnt|\\\\|P62|R3P|S4Q/i.test(raw));
});

test('S/4 table-buffer chain: the kernel formulas (Windows S/4 export), evaluated for SMALL systems, equal the calculator', () => {
  // On the real (large) systems the 2.7 GB cap dominates, so only the formula text can verify the 0.08 factor.
  const sys = EV.Win_S4;
  const rows = sys.rows;
  for (const PM of [4000, 8000, 16000, 20000, 30000, 60000]) {
    const memo = new Map();
    const val = (name) => {
      if (name.toLowerCase() === 'phys_memsize') return PM;
      const k = keyOf(rows, name);
      if (!k) return undefined;
      if (!memo.has(k)) { const r = tool.evalDocExpr(rows[k].formula, val); memo.set(k, r.ok ? Math.round(r.value) : undefined); }
      return memo.get(k);
    };
    const kernel = val('rsdb/tbi_buffer_area_MB');
    assert.ok(Number.isFinite(kernel), `formula chain evaluable for PM=${PM}`);
    assert.equal(tool.calcZAMM(PM, 'windows', 's4')['rsdb/tbi_buffer_area_MB'], kernel, `tbi at PM=${PM}`);
    assert.equal(tool.calcZAMM(PM, 'windows', 's4')['em/initial_size_MB'], val('em/initial_size_MB'), `em/initial at PM=${PM}`);
  }
  // the factor is really 0.08 in the export text (and 0.1 is what the 7.40 listing shows for ECC-era kernels)
  assert.match(rows['zcsa/table_buffer_area'].formula, /\* 1024 \* 1024 \* 0\.08\)/);
});
