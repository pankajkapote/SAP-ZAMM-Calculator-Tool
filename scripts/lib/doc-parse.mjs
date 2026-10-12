/**
 * Parsers for SAP Help "Parameter Reference" tables.
 *
 * Input formats handled
 *   1. Markdown / pipe tables  (what a web extractor such as Tavily Extract is expected to return)
 *        | Profile Parameter | Description | Default value | Unit | Restrictions |
 *   2. Layout text            (pdftotext -layout of the Help Portal PDF export; columns found from the header line)
 *
 * Output: rows = [{ param, variants: [{ expr, restriction, platforms }] }]
 *   - one row can carry several variants (e.g. em/max_size_MB: Windows formula vs. other platforms)
 *   - platforms = [] means "not stated / could not be aligned"  (the consumer must treat it as unlabeled)
 *
 * Nothing here evaluates formulas; evaluation lives in index.html (single source of truth, see evalDocExpr).
 */

const FOOTER_RE = /This is custom documentation|^\s*\d{1,2}\/\d{1,2}\/\d{2},\s*\d{1,2}:\d{2}\s*[AP]M\s*$/;
const IDENT_RE = /^[A-Za-z][A-Za-z0-9_]*(?:\/[A-Za-z0-9_]+)*$/;

// NB: never strip a lone "*": it is the multiplication operator in documented formulas ("$(PHYS_MEMSIZE) * 0.7").
// Only markdown wrappers are removed: **bold**, `code`.
const clean = (s) => String(s).replace(/\u00a0/g, ' ').replace(/\*\*/g, '').replace(/`/g, '').replace(/\s+/g, ' ').trim();

/** Does this cell text look like a parameter default (formula / number) rather than prose? */
export function looksLikeDefault(v) {
  const t = clean(v);
  if (!t || t.length > 200) return false;
  if (/\$\(/.test(t) || /\[(PM|MM|BE)\]/i.test(t)) return true;                 // formula or [PM]-style
  if (/^\(?\s*(min|max|floor|ceil|sqrt)\s*\(/i.test(t)) return true;
  if (/^\(?\s*\d[\d,.]*\s*\)?(\s*(\*|\/|\+|-)\s*\(?\s*\d[\d,.]*\s*\)?)*$/.test(t)) return true;   // 4096, 2000000000, 1000*2
  if (/^\d[\d,]*\s*[\[(]\s*[^)\]]*on 64 bit\s*[\])]$/i.test(t)) return true;
  return false;
}

export function platformsFromLabel(label) {
  const l = String(label).toLowerCase();
  const out = new Set();
  if (/windows/.test(l)) out.add('windows');
  if (/linux/.test(l)) out.add('linux');
  if (/\bunix\b/.test(l)) out.add('unix');
  if (/\baix\b/.test(l)) out.add('aix');
  if (/ibm i|os\/?400/.test(l)) out.add('ibmi');
  if (/z\/os|os390/.test(l)) out.add('zos');
  return [...out];
}

/** Split one table cell into its top-level parenthesised formulas, or fall back to <br>/newline pieces. */
export function splitVariants(cell) {
  const pieces = String(cell).split(/<br\s*\/?>|\n/).map(clean).filter(Boolean);
  const out = [];
  for (const p of pieces) {
    const groups = [];
    let depth = 0, start = -1;
    for (let i = 0; i < p.length; i++) {
      if (p[i] === '(') { if (depth === 0) start = i; depth++; }
      else if (p[i] === ')') { depth--; if (depth === 0 && start >= 0) { groups.push(p.slice(start, i + 1)); start = -1; } }
    }
    const rest = groups.reduce((acc, g) => acc.replace(g, ''), p).trim();
    if (groups.length > 1 && rest === '') out.push(...groups);                 // "(a) (b)"  ->  two variants
    else out.push(p);
  }
  return out.filter(looksLikeDefault);
}

/** groups = one label string per line / <br> in the Restrictions cell ("UNIX, Windows, AIX" stays ONE group).
 *  Returns, per variant, the platform list - or null when the groups cannot be aligned with the variants. */
function alignGroups(variantCount, groups) {
  if (!groups.length) return Array.from({ length: variantCount }, () => ({ restriction: '', platforms: [] }));
  const mk = (g) => ({ restriction: g.join(', '), platforms: [...new Set(g.flatMap(platformsFromLabel))] });
  if (variantCount === 1) return [mk(groups)];
  if (groups.length === variantCount) return groups.map((g) => mk([g]));
  return null;
}

/* ------------------------------------------------------------ pipe tables */
export function parsePipeTables(text, tracked) {
  const canon = new Map(tracked.map((p) => [p.toLowerCase(), p]));
  const rows = [];
  let cols = null;                                              // {def, unit, restr} cell indexes
  for (const raw of String(text).split(/\r?\n/)) {
    if (!raw.includes('|')) { if (raw.trim() && !/^\s*[-: |]+$/.test(raw)) cols = cols && /\|/.test(raw) ? cols : null; continue; }
    const cells = raw.split('|').map((c) => c.trim());
    if (cells[0] === '') cells.shift();
    if (cells.length && cells[cells.length - 1] === '') cells.pop();
    if (!cells.length || cells.every((c) => /^[-: ]*$/.test(c))) continue;      // separator row
    const first = clean(cells[0]).toLowerCase();
    if (/^(profile )?parameter( name)?$/.test(first)) {                          // header row
      const idx = (re) => cells.findIndex((c) => re.test(c));
      cols = { def: idx(/default/i), unit: idx(/^unit/i), restr: idx(/restriction|platform/i) };
      continue;
    }
    const param = canon.get(first);
    if (!param) continue;
    let defCell;
    if (cols && cols.def > 0) defCell = cells[cols.def];
    else defCell = cells.slice(1).find((c) => splitVariants(c).length);          // headerless: first value-looking cell
    if (!defCell) continue;
    const variants = splitVariants(defCell);
    if (!variants.length) continue;
    const groups = cols && cols.restr > 0 && cells[cols.restr]
      ? String(cells[cols.restr]).split(/<br\s*\/?>|\n/).map(clean).filter(Boolean) : [];
    const aligned = alignGroups(variants.length, groups);
    rows.push({
      param,
      variants: variants.map((expr, i) => ({
        expr, restriction: aligned ? aligned[i].restriction : groups.join(' / '),
        platforms: aligned ? aligned[i].platforms : []
      }))
    });
  }
  return rows;
}

/* ------------------------------------------------------------ layout text */
function headerCols(line) {
  const at = (re, from = 0) => { const m = re.exec(line.slice(from)); return m ? m.index + from : -1; };
  const param = at(/Profile Parameter/);
  const desc = at(/Description/, param + 1);
  const def = at(/Default/i, param + 1);
  const unit = at(/\bUn(it)?\b/, def + 1);
  const restr = at(/Restrictions?/, def + 1);
  if (param < 0 || def < 0) return null;
  const paramEnd = desc > 0 && desc < def ? desc : def;
  const defEnd = unit > 0 ? unit : restr > 0 ? restr : line.length + 60;
  return { paramStart: param, paramEnd, def, defEnd, restr };
}

export function parseLayoutTables(text, tracked) {
  const canon = new Map(tracked.map((p) => [p.toLowerCase(), p]));
  const rows = [];
  let hdr = null, cur = null, ctxPlatforms = [];
  const recent = [];                                   // last short non-table lines (section headings)
  const flush = () => {
    if (cur) {
      // variant groups = contiguous non-empty runs of the default column
      const groups = [];
      let g = null;
      cur.lines.forEach((l, i) => {
        const d = l.def.trim();
        if (d) { if (!g) { g = { start: i, text: [] }; groups.push(g); } g.text.push(d); } else g = null;
      });
      const variants = [];
      groups.forEach((gr, gi) => {
        const expr = clean(gr.text.join(' '));
        if (!looksLikeDefault(expr)) return;
        const end = gi + 1 < groups.length ? groups[gi + 1].start : cur.lines.length;
        const labels = cur.lines.map((l, i) => (i >= gr.start && i < end ? l.restr.trim() : '')).filter(Boolean);
        variants.push({ expr, restriction: labels.join(', '), platforms: [...new Set(labels.flatMap(platformsFromLabel))] });
      });
      for (const v of variants) if (!v.platforms.length && ctxPlatforms.length) { v.platforms = [...ctxPlatforms]; v.inferred = true; }
      if (variants.length) rows.push({ param: cur.param, variants });
    }
    cur = null;
  };
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/\f/g, '');
    if (!line.trim() || FOOTER_RE.test(line)) continue;
    if (/^\s*Profile Parameter\b/.test(line)) {
      flush(); hdr = headerCols(line);
      // Only an explicit section heading counts ("Overview of Profile parameters for Windows"); prose such as
      // "Caution: On AIX there are ..." must never label a table.
      const hm = recent.map((l) => /^Overview of (?:Profile )?Parameters? for (Windows|UNIX|Linux|AIX)\b/i.exec(l)).filter(Boolean).pop();
      ctxPlatforms = hm ? platformsFromLabel(hm[1]) : [];
      continue;
    }
    if (!hdr) { const t = line.trim(); if (t.length < 90) recent.push(t); if (recent.length > 12) recent.shift(); continue; }
    const pcell = line.slice(hdr.paramStart, hdr.paramEnd).trim();
    if (pcell) {
      flush();
      if (!IDENT_RE.test(pcell)) { hdr = null; continue; }                 // heading/prose line: table ended
      const canonName = canon.get(pcell.toLowerCase());
      if (!canonName) continue;                                            // untracked row: ignore its lines too
      cur = { param: canonName, lines: [] };
    }
    if (cur) cur.lines.push({
      def: line.slice(hdr.def, hdr.defEnd),
      restr: hdr.restr > 0 ? line.slice(hdr.restr) : ''
    });
  }
  flush();
  return rows;
}

/** Document header such as "ABAP platform | 2025 FPS02 (Oct 2026)" / "SAP NetWeaver 7.4 | SPS31" / "...version=202510.002". */
export function parseDocMeta(text) {
  const head = String(text).slice(0, 4000);
  const out = { product: '', release: '', version: '' };
  const m = head.match(/^\s*([^\n|]{3,60}?)\s*\|\s*([^\n]*(?:FPS|SPS|SP|20\d\d)[^\n]*)$/m);
  if (m) { out.product = clean(m[1]); out.release = clean(m[2]); }
  const v = head.match(/version=([0-9][0-9.]*)/i);
  if (v) out.version = v[1].replace(/\.$/, '');
  return out;
}

/** Both parsers; result de-duplicated by param+expression. */
export function parseTables(text, tracked) {
  const rows = [...parsePipeTables(text, tracked), ...parseLayoutTables(text, tracked)];
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const variants = r.variants.filter((v) => { const k = `${r.param}|${v.expr}|${v.restriction}`; if (seen.has(k)) return false; seen.add(k); return true; });
    if (variants.length) out.push({ param: r.param, variants });
  }
  return out;
}
