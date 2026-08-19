# droid-tune — Agent Notes

Droid Tune-Up: open-source diagnostic, tuning, and verification toolkit for
Factory Droid — measures and maximizes **verified** engineering work per
dollar. Built as a Factory Guild submission (factory.ai/ambassador).

**Status: plan stage.** `PLAN.md` is the source of truth; `docs/research-2026-08.md`
is the verified evidence base. No code exists yet — first code lands in
PLAN.md §10 M1 (scaffold + `sessions.js` + `diagnose` MVP).

## Commands

None yet (plan stage). When M1 lands: `node bin/droidtune.js <cmd>` with exit
codes 0 clean / 1 faults / 2 usage, hand-rolled arg parsing, `npm run check`
for CI parity.

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
- Never commit API keys. `~/.factory/settings.json` holds a live Z.AI key
  that must be rotated before M5 config snapshots.
- The telemetry proxy (v1, deferred) stores hashes, lengths, and counters —
  never prompt contents.
- Vendor-neutral language for runtime-architecture concepts; DeepSeek and
  other influences are credited in docs, never in branding.

## Definition of done (plan stage)

This file, `PLAN.md`, and `docs/research-2026-08.md` committed; workspace map
row added. Build begins at M1.
