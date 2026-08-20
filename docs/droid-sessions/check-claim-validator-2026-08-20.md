# Droid session: mechanical claim validator (`scripts/check-claim.js`)

- **Session id**: `ef66b883-4cb3-4eb3-aa04-9aa5b2aa4047`
- **Model**: `deepseek-v4-flash-0731` (Factory native — this session spent
  11,138 Factory Standard Credits, unlike the earlier free-route sessions)
- **Autonomy**: `--auto high`, run in an isolated git worktree
  (`droid/flash-claimcheck`) so it could not collide with concurrent work
- **Invocation**: `droid exec -m deepseek-v4-flash-0731 --auto high -f
  /tmp/dt-specs/flash-claimcheck.md --cwd /tmp/dt-flash -o json`
- **Duration / usage**: 211s, 16 turns; input 47,183 · output 22,306 ·
  cache_read 534,669 · factory_credits 11,138
- **Result envelope**: `is_error: false`, `subtype: success`

## The brief

Build a mechanical validator for `claims/*.json` — the repo's Claims Integrity
Protocol (PLAN §8) requires the tool be incapable of stating a claim the
evidence does not support, but the claim files were hand-written and unchecked.
Constraints given: one new script plus one new test file, no existing file
modified, follow the argv/exit conventions of `scripts/results-table.js`, reuse
`sha256String` from `lib/pack.js` rather than hand-rolling hashing.

## What Droid produced

`scripts/check-claim.js` (188 lines) and `test/check-claim.test.js` (167
lines), 355 insertions, no existing file touched. Ten checks, one OK/FAIL line
per claim, exit 0/1/2. Notably it worked out on its own that checks for
`design`, `routes` and `exclusionRule` must be presence-conditional, because
the committed `dt-v0-cache-stability.json` legitimately carries none of them
while still having to pass.

## Verification performed by the maintainer before merge

Not taken on trust. Independently re-ran the script against both committed
claims (both OK, exit 0), then tampered with copies:

- `tuneSha256` replaced with a bogus digest → exit 1,
  `tune: sha256 of tunes/ledger-lite/AGENTS.md does not match the pinned tuneSha256`
- `design.totalTrials` changed 80 → 79 → exit 1,
  `design: totalTrials 79 != arms 2 x routes 4 x nPerArmPerRoute 10 (= 80)`

Full suite green with the new tests included. Wired into CI in the same commit
so claim drift fails the build.
