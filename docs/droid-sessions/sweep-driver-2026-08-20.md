# Droid session: `droidtune sweep` — the preregistered-claim driver

- **Session id**: `48128b54-2c1d-47f5-9bda-f676028cfe79`
- **Model**: `kimi-k3` (Factory native; 665,436 Factory Standard Credits)
- **Autonomy**: `--auto high`, in an isolated git worktree (`droid/kimi-sweep`)
  so it could not collide with four other Droid sessions running concurrently
- **Invocation**: `droid exec -m kimi-k3 --auto high -f /tmp/dt-specs/kimi-sweep.md
  --cwd /tmp/dt-kimi -o json`
- **Duration / usage**: 25 turns; `is_error: false`, `subtype: success`

## The brief

Build the missing driver for the 80-trial design in
`claims/dt-v1-ledger-lite-nosub.json`. The claim file was handed over as the
requirements document: 2 arms x 4 routes x 10 attempts, arms alternating within
each route, a capped replacement rule, per-route analysis. Constraints: three
files only (`lib/sweep.js`, `test/sweep.test.js`, CLI wiring), dry-run by
default, injectable `runOne` so tests never spawn droid, never renumber an
attempt to dodge a collision, do not modify any existing lib file.

## What Droid produced

`lib/sweep.js` (551 lines), `test/sweep.test.js` (18 tests), and the `sweep`
subcommand. Design decisions it made unprompted and got right:

- Re-validating the tune's sha256 against the claim's pinned hash at load time,
  so a drifted tune refuses to run rather than silently sweeping the wrong file.
- Resolving routes against `customModels` by exact id or *unique* substring, and
  refusing ambiguous matches with the candidate list.
- Resume by evidence-pack existence **plus** the append-only log, so
  scheduled-but-never-executed replacements are re-queued on a later invocation
  while completed slots are skipped.
- Scheduling replacements at attempt numbers *above* the registered n, so a
  replacement is always an extra pack and never overwrites the trial it replaces.

## Maintainer integration and verification

Not merged on trust. The branch was rebased onto the three commits that landed
while it ran, then:

- Full suite re-run after rebase (317 tests, 0 failures).
- Dry run of the real claim inspected end to end: 80 slots, arms correctly
  alternating within each route, and confirmed to write nothing to `runs/`.
- **Gap found and fixed by the maintainer**: kimi worked from a base that
  predated `HARNESS_ERROR` and `TUNE_CONTAMINATED`, so both fell through its
  replacement branch and were merely logged. A harness fault now aborts the
  sweep (every later slot is suspect), and a contaminated trial is reported and
  never replaced (resampling until an arm looks clean is the re-cutting the
  claim's decision rule forbids). Two tests were added for these paths.
