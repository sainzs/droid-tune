# Droid session — flake-report.js task-selection filter (2026-08-19)

## Defect this fixes

`scripts/flake-report.js` had no per-task filter, so it always aggregated
every task directory under `--runs-dir`. The published headline result in
`docs/m4-flake-check-2026-08.md` / README (**29/40 VERIFIED_PASS** across five
tasks and four models, from `runs/m4-flake3`) could not be reproduced: running
the script over `runs/m4-flake3` as-is aggregates a sixth task
(`t006-safe-listdir`, added after the doc was written) and reports **35/48**
instead. Verified empirically before briefing Droid:

```
$ node scripts/flake-report.js --runs-dir runs/m4-flake3 | tail -3
TOTAL 35/48 VERIFIED_PASS (73%)
```

## Session

- Prompt file: `/tmp/droid-task-flake.md` (full spec: add `--task`/`--tasks`
  filter, self-documenting scope line, no default-behavior change, must not
  touch `lib/runner.js`/`bin/droidtune.js`, `npm test` must stay green).
- Command: `droid exec -m hy3-free --auto medium -o json -f /tmp/droid-task-flake.md`
- Session id: `b4d00cd4-12d6-4e53-8458-c5b27b1a79c6`
- Model: `hy3-free` (OpenCode Zen free route)
- Autonomy: medium
- Turns: 11, duration: 166915 ms
- Route history: `deepseek-v4-flash-free` (3 attempts, 429 rate-limit
  exhaustion, ~97s backoff-then-fail each) and `glm-5-free` /
  `kimi-k2.5-free` (both `401 Model <id> is not supported`, fail in <1s) were
  tried first per the runbook and did not work in this session; `hy3-free`
  succeeded on the first attempt.

Droid's own final summary (verbatim, from the `-o json` result field):

> I added a task-selection filter to `scripts/flake-report.js` (the only file
> changed; `lib/runner.js`, `bin/droidtune.js`, and `runs/` are untouched, and
> the script stays dependency-free with Node builtins only).
>
> **What changed:**
> - `--task <id>` (repeatable) and `--tasks a,b,c` (comma-separated), both
>   implemented. A task is included only if its directory name is in the
>   filter set, so it is skipped before being read.
> - Self-documenting scope line printed right after the `## Outcome matrix`
>   header: `Included: all N task(s) found in <runs-dir>` when no filter is
>   given, or `Included (filtered to N): <explicit comma list>` when filtered.
> - Loud error on unknown task id: exit code 2, names the missing id(s) and
>   lists available tasks (no silent skipping).
> - `--json` (nice-to-have): same aggregation as a single JSON object.
> - Default behavior preserved: no flag → all tasks, identical sections/order,
>   same TOTAL.

## Maintainer review

Reviewed `git diff scripts/flake-report.js` and the new
`test/flake-report.test.js` (5 new `node:test` cases) line by line.

- Filter logic (`filterSet`, skip check in the row-building loop) is correct
  and minimal.
- Unknown-task validation reads the actual directory listing first and errors
  loudly (exit 2) rather than silently ignoring bad ids — matches the spec.
- The refactor that hoists `matrix`/`perTask`/`nonPass`/token totals into
  shared variables (consumed by both the text and `--json` renderers) is a
  faithful behavior-preserving extraction of the pre-existing inline
  computations — confirmed by diffing full output before/after with no
  filter (see Verification below): identical except for the one added
  `Included:` line.
- `--json` addition is in scope (explicitly listed as a secondary ask) and
  self-contained.
- No test was weakened or deleted; 5 new tests were added, existing 75 kept
  as-is.
- No changes outside `scripts/flake-report.js` and the new test file. No
  edits to `lib/runner.js`, `bin/droidtune.js`, or anything under `runs/`.

**No corrections were needed.** This entire diff is Droid's unmodified
output.

## Verification (payoff)

```
$ node scripts/flake-report.js --runs-dir runs/m4-flake3 | grep -E '^Included|^TOTAL'
Included: all 6 task(s) found in runs/m4-flake3
TOTAL 35/48 VERIFIED_PASS (73%)

$ node scripts/flake-report.js --runs-dir runs/m4-flake3 \
    --task t002-slugify --task t003-path-canonicalize --task t004-git-surgery \
    --task t005-agents-md-compliance --task t007-rename-symbol | grep -E '^Included|^TOTAL'
Included (filtered to 5): t002-slugify, t003-path-canonicalize, t004-git-surgery, t005-agents-md-compliance, t007-rename-symbol
TOTAL 29/40 VERIFIED_PASS (73%)
```

The filtered run reproduces the published **29/40** exactly, straight from
the on-disk `runs/m4-flake3` evidence packs — no packs were edited.

Diffing full script output before/after the change with no filter applied
(`git stash` / `git stash pop` around the run) showed only the one new
`Included:` line was added; every other line (matrix, per-task rates,
non-pass list, token summary, TOTAL) was byte-identical, confirming no
default-behavior change for existing callers.

`npm test`: **80/80 pass** (75 existing + 5 new in `test/flake-report.test.js`).
