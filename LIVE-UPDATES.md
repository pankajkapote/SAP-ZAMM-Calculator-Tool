# ZAMM Calculator – live SAP Help updates

The calculator's formulas stay **built in** (it always works, even offline). A scheduled job reads the SAP Help documents, extracts their
parameter tables **deterministically**, and then **checks the calculator against them**. The page shows the result; a GitHub issue is opened when they disagree.

```
GitHub Actions (weekly)
 1. SEED documents (scripts/config.json -> seeds):  ABAP platform · NetWeaver 7.4 · Application Server Infrastructure
      Tavily Extract (advanced) ──if too few table rows──►  PDF export download + pdftotext
 2. Tavily Search (help.sap.com only) for extra pages  ──►  Cohere rerank + validated summaries
 3. table-aware parser: parameter | default FORMULA | platform labels      (no LLM touches numbers)
 4. DRIFT CHECK: loads the real calcZAMM + formula evaluator out of index.html and compares every documented formula
    for 4 OS types × 4 RAM sizes, per release basis
 5. commit data/zamm-live.json  ──►  Vercel redeploys  ──►  page shows "Live SAP Help Cross-check" + drift banner
    └─ unacknowledged drift  ──►  GitHub issue "ZAMM calculator disagrees with SAP Help documentation"
```

**Why the calculator is not rewritten automatically.** These are sizing formulas. Letting scraped web text silently change them is the wrong failure mode:
a layout change or a mis-parsed cell would corrupt every result. The pipeline therefore *detects and reports*; a human updates `calcZAMM()` (the drift issue tells you which
parameter, which OS/RAM, tool vs documented value). Cohere is used for relevance filtering and short, number-validated summaries of search hits – never to extract numbers.

## Setup (≈10 minutes)
1. Free keys: Tavily (app.tavily.com), Cohere trial (dashboard.cohere.com/api-keys).
2. Repo → Settings → Secrets and variables → Actions: `TAVILY_API_KEY`, `COHERE_API_KEY` (Cohere optional).
3. Copy into the repo root: `index.html`, `data/`, `scripts/`, `.github/workflows/`, `package.json`, `.gitignore`, `.env.example`.
4. **Set the seed URLs** (see below), then Actions → "Update ZAMM live knowledge" → *Run workflow*.
5. Open the page: header shows *"SAP Help data refreshed …"*; the card shows *"Calculator and SAP Help agree …"* or a drift warning.

### Seed documents: three routes, in this order (per seed in `config.seeds`)
1. **`file`** – a document **you downloaded yourself** (the Help Portal "Download PDF"), e.g. `data/sources/abap-platform.pdf`. Parsed with `pdftotext` (poppler-utils). No network, no Tavily credits, fully verifiable – tested with a real PDF.
2. **`url`** – the topic page, read by **Tavily Extract** (advanced). Set to the "Parameter Reference of SAP Memory Management" topic of each release (already filled in).
3. **`pdfUrl`** – the Help Portal PDF export, downloaded directly.

**Robots / terms of use – please read.** While preparing this update, the fetcher I use was **refused by help.sap.com's robots rules** (`ROBOTS_DISALLOWED`) for the ABAP Platform topic URL you supplied (I did not try the NW 7.4 one).
A scheduled job that scrapes the portal may be refused the same way – and automated access may conflict with SAP's terms of use. I could not test Tavily Extract or the PDF export URL from here.
The route that is both verifiable and unambiguous is **#1: download the PDFs yourself when SAP publishes a new release, drop them into `data/sources/`, run `npm run update` locally, commit only the resulting `data/zamm-live.json`.**
`data/sources/` is git-ignored on purpose (SAP's documents are SAP's copyright – do not publish them in a public repository). The weekly GitHub Action then runs the Tavily routes (#2/#3) only if you enable them, and a seed that fails keeps its last good data (flagged *stale*).
Check `run.seeds` in `data/zamm-live.json` after each run: per seed `via` (file / tavily / pdf), `rows` found, `ok`.

## Safety behaviour
* A run with **no fresh data never touches** `data/zamm-live.json` (workflow turns red). A seed that fails keeps its previous entries, flagged `stale`, and is excluded from the drift check.
* Weak parse (fewer table rows than `minRows`) never replaces good seed data.
* Data older than `staleAfterDays` (45) → orange warning in header and card.
* Fetched text is HTML-escaped; links only for `https://*.help.sap.com`; formulas are evaluated by a small parser (no `eval`; hostile input rejected – tested).
* The JSON stores URLs, parameter formulas and ≤ 240-char snippets – not page copies (SAP Help content is SAP's).
* `knownDifferences` in `config.json` lists documented contradictions between SAP sources, with the reason – they appear under "Verification details" instead of raising an issue.

## Free-tier usage (checked against vendor docs, Oct 2026)
Per run: 6 Tavily searches (1 credit each) + 1 advanced Extract batch of up to 3 URLs (2 credits; **0** if every seed has a local file) = **6–8 Tavily credits**, plus ≈ 6 Cohere calls. Weekly ≈ 35 credits and ≈ 26 Cohere calls a month vs **1,000/month** each.
Hard caps per run: `config.limits`. Cohere trial keys are documented as non-commercial and rate-limited (rerank 10/min; calls are spaced out).

## Tuning
Queries, tracked parameters, grid, caps, `knownDifferences` → `scripts/config.json`; schedule → workflow file.
Cohere model IDs are the most likely thing to need changing (`COHERE_CHAT_MODEL` / `COHERE_RERANK_MODEL`; a 404 only makes the run "partial").
If the page is embedded on another site, set `LIVE_DATA_URL` in `index.html` to an absolute URL of `data/zamm-live.json`.

## Tests (`npm test`, 48 tests, local mock Tavily/Cohere servers + anonymized RSPARAM evidence)
Parser (pipe tables, layout text, label alignment, `*` operators), evaluator (hostile input), seeds incl. PDF fallback, drift detection against a deliberately mutated calculator,
known-difference handling, carry-forward of stale seeds, change detection, outage / budget / missing-key behaviour, issue-body generation, real-PDF routes through `pdftotext`,
and **the calculator versus the kernel defaults of four real systems** (`scripts/test/rsparam-evidence.test.mjs`).
