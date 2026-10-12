#!/usr/bin/env node
/**
 * ZAMM Calculator - live knowledge refresher
 * ------------------------------------------
 * Pipeline:  1. SEED documents (config.seeds): Tavily Extract of the Help Portal page,
 *               fallback = PDF export (direct download + pdftotext)
 *            2. Tavily Search (help.sap.com only) for additional pages
 *         -> table-aware, DETERMINISTIC extraction of documented defaults / formulas (no LLM touches numbers)
 *         -> Cohere rerank (relevance filter of search hits)   [optional - degrades gracefully]
 *         -> Cohere chat (short summaries, validated)          [optional - degrades gracefully]
 *         -> DRIFT CHECK: loads calcZAMM + evalDocExpr straight from index.html and compares the calculator
 *            with every documented formula of the seed documents (per OS and RAM size)
 *         -> data/zamm-live.json  (read by index.html)
 *
 * Zero dependencies. Node >= 18 (global fetch).
 *
 * Env:  TAVILY_API_KEY (required)   COHERE_API_KEY (optional)
 *       COHERE_RERANK_MODEL / COHERE_CHAT_MODEL (override config.json)
 *       TAVILY_BASE_URL / COHERE_BASE_URL (testing only)
 *       ZAMM_OUT / ZAMM_CONFIG (paths), ZAMM_FAST=1 (tests: no waits)
 * Flags: --dry-run (print, don't write)
 *
 * Safety rules baked in:
 *  - A failed run NEVER overwrites the last good data file.
 *  - Numbers/params in LLM summaries must appear in the source text, else the summary is dropped.
 *  - Hard per-run budget caps so the free tiers can't be exhausted by a bug.
 */
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { parseTables, parseDocMeta } from './lib/doc-parse.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = process.env.ZAMM_CONFIG || path.join(__dirname, 'config.json');
const OUT_PATH = process.env.ZAMM_OUT || path.join(ROOT, 'data', 'zamm-live.json');
const HTML_PATH = process.env.ZAMM_HTML || path.join(ROOT, 'index.html');
const DRY = process.argv.includes('--dry-run');
const FAST = process.env.ZAMM_FAST === '1';

const TAVILY_KEY = process.env.TAVILY_API_KEY || '';
const COHERE_KEY = process.env.COHERE_API_KEY || '';
const TAVILY_BASE = (process.env.TAVILY_BASE_URL || 'https://api.tavily.com').replace(/\/$/, '');
const COHERE_BASE = (process.env.COHERE_BASE_URL || 'https://api.cohere.com').replace(/\/$/, '');

const sleep = (ms) => new Promise((r) => setTimeout(r, FAST ? 1 : ms));
const log = (...a) => console.log('[zamm-update]', ...a);
const sha = (s) => createHash('sha1').update(s).digest('hex');

class BudgetError extends Error {}

/* ---------------------------------------------------------------- helpers */
async function fetchJson(url, init, label, retries = 2) {
  for (let attempt = 0; ; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 30000);
    let res;
    try {
      res = await fetch(url, { ...init, signal: ctl.signal });
    } catch (e) {
      clearTimeout(timer);
      if (attempt < retries) { await sleep(1500 * (attempt + 1)); continue; }
      throw new Error(`${label}: network error (${e.message})`);
    }
    clearTimeout(timer);
    if (res.ok) return res.json();
    const body = (await res.text()).slice(0, 300).replace(/\s+/g, ' ');
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      const ra = Number(res.headers.get('retry-after'));
      await sleep(Math.min((ra > 0 ? ra : 5 * (attempt + 1)) * 1000, 30000));
      continue;
    }
    throw new Error(`${label}: HTTP ${res.status} ${body}`);
  }
}

