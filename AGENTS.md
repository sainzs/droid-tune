# droid-tune — Agent Notes

Droid Tune-Up: open-source diagnostic, tuning, and verification toolkit for
Factory Droid — measures and maximizes **verified** engineering work per
dollar. Built as a Factory Guild submission (factory.ai/ambassador).

**Status: M4 shipped; M5 infrastructure done, paid baseline not run
(2026-08-19).** `PLAN.md` is the source of truth; `docs/research-2026-08.md` is
the verified evidence base. M4: 7 tasks authored (t001 toy; t002 core-swe; t003
+ t006 filesystem-torture [memex]; t004 + t007 terminal-native; t005
harness-surface). `triforce` gates every full-layout task (49/49 legs); each
verifier discriminates a wrong/default/partial solution. Runner hardening: S1
isolation (tests//solution/ patches disqualified; grading replaces tests/
wholesale), S2/S3 PROVIDER_ERROR envelope gating (trusted envelope + is_error +
num_turns:0; unit-tested), env-allowlist for `droid exec` (stops env-name leak
into public packs; `DROIDTUNE_ENV_ALLOW` escape hatch). Live flake check (40
trials, 4 Zen free routes, $0): 73% PASS — **t004-git-surgery is the
discriminative instrument** (7/8 NO_SUBMISSION: models do the work but forget
`git commit`); t003 separates small models by timeout; t002/t005/t007 stable.
Results: `docs/m4-flake-check-2026-08.md`; aggregate any run with
`node scripts/flake-report.js --runs-dir <dir>`. Working free routes:
`hy3-free`, `laguna-s-2.1-free`, `nemotron-3.5-lightning-free`,
`nemotron-3-ultra-free` (ids added to `~/.factory/settings.json`; backup
`settings.json.bak-20260819`).

M5 adds versioned pricing (`lib/pricing.js`), an explicit-spend native baseline
that freezes bundle provenance before execution (`configs/native-droid.json`),
and a validated preregistered claim under `claims/`. Native Droid is accounted
in observed Factory Standard Credits; do not infer a USD conversion. No paid
baseline has been run. `baseline` must keep the `--confirm-spend` gate.

## Commands

```sh
node bin/droidtune.js diagnose [--json] [--demo] [--probe [model]]
                               [--sessions-dir D] [--config F]
                               [--droid-path P] [--limit N]
node bin/droidtune.js trial --task <dir> [--model m] [--tune name]
                            [--auto high|medium|low] [--timeout-ms N]
                            [--runs-dir D] [--attempt N] [common flags]
npm run check        # node --test + CLI smoke (CI parity)
node bin/droidtune.js baseline --confirm-spend  # LIVE: spends Factory credits
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
