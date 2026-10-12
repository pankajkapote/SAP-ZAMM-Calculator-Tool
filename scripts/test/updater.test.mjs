import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractDefaults, summarySupported, classifyUrl, detectPlatform, loadToolCode, runToolCheck } from '../update-knowledge.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', 'update-knowledge.mjs');
const CONFIG = JSON.parse(await readFile(path.join(HERE, '..', 'config.json'), 'utf8'));

/* ------------------------------------------------------------ mock fixtures */
// Flattened one-cell-per-line format (how HTML tables often come back from extraction)
const WIN_PAGE = `Overview of Parameters for Windows
All relevant memory parameters are set with an optimal default value.
Profile Parameter
Default Value
Unit
abap/heap_area_dia
2000000000
Byte
abap/heap_area_nondia
0
Byte
em/initial_size_MB
[PM]
Megabyte
em/max_size_MB
[PM] * 1.5
Megabyte
ztta/roll_area
6500000
Byte
where [PM] = value of PHYS_MEMSIZE`;

// Markdown pipe-table format, Unix, current docs
const UNIX_PAGE = `# Parameters for UNIX and Linux
| Profile Parameter | Default Value | Unit |
|---|---|---|
| em/initial_size_MB | [PM] | Megabyte |
| em/max_size_MB | 100000 | Megabyte |
| rdisp/PG_SHM | [BE] * 50 | 8 KB block |
| ztta/roll_extension | 2000000000 | Byte |`;

// Legacy per-release tree, deliberately different max size so we can see conflicts
const LEGACY_PAGE = `Overview of Parameters for Windows
| em/max_size_MB | 20000 (100000 on 64 bit) | Megabyte |
| rdisp/PG_MAXFS | 32768 | 8 KB block |`;

// Seed documents. ABAP seed = markdown pipe table as a web extractor would return it (consistent with the calculator, basis "current").
const ABAP_MD = `ABAP platform | 2025 FPS02 (Oct 2026)

## Parameter Reference of SAP Memory Management
| Profile Parameter | Description | Default value | Unit | Restrictions |
|---|---|---|---|---|
| PHYS_MEMSIZE | Size of the main memory of the host | Size of the main memory (RAM) | MB | |
| em/initial_size_MB | Total size of the EM | (min(512000, $(PHYS_MEMSIZE) * 0.7)) | MB | |
| em/max_size_MB | Maximum size of the EM | (min(512000, $(PHYS_MEMSIZE) * 1.5)) <br> ($(em/initial_size_MB)) | MB | Windows <br> UNIX, Linux, AIX |
| em/global_area_MB | Size of the EG | (min($(em/initial_size_MB) * 0.05, 32000)) | MB | |
| em/blocksize_KB | Block size | (ceil($(em/initial_size_MB) * 1024 / 100000 / 4096) * 4096) | KB | |
| rdisp/PG_SHM | Paging buffer | (min(1000+40*max(5,floor(($(PHYS_MEMSIZE)-128)/20)),256000)) | 8K blocks | |
| rdisp/PG_MAXFS | Paging file | ($(rdisp/PG_SHM)) | 8K blocks | |
| ztta/roll_extension | EM per user context | 4000000000 <br> 2000000000 | bytes | Linux <br> UNIX, Windows, AIX |
| abap/heap_area_dia | PRIV dialog | 2000000000 | bytes | |
| abap/heap_area_nondia | PRIV non-dialog | 2000000000 <br> 0 | bytes | UNIX, Linux, AIX <br> Windows |
| abap/heap_area_total | PRIV total | $(PHYS_MEMSIZE) * 1024 * 1024 <br> max($(PHYS_MEMSIZE)*1024*1024 * 0.1, $(abap/heap_area_dia) * 2) | bytes | Windows <br> UNIX, Linux, AIX |
| abap/heaplimit | restart limit | 150000000 | bytes | |
`;
// NW 7.4 seed = layout text (PDF export fallback). Table is the WINDOWS table; two rows deliberately contradict Note 88416 / the calculator.
const pad = (cells, widths) => '    ' + cells.map((c, i) => String(c).padEnd(widths[i])).join('');
const NW_W = [33, 100, 10];
const NW_LAYOUT = [
  'SAP NetWeaver 7.4 | SPS31', '',
  '   Overview of Profile parameters for Windows', '',
  pad(['Profile Parameter', 'Default Value', 'Unit'], NW_W),
  pad(['abap/heap_area_nondia', '2000000000', 'Bytes'], NW_W),
  pad(['em/initial_size_MB', '(min(512000, $(PHYS_MEMSIZE) * 0.7))', 'MB'], NW_W),
  pad(['em/max_size_MB', '($(em/initial_size_MB))', 'MB'], NW_W),
  pad(['rdisp/PG_MAXFS', '32768', '8 KB'], NW_W),
  pad(['rdisp/PG_SHM', '(max(min(1000+40*max(5,floor(($(PHYS_MEMSIZE)-128)*25/128)),16384),1024))', '8 KB'], NW_W),
  pad(['ztta/roll_extension', '2000000000', 'Bytes'], NW_W),
  pad(['abap/heaplimit', '150000000', 'Bytes'], NW_W),
  pad(['abap/heap_area_dia', '2000000000', 'Bytes'], NW_W),
  pad(['abap/heap_area_total', '(max($(PHYS_MEMSIZE)*1024*1024 * 0.1, $(abap/heap_area_dia) * 2 ))', 'Bytes'], NW_W)
].join('\n');
const INFRA_PROSE = 'Application Server Infrastructure | Support Content 1.0\n\nHigh memory allocation or Memory not released. The user contexts are stored in the extended memory first.';

