# dt-v1-ledger-lite-nosub — preregistered sweep results, 2026-08-20

Preregistered claim: `claims/dt-v1-ledger-lite-nosub.json` (status
`preregistered`; this document is the separate results publication the claim
registry requires). Design as frozen: 80 trials, t004-git-surgery only, 10 per
arm per route, arms alternating within route, four OpenCode Zen free BYOK
routes, $0. Executed in one session, 2026-08-20 20:32–22:08 UTC. Evidence
packs: `runs/{no-tune,ledger-lite}/<route>/t004-git-surgery/attempt-N/`
(gitignored); sweep log `runs/dt-v1-ledger-lite-nosub/sweep-log.jsonl`.
Analysis: `node scripts/claim-report.js --claim dt-v1-ledger-lite-nosub`
(plain) / `--json` (machine-readable); the analysis reads packs as they are
on disk and computes no fresh trial.

## Decision: NOT SUPPORTED

The preregistered decision rule requires ALL three conditions; two failed.

| # | Condition (frozen in claim) | Result | Met? |
|---|---|---|---|
| 1 | Pooled NO_SUBMISSION rate ≥ 25pp below control | 5.0pp drop (ledger-lite 80.0% vs no-tune 85.0%) | NO |
| 2 | Two-sided Fisher exact p < 0.05 on pooled 2×2 | p = 0.7695 on [[34, 6], [32, 8]] | NO |
| 3 | Pooled VERIFIED_PASS rate not lower in tune arm | ledger-lite 20.0% vs no-tune 15.0% | YES |

Pooled 2×2 (arm × NO_SUBMISSION / submitted): no-tune 34 / 6, ledger-lite
32 / 8, 40 scorable trials per arm. Every submission in both arms was
VERIFIED_PASS — the arms differed only in whether `git commit` happened, not
in whether submitted work passed the behavioral contract.

## Per-route rates (published as registered, exclusions included)

| route | no-tune NO_SUBMISSION | ledger-lite NO_SUBMISSION | no-tune VERIFIED_PASS | ledger-lite VERIFIED_PASS |
|---|---|---|---|---|
| hy3-free | 8/10 (80.0%) | 10/10 (100.0%) | 2/10 | 0/10 |
| nemotron-3.5-lightning-free | 10/10 (100.0%) | 5/10 (50.0%) | 0/10 | 5/10 |
| laguna-s-2.1-free | 8/10 (80.0%) | 8/10 (80.0%) | 2/10 | 2/10 |
| nemotron-3-ultra-free | 8/10 (80.0%) | 9/10 (90.0%) | 2/10 | 1/10 |
| **pooled** | **34/40 (85.0%)** | **32/40 (80.0%)** | **6/40 (15.0%)** | **8/40 (20.0%)** |

Actual config routes: `custom:hy3-free-OpenCode-Zen-free-8`,
`custom:nemotron-3-5-lightning-free-OpenCode-Zen-free-10`,
`custom:laguna-s-2-1-free-OpenCode-Zen-free-11`,
`custom:nemotron-3-ultra-free-OpenCode-Zen-free-9`.

## Exclusions and replacements

Zero. No PROVIDER_ERROR, DROID_ERROR, or VERIFIER_ERROR occurred in any of
the 80 trials, so the exclusion rule never fired, no replacement was queued
(0/5 cap untouched on every route), and no route was dropped. Every executed
attempt is in the tables above.

## Secondary metrics (as registered)

| metric | no-tune | ledger-lite |
|---|---|---|
| output tokens / trial (mean · median) | 3299 · 2823 | 3565 · 2758 |
| cycle time ms / trial (mean · median) | 68289 · 65925 | 79036 · 62468 |
| audit claim-without-coverage (80/80 packs auditable) | 17 | 18 |
| audit no-test-finish | 0 | 0 |

## Provenance and integrity

- All 80 packs record `runnerSha` `62d5145e76a8742ac09db3794a1c290489caf25a`,
  constant across the sweep and equal to repository HEAD at completion. No
  commit landed during execution.
- `runnerDirty` is `false` on 8 packs and `true` on 72. The only dirty paths
  at any point were the two untracked analysis-tooling files
  (`scripts/claim-report.js`, `test/claim-report.test.js`), created mid-sweep;
  they are not on the runner code path, and no tracked file was modified
  during the sweep. The tune file itself is tracked and unchanged.
- Every ledger-lite pack's provenance records tune sha256
  `17ee2f2201af4aaf67227e7e5bbf366a94c11272720f4a823aae5580a4641b4b`, matching
  the claim's frozen `tuneSha256` byte-for-byte; every no-tune pack records
  `tune: null`. Seed histories are byte-identical across arms by construction
  (`lib/tune.js` untracked + `.git/info/exclude`).
- Packs are gitignored by design; this document plus the claim file plus
  `scripts/claim-report.js` are the committed, reproducible surface.

## Reading (descriptive only — no re-cut)

Per the registered rule the tune is not recommended for this task: the
observed 5.0pp reduction is a fifth of the required 25pp and the Fisher test
is nowhere near significance. Route-level heterogeneity is visible
(nemotron-3.5-lightning halved its NO_SUBMISSION rate under the tune; hy3
moved the other way), but the design pools across routes and these cells are
n=10 — noted for future hypothesis generation, not evidence. The
preregistered limitations stand: free BYOK routes only, single task, nothing
transfers to native Droid or paid routes without a separate claim.

## Reproduce

```sh
# re-run the analysis against the packs exactly as they are on disk
node scripts/claim-report.js --claim dt-v1-ledger-lite-nosub          # plain, exit 1 = NOT SUPPORTED
node scripts/claim-report.js --claim dt-v1-ledger-lite-nosub --json   # machine-readable

# the sweep itself (already executed; would resume/skip completed slots)
node bin/droidtune.js sweep --claim dt-v1-ledger-lite-nosub --live
```