// NB: never strip inner "_" or a lone "*": SAP parameter names (em/initial_size_MB) contain
// underscores and documented defaults contain formulas such as "[PM] * 1.5". Only markdown
// wrappers are removed: **bold**, `code`, *italic*, _italic_.
const stripMd = (s) => String(s)
  .replace(/\*\*/g, '').replace(/`/g, '').replace(/\u00a0/g, ' ').trim()
  .replace(/^\*(?!\s)(.+?)\*$/, '$1').replace(/^_+|_+$/g, '').trim();
const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/* ------------------------------------------------- classification helpers */
export function classifyUrl(u) {
  const p = u.pathname;
  if (/\/saphelp_|\/saphelp\//i.test(p)) return 'legacy';      // old per-release help trees
  if (/^\/(docs|doc)\//i.test(p)) return 'current';            // current Help Portal
  return 'other';
}

export function detectPlatform(title, url, text) {
  const h = `${title} ${url} ${String(text).slice(0, 600)}`.toLowerCase();
  const win = /\bwindows\b/.test(h);
  const nix = /\b(unix|linux)\b/.test(h);
  if (win && !nix) return 'windows';
  if (nix && !win) return /linux/.test(h) && !/unix/.test(h) ? 'linux' : 'unix';
  return 'unknown';
}

export function releaseHint(url, title, text) {
  const m1 = url.match(/\/(saphelp_[a-z0-9_]+)\//i);
  if (m1) return m1[1].toLowerCase();
  const m2 = url.match(/[?&]version=([\w.]+)/i);
  if (m2) return m2[1];
  const head = `${title} ${String(text).slice(0, 2000)}`;
  const m3 = head.match(/(S\/4HANA(?:\s+\w+)?\s+20\d{2}|ABAP Platform\s+20\d{2}|SAP NetWeaver\s+7\.\d+(?:\s+EHP\s*\d)?|kernel\s+7\.\d{2,3})/i);
  return m3 ? squash(m3[1]) : '';
}

/* --------------------------------------- deterministic defaults extraction */
const UNIT_RE = /^(byte|bytes|megabyte|megabytes|kilobyte|kilobytes|mb|kb|8\s*kb\s*block|pages?|percent|%)$/i;

function looksLikeValue(v) {
  return !!v && v.length <= 80 && /[\d[]/.test(v) && !/[.!?]\s+[A-Z]/.test(v) && v.split(/\s+/).length <= 12;
}

/** Handles markdown/pipe tables ("| param | default | unit |") and flattened
 *  one-cell-per-line text ("param\n2000000000\nByte"). Only whitelisted params. */
export function extractDefaults(text, tracked) {
  const canonByLower = new Map(tracked.map((p) => [p.toLowerCase(), p]));
  const out = [];
  const seen = new Set();
  const push = (param, def, unit) => {
    def = stripMd(def);
    unit = stripMd(unit || '');
    if (!looksLikeValue(def)) return;
    const k = `${param}|${def}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ param, default: def, unit: UNIT_RE.test(unit) || unit.length <= 20 ? unit : '' });
  };
  const lines = String(text).split(/\r?\n/).map(stripMd).filter((l) => l.length);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.includes('|')) {
      const cells = l.split('|').map(stripMd).filter((c, idx, arr) => !(c === '' && (idx === 0 || idx === arr.length - 1)));
      const canon = canonByLower.get((cells[0] || '').toLowerCase());
      if (canon && cells.length >= 2 && !/^[-: ]+$/.test(cells[1])) push(canon, cells[1], cells[2]);
      continue;
    }
    const canon = canonByLower.get(l.toLowerCase());
    if (canon && i + 1 < lines.length) {
      const next = lines[i + 1];
      if (canonByLower.has(next.toLowerCase())) continue;
      const unit = i + 2 < lines.length && UNIT_RE.test(lines[i + 2]) ? lines[i + 2] : '';
      push(canon, next, unit);
    }
  }
  return out;
}

/** Hallucination guard: every number >= 3 digits and every param-like token in the
 *  summary must literally occur in the source text. */