const state = { winPage: WIN_PAGE, tavilyFail: false, cohereRerankStatus: 200, chatMode: 'ok', abapMd: ABAP_MD, abapMissing: false, extractBodies: [] };

function results() {
  return [
    { url: 'https://help.sap.com/docs/ABAP_PLATFORM_NEW/abc/memory-windows?version=2023.001', title: 'Overview of Parameters for Windows', content: 'Memory parameters for Windows application servers.', raw_content: state.winPage, score: 0.91 },
    { url: 'https://help.sap.com/docs/ABAP_PLATFORM_NEW/abc/memory-unix', title: 'Parameters for UNIX and Linux', content: 'Unix memory parameters.', raw_content: UNIX_PAGE, score: 0.88 },
    { url: 'https://help.sap.com/saphelp_nw73/helpdata/en/49/3d1b/content.htm', title: 'Overview of Parameters for Windows', content: 'Legacy page.', raw_content: LEGACY_PAGE, score: 0.7 },
    { url: 'https://help.sap.com/saphelp_nw70/helpdata/en/00/aa/content.htm', title: 'Old unrelated page', content: 'Nothing useful here.', raw_content: 'Nothing about parameters.', score: 0.6 },
    { url: 'https://evil.example.com/em-initial-size', title: 'Off-domain', content: 'x', raw_content: 'em/initial_size_MB\n1\nMegabyte', score: 0.99 },
    { url: 'https://help.sap.com/docs/ABAP_PLATFORM_NEW/abc/memory-concepts', title: 'Memory management concepts', content: 'Concept overview of extended memory and heap memory in the ABAP application server.', raw_content: 'Extended memory is used first, then heap memory, for each work process. This page explains concepts only.', score: 0.5 }
  ];
}

