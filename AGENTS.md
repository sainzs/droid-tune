# droid-tune

Open-source diagnostic, tuning and verification toolkit for Factory Droid. It
measures **verified** engineering work per dollar. Unofficial community project,
not affiliated with Factory.

`PLAN.md` is the source of truth. `docs/research-2026-08.md` is the evidence base.
`docs/agent-notes.md` has the full milestone history and subsystem detail: read it
before changing `lib/runner.js`, tunes, `weather/` or the audit detectors.

## Status

- M4 shipped. M5 infrastructure is done, but no paid baseline has been run.
- `dt-v1-ledger-lite-nosub` ran 2026-08-20: **NOT SUPPORTED**. `dt-v0` has not run.
- `weather/` is a daily series. Its last entry is 2026-09-09.

## Commands

```sh
npm run check                     # definition of done: tests plus CLI smoke
node scripts/check-claim.js       # CI: validates claims/
node scripts/check-demo-table.js  # CI: README and snapshot match demo-pack/
node bin/droidtune.js triforce    # CI: gates every full-layout task
node bin/droidtune.js diagnose --demo   # bundled fixtures, no Droid install needed
node bin/droidtune.js audit <pack-dir|runs-dir>   # offline
node bin/droidtune.js trial --task <dir> --model <m>   # live, needs droid exec
node scripts/route-weather.js --probe | --render [--check]
```

Exit codes: 0 clean or VERIFIED_PASS, 1 faults or non-pass outcome, 2 usage.

## Spending gates

- `baseline --confirm-spend` spends Factory credits. Keep that gate.
- `diagnose --probe` spends BYOK credits and is opt-in.
- `trial` requires an explicit `--model`, so no run can silently spend a paid plan.

## Invariants

- Zero runtime dependencies. Node ≥ 20, ESM.
- Keep the unofficial disclaimer in the README and any public output.
- Nothing is claimed publicly that a stranger cannot reproduce from the repo
  (Claims Integrity Protocol, PLAN §8). The tool may not emit a claim stronger than
  its evidence.
- Every claim-eligible trial writes the complete §8.4 evidence pack. No transcript,
  verifier provenance or pricing snapshot means no claim.
- LLM judges are barred from pass/fail. Deterministic behavioral tests only.
- The agent worktree never contains `tests/` or `solution/`.
- Never commit API keys. They live in `~/.factory/env.sh` (mode 600), and
  `~/.factory/settings.json` uses `${ENV_VAR}` refs. Rotate the Z.AI key at the
  provider console before M5 config snapshots.
- The telemetry proxy (v1, deferred) stores hashes, lengths and counters, never
  prompt contents.
- Vendor-neutral language for runtime-architecture concepts. Credit influences in
  docs, never in branding.

## Gotchas

- `weather/README.md` and `weather/badge.json` are pure functions of
  `weather/route-status.jsonl`. Do not hand-edit them; tests re-derive them.
- `runs/` is gitignored. Published numbers are reproduced from `demo-pack/`, and
  `scripts/results-table.js` plain output is byte-compared in CI.
- `audit demo-pack` reports `0/24 auditable` by design: the pack has no transcripts.
- Native Droid is accounted in Factory Standard Credits. Do not infer a USD
  conversion.