export function summarySupported(summary, sourceText) {
  const src = sourceText.toLowerCase().replace(/,/g, '');
  const nums = summary.replace(/,/g, '').match(/\d+(?:\.\d+)?/g) || [];
  for (const n of nums) if (n.replace('.', '').length >= 3 && !src.includes(n)) return false;
  const params = summary.match(/\b(?:abap|em|rdisp|ztta|es|icm|rfc|login)\/[A-Za-z0-9_]+/g) || [];
  for (const p of params) if (!src.includes(p.toLowerCase())) return false;
  return true;
}

function focusWindow(text, n, tracked) {
  if (text.length <= n) return text;
  const lower = text.toLowerCase();
  let idx = -1;
  for (const p of tracked) {
    const i = lower.indexOf(p.toLowerCase());
    if (i >= 0 && (idx < 0 || i < idx)) idx = i;
  }
  if (idx < 0) idx = Math.max(0, lower.indexOf('memory'));
  const start = Math.max(0, idx - Math.floor(n / 4));
  return text.slice(start, start + n);
}

/* ------------------------------------------------ tool code: single source of truth is index.html */
function sliceBlock(html, name) {
  const a = html.indexOf(`/* <${name}> */`), b = html.indexOf(`/* </${name}> */`);
  if (a < 0 || b < a) throw new Error(`marker <${name}> not found in index.html`);
  return html.slice(a, b);
}
/** Loads the REAL calcZAMM and evalDocExpr out of index.html (our own repo file, not remote data). */
export function loadToolCode(html) {
  const code = `${sliceBlock(html, 'zamm-calc')}\n${sliceBlock(html, 'doc-expr')}`;
  return new Function(`${code}\nreturn { calcZAMM: calcZAMM, evalDocExpr: evalDocExpr };`)();
}

function evalDocValue(tool, expr, lookup) {
  const t = String(expr).trim();
  const m64 = t.match(/(\d[\d,]*)\s*[\[(]\s*(\d[\d,]*)\s+on\s+64\s*bit\s*[\])]/i);
  if (m64) return Number(m64[2].replace(/,/g, ''));
  if (/^\d[\d,]*$/.test(t)) return Number(t.replace(/,/g, ''));
  const r = tool.evalDocExpr(t, lookup);
  return r.ok ? r.value : null;
}

const entriesFromRows = (rows) => rows.flatMap((r) => r.variants.map((v) => ({
  param: r.param, default: v.expr, unit: '', platforms: v.platforms || [], ...(v.restriction ? { restriction: v.restriction } : {})
})));