const counters = { search: 0, rerank: 0, chat: 0, extract: 0 };
const server = http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (req.url.startsWith('/pdf/')) { if (state.tavilyFail) { res.writeHead(500); return res.end('down'); } res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end(NW_LAYOUT); }   // 'outage' mode takes the whole network down
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return json(401, { error: 'no key' });
  const payload = body ? JSON.parse(body) : {};

  if (req.url === '/search') {
    counters.search++;
    if (state.tavilyFail) return json(500, { error: 'boom' });
    assert.deepEqual(payload.include_domains, ['help.sap.com']);
    assert.equal(payload.include_raw_content, true);
    return json(200, { query: payload.query, results: results() });
  }
  if (req.url === '/extract') {
    counters.extract++; state.extractBodies.push(payload);
    if (state.tavilyFail) return json(500, { error: 'boom' });
    const results = [], failed = [];
    for (const u of payload.urls) {
      if (u.endsWith('/doc/abap')) { if (state.abapMissing) failed.push({ url: u, error: 'timeout' }); else results.push({ url: u, raw_content: state.abapMd }); }
      else if (u.endsWith('/doc/nw740')) failed.push({ url: u, error: 'could not render' });          // forces the PDF fallback
      else results.push({ url: u, raw_content: INFRA_PROSE });
    }
    return json(200, { results, failed_results: failed });
  }
  if (req.url === '/v2/rerank') {
    counters.rerank++;
    if (state.cohereRerankStatus !== 200) return json(state.cohereRerankStatus, { message: 'trial key limit' });
    return json(200, { results: payload.documents.map((d, index) => ({ index, relevance_score: d.includes('em/') || d.includes('rdisp/') ? 0.9 : d.includes('Extended memory') ? 0.4 : 0.02 })) });
  }
  if (req.url === '/v2/chat') {
    counters.chat++;
    const prompt = payload.messages[0].content;
    let summary = 'Lists documented defaults for work-process memory parameters including em/initial_size_MB.';
    if (state.chatMode === 'hallucinate' || prompt.includes('Parameters for UNIX and Linux')) {
      summary = 'em/initial_size_MB defaults to 99999999 megabytes on Unix.'; // number not in source -> must be dropped
    }
    return json(200, { message: { content: [{ type: 'text', text: JSON.stringify({ summary, relevance: 'high' }) }] } });
  }
  return json(404, {});
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

