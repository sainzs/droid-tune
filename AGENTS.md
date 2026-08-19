# droid-tune — Agent Notes

Droid Tune-Up: open-source diagnostic, tuning, and verification toolkit for
Factory Droid — measures and maximizes **verified** engineering work per
dollar. Built as a Factory Guild submission (factory.ai/ambassador).

**Status: M1 shipped (2026-08-18).** `PLAN.md` is the source of truth;
`docs/research-2026-08.md` is the verified evidence base. Next: M2
(`runner.js` + `ledger.js` + evidence packs, one toy task end-to-end).

## Commands

```sh
node bin/droidtune.js diagnose [--json] [--demo] [--probe [model]]
                               [--sessions-dir D] [--config F]
                               [--droid-path P] [--limit N]
npm run check        # node --test + CLI smoke (CI parity)
```

Exit codes: 0 clean · 1 faults · 2 usage. Fault/hint IDs are stable
(`DT001`–`DT009`, `DT101`–`DT104`, `DT-P00x`); `--demo` runs bundled fixtures
with no Droid install. `--probe` spends BYOK credits (opt-in) and tags its
session `droidtune-probe` (excluded from aggregates). BYOK keys live in
`~/.factory/env.sh` (mode 600, `${ENV_VAR}` refs in `~/.factory/settings.json`).

## Invariants

- Zero runtime dependencies. Node ≥ 20, ESM.
- **Unofficial community project, not affiliated with Factory.** Keep the
  disclaimer in README and any public output.
- Nothing is claimed publicly that a stranger cannot reproduce from the repo —
  Claims Integrity Protocol, PLAN §8. The tool may not emit a claim stronger
  than its evidence.
- Every trial writes an evidence pack (manifest, transcript, patch, frozen
  tests, results, usage, pricing). No transcript → no claim.
- LLM judges are barred from pass/fail. Deterministic behavioral tests only.
- The agent worktree never contains `tests/` or `solution/`.
- Never commit API keys. Keys live in `~/.factory/env.sh` (mode 600), never
  in the repo or `~/.factory/settings.json` (which uses `${ENV_VAR}` refs).
  Rotate the Z.AI key at the provider console before M5 config snapshots.
- The telemetry proxy (v1, deferred) stores hashes, lengths, and counters —
  never prompt contents.
- Vendor-neutral language for runtime-architecture concepts; DeepSeek and
  other influences are credited in docs, never in branding.

## Definition of done (M1) — met 2026-08-18

Scaffold + `sessions.js` two-level reader + `diagnose` MVP (stamp, redacted
snapshot, session dump, DT-id faults/hints, `--demo`, `--probe`) shipped;
28 tests + `npm run check` green; BYOK wiring done (env.sh, GLM-5.3 + Zen
free routes, probe-validated); docs synced. Build continues at M2.
