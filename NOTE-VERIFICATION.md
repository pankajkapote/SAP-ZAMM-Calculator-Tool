# ZAMM Calculator – verification against SAP Notes, SAP Help **and four live systems**

**Sources.** Notes 88416 · 941735 · 2085980 · 1518419 · 3681846 ·
SAP Help "SAP Memory Management": ABAP platform 2025 FPS02 (202510.002), NetWeaver 7.4 SPS31 (7.4.31), Application Server Infrastructure (Support Content 1.0) ·
**RSPARAM exports of four real systems**: Linux ECC, Windows ECC (**SAP kernel 7.54**), Linux S/4HANA, Windows S/4HANA (**SAP kernel 7.93**) – kernel numbers as stated by the system owner; (columns *System Default Value* **and** *Unsubstituted Form* = the kernel's own default formula).
A NW 7.4 system is not available, so that basis stays "Notes + Help only".

## 1. Result in one line
After the corrections below, **the calculator reproduces every kernel default the four systems reveal – 61 exact comparisons, 0 differences** (Linux ECC 17, Windows ECC 17, Linux S/4 11, Windows S/4 16).
It is enforced by `scripts/test/rsparam-evidence.test.mjs` (anonymized fixture – no SIDs, hosts or paths) and by mutation tests that re-introduce each earlier mistake.

## 2. Three release bases, named by SAP kernel (the selector in the page)
| | **ECC – kernel 7.54** (`current`) | **S/4HANA – kernel 7.93** (`s4`) | **NW 7.4 – kernel 7.40–7.4x** (`nw740`) |
|---|---|---|---|
| evidence | Note 2085980 + Help 2025 + **2 live systems** | as `current` + **2 live systems** (Help does *not* describe it) | Note 88416 + Help 7.4 only |
| `em/initial_size_MB` | `PM × 0.7` (cap 512 000 ¹) | **`PM × 0.8`, no cap** | `PM × 0.7` (cap 512 000) |
| `em/max_size_MB` | Windows `PM × 1.5` (cap ¹); others `= em/initial` | **= `VIRT_MEMSIZE`**: Windows `PM × 1.5`, others `= em/initial` | Windows `PM × 1.5`; others `= em/initial` |
| `em/blocksize_KB` | formula (Note) | **does not exist** (shown "n/a") | formula |
| `rsdb/tbi_buffer_area_MB` | `1.21 × zcsa/table_buffer_area / 2²⁰ + 1`, `zcsa = min(2.7e9, max(3e7, em_init·2²⁰·0.1 ²))` ≈ 3 117 MB on large hosts | same, factor **0.08** | not computed |
| `abap/buffersize` | `min(ceil(em·1024·0.2/4096)·4096, ceil(sqrt(PM/1024)·2²⁰))` – **confirmed by 2 systems** | same (confirmed on Windows S/4) | `ceil(em·1024·0.15/4096)·4096` |
| `rdisp/PG_SHM` | `min(1000+40·max(5,floor((PM−128)/20)),256000)` – confirmed | same | `max(min(1000+40·max(5,floor((PM−128)·25/128)),16384),1024)` |
| **`rdisp/PG_MAXFS`** | **256 000 fixed** – all four systems (Help/Note say "= PG_SHM") | 256 000 | 32 768 |
| `ztta/roll_extension` | Linux **4 GB** (confirmed on Linux ECC), Win/UNIX/AIX 2 GB (Windows confirmed) | same ³ | 2 GB |
| other (`heap_*`, `heaplimit`, `global_area`, `shared_objects`, `EM/TOTAL_SIZE_MB`) | identical on all four systems | | |

**Rounding.** The kernel rounds derived integer parameters to the **nearest** integer (126 428 × 0.7 = 88 499.6 → **88 500**). The calculator used `floor` before – off by 1 MB. The drift check now uses a half-unit tolerance instead of 1.

¹ The kernel formulas in RSPARAM contain **no** 512 000 cap (`PM × 0.7`); the Help/Notes do (`min(512000, …)`). All four systems have < 263 GB, so the cap (relevant above ≈ 714 GB RAM) could not be tested; the documented cap is kept.
² Factor 0.1 comes from the 7.40 `sappfpar` listing. On the live kernel-7.54 ECC systems it **cannot be read**: the RSPARAM cell is hard-truncated **inside the file** at 60 characters (the visible text ends at `$(em/initial_size_MB) * 1024`; 42 cells in the Linux ECC export and 40 in the Windows ECC export stop at exactly 60 characters, whereas the 7.93 exports hold cells of up to 380 characters), so widening a column does not help. **Effect of the unknown factor:** none on hosts with ≥ 48 GB RAM (the 2.7 GB cap applies); on hosts ≤ 40 GB the table-buffer area differs by ≈ 240–520 MB, about 2.4 % of EM (e.g. 32 GB RAM: 2 603 MB at 0.1 vs 2 083 MB at 0.08). The S/4 factor 0.08 is read from the full 7.93 formula text.
³ Linux S/4 shows 12 000 000 000, but that equals its user-defined value (see §4), so the S/4 Linux kernel default is unknown; the 4 GB value is carried over from Help/Linux ECC.

## 3. What the live systems taught us beyond the documents
* The SAP Help (2025) and Notes **lag the kernels** – even the newest Help text is behind the **7.93** kernel: neither mentions `0.8`, `VIRT_MEMSIZE`, or the removal of `em/blocksize_KB`, and both say `PG_MAXFS = PG_SHM` (kernel 7.54 and 7.93 both use a fixed 256 000).
* **Usable EM** (work-process analysis) = `em/initial − (em/global_area + abap/shared_objects + rsdb/tbi_buffer_area_MB)`. The RSPARAM formula of `em/address_space_MB` contains exactly these three areas; the tbi default was previously "undocumented" – it is derivable from the visible formula chain (verified for small systems by test).
  Example, Linux ECC 128 GB: EM 90 317 MB, overhead 4 516 + 1 806 + 3 117 = 9 439 MB → **80 878 MB** usable (previous version: 83 995 MB).
* Two earlier "open items" are closed: `abap/buffersize` 0.2 + sqrt cap **is** real on current kernels; the Linux ECC `ztta/roll_extension` default **is** 4 GB.
* Kernels are now known (**ECC 7.54, S/4HANA 7.93**; stated by the system owner, not part of RSPARAM). This is also the migration pair (source ECC 7.54 → target S/4HANA 7.93). Other kernels (e.g. 7.77, 7.89, other 7.5x) have **no live evidence**; they are assumed to follow the nearest basis.

## 4. Rows that carry NO evidence (not used to fit anything)
Linux S/4 lists a *literal* default identical to its user-defined value for `abap/buffersize` (7 000 000), `rdisp/PG_SHM` (131 072), `rsdb/tbi_buffer_area_MB` (4 000), `ztta/roll_extension` (12 000 000 000) and shows `abap/shared_objects_size_MB` as `max(800, …)` while Windows S/4 shows `min(20000, …)`.
These echo the administrator's profile settings (and `abap/programs = buffersize/4` inherits one of them), so they say nothing about kernel defaults. The calculator uses the `min(20000, …)` form for all bases (the two forms give identical values for 40 GB < EM < 1 TB).

## 5. Contradictions between SAP documents (calculator follows the Note / real system)
NW 7.4 SPS31 Help (Windows table) vs Note 88416: `em/max_size_MB` (= `em/initial` vs `1.5 × PM`), `abap/heap_area_nondia` (2 000 000 000 vs 0), `abap/heap_area_total` (`max(0.1·PM·1024², 2·dia)` vs `PM·1024²`) → follows 88416 (cannot be checked: no NW 7.4 system).
ABAP platform 2025 Help / Note 2085980 vs real systems: `rdisp/PG_MAXFS` → follows the systems. Both are listed in `config.json → knownDifferences` with reasons and appear under "Verification details" in the page.

## 6. Automated check against the Help documents (your three PDFs, local-file route)
ABAP platform 2025: 13 parameter rows → 0 unacknowledged differences. NW 7.4 SPS31: 9 rows → 5 agree, 3 acknowledged contradictions. Formulas backed by SAP Notes/systems but **not** by the 2025 Help table: `abap/buffersize`, `abap/programs`, `abap/shared_objects_size_MB`, `rsdb/tbi_buffer_area_MB`.

## 7. Still open
1. ECC `zcsa/table_buffer_area` factor (0.1 vs 0.08) – **not obtainable from RSPARAM on 7.54** (truncated at 60 characters in the file, see footnote ²). Only `sappfpar` prints the full formula: as `<sid>adm` run `sappfpar all pf=<instance profile> | grep zcsa/table_buffer_area` (Windows: `| findstr zcsa/table_buffer_area`) on the ECC system. Low impact (hosts ≤ 40 GB only).
2. Linux S/4 kernel defaults for `abap/buffersize`, `rdisp/PG_SHM`, `ztta/roll_extension`, `tbi`: **no Linux S/4 system is available at the moment**, so these stay unverified (the Windows S/4 7.93 system confirms the formulas for `buffersize`, `PG_SHM` and `tbi`; the Linux `ztta/roll_extension` 4 GB default on 7.93 is assumed from Help and Linux ECC).
3. The 512 000 / uncapped question for hosts > 714 GB RAM.
4. ~~Kernel release of each system~~ – answered: ECC 7.54, S/4HANA 7.93.
5. Not implemented (offered): OS-level guidance from the Notes (Windows fixed page file ≥ 1× RAM, ≈ 2× productive; Linux `es/implementation=std`, TMPFS ≈ 75 % of RAM + swap).