function testConfig(over = {}) {
  const c = JSON.parse(JSON.stringify(CONFIG));
  c.seeds = [
    { id: 'abap-platform', basis: 'current', label: 'ABAP platform (test)', url: `${BASE}/doc/abap` },
    { id: 'nw740', basis: 'nw740', label: 'NW 7.4 (test)', url: `${BASE}/doc/nw740`, pdfUrl: `${BASE}/pdf/nw` },
    { id: 'app-infra', basis: 'none', minRows: 0, label: 'App infra (test)', url: `${BASE}/doc/infra` }
  ];
  return Object.assign(c, over);
}
async function runUpdater({ env = {}, config } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'zamm-'));
  const out = path.join(dir, 'zamm-live.json');
  const cfgPath = path.join(dir, 'config.json');
  await writeFile(cfgPath, JSON.stringify(config || testConfig()));
  const child = spawn(process.execPath, [SCRIPT], {
    env: { ...process.env, TAVILY_API_KEY: 'tvly-test', COHERE_API_KEY: 'co-test', TAVILY_BASE_URL: BASE, COHERE_BASE_URL: BASE, ZAMM_OUT: out, ZAMM_CONFIG: cfgPath, ZAMM_FAST: '1', ZAMM_COHERE_GAP_MS: '0', ZAMM_ALLOW_ANY_HOST: '1', ...env }
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  const code = await new Promise((r) => child.on('close', r));
  let data = null;
  try { data = JSON.parse(await readFile(out, 'utf8')); } catch { /* not written */ }
  return { code, stdout, stderr, data, out, dir };
}
const reset = () => { Object.assign(state, { winPage: WIN_PAGE, tavilyFail: false, cohereRerankStatus: 200, chatMode: 'ok', abapMd: ABAP_MD, abapMissing: false, extractBodies: [] }); counters.search = counters.rerank = counters.chat = counters.extract = 0; };

/* ------------------------------------------------------------ unit tests */
test('extractDefaults: flattened lines and pipe tables, whitelisted params only', () => {
  const a = extractDefaults(WIN_PAGE, CONFIG.trackedParams);
  const map = Object.fromEntries(a.map((d) => [d.param, d]));
  assert.equal(map['abap/heap_area_nondia'].default, '0');
  assert.equal(map['em/initial_size_MB'].default, '[PM]');
  assert.equal(map['em/max_size_MB'].default, '[PM] * 1.5');
  assert.equal(map['ztta/roll_area'].default, '6500000');
  assert.equal(map['ztta/roll_area'].unit, 'Byte');
  const b = extractDefaults(UNIX_PAGE, CONFIG.trackedParams);
  assert.equal(b.find((d) => d.param === 'rdisp/PG_SHM').default, '[BE] * 50');
  assert.equal(b.find((d) => d.param === 'rdisp/PG_SHM').unit, '8 KB block');
  assert.equal(b.length, 4, 'header/separator rows must not be extracted');
});

test('extractDefaults: prose mentions and unknown params are ignored', () => {
  const prose = 'The parameter em/initial_size_MB controls memory. Set it carefully.\nzzz/unknown_param\n123';
  assert.deepEqual(extractDefaults(prose, CONFIG.trackedParams), []);
});

test('summarySupported rejects invented numbers and params, accepts grounded ones', () => {
  const src = 'em/initial_size_MB default is 2000000000 bytes. See Note 88416.';
  assert.ok(summarySupported('Default of em/initial_size_MB is 2000000000, see Note 88416.', src));
  assert.ok(!summarySupported('Default is 99999999.', src));
  assert.ok(!summarySupported('Also set abap/heaplimit.', src));
});

test('classifyUrl / detectPlatform', () => {
  assert.equal(classifyUrl(new URL('https://help.sap.com/docs/X/y/z')), 'current');
  assert.equal(classifyUrl(new URL('https://help.sap.com/saphelp_nw73/helpdata/en/1/2/content.htm')), 'legacy');
  assert.equal(detectPlatform('Overview of Parameters for Windows', '', ''), 'windows');
  assert.equal(detectPlatform('Parameters for UNIX and Linux', '', ''), 'unix');
  assert.equal(detectPlatform('Something', '', 'no hints'), 'unknown');
});

/* ------------------------------------------------------- end-to-end tests */
test('full run: filters, extracts, reranks, validates summaries, respects budgets', async () => {
  reset();
  const r = await runUpdater();
  assert.equal(r.code, 0, r.stderr);
  const d = r.data;
  assert.equal(d.schemaVersion, 1);
  assert.equal(d.status, 'ok', JSON.stringify(d.run));
  assert.equal(counters.search, CONFIG.queries.length);
  assert.equal(d.run.tavilyCredits, CONFIG.queries.length + 2);   // 6 searches + 1 advanced extract batch (3 URLs = 2 credits)
  assert.ok(d.run.reranked);
  // off-domain page and legacy page without parameters are excluded
  assert.ok(!d.sources.some((s) => s.url.includes('evil.example.com')));
  assert.ok(!d.sources.some((s) => s.url.includes('saphelp_nw70')));
  // legacy page WITH parameters kept but flagged
  const legacy = d.sources.find((s) => s.url.includes('saphelp_nw73'));
  assert.equal(legacy.kind, 'legacy');
  assert.equal(legacy.release, 'saphelp_nw73');
  // current sources sort before legacy
  const kinds = d.sources.map((s) => s.kind);
  assert.ok(kinds.lastIndexOf('current') < kinds.indexOf('legacy'));
  // windows page: platform + defaults
  const win = d.sources.find((s) => s.url.includes('memory-windows'));
  assert.equal(win.platform, 'windows');
  assert.equal(win.release, '2023.001');
  const winDefaults = d.documentedDefaults.filter((x) => x.sourceId === win.id);
  assert.equal(winDefaults.find((x) => x.param === 'abap/heap_area_nondia').default, '0');
  // hallucinated summary (Unix page) dropped, grounded one (Windows page) kept
  const unix = d.sources.find((s) => s.url.includes('memory-unix'));
  assert.ok(!d.advisories.some((a) => a.sourceId === unix.id), 'hallucinated summary must be dropped');
  assert.ok(d.advisories.some((a) => a.sourceId === win.id), 'grounded summary must be kept');
  // no raw page text stored (keep repo small + limit republishing SAP content)
  assert.ok(JSON.stringify(d).length < 20000);
  assert.ok(d.sources.every((s) => s.snippet.length <= 240));
});

test('change detection: second run with a changed default is reported and logged', async () => {
  reset();
  const first = await runUpdater();
  assert.equal(first.data.changes.length, 0);
  state.winPage = WIN_PAGE.replace('ztta/roll_area\n6500000', 'ztta/roll_area\n3000000');
  const out = first.out;
  const second = await new Promise(async (resolve) => {
    // re-run against the SAME output file so the diff has a previous state
    const child = spawn(process.execPath, [SCRIPT], { env: { ...process.env, TAVILY_API_KEY: 'tvly-test', COHERE_API_KEY: 'co-test', TAVILY_BASE_URL: BASE, COHERE_BASE_URL: BASE, ZAMM_OUT: out, ZAMM_CONFIG: path.join(first.dir, 'config.json'), ZAMM_FAST: '1', ZAMM_COHERE_GAP_MS: '0', ZAMM_ALLOW_ANY_HOST: '1' } });
    child.on('close', async (code) => resolve({ code, data: JSON.parse(await readFile(out, 'utf8')) }));
  });
  assert.equal(second.code, 0);
  const ch = second.data.changes.find((c) => c.param === 'ztta/roll_area');
  assert.deepEqual([ch.was, ch.now], ['6500000', '3000000']);
  assert.ok(second.data.changeLog.length >= 1);
});

test('Tavily outage: exit 1 and the last good file is left byte-identical', async () => {
  reset();
  const good = await runUpdater();
  const before = await readFile(good.out, 'utf8');
  state.tavilyFail = true;
  const bad = await new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT], { env: { ...process.env, TAVILY_API_KEY: 'tvly-test', COHERE_API_KEY: 'co-test', TAVILY_BASE_URL: BASE, COHERE_BASE_URL: BASE, ZAMM_OUT: good.out, ZAMM_CONFIG: path.join(good.dir, 'config.json'), ZAMM_FAST: '1', ZAMM_COHERE_GAP_MS: '0', ZAMM_ALLOW_ANY_HOST: '1' } });
    child.on('close', (code) => resolve(code));
  });
  assert.equal(bad, 1);
  assert.equal(await readFile(good.out, 'utf8'), before);
});

