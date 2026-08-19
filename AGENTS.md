# droid-tune — Agent Notes

Droid Tune-Up: open-source diagnostic, tuning, and verification toolkit for
Factory Droid — measures and maximizes **verified** engineering work per
dollar. Built as a Factory Guild submission (factory.ai/ambassador).

**Status: M3 shipped (2026-08-18).** `PLAN.md` is the source of truth;
`docs/research-2026-08.md` is the verified evidence base. Next: M4
(author 6–8 tasks incl. memex filesystem-torture; 3× flake check).

## Commands

```sh
node bin/droidtune.js diagnose [--json] [--demo] [--probe [model]]
                               [--sessions-dir D] [--config F]
                               [--droid-path P] [--limit N]
node bin/droidtune.js trial --task <dir> [--model m] [--tune name]
                            [--auto high|medium|low] [--timeout-ms N]
                            [--runs-dir D] [--attempt N] [common flags]
npm run check        # node --test + CLI smoke (CI parity)
```

Exit codes: 0 clean/VERIFIED_PASS · 1 faults or non-pass outcome · 2 usage.
Fault/hint IDs are stable (`DT001`–`DT009`, `DT101`–`DT104`, `DT-P00x`);
`--demo` runs bundled fixtures with no Droid install. `--probe` spends BYOK
credits (opt-in). `trial` runs one task end-to-end through `droid exec`
(autonomy high by default, `droidtune-trial` tagged session) and writes a
development evidence pack under `runs/<tune>/<task>/attempt-N/` (gitignored;
claim-eligible published packs begin with M5 baselines). First live integration
trial 2026-08-18: t001 VERIFIED_PASS via `deepseek-v4-flash-free` (Zen free)
in 15.4s at $0; n=1 toy-task result, not a benchmark claim. BYOK keys live in
`~/.factory/env.sh` (mode 600, `${ENV_VAR}` refs in `~/.factory/settings.json`).

## Invariants

- Zero runtime dependencies. Node ≥ 20, ESM.
- **Unofficial community project, not affiliated with Factory.** Keep the
  disclaimer in README and any public output.
- Nothing is claimed publicly that a stranger cannot reproduce from the repo —
  Claims Integrity Protocol, PLAN §8. The tool may not emit a claim stronger
  than its evidence.
- Every claim-eligible trial writes the complete §8.4 evidence pack (manifest,
  transcript, patch, frozen tests, results, usage, pricing). M2 development
  packs omit unavailable artifacts such as pricing; they cannot support public
  claims. No transcript, verifier provenance, or pricing snapshot → no claim.
- LLM judges are barred from pass/fail. Deterministic behavioral tests only.
- The agent worktree never contains `tests/` or `solution/`.
- Never commit API keys. Keys live in `~/.factory/env.sh` (mode 600), never
  in the repo or `~/.factory/settings.json` (which uses `${ENV_VAR}` refs).
  Rotate the Z.AI key at the provider console before M5 config snapshots.
- The telemetry proxy (v1, deferred) stores hashes, lengths, and counters —
  never prompt contents.
- Vendor-neutral language for runtime-architecture concepts; DeepSeek and
  other influences are credited in docs, never in branding.

## Definition of done (M2) — met 2026-08-18

`lib/ledger.js` (append-only JSONL) + `lib/pack.js` (evidence packs with
sha256 manifests) + `lib/runner.js` (droid exec orchestration, outcome
classes, isolation-invariant grading, budget gates) + `trial` CLI + toy task
`t001-greet-script`; 49 tests green; live end-to-end VERIFIED_PASS via Zen
free route. Build continues at M3.
