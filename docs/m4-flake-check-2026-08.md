# M4 live flake check — 2026-08-19

First live multi-model run of the droid-tune suite. **40 trials, $0**, via
OpenCode Zen **free** routes. Evidence packs: `runs/m4-flake3/` (gitignored).
Aggregation: `node scripts/flake-report.js --runs-dir runs/m4-flake3`.

## Routes used (all free tier)

| Model id (settings.json) | Short |
|---|---|
| `custom:hy3-free-OpenCode-Zen-free-8` | hy3 |
| `custom:laguna-s-2-1-free-OpenCode-Zen-free-11` | laguna-s |
| `custom:nemotron-3-5-lightning-free-OpenCode-Zen-free-10` | nem-lightning |
| `custom:nemotron-3-ultra-free-OpenCode-Zen-free-9` | nem-ultra |

These 4 were wired 2026-08-19 by adding `id`s to pre-existing (keyed) entries
in `~/.factory/settings.json` that had `model`+`apiKey` but no `id`. Backup:
`~/.factory/settings.json.bak-20260819`. The 3 originally-configured free
routes (`deepseek-v4-flash-free`, `glm-5-free`, `kimi-k2.5-free`) and
`mimo-v2.5-free` all returned PROVIDER_ERROR/429 at run time.

## Outcome matrix (count per task × model)

| task | hy3 | laguna-s | nem-lightning | nem-ultra | n |
|---|---|---|---|---|---|
| t002-slugify | 2 PASS | 2 PASS | 2 PASS | 2 PASS | 8 |
| t003-path-canonicalize | 2 PASS, 1 TIMEOUT | 1 TIMEOUT | 1 PASS, 1 TIMEOUT | 2 PASS | 8 |
| t004-git-surgery | 2 NO_SUBMISSION | 2 NO_SUBMISSION | 1 PASS, 1 NO_SUBMISSION | 2 NO_SUBMISSION | 8 |
| t005-agents-md-compliance | 2 PASS | 2 PASS | 2 PASS | 2 PASS | 8 |
| t007-rename-symbol | 1 PROVIDER_ERROR, 1 PASS | 2 PASS | 2 PASS | 2 PASS | 8 |

**Per-task VERIFIED_PASS rate:** t002 8/8 · t003 5/8 · t004 1/8 · t005 8/8 ·
t007 7/8. **TOTAL 29/40 PASS (73%)**; 1.30M in / 133k out tokens ($0).

## The signal

1. **t004-git-surgery is the discriminative instrument.** 7 of 8 attempts
   (across all 4 models) ended NO_SUBMISSION. Transcripts show the models do
   the technical work — inspect history, fix `add`/`multiply`, drop `JUNK.txt`,
   verify the behavioral contract — and then **do not run `git commit`**. The
   task's contract is "commit your result on `main`"; the harness correctly
   scores the missing commit as no-submission. One nem-lightning attempt did
   commit (PASS), so the failure is near-universal, not absolute. Lesson:
   **an eval that grades only the final diff/file contents reports a pass for
   work that was never submitted.** "Did you finish" ≠ "did you do the work."

2. **t003-path-canonicalize separates small models by latency/capability.** 3
   TIMEOUTs (300s) across hy3, laguna-s, nem-lightning; nem-ultra passed both
   attempts. The Unicode-twin canonicalization (NFC/NFD + case + NFKC
   compatibility) is hard for the smaller free models under a timeout.

3. **t002, t005, t007 are stable** (PASS across every model that completed) —
   good regression floor, low discriminative value.

4. **One transient PROVIDER_ERROR** (t007/hy3 attempt-33) — free-route 429,
   correctly classified excludable by the S2 gate.

## Methodology notes (Claims Integrity, §8)

- Runner changed mid-sweep: env-allowlist (`7546aa8`) landed while `m4-flake3`
  was running. In-flight trials used the old full-env inheritance; trials
  spawned after the edit used the filtered env. The change is env-only and was
  verified compatible (live t002 PASS on the new env before commit), so
  outcomes are comparable — recorded here for pack-lineage honesty.
- First sweep attempt (`m4-flake2`) was discarded: it reused `attempt 1/2`
  across 4 models per task, causing `writeEvidencePack` collisions (only the
  first model per task wrote a pack). `m4-flake3` uses globally-unique attempt
  ids. The 4 valid `m4-flake2` packs (hy3 on t002/t003, all PASS) are
  consistent with these results.
- All outcomes reconciled against on-disk `manifest.json`/`results.json`, not
  console output.