test('no Cohere key: Tavily-only mode still produces sources and defaults', async () => {
  reset();
  const r = await runUpdater({ env: { COHERE_API_KEY: '' } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.data.run.reranked, false);
  assert.equal(r.data.run.cohereCalls, 0);
  assert.equal(r.data.advisories.length, 0);
  assert.ok(r.data.documentedDefaults.length >= 8);
  assert.ok(r.data.sources.filter((s) => !s.seed).every((s) => s.scoreBy === 'tavily'));
});

test('Cohere trial cap (HTTP 429): partial result, defaults still delivered, no crash', async () => {
  reset();
  state.cohereRerankStatus = 429;
  const r = await runUpdater();
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.data.status, 'partial');
  assert.ok(r.data.run.errors.some((e) => e.includes('429')));
  assert.ok(r.data.documentedDefaults.length >= 8);
});

test('budget cap: Tavily credit limit stops the run early but still writes a partial result', async () => {
  reset();
  const cfg = testConfig({ limits: { ...CONFIG.limits, maxTavilyCredits: 2 } });
  const r = await runUpdater({ config: cfg });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(counters.search, 2);
  assert.equal(r.data.status, 'partial');
  assert.ok(r.data.run.errors.some((e) => /credit cap/i.test(e)));
});

test('missing TAVILY_API_KEY: exit 1, nothing written', async () => {
  reset();
  const r = await runUpdater({ env: { TAVILY_API_KEY: '' } });
  assert.equal(r.code, 1);
  assert.equal(r.data, null);
});

