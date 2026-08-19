# Droid Tune-Up

**Diagnose. Tune. Verify. — More verified work. Fewer wasted tokens.**

An open-source diagnostic, tuning, and verification toolkit for
[Factory Droid](https://docs.factory.ai). It answers one question, mechanically:
which Droid configuration delivers the most *verified* engineering work per
dollar — with evidence packs, paired trials, and claims that never outrun their
data.

> **Unofficial community project. Not affiliated with Factory.**
> "Factory Droid" is referenced as the measured product, nominative use only.

**Status: M1** — `diagnose` MVP (session telemetry reader, config health,
fault detection, BYOK exec probe). Baseline/tune/verify/monitor land in later
milestones. See [`PLAN.md`](PLAN.md).

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

Exit codes: `0` clean · `1` faults found · `2` usage error.

## Commands

| Command | What it does |
|---|---|
| `diagnose` | Version stamp, redacted config snapshot, session token/cache dump, faults + harness hints |
| `diagnose --probe [model]` | Live round-trip through `droid exec` on a BYOK custom model; asserts the session lands with disjoint cache fields. Opt-in (spends your BYOK credits/points) |
| `diagnose --demo` | Same pipeline against bundled fixtures — no Droid install needed |

Flags: `--sessions-dir <path>` · `--config <file>` · `--droid-path <path>` ·
`--limit <n>` · `--json`.

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
- Later milestones run full task suites through `droid exec` with paired
  trials and frozen evidence packs (see `PLAN.md` §6–§8).

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
