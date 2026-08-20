# Droid Tune-Up

**Diagnose. Tune. Verify. — More verified work. Fewer wasted tokens.**

An open-source diagnostic, tuning, and verification toolkit for
[Factory Droid](https://docs.factory.ai). It answers one question, mechanically:
which Droid configuration delivers the most *verified* engineering work per
dollar — with evidence packs, paired trials, and claims that never outrun their
data.

> **Unofficial community project. Not affiliated with Factory.**
> "Factory Droid" is referenced as the measured product, nominative use only.

**Status: M5 infrastructure complete** — diagnostics, isolated trials, the
seven-task tri-force suite, versioned pricing, frozen native-Droid baseline
bundles, and preregistered claims are live. The first paid native baseline has
not been run; `baseline` requires explicit spend confirmation. See
[`PLAN.md`](PLAN.md).

## Results

In this suite, on 2026-08-19, the original M4 flake check observed
**29/40 `VERIFIED_PASS`** across five original tasks and four OpenCode Zen
free routes, at **$0**. **t004-git-surgery** was the discriminative
instrument: **7/8 `NO_SUBMISSION`** — agents did the technical work and
omitted the required `git commit`. One `nemotron-3.5-lightning-free`
attempt committed and passed. Full matrix, lineage notes, and limitations:
[`docs/m4-flake-check-2026-08.md`](docs/m4-flake-check-2026-08.md).

| task | hy3-free | laguna-s-2-1-free | nemotron-3-5-lightning-free | nemotron-3-ultra-free |
| --- | --- | --- | --- | --- |
| `t002-slugify` | PASS, PASS | PASS, PASS | PASS, PASS | PASS, PASS |
| `t003-path-canonicalize` | PASS, timeout, PASS | timeout | PASS, timeout | PASS, PASS |
| `t004-git-surgery` | no-sub, no-sub | no-sub, no-sub | PASS, no-sub | no-sub, no-sub |
| `t005-agents-md-compliance` | PASS, PASS | PASS, PASS | PASS, PASS | PASS, PASS |
| `t007-rename-symbol` | unknown, PASS | PASS, PASS | PASS, PASS | PASS, PASS |

Regenerate either view from the evidence packs — no numbers are hand-written:

```sh
node scripts/flake-report.js  --runs-dir runs/m4-flake3 \
  --tasks t002-slugify,t003-path-canonicalize,t004-git-surgery,t005-agents-md-compliance,t007-rename-symbol
node scripts/results-table.js --runs-dir runs/m4-flake3 --tasks <same list>
```

Counting note: of those 40 trials, 39 actually reached the model (one never
did). Scored over trials that reached the model, the rate is **29/39 (74%)**.
`results-table.js` reports the stricter denominator; the 29/40 figure counts
every attempted trial.

This is a harness result, not a model ranking and not a Droid
cost-optimization claim. No paid native baseline has been run.

**Not every advertised free route works.** A serial probe of all 10 configured
free routes on 2026-08-19 found only 4 usable; the rest failed with 429 rate
limiting, `401 ... is not supported`, a local config gap, or a timeout — all
of which `droid exec` reports as the same `PROVIDER_ERROR`. See
[`docs/free-route-routability-2026-08-19.md`](docs/free-route-routability-2026-08-19.md).

## Install as a Droid plugin

```sh
droid plugin marketplace add https://github.com/sainzs/droid-tune && droid plugin install droid-tune --scope user
```

This exposes `/tune-diagnose`, `/tune-trial`, and `/tune-report`, which wrap the CLI in this repo — no logic duplication.

## Requirements

- Node ≥ 20 (zero runtime dependencies)
- [Factory Droid CLI](https://docs.factory.ai) installed (optional for `--demo`)

## Quickstart

```sh
git clone https://github.com/sainzs/droid-tune.git && cd droid-tune
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
  --model hy3-free \
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
| `baseline --confirm-spend` | Freezes the committed `native-droid-v1` bundle, then runs its six live Droid Core tasks; refuses to start without the confirmation flag |
| `triforce` | Runs oracle, no-op, and cheat controls for every full-layout task without calling Droid |

Diagnose flags: `--probe [model]` · `--demo` · `--limit <n>` · `--json`.

Trial flags: `--task <dir>` · `--model <id-or-substring>` · `--tune <name>` ·
`--attempt <n>` · `--auto <low|medium|high>` · `--timeout-ms <n>` ·
`--runs-dir <path>` · `--json`.

Common overrides: `--sessions-dir <path>` · `--config <file>` ·
`--droid-path <path>`.

The native baseline intentionally records observed Factory Standard Credits,
not a fabricated USD conversion. No live baseline was run as part of M5
implementation. Its frozen guard is 100k output tokens per trial and 600k
cumulative; a breach stops the remaining tasks. To spend credits deliberately:

```sh
node bin/droidtune.js baseline --confirm-spend
```

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
- `baseline` freezes the bundle, task/verifier hashes, redacted-config hash,
  Droid version, pricing table, and claim IDs before its first live trial.

## Evidence packs

Evidence packs include provenance, instruction, redacted config snapshot, event
ledger, transcript when Droid emitted one, committed patch, frozen tests,
results, usage, errors when present, and a SHA-256 manifest. Local development
packs under `runs/` are gitignored.

M5 can add a versioned `pricing.json`: exact USD token cost for supported
DeepSeek V4 tables, exact zero for the frozen Zen-free table, or observed
Factory Standard Credits for native Droid. Unknown routes and stale tables fail
closed. Development packs remain ineligible when any required artifact is
absent. No transcript, verifier provenance, or pricing snapshot means no claim.

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