/* ------------------------------------------------------- seed documents + drift */
test('seeds: Tavily Extract request shape, markdown table parsed, NW 7.4 via PDF-text fallback, metadata detected', async () => {
  reset();
  const r = await runUpdater();
  assert.equal(r.code, 0, r.stderr);
  const body = state.extractBodies[0];
  assert.equal(body.extract_depth, 'advanced'); assert.equal(body.format, 'markdown');
  assert.ok(!('query' in body) && !('chunks_per_source' in body), 'query/chunks would truncate raw_content');
  assert.equal(body.urls.length, 3);
  const seeds = Object.fromEntries(r.data.run.seeds.map((x) => [x.id, x]));
  assert.equal(seeds['abap-platform'].via, 'tavily'); assert.equal(seeds['abap-platform'].rows, 11);
  assert.equal(seeds['nw740'].via, 'pdf'); assert.ok(seeds['nw740'].ok);
  assert.ok(seeds['app-infra'].ok && seeds['app-infra'].rows === 0);
  const abap = r.data.sources.find((x) => x.id === 'abap-platform');
  assert.equal(abap.basis, 'current'); assert.equal(abap.seed, true); assert.match(abap.docRelease, /ABAP platform 2025 FPS02/);
  // variants + platform labels aligned from the table
  const rext = r.data.documentedDefaults.filter((x) => x.sourceId === 'abap-platform' && x.param === 'ztta/roll_extension');
  assert.deepEqual(rext.map((x) => [x.default, [...x.platforms].sort().join('/')]), [['4000000000', 'linux'], ['2000000000', 'aix/unix/windows']]);
  const nondia = r.data.documentedDefaults.filter((x) => x.sourceId === 'abap-platform' && x.param === 'abap/heap_area_nondia');
  assert.deepEqual(nondia.map((x) => [x.default, [...x.platforms].sort().join('/')]), [['2000000000', 'aix/linux/unix'], ['0', 'windows']]);
  const tot = r.data.documentedDefaults.find((x) => x.sourceId === 'abap-platform' && x.param === 'abap/heap_area_total' && x.platforms.includes('linux'));
  assert.equal(tot.default, 'max($(PHYS_MEMSIZE)*1024*1024 * 0.1, $(abap/heap_area_dia) * 2)');   // '*' operators must survive
  // NW table: platform inferred from the explicit "...for Windows" heading
  assert.ok(r.data.documentedDefaults.filter((x) => x.sourceId === 'nw740').every((x) => x.platforms.join() === 'windows'));
});

test('drift check: calculator agrees with both seed documents; documented contradictions are acknowledged, not silent', async () => {
  reset();
  const r = await runUpdater();
  const tc = r.data.toolCheck;
  assert.deepEqual(tc.drift, [], JSON.stringify(tc.drift));
  assert.deepEqual(tc.acknowledged.map((x) => `${x.param}@${x.basis}`).sort(), ['abap/heap_area_nondia@nw740', 'abap/heap_area_total@nw740', 'em/max_size_MB@nw740', 'rdisp/PG_MAXFS@current']);
  assert.ok(tc.acknowledged.every((x) => x.reason));
  assert.ok(tc.acknowledged.filter((x) => x.basis === 'nw740').every((x) => x.os.join() === 'windows'));
  assert.match(tc.acknowledged.find((x) => x.param === 'rdisp/PG_MAXFS').reason, /256000/);
  assert.ok(tc.covered.current.includes('rdisp/pg_shm'));
  assert.ok(tc.uncovered.current.includes('abap/buffersize'), 'buffersize is not documented by the seed -> reported as uncovered');
});

test('drift check detects a changed calculator (mutated index.html) and a removed known-difference entry', async () => {
  reset();
  const html = await readFile(path.join(HERE, '..', '..', 'index.html'), 'utf8');
  const dir = await mkdtemp(path.join(tmpdir(), 'zamm-html-'));
  const mutated = path.join(dir, 'index.html');
  await writeFile(mutated, html.replace('(s4?0.8:0.7)', '(s4?0.8:0.75)').replace('c[\'ztta/roll_extension\']=(!legacy && os===\'linux\') ? 4000000000', "c['ztta/roll_extension']=(!legacy && os==='linux') ? 3000000000"));
  const r = await runUpdater({ env: { ZAMM_HTML: mutated } });
  const params = r.data.toolCheck.drift.map((x) => `${x.param}@${x.basis}`);
  assert.ok(params.includes('em/initial_size_MB@current') && params.includes('em/initial_size_MB@nw740'), params.join());
  const roll = r.data.toolCheck.drift.find((x) => x.param === 'ztta/roll_extension' && x.basis === 'current');
  assert.ok(roll && roll.os.join() === 'linux' && roll.examples[0].tool === 3000000000 && roll.examples[0].documented.join() === '4000000000');
  // without the knownDifferences list the NW 7.4 contradictions become real drift
  reset();
  const r2 = await runUpdater({ config: testConfig({ knownDifferences: [] }) });
  assert.deepEqual(r2.data.toolCheck.drift.map((x) => x.param).sort(), ['abap/heap_area_nondia', 'abap/heap_area_total', 'em/max_size_MB', 'rdisp/PG_MAXFS']);
});

