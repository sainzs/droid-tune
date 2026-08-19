# Droid Tune-Up

**Diagnose. Tune. Verify. — More verified work. Fewer wasted tokens.**

An open-source diagnostic, tuning, and verification toolkit for
[Factory Droid](https://docs.factory.ai). It answers one question, mechanically:
which Droid configuration delivers the most *verified* engineering work per
dollar — with evidence packs, paired trials, and claims that never outrun their
data.

> **Unofficial community project. Not affiliated with Factory.**
> "Factory Droid" is referenced as the measured product, nominative use only.

**Status: M2 complete** — `diagnose` (session telemetry, config health,
faults/hints, BYOK probe) and `trial` (one task end-to-end through `droid
exec` with a hash-manifested development evidence pack) are live. M3 adds the
hardened verifier and tri-force validation; pricing and claim-eligible packs
arrive at M5. See [`PLAN.md`](PLAN.md).

## Requirements

- Node ≥ 20 (zero runtime dependencies)
- [Factory Droid CLI](https://docs.factory.ai) installed (optional for `--demo`)

## Quickstart

```sh
git clone <repo> && cd droid-tune
node bin/droidtune.js diagnose --demo   # zero-install: runs bundled fixtures
npm run check                           # tests + CLI smoke
```

Diagnose your real setup:

```sh
node bin/droidtune.js diagnose          # offline: version, config, sessions
node bin/droidtune.js diagnose --json   # machine-readable
```

Run the included toy task through a configured BYOK model:

```sh
source ~/.factory/env.sh
node bin/droidtune.js trial \
  --task tasks/t001-greet-script \
  --model deepseek-v4-flash-free \
  --tune m2-smoke
```

Exit codes: `0` clean or `VERIFIED_PASS` · `1` faults or another trial
outcome · `2` usage error.

## Commands

| Command | What it does |
|---|---|
| `diagnose` | Version stamp, redacted config snapshot, session token/cache dump, faults + harness hints |
| `diagnose --probe [model]` | Live round-trip through `droid exec` on a BYOK custom model; asserts the session lands with disjoint cache fields. Opt-in (spends your BYOK credits/points) |
| `diagnose --demo` | Same pipeline against bundled fixtures — no Droid install needed |
| `trial --task <dir>` | Runs one task end-to-end through `droid exec` (isolated temporary repo, frozen tests copied into a fresh grading copy only after the agent commits) and writes a hash-manifested development evidence pack |

Diagnose flags: `--probe [model]` · `--demo` · `--limit <n>` · `--json`.

Trial flags: `--task <dir>` · `--model <id-or-substring>` · `--tune <name>` ·
`--attempt <n>` · `--auto <low|medium|high>` · `--timeout-ms <n>` ·
`--runs-dir <path>` · `--json`.

Common overrides: `--sessions-dir <path>` · `--config <file>` ·
`--droid-path <path>`.

### Findings

Every finding has a stable ID. Faults (exit 1): `DT001` droid missing ·
`DT002` plaintext API key · `DT003` unparseable session · `DT004` session
without transcript · `DT005` orphan transcript · `DT006` no token usage despite
messages · `DT007` sessions dir missing · `DT-P00x` probe failures.
Hints (advisory, evidence-linked): `DT101` coding-endpoint tool-call risk ·
`DT102` newer GLM available · `DT103` high-effort thinking tax ·
`DT104` model slots burning Factory credits.

## How it uses Droid

- Reads Droid's own telemetry: `~/.factory/sessions/<encoded-cwd>/<uuid>.settings.json`
  (`tokenUsage`, cache fields, tags, provider lock) and `.jsonl` transcripts.
- `--probe` drives `droid exec` headless with a custom model, tagging the
  session (`--tag droidtune-probe`) so probe runs are self-identifying and
  excluded from your session aggregates.
- `trial` drives a task through `droid exec`, records the tagged Droid session,
  extracts the committed patch, grades it against tests the agent never saw,
  and freezes the artifacts under `runs/<tune>/<task>/attempt-N/`.
- Later milestones add hardened CTRF verification, task-suite controls,
  paired trials, pricing, and claim-registry enforcement (see `PLAN.md` §6–§8).

## Evidence packs

M2 packs include provenance, instruction, redacted config snapshot, event
ledger, transcript when Droid emitted one, committed patch, frozen tests,
results, usage, errors when present, and a SHA-256 manifest. Local development
packs under `runs/` are gitignored.

These M2 packs are **not public-claim evidence**: pricing is not implemented
until M5, and M3 still needs to harden verification and add tri-force controls.
No transcript, verifier provenance, or pricing snapshot means no claim.

## BYOK recipe (`${ENV_VAR}` keys, never plaintext)

Droid's `~/.factory/settings.json` supports environment-variable references in
`customModels[].apiKey`. Recommended setup:

```sh
# 1. Keep keys in a 600-mode env file (never committed):
cat > ~/.factory/env.sh <<'EOF'
export ZAI_API_KEY="sk-..."
export OPENCODE_ZEN_KEY="sk-..."
EOF
chmod 600 ~/.factory/env.sh

# 2. Source it from your shell:
echo '[ -f "$HOME/.factory/env.sh" ] && source "$HOME/.factory/env.sh"' >> ~/.zshrc

# 3. Reference in settings.json:
#    { "model": "glm-5.3", "baseUrl": "https://api.z.ai/api/anthropic",
#      "apiKey": "${ZAI_API_KEY}", "provider": "anthropic", ... }
```

`diagnose` treats any non-`${ENV}` apiKey as fault `DT002`. Rotate keys at the
provider console before relying on config snapshots.

## Claims integrity

Nothing is claimed publicly that a stranger cannot reproduce from this repo.
The full protocol lives in [`PLAN.md`](PLAN.md) §8; the verified evidence base
with citations is [`docs/research-2026-08.md`](docs/research-2026-08.md).

## License

[MIT](LICENSE) © Santiago Sainz