/** Compare the calculator with every documented formula of the seed documents (per OS and RAM size). */
export function runToolCheck(tool, sources, entries, cfg) {
  const grid = cfg.toolCheck?.grid || { ramGB: [16, 64, 128, 512], os: ['windows', 'linux', 'unix', 'aix'] };
  const known = cfg.knownDifferences || [];
  const srcById = new Map(sources.map((s) => [s.id, s]));
  const groups = new Map();
  for (const e of entries) {
    const s = srcById.get(e.sourceId);
    if (!s || !s.seed || s.stale || !['current', 'nw740'].includes(s.basis)) continue;
    const k = `${e.sourceId}|${e.param}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  const covered = { current: new Set(), nw740: new Set() };
  const drift = [];
  for (const [k, list] of groups) {
    const sourceId = k.slice(0, k.indexOf('|')), param = k.slice(k.indexOf('|') + 1);
    const basis = srcById.get(sourceId).basis;
    const failing = [];
    let total = 0;
    for (const os of grid.os) for (const ram of grid.ramGB) {
      const PM = (ram - 2) * 1024;
      const calc = tool.calcZAMM(PM, os, basis);
      const key = Object.keys(calc).find((x) => x.toLowerCase() === param.toLowerCase());
      if (!key) continue;                                                       // calculator does not compute this parameter
      const lookup = (n) => {
        if (n.toLowerCase() === 'phys_memsize') return PM;
        const kk = Object.keys(calc).find((x) => x.toLowerCase() === n.toLowerCase());
        return kk ? calc[kk] : undefined;
      };
      const applicable = list.filter((e) => !e.platforms || !e.platforms.length || e.platforms.includes(os));
      const vals = applicable.map((e) => evalDocValue(tool, e.default, lookup)).filter((v) => v !== null);
      if (!vals.length) continue;
      total++;
      // the kernel rounds derived values to the nearest integer, so compare with a half-unit tolerance
      if (!vals.some((v) => Math.abs(v - calc[key]) <= 0.5001)) failing.push({ os, ramGB: ram, tool: calc[key], documented: vals.map((v) => Math.round(v * 100) / 100) });
    }
    if (total) covered[basis].add(param.toLowerCase());
    if (failing.length) {
      const osFail = [...new Set(failing.map((f) => f.os))];
      const kd = known.find((x) => x.param.toLowerCase() === param.toLowerCase() && x.basis === basis && (!x.os || osFail.every((o) => x.os.includes(o))));
      drift.push({ param, basis, sourceId, failing: failing.length, total, os: osFail, examples: failing.slice(0, 3), ...(kd ? { acknowledged: true, reason: kd.reason } : {}) });
    }
  }
  const uncovered = {};
  for (const basis of ['current', 'nw740']) {
    if (![...srcById.values()].some((s) => s.seed && s.basis === basis && !s.stale)) continue;
    uncovered[basis] = Object.keys(tool.calcZAMM(129024, 'linux', basis)).filter((x) => !covered[basis].has(x.toLowerCase()));
  }
  return {
    ranAt: new Date().toISOString(), grid,
    covered: { current: [...covered.current], nw740: [...covered.nw740] }, uncovered,
    drift: drift.filter((d) => !d.acknowledged), acknowledged: drift.filter((d) => d.acknowledged)
  };
}

/** Reads a document the user placed in the repo / working copy: PDF (via pdftotext -layout) or plain/markdown text. */
function readLocalDocument(file) {
  const buf = readFileSync(file);
  if (buf.length > 60 * 1024 * 1024) throw new Error('file too large');
  if (buf.subarray(0, 4).toString() === '%PDF') {
    const r = spawnSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8', maxBuffer: 200 * 1024 * 1024 });
    if (r.error || r.status !== 0) throw new Error('pdftotext unavailable or failed (install poppler-utils)');
    return r.stdout;
  }
  return buf.toString('utf8');
}

/** Direct download of a Help Portal document (PDF export or text). PDF -> pdftotext -layout (needs poppler-utils). */
async function fetchFallbackText(url) {
  const u = new URL(url);
  if (process.env.ZAMM_ALLOW_ANY_HOST !== '1' && !(u.protocol === 'https:' && (u.hostname === 'help.sap.com' || u.hostname.endsWith('.help.sap.com')))) {
    throw new Error('fallback URL must be https://help.sap.com/...');
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 60000);
  let res;
  try { res = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'zamm-knowledge-bot' } }); }
  finally { clearTimeout(timer); }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 40 * 1024 * 1024) throw new Error('document too large');
  if ((res.headers.get('content-type') || '').toLowerCase().includes('pdf') || buf.subarray(0, 4).toString() === '%PDF') {
    const dir = mkdtempSync(path.join(tmpdir(), 'zamm-pdf-'));
    try {
      const f = path.join(dir, 'doc.pdf');
      writeFileSync(f, buf);
      const r = spawnSync('pdftotext', ['-layout', f, '-'], { encoding: 'utf8', maxBuffer: 200 * 1024 * 1024 });
      if (r.error || r.status !== 0) throw new Error('pdftotext unavailable or failed (install poppler-utils)');
      return r.stdout;
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  return buf.toString('utf8');
}

/* ------------------------------------------------------------------- main */
async function main() {
  const cfg = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
  const models = {
    rerank: process.env.COHERE_RERANK_MODEL || cfg.models.rerank,
    chat: process.env.COHERE_CHAT_MODEL || cfg.models.chat
  };
  const limits = cfg.limits;
  const gapMs = process.env.ZAMM_COHERE_GAP_MS !== undefined ? Number(process.env.ZAMM_COHERE_GAP_MS) : limits.cohereMinGapMs;
  const used = { tavily: 0, cohere: 0 };
  const errors = [];
  const now = new Date().toISOString();

  if (!TAVILY_KEY) {
    console.error('[zamm-update] TAVILY_API_KEY is not set - nothing was changed.');
    process.exit(1);
  }
  if (!COHERE_KEY) log('COHERE_API_KEY not set: continuing without rerank/summaries (Tavily-only mode).');

  let prev = null;
  try { prev = JSON.parse(await readFile(OUT_PATH, 'utf8')); } catch { /* first run */ }

  /* ---- 1. Tavily search ---- */
  const byUrl = new Map();
  let tavilyFailures = 0;
  for (const q of cfg.queries) {
    try {
      const credits = cfg.searchDepth === 'advanced' ? 2 : 1;
      if (used.tavily + credits > limits.maxTavilyCredits) throw new BudgetError('Tavily credit cap reached');
      used.tavily += credits;
      const res = await fetchJson(`${TAVILY_BASE}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TAVILY_KEY}` },
        body: JSON.stringify({
          query: q, search_depth: cfg.searchDepth, max_results: cfg.maxResultsPerQuery,
          include_domains: cfg.domains, include_raw_content: true, include_answer: false, include_images: false
        })
      }, 'tavily');
      for (const r of Array.isArray(res.results) ? res.results : []) {
        let u; try { u = new URL(r.url); } catch { continue; }
        if (u.protocol !== 'https:' || !(u.hostname === 'help.sap.com' || u.hostname.endsWith('.help.sap.com'))) continue;
        const text = String(r.raw_content || r.content || '');
        const prevHit = byUrl.get(u.href);
        if (!prevHit || (r.score || 0) > prevHit.tavilyScore) {
          byUrl.set(u.href, { url: u.href, urlObj: u, title: squash(r.title).slice(0, 160), content: String(r.content || ''), text, tavilyScore: Number(r.score) || 0 });
        }
      }
    } catch (e) {
      if (e instanceof BudgetError) { errors.push(e.message); break; }
      tavilyFailures++;
      errors.push(e.message);
      log('query failed:', e.message);
    }
  }

  /* ---- 1b. Seed documents (Tavily Extract; fallback = PDF export) ---- */
  const seedStatus = [];
  const seedCands = [];
  const carried = { sources: [], entries: [] };
  const seeds = cfg.seeds || [];
  if (seeds.length) {
    const extracted = new Map();
    const extractFailed = [];
    const hasLocal = (sd) => !!(sd.file && existsSync(path.resolve(ROOT, sd.file)));
    const withUrl = seeds.filter((sd) => sd.url && !hasLocal(sd));          // a seed served from a local file costs no Tavily credits
    if (withUrl.length) {
      try {
        const depth = cfg.seedExtractDepth || 'advanced';
        const credits = Math.ceil(withUrl.length / 5) * (depth === 'advanced' ? 2 : 1);
        if (used.tavily + credits > limits.maxTavilyCredits) throw new BudgetError('Tavily credit cap reached (seed extract)');
        used.tavily += credits;
        // NB: no "query"/"chunks_per_source" - those would truncate raw_content to snippets.
        const res = await fetchJson(`${TAVILY_BASE}/extract`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TAVILY_KEY}` },
          body: JSON.stringify({ urls: withUrl.map((x) => x.url), extract_depth: depth, format: 'markdown', include_images: false, timeout: depth === 'advanced' ? 60 : 20 })
        }, 'tavily-extract');
        for (const r of Array.isArray(res.results) ? res.results : []) extracted.set(r.url, String(r.raw_content || ''));
        for (const f of Array.isArray(res.failed_results) ? res.failed_results : []) extractFailed.push(typeof f === 'string' ? f : (f && (f.url || JSON.stringify(f))));   // only reported if the seed ends up unusable
      } catch (e) { errors.push(e.message); log('seed extract failed:', e.message); }
    }
    for (const sd of seeds) {
      const min = sd.minRows ?? cfg.minRowsPerSeed ?? 6;
      let text = sd.url ? (extracted.get(sd.url) || '') : '';
      let via = 'tavily';
      if (hasLocal(sd)) {          // a document you downloaded yourself (compliant, verifiable route)
        try { text = readLocalDocument(path.resolve(ROOT, sd.file)); via = 'file'; }
        catch (e) { errors.push(`seed ${sd.id}: local file unreadable (${e.message})`); }
      }
      let rows = text ? parseTables(text, cfg.trackedParams) : [];
      let ferr = '';
      if (rows.length < min && sd.pdfUrl && via !== 'file') {
        try {
          const t2 = await fetchFallbackText(sd.pdfUrl);
          const r2 = parseTables(t2, cfg.trackedParams);
          if (r2.length > rows.length || !text) { text = t2; rows = r2; via = 'pdf'; }
        } catch (e) { ferr = e.message; errors.push(`seed ${sd.id}: PDF fallback failed (${e.message})`); }
      }
      const ok = rows.length >= min && (min === 0 ? !!text : true);
      seedStatus.push({ id: sd.id, via: text ? via : 'none', rows: rows.length, min, ok, ...(ferr ? { error: ferr } : {}) });
      if (!ok) errors.push(`seed ${sd.id}: ${rows.length} parameter rows found (expected >= ${min}) via ${text ? via : 'no content'}${extractFailed.includes(sd.url) ? ' (Tavily Extract reported this URL as failed)' : ''}`);
      const prevSrc = (prev?.sources || []).find((x) => x.id === sd.id);
      if (!ok && prevSrc) {                                         // never replace good seed data with a weak parse
        carried.sources.push({ ...prevSrc, stale: true });
        carried.entries.push(...(prev.documentedDefaults || []).filter((d) => d.sourceId === sd.id));
        continue;
      }
      if (text) {
        const meta = parseDocMeta(text);
        seedCands.push({
          id: sd.id, url: sd.url || sd.pdfUrl, title: String(sd.label || sd.id).slice(0, 160), kind: 'current', platform: 'unknown',
          release: meta.release, docRelease: `${meta.product} ${meta.release}`.trim(), docVersion: meta.version,
          basis: sd.basis || 'none', seed: true, via, score: 1, content: `${meta.product} | ${meta.release}`.slice(0, 240),
          defaults: entriesFromRows(rows)
        });
      }
    }
  }
  let candidates = [...byUrl.values()];
  if (!candidates.length && !seedCands.length) {            // carried-forward seed data is not "fresh": never restamp generatedAt with it
    console.error(`[zamm-update] No usable results (${tavilyFailures} failed queries, ${seedStatus.length} seeds). Existing data file left untouched.`);
    process.exit(1);
  }

  /* ---- 2. Deterministic enrichment ---- */
  for (const c of candidates) {
    c.kind = classifyUrl(c.urlObj);
    c.platform = detectPlatform(c.title, c.url, c.text);
    c.release = releaseHint(c.url, c.title, c.text);
    const rows = parseTables(c.text, cfg.trackedParams);
    c.defaults = rows.length ? entriesFromRows(rows) : extractDefaults(c.text, cfg.trackedParams);
    c.id = sha(c.url).slice(0, 8);
  }

  /* ---- 3. Cohere rerank (optional) ---- */
  const cohere = async (endpoint, body, label) => {
    if (used.cohere >= limits.maxCohereCalls) throw new BudgetError('Cohere call cap reached');
    used.cohere++;
    if (gapMs > 0 && used.cohere > 1) await sleep(gapMs);
    return fetchJson(`${COHERE_BASE}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${COHERE_KEY}` },
      body: JSON.stringify(body)
    }, label);
  };

  let reranked = false;
  if (COHERE_KEY) {
    try {
      const docs = candidates.map((c) => focusWindow(c.text || c.content, 1800, cfg.trackedParams));
      const res = await cohere('/v2/rerank', { model: models.rerank, query: cfg.rerankQuery, documents: docs, top_n: docs.length }, 'cohere-rerank');
      for (const r of res.results || []) if (candidates[r.index]) candidates[r.index].rerank = Number(r.relevance_score);
      reranked = candidates.some((c) => typeof c.rerank === 'number');
      if (!reranked) errors.push('cohere-rerank: response had no scores');
    } catch (e) { errors.push(e.message); log('rerank skipped:', e.message); }
  }

  candidates.forEach((c) => { c.score = reranked && typeof c.rerank === 'number' ? c.rerank : c.tavilyScore; });
  candidates = candidates.filter((c) => {
    if (c.defaults.length) return true;                 // yields tracked parameters -> relevant by construction
    if (c.kind === 'legacy') return false;              // legacy pages without parameters are just noise
    return reranked ? c.score >= cfg.minRelevance : true;
  });
  const kindRank = { current: 0, other: 1, legacy: 2 };
  candidates.sort((a, b) => kindRank[a.kind] - kindRank[b.kind] || b.score - a.score);
  candidates = candidates.slice(0, cfg.maxSources);

  /* ---- 4. Cohere summaries (optional, validated) ---- */
  const advisories = [];
  if (COHERE_KEY && reranked) {
    for (const c of candidates.filter((x) => x.kind !== 'legacy').slice(0, cfg.maxSummaries)) {
      try {
        const excerpt = focusWindow(c.text || c.content, 6000, cfg.trackedParams);
        const prompt =
          'You summarise SAP Help Portal pages for SAP BASIS administrators.\n' +
          'Using ONLY the text between <page> tags, return a single JSON object: ' +
          '{"summary": string (max 280 characters, about memory-management / work-process parameter guidance), "relevance": "high"|"medium"|"low"}.\n' +
          'Rules: do not add any number, parameter name or SAP Note that is not in the text. ' +
          'If the text has nothing relevant, return {"summary":"","relevance":"low"}. Output JSON only.\n' +
          `<page title="${c.title.replace(/"/g, "'")}">\n${excerpt}\n</page>`;
        const res = await cohere('/v2/chat', { model: models.chat, temperature: 0, max_tokens: 300, messages: [{ role: 'user', content: prompt }] }, 'cohere-chat');
        const raw = (res.message?.content || []).map((p) => p.text || '').join('');
        const j = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
        const parsed = JSON.parse(j);
        const summary = squash(parsed.summary).slice(0, 300);
        if (!summary || parsed.relevance === 'low') continue;
        if (!summarySupported(summary, c.text || c.content)) { log('summary dropped (unsupported figures):', c.id); continue; }
        advisories.push({ sourceId: c.id, summary, relevance: parsed.relevance === 'high' ? 'high' : 'medium' });
      } catch (e) {
        errors.push(e.message);
        log('summary skipped:', e.message);
        if (e instanceof BudgetError || /HTTP 4(01|03|04|29)/.test(e.message)) break;
      }
    }
  }

  /* ---- 5. Assemble + diff ---- */
  const toSource = (c) => ({
    id: c.id, url: c.url, title: c.title, kind: c.kind, platform: c.platform, release: c.release,
    ...(c.seed ? { seed: true, basis: c.basis, docRelease: c.docRelease, docVersion: c.docVersion, via: c.via } : {}),
    score: Math.round(c.score * 1000) / 1000, scoreBy: c.seed ? 'seed' : (reranked && typeof c.rerank === 'number' ? 'cohere-rerank' : 'tavily'),
    snippet: squash(c.content).slice(0, 240), retrievedAt: now
  });
  const toEntries = (c) => c.defaults.map((d) => ({
    param: d.param, default: d.default, unit: d.unit || '', platform: c.platform,
    ...(d.platforms ? { platforms: d.platforms } : {}), ...(d.restriction ? { restriction: d.restriction } : {}), sourceId: c.id
  }));
  const sources = [...seedCands.map(toSource), ...carried.sources, ...candidates.map(toSource)];
  const documentedDefaults = [...seedCands.flatMap(toEntries), ...carried.entries, ...candidates.flatMap(toEntries)];

  const groupExprs = (list) => {
    const m = new Map();
    for (const d of list) { const k = `${d.param}|${d.sourceId}`; if (!m.has(k)) m.set(k, new Set()); m.get(k).add(d.default); }
    return new Map([...m].map(([k, v]) => [k, [...v].sort().join(' || ')]));
  };
  const prevG = groupExprs(prev?.documentedDefaults || []), nowG = groupExprs(documentedDefaults);
  const platformOf = new Map(documentedDefaults.map((d) => [`${d.param}|${d.sourceId}`, d.platform]));
  const changes = [];
  for (const [k, v] of nowG) {
    const o = prevG.get(k);
    if (o !== undefined && o !== v) {
      const [param, sourceId] = [k.slice(0, k.lastIndexOf('|')), k.slice(k.lastIndexOf('|') + 1)];
      changes.push({ param, platform: platformOf.get(k), sourceId, was: o, now: v, detectedAt: now });
    }
  }
  const prevIds = new Set((prev?.sources || []).map((s) => s.id));
  const newSources = sources.filter((s) => !prevIds.has(s.id)).length;

  let toolCheck = null;
  try {
    const tool = loadToolCode(await readFile(HTML_PATH, 'utf8'));
    toolCheck = runToolCheck(tool, sources, documentedDefaults, cfg);
  } catch (e) { errors.push(`tool check skipped: ${e.message}`); log('tool check skipped:', e.message); }

  const out = {
    schemaVersion: 1,
    status: errors.length ? 'partial' : 'ok',
    generatedAt: now,
    staleAfterDays: cfg.staleAfterDays,
    run: { queries: cfg.queries.length, tavilyCredits: used.tavily, cohereCalls: used.cohere, reranked, summaries: advisories.length, seeds: seedStatus, errors: errors.slice(0, 10) },
    sources,
    documentedDefaults,
    advisories,
    changes,
    ...(toolCheck ? { toolCheck } : {}),
    changeLog: [...changes, ...(prev?.changeLog || [])].slice(0, 25)
  };

  const line = `${out.status.toUpperCase()}: ${sources.length} sources (${newSources} new), ${documentedDefaults.length} documented defaults, ` +
    `${advisories.length} summaries, ${changes.length} changed defaults, seeds ${seedStatus.filter((x) => x.ok).length}/${seedStatus.length} ok, ` +
    `calculator drift ${toolCheck ? toolCheck.drift.length : 'n/a'} (${toolCheck ? toolCheck.acknowledged.length : 0} acknowledged) | Tavily credits ${used.tavily}, Cohere calls ${used.cohere}`;
  log(line);
  if (errors.length) log('notes:', errors.join(' || ').slice(0, 600));

  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `### ZAMM knowledge refresh\n${line}\n` +
      (changes.length ? changes.map((c) => `- **${c.param}** (${c.platform}): \`${c.was}\` -> \`${c.now}\``).join('\n') + '\n' : '') +
      (toolCheck && toolCheck.drift.length ? '\n**Calculator drift vs documentation:**\n' + toolCheck.drift.map((d) => `- **${d.param}** [${d.basis}] ${d.failing}/${d.total} grid points differ, e.g. ${JSON.stringify(d.examples[0])}`).join('\n') + '\n' : '')).catch(() => {});
  }
  if (DRY) { log('dry-run: file not written'); return; }
  await mkdir(path.dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(out, null, 2) + '\n');
  log('wrote', path.relative(process.cwd(), OUT_PATH));
}

import { pathToFileURL } from 'node:url';
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => { console.error('[zamm-update] FATAL:', e.message); process.exit(1); });
}