test('weak/failed seed never replaces good data: previous entries are carried forward and flagged stale', async () => {
  reset();
  const good = await runUpdater();
  const before = good.data.documentedDefaults.filter((x) => x.sourceId === 'abap-platform');
  assert.ok(before.length >= 11);
  state.abapMissing = true;                                          // extractor now fails for the ABAP seed (no pdfUrl configured)
  const out = good.out, cfgPath = path.join(good.dir, 'config.json');
  const second = await new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT], { env: { ...process.env, TAVILY_API_KEY: 't', COHERE_API_KEY: 'c', TAVILY_BASE_URL: BASE, COHERE_BASE_URL: BASE, ZAMM_OUT: out, ZAMM_CONFIG: cfgPath, ZAMM_FAST: '1', ZAMM_COHERE_GAP_MS: '0', ZAMM_ALLOW_ANY_HOST: '1' } });
    child.on('close', async (code) => resolve({ code, data: JSON.parse(await readFile(out, 'utf8')) }));
  });
  assert.equal(second.code, 0);
  assert.equal(second.data.status, 'partial');
  const src = second.data.sources.find((x) => x.id === 'abap-platform');
  assert.equal(src.stale, true);
  assert.deepEqual(second.data.documentedDefaults.filter((x) => x.sourceId === 'abap-platform'), before);
  assert.ok(second.data.run.errors.some((e) => /abap-platform/.test(e)));
  assert.equal(second.data.toolCheck.drift.length, 0, 'stale seeds are excluded from the drift check');
});

test('changed documented formula between runs is reported (variant-aware change detection)', async () => {
  reset();
  const first = await runUpdater();
  state.abapMd = ABAP_MD.replace('4000000000 <br> 2000000000', '8000000000 <br> 2000000000');
  const second = await new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT], { env: { ...process.env, TAVILY_API_KEY: 't', COHERE_API_KEY: 'c', TAVILY_BASE_URL: BASE, COHERE_BASE_URL: BASE, ZAMM_OUT: first.out, ZAMM_CONFIG: path.join(first.dir, 'config.json'), ZAMM_FAST: '1', ZAMM_COHERE_GAP_MS: '0', ZAMM_ALLOW_ANY_HOST: '1' } });
    child.on('close', async (code) => resolve({ code, data: JSON.parse(await readFile(first.out, 'utf8')) }));
  });
  const ch = second.data.changes.find((c) => c.param === 'ztta/roll_extension' && c.sourceId === 'abap-platform');
  assert.ok(ch, JSON.stringify(second.data.changes));
  assert.match(ch.was, /4000000000/); assert.match(ch.now, /8000000000/);
  // and the calculator now disagrees with the (changed) documentation for Linux
  const d = second.data.toolCheck.drift.find((x) => x.param === 'ztta/roll_extension');
  assert.ok(d && d.os.join() === 'linux' && d.basis === 'current');
});

