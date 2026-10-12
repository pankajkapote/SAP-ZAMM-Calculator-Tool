#!/usr/bin/env node
/**
 * Prints the Markdown body for the "calculator drift" GitHub issue, or NOTHING when there is no
 * unacknowledged drift (so the workflow can test `[ -n "$body" ]`).   Usage: node scripts/drift-issue-body.mjs [data/zamm-live.json]
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function driftIssueBody(data) {
  const drift = data?.toolCheck?.drift;
  if (!Array.isArray(drift) || !drift.length) return '';
  const fmt = (n) => (typeof n === 'number' ? String(n) : JSON.stringify(n));
  const items = drift.map((d) => {
    const e = d.examples?.[0] || {};
    return `- \`${d.param}\` [${d.basis}] - ${d.failing} of ${d.total} checks differ (OS: ${(d.os || []).join(', ')}), e.g. ` +
           `${e.os} / ${e.ramGB} GB: calculator ${fmt(e.tool)} vs documented ${(e.documented || []).map(fmt).join(' or ')}`;
  });
  const seeds = (data.run?.seeds || []).map((s) => `${s.id} (${s.via}, ${s.rows} rows)`).join('; ');
  return [
    `The SAP Help documentation and the calculator disagree (checked ${data.toolCheck.ranAt || '?'}).`, '',
    'Either SAP changed a documented default, or `calcZAMM()` in `index.html` needs updating, or the seed parse needs a fix.', '',
    ...items, '',
    `Seeds: ${seeds || 'n/a'}`, '',
    'Full details: `data/zamm-live.json` -> `toolCheck`. Known, acknowledged differences live in `scripts/config.json` -> `knownDifferences`.'
  ].join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try { process.stdout.write(driftIssueBody(JSON.parse(readFileSync(process.argv[2] || 'data/zamm-live.json', 'utf8')))); }
  catch (e) { console.error('[drift-issue] cannot read data file:', e.message); }
}