/* ------------------------------------------------------- PDF routes (real PDF through pdftotext) */
const HAVE_PDFTOTEXT = spawnSync('pdftotext', ['-v']).error === undefined;
function makePdf(text) {                                   // minimal single-page PDF, Courier 6pt so wide tables keep their column layout
  const lines = text.split('\n');
  const esc = (l) => l.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  let stream = 'BT /F1 6 Tf 7 TL 10 780 Td\n';
  for (const l of lines) stream += `(${esc(l)}) '\n`;
  stream += 'ET';
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1400 800] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>'
  ];
  let pdf = '%PDF-1.4\n'; const off = [];
  objs.forEach((o, i) => { off.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + off.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}
test('local PDF seed (data/sources style): real PDF -> pdftotext -> parsed rows, via "file", no network needed', { skip: !HAVE_PDFTOTEXT && 'pdftotext not installed' }, async () => {
  reset();
  const dir = await mkdtemp(path.join(tmpdir(), 'zamm-file-'));
  const pdfPath = path.join(dir, 'nw.pdf');
  await writeFile(pdfPath, makePdf(NW_LAYOUT));
  const cfg = testConfig();
  cfg.seeds[1] = { ...cfg.seeds[1], url: '', pdfUrl: '', file: pdfPath };          // absolute path: path.resolve keeps it
  const r = await runUpdater({ config: cfg });
  assert.equal(r.code, 0, r.stderr);
  const sd = r.data.run.seeds.find((x) => x.id === 'nw740');
  assert.equal(sd.via, 'file'); assert.ok(sd.ok, JSON.stringify(sd)); assert.ok(sd.rows >= 8);
  assert.ok(r.data.documentedDefaults.filter((x) => x.sourceId === 'nw740').some((x) => x.param === 'rdisp/PG_SHM' && /25\/128/.test(x.default)));
  assert.equal(r.data.sources.find((x) => x.id === 'nw740').docRelease, 'SAP NetWeaver 7.4 SPS31');
});

test('PDF download fallback: server returns application/pdf -> pdftotext -> parsed', { skip: !HAVE_PDFTOTEXT && 'pdftotext not installed' }, async () => {
  reset();
  const pdfServer = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/pdf' }); res.end(makePdf(NW_LAYOUT)); });
  await new Promise((r) => pdfServer.listen(0, '127.0.0.1', r));
  try {
    const cfg = testConfig();
    cfg.seeds[1].pdfUrl = `http://127.0.0.1:${pdfServer.address().port}/export.pdf`;
    const r = await runUpdater({ config: cfg });
    const sd = r.data.run.seeds.find((x) => x.id === 'nw740');
    assert.equal(sd.via, 'pdf'); assert.ok(sd.ok && sd.rows >= 8, JSON.stringify(sd));
  } finally { pdfServer.close(); }
});

test('local file takes precedence over the network and an unreadable local file is reported, not fatal', async () => {
  reset();
  const dir = await mkdtemp(path.join(tmpdir(), 'zamm-file-'));
  const txt = path.join(dir, 'nw.txt'); await writeFile(txt, NW_LAYOUT);
  const cfg = testConfig(); cfg.seeds[1] = { ...cfg.seeds[1], file: txt };
  const r = await runUpdater({ config: cfg });
  assert.equal(r.data.run.seeds.find((x) => x.id === 'nw740').via, 'file');
  const bad = path.join(dir, 'broken.pdf'); await writeFile(bad, '%PDF-1.4 garbage');
  const cfg2 = testConfig(); cfg2.seeds[1] = { ...cfg2.seeds[1], file: bad };
  const r2 = await runUpdater({ config: cfg2 });
  assert.equal(r2.code, 0); assert.ok(r2.data.run.errors.some((e) => /nw740/.test(e)));
});

test('seeds served from local files cost no Tavily Extract credits', async () => {
  reset();
  const dir = await mkdtemp(path.join(tmpdir(), 'zamm-file-'));
  const f = {}; for (const [k, v] of Object.entries({ abap: ABAP_MD, nw: NW_LAYOUT, infra: INFRA_PROSE })) { f[k] = path.join(dir, `${k}.txt`); await writeFile(f[k], v); }
  const cfg = testConfig();
  cfg.seeds[0].file = f.abap; cfg.seeds[1].file = f.nw; cfg.seeds[2].file = f.infra;
  const r = await runUpdater({ config: cfg });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(counters.extract, 0, 'no extract request when every seed has a local file');
  assert.equal(r.data.run.tavilyCredits, CONFIG.queries.length);
  assert.deepEqual(r.data.run.seeds.map((x) => x.via), ['file', 'file', 'file']);
  assert.deepEqual(r.data.toolCheck.drift, []);
});
