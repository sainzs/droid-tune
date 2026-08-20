# droid-tune — Project Plan

**Public name:** Droid Tune-Up · **Repo:** `droid-tune` · **CLI:** `droidtune`
**Tagline:** Diagnose. Tune. Verify. — More verified work. Fewer wasted tokens.
**One-line mission:** Find the Factory Droid configuration that produces the most
*verified* engineering work per dollar, then publish the evidence.

| | |
|---|---|
| Plan date | 2026-08-18 |
| Landscape verified as of | 2026-08-18 (see `docs/research-2026-08.md`) |
| Status | M5 infrastructure complete (2026-08-19); paid native baseline not run |
| Primary goal | Factory Guild submission (factory.ai/ambassador) |
| Stack | Zero runtime deps, Node ≥ 20, ESM (memex identity) |
| Relationship | Unofficial community project. **Not affiliated with Factory.** |

---

## 1. Mission and the one question

Droid is used daily and tuned by nobody. Factory declines to publish benchmark
numbers (Series C coverage, Apr 2026), ships ~10 CLI releases a month, and
records per-session cache token accounting that six community tools *report*
but none *optimize*. Meanwhile agent cost is dominated by cache economics that
changed underneath everyone twice this quarter (DeepSeek peak/off-peak billing
effective 2026-08-16; Anthropic default cache TTL dropped 1h→5m in early 2026).

Droid Tune-Up answers exactly one question, mechanically:

> **Which combination of model, reasoning effort, tool surface, context
> structure, session policy, and execution timing delivers the most verified
> engineering work per dollar from Factory Droid?**

The product is **not a leaderboard**. It is a diagnose → baseline → tune →
verify → monitor pipeline whose public claims are constrained by the Claims
Integrity Protocol (§8). The tool must be incapable of writing a stronger claim
than the evidence permits.

## 2. Why this, why now (all verified 2026-08-18)

1. **Factory can't self-produce credible external numbers.** Press coverage of
   their $150M Series C notes they've "declined to publish" benchmark scores.
   An independent, reproducible measurement is repostable marketing for them —
   exactly what the Guild rewards.
2. **Nobody benchmarks Droid.** No community harness drives `droid exec`; the
   GitHub topic `factory-droid-cli` had exactly 1 repo. Terminal-Bench 3
   measures harness/model pairs but doesn't include Droid; DeepSWE holds the
   harness constant by design.
3. **Cache economics are the cost story.** Agent loops re-send the same prefix
   every turn; hit-rate is the dominant term (DeepSeek cache-hit input is
   15–50× cheaper than miss depending on window and model — and now
   time-of-day doubles it). DeepSWE's own data shows the pattern: DeepSeek V4
   Flash at $0.10/task vs Claude Sonnet-class at $26/task.
4. **The telemetry already exists locally.**
   `~/.factory/sessions/<encoded-cwd>/<uuid>.settings.json` carries
   `tokenUsage.{inputTokens, outputTokens, cacheReadTokens,
   cacheCreationTokens, thinkingTokens, factoryCredits}` per session, paired
   with a `.jsonl` transcript. Reporting tools exist (OpenUsage, ccusage,
   SuperBased, toktrail); optimization tooling does not.
5. **Version churn creates the regression-tracking niche.** v0.193 retired
   MiniMax M2.5; v0.190 added Opus 5 to Auto routing; v0.196 fixed SessionStart
   hook context; v0.194/v0.189 fixed custom-model credential handling. At this
   cadence, version-stamped before/after measurement is a durable product.
6. **Factory has bugs in exactly our probe territory.** Their changelog shows
   fixes for "corrupted unicode normalization in file paths" — the memex
   corpus's home turf. Filesystem-torture tasks are regression territory.
7. **August 2026 runtime advances give us the vocabulary.** Composable plugin
   runtimes, event-sourced sessions, cache-safe prompt assembly, disjoint cache
   accounting (see §5 — credited vendor-neutrally; DeepSeek is attribution, not
   branding).

## 3. The gate: Factory Guild requirements

Application flow: **build something with Factory → post it publicly → submit
the link → interview with the Guild Council.** Resume upload is required.
Ranks: Apprentice (Max-plan credits) → Craftsman (Ultra) → Artisan
(unlimited credits, hiring fast-track).

Open-source submission guide (their words):

- ✅ Do: public repo, clear README + license, explain how it uses Droid,
  quickstart others can run, kept working today.
- ❌ Don't: empty repos, no setup instructions, **"copies of existing projects
  with no added value."**

Our fit map:

| Criterion | How we hit it |
|---|---|
| Build something with Factory | **Shipped:** drives `droid exec` headless through BYOK `customModels`, captures Droid session telemetry, and grades committed work. **Planned before launch:** `--worktree`, skills, hooks, and custom-droid experiments documented in README. |
| Public + linkable | Public repo, public results, public trajectories, 60-second demo |
| Reproducible | One command reruns any published claim from raw artifacts (§8) |
| Real metric | First public Droid configuration cost/quality frontier |
| Product signal to Factory | Diagnostics + harness-surface findings filed as issues (Craftsman-rank language) |
| Added value (not a copy) | Original tasks, original tooling, original methodology; parents (TB3/DeepSWE) credited in methodology |

**Submission checklist:** resume polished · timezone selected · "unofficial
community project, not affiliated with Factory" disclaimer in README ·
@FactoryAI tagged on the launch post · apply only after §11's bracketed
numbers are real.

## 4. Product definition

```text
droidtune diagnose     Check protocol, model routing, cache, and configuration health
droidtune trial        Run one development task and write a local evidence pack (M2 internal surface)
droidtune triforce     Offline verifier self-test: oracle×3, no-op×2, cheat legs (M3; CI gate)
droidtune baseline     Establish verified performance and cost (frozen bundle)
droidtune tune         Search model, effort, context, cache, and session settings (pilot)
droidtune verify       Prove a frozen tune on fresh confirmatory runs
droidtune monitor      Detect regressions after Droid or model updates (SPC)
```

Workflow: **Diagnose → Baseline → Tune → Verify → Monitor.**

Vocabulary (mechanical tune-up register):

| Concept | Term |
|---|---|
| Protocol + cache probes | **Diagnostics** |
| Initial benchmark | **Baseline run** |
| Named configuration under test | **Tune** |
| Task suite | **Test drive** |
| Cache cold start | **Warm-up cycle** |
| Failed task | **Fault** |
| Optimized configuration | **Performance tune** |
| Before/after results page | **Tune sheet** |
| Version re-checks | **Scheduled maintenance** |
| Regression alert | **Check-engine warning** |

Tunables (the levers `tune` sweeps — none may reference task content):

- Model + provider (Droid Core routing vs BYOK customModels)
- Reasoning effort (low / high / max on V4; per-model equivalents)
- Tool surface (custom droid `tools:` categories; skills count)
- AGENTS.md size and stability (byte-stable vs churn)
- Session reuse (fresh `droid exec` vs `--resume` chains)
- Compaction policy (timing, PreCompact hooks)
- Execution window (DeepSeek peak vs off-peak; Z.AI points windows)
- `maxOutputTokens` caps

## 5. Architecture

Vendor-neutral components; August-2026 runtime advances credited in
`docs/research-2026-08.md`, never in branding.

| Component | Advance it embodies | Implementation |
|---|---|---|
| **Diagnostics** (protocol witness) | Protocol correctness precedes performance claims | Probes: reasoning round-trip, thinking default tax, parallel tool-stream aggregation, cache-field decomposition, context ceiling, endpoint remapping, empty-response handling |
| **Event ledger** | "Model-visible means logged"; append-only source of truth | Every trial appends JSONL events; all metrics are projections over the log |
| **Context-surface meter** | Static prefix, tool schemas, dynamic context, history have different cache behavior | Measures stable-prefix size/churn, tool-surface size, growth per step |
| **Cache optimizer** | Cache efficiency = prefix stability × session policy × compaction × endpoint × window | Sweeps the tunables; before/after evidence packs |
| **Outcome verifier** | Grade observable behavior, never narration | Harbor-compatible tasks; hidden deterministic tests; isolated grading; no LLM judge for pass/fail |
| **Adaptive racer** | Full factorial sweeps waste money | Paired trials + successive halving; eliminate dominated tunes before n=5 finals |
| **Reporter** | One composite score hides tradeoffs | Tune sheet = counts, Wilson CIs, paired deltas, Pareto frontier |
| **Provenance stamp** | Fast-moving runtimes need exact attribution | Droid version, model route, config hashes, task/verifier SHAs, pricing snapshot, UTC window per trial |

Repo layout:

```text
droid-tune/
├── AGENTS.md
├── PLAN.md                    (this file)
├── README.md                  (M2 quickstart + disclaimer; M8 launch/results pass)
├── LICENSE                    (MIT)
├── docs/research-2026-08.md   (verified evidence base + citations)
├── bin/droidtune.js           (hand-rolled args; exit codes 0/1/2 like memex)
├── lib/
│   ├── diagnose.js            protocol + cache + config probes
│   ├── sessions.js            ~/.factory/sessions reader — two-level
│   │                          <encoded-cwd>/<uuid> pairs (settings.json + jsonl)
│   ├── runner.js              droid exec orchestration, isolated trials, timeouts
│   ├── ledger.js              append-only JSONL event log
│   ├── pack.js                evidence-pack writer + SHA-256 manifest
│   ├── verify.js              isolated verifier exec + CTRF/reward parsing
│   ├── tasks.js               Harbor-subset loader (minimal TOML subset parser)
│   ├── pricing.js             versioned pricing tables + peak/off-peak window math
│   ├── claims.js              claim registry: freeze, validate, render
│   ├── stats.js               Wilson CI, paired deltas, Pareto filter
│   └── report.js              tune sheets + claims report (from raw artifacts only)
├── tasks/                     Harbor layout per task (§6; t001 toy shipped M2)
├── configs/                   named tunes: native-droid, cache-stable-droid, byok-*
├── fixtures/                  synthetic sessions/configs for --demo + tests
├── test/                      node --test suites (zero-dep)
├── proxy/                     (v1, deferred) local BYOK telemetry proxy — hashes only
└── .github/workflows/ci.yml   tri-force validation + claim-registry CI
```

Deferred by design (post-submission north star, §10): cross-runtime adapter
plugin, telemetry proxy, metamorphic task generation, signed attestations,
mobile surface.

## 6. Task suite ("test drives")

**v0: 6–8 original tasks.** Small, hand-verified, offline fixtures.

Harbor-compatible layout (interop with the TB3/DeepSWE ecosystem):

```text
tasks/<task-id>/
├── instruction.md     short, behavior-focused prompt (DeepSWE register)
├── task.toml          fixture repo, base commit, language, category, timeouts
├── environment/       fixture setup (git repo seed script; Docker optional later)
├── solution/solve.sh  oracle — proves solvability
└── tests/test.sh      writes reward.json + CTRF per-test report
```

Categories:

| Category | Count | Notes |
|---|---|---|
| core-swe | 3 | Original feature/bug work on small pinned OSS fixtures |
| terminal-native | 2 | TB-style: git surgery, build plumbing; self-contained |
| filesystem-torture | 1–2 | **memex-derived** (NFC/NFD twins, reserved names, invisibles); reuse `matchKind` + `analyze()` from `~/Code/projects/memex/lib/` |
| harness-surface | 1 | Droid-specific probe: AGENTS.md compliance / skill invocation |

Anti-cheat invariants (from TB3 + DeepSWE v1.1):

- **Isolation invariant** — the agent worktree never contains `tests/` or
  `solution/`; runner copies tests in only after the agent commits.
- Git hygiene — shallow fixture at base commit, `main` pinned, future history
  destroyed; grade only the committed patch in a fresh checkout.
- Verifier asserts **public observable behavior** (CLI/API/files/exit codes),
  never internal symbols; accepts any reasonable implementation
  (prompt↔verifier bijection + acceptance breadth).
- Canary string in every task file.
- **Tri-force validation in CI before a task can enter a suite:** oracle
  passes · no-op fails · cheat-prompt agent fails. Flake-check each verifier
  3× during authoring.

Verification model: outcome-driven, deterministic tests only, exit-code →
reward contract; LLM judges are barred from pass/fail (TB3 precedent).

## 7. Experiment design

**Arms (v0):**

| Tune | Description |
|---|---|
| `native-droid` | Factory defaults, Droid Core routing |
| `cache-stable-droid` | Frozen AGENTS.md, progressive skills, scoped tool droid, deliberate session policy |
| `byok-deepseek-v4-flash` | DeepSeek V4 Flash (off-peak scheduled) |
| `byok-deepseek-v4-pro` | DeepSeek V4 Pro (off-peak scheduled) |
| `byok-glm-5.3` | Z.AI coding plan (user's existing config; points-window aware) |

**Model held constant** within any claim comparison; the *tune* varies.
Pairing: every arm gets the same task × attempt number; publish paired deltas.

**Scientific scope (what we may and may not claim):**

- ✅ Clean: within-Droid pass rate, cost, cache share, cycle time per tune at
  pinned model+task+verifier; cache-ablation deltas; version regressions.
- ✅ Descriptive: per-model BYOK economics (cost per verified task) through
  the same harness.
- ❌ Forbidden: cross-harness model rankings (system prompts, tool schemas,
  serving, tokenizers differ — the harness *is* the confound); universal
  claims beyond the observed suite/version; "Droid is X% better" language.

Cache ablations folded into `tune` sweeps: AGENTS.md minimal vs maximal ·
fresh vs resumed sessions · compaction at breakpoint vs never · endpoint
choice (Z.AI anthropic vs coding endpoint) · peak vs off-peak timing ·
per-provider hit-rate profile. Every trial stamped with UTC pricing window.

## 8. Claims Integrity Protocol (the core of the project)

> **Nothing appears on the public result page unless a stranger can run one
> command and reproduce the exact claim.**

1. **Pre-registered claims.** Before tuning, freeze a claim JSON: id,
   question, population (tasks), arms, pinned model, primary metric,
   secondary metrics, n (confirmatory), decision rule, date. Optimization may
   explore; the report may only present confirmatory runs.
2. **Baseline first.** Freeze the bundle before any tuning: task SHAs,
   verifier SHAs, Droid version, settings hash, model/provider/effort, plugin
   state, fixture repo states, pricing table, prompts, timeout/retry policy.
3. **Paired trials.** task-01/attempt-01 runs in *every* arm; publish observed
   paired deltas, not averages that hide heterogeneity.
4. **Evidence packs per trial.** `manifest.json`, `instruction.md`,
   `config.snapshot.json`, `events.jsonl`, `transcript.jsonl`, `patch.diff`,
   frozen `tests/`, `results.json`, `usage.json` (+ optional
   `provider-usage.json`), `pricing.json`, `errors.json`. No transcript → no
   claim. No verifier SHA → no claim. No model-route evidence → no claim.
5. **Behavioral, isolated verification** (§6): agent never sees tests,
   reference solution, or future history; verifier reads final state only.
6. **Tri-force per task** (oracle / no-op / cheat), stored as evidence.
7. **Fail loud.** Outcome classes: `VERIFIED_PASS`, `VERIFIED_FAIL`,
   `NO_SUBMISSION`, `CONTEXT_OVERFLOW`, `PROVIDER_ERROR`, `NETWORK_ERROR`,
   `DROID_ERROR`, `TIMEOUT`, `VERIFIER_ERROR`. Primary claims use only
   VERIFIED_*; every excluded trial stays public with its class.
8. **No retry grooming.** Retry policy frozen up front: ≤1 retry for
   transient provider errors; verifier-error → quarantine task; crash/overflow
   → recorded class. Retries replace nothing; originals stay public.
9. **Dual-layer cache accounting.** Layer 1: Droid session `tokenUsage`.
   Layer 2 (BYOK only, v1): local proxy verifying provider usage fields,
   effective route, envelope hash, prefix hash, dynamic-context boundary,
   pricing window — **hashes/lengths/counters only, never prompt contents**.
   If layers disagree, publish the disagreement.
10. **Pilot ≠ confirmatory.** `tune` explores on pilot runs (n=3); claims are
    computed only from fresh confirmatory runs (n=5) after the tune is frozen.
11. **Controls in every suite.** no-op, oracle, cheat, cache-invalidating
    control, and (where feasible) wrong-model and malformed-protocol controls
    — proof the suite can detect failure.
12. **Bounds, not hype.** Exact counts (`7/12`), Wilson CIs, absolute dollar
    deltas, paired per-task deltas, n, date range, Droid version, model route,
    pricing window, exclusions, limitations. A tight small result beats a
    broad claim.
13. **Versioned claims.** Every result carries
    `{droidVersion, observedAt, modelRoute{requested,observedProvider,endpointHash}, pricingSnapshot, taskSetSha, verifierSha}`.
    A Droid/model update creates a new control-chart point, never invalidates
    history.
14. **Language rules.** Allowed: "in this suite", "across these paired
    trials", "at Droid vX and route Y", "observed", "measured". Forbidden:
    "Droid is now X% better", "this model is best", "universally faster",
    "first-ever" (unverified), "cache optimized" without before/after.
15. **Guild evidence bar.** Fresh clone runs the baseline; the report
    regenerates from raw artifacts; every public number maps to a claim ID;
    CI validates the claim registry; the demo shows one before/after result
    end-to-end.

## 9. Metrics and reporting

| Metric | Definition |
|---|---|
| **Cost per verified task** | total observed $ ÷ VERIFIED_PASS count (primary economic) |
| **First-pass yield** | VERIFIED_PASS ÷ valid trials (primary quality) |
| **Cache read share** | cacheReadTokens ÷ (input + cacheRead) reusable input |
| **Specific token consumption** | tokens ÷ verified task |
| **Cycle time** | wall-clock per trial (reported; never sole ranking key) |
| **Availability** | 1 − (harness/provider failure rate) |
| **Consistency** | spread across repeated trials (Cpk-lite) |

Pricing engine: versioned tables with effective dates; DeepSeek peak windows
(01:00–04:00, 06:00–10:00 UTC) and Z.AI points windows (14:00–18:00 UTC+8
weekdays) resolved per-trial from UTC timestamps. Stale-pricing guards: refuse
to price a trial whose window precedes the table's effective date.

Report shape (tune sheet): provenance block → outcome-class table (nothing
hidden) → paired per-task deltas → Wilson-CI'd yields → Pareto frontier
(cost × first-pass yield) → limitations.

## 10. Milestones

**v0 — two weeks, Guild-ready:**

| # | Days | Deliverable |
|---|---|---|
| M1 | 1–2 | Scaffold; `sessions.js` reader; `diagnose` MVP (version stamp, config snapshot, session tokenUsage dump, obvious-fault detection); BYOK `--probe` round-trip; harness hints; `--demo` fixtures; README stub + LICENSE ✅ 2026-08-18 |
| M2 | 3–4 | `runner.js` + `ledger.js` + evidence packs; one toy task end-to-end through `droid exec` ✅ 2026-08-18 (t001 VERIFIED_PASS, Zen free route, $0) |
| M3 | 5–6 | `verify.js` (isolation invariant, git hygiene, CTRF/reward); tri-force CI ✅ 2026-08-18 (62 tests, 7/7 triforce legs green) |
| M4 | 7–8 | Author 6–8 tasks; 3× flake check — **tasks done**: 7 authored 2026-08-19 (t001 toy; t002 core-swe; t003 + t006 filesystem-torture [memex]; t004 + t007 terminal-native; t005 harness-surface), all verifiers discriminate. Triforce generalized (49/49 legs). Hardening shipped: S1 isolation (tests//solution/ patches disqualified), S2/S3 PROVIDER_ERROR envelope gating (+ unit tests), env-allowlist for droid exec (stop env-name leak into packs). **Live flake check done 2026-08-19**: 40 trials on 4 Zen free routes ($0), 73% PASS — t004-git-surgery is the discriminative instrument (7/8 NO_SUBMISSION: models do the work, forget `git commit`); t003 separates small models by timeout; t002/t005/t007 stable. See `docs/m4-flake-check-2026-08.md` |
| M5 | 9–10 | `pricing.js`; baseline runs for `native-droid`; freeze first claim entries — **infrastructure done 2026-08-19**: pricing fails closed on stale/unknown routes, native bundle + preregistered claim frozen, explicit-spend baseline CLI added. Paid native baseline remains unrun. |
| M6 | 11–12 | Tune arms (`cache-stable-droid` + BYOK models); pilot n=3 |
| M7 | 13 | Confirmatory paired runs n=5 (finalists only) |
| M8 | 14 | Tune sheet + claims report + 60-second demo + README/disclaimer → publish → Guild submission |

**M2 packs are development artifacts, not claim evidence.** They intentionally
omit `pricing.json` until M5 and do not satisfy the M3 verifier/tri-force gate.
The Claims Integrity Protocol still requires the complete §8.4 pack before a
number may appear publicly.

**Budget guardrail:** pilot n=3, confirmatory n=5 finalists only; rough v0
envelope at V4-Flash off-peak ≈ $0.07/trial (100k output tokens) → full v0
well under $100. Hard budget flag in the runner; abort over cap. Free BYOK
routes (OpenCode Zen free tier, wired 2026-08-18 — research §6) cover M4
flake-checks and M6 pilots at $0; paid routes are reserved for M7
confirmatory runs.

**North star (post-submission, in order):**

1. `monitor` — SPC control charts per Droid release (the regression tracker).
2. Cross-runtime descriptive comparisons (minimal/tool-rich reference
   profiles) — clearly labeled full-system comparisons.
3. Local BYOK telemetry proxy (request-level cache attribution; hashes only).
4. Compaction break-even analysis (summary cost vs re-encoding savings).
5. Metamorphic/procedural task variants against unpublished seeds
   (contamination defense).
6. Signed result attestations (runtime + task + verifier + pricing hashes).
7. Mobile results/approval surface (after the measurement foundation).

## 11. Guild application kit

**Pitch template** (submit only when brackets are real):

> I built **Droid Tune-Up**, an open-source diagnostic and optimization
> toolkit for Factory Droid. It establishes a verified baseline, diagnoses
> model-routing and cache problems, and tunes model choice, reasoning effort,
> tools, context structure, session reuse, compaction, and execution timing.
> Every tune is tested against original software tasks with deterministic
> behavioral verification; a configuration is recommended only when it
> improves cost or performance without reducing task success.
>
> Across **[N] verified test drives**, the recommended tune reduced cost per
> successful task by **[$X→$Y]**, increased cache reuse by **[Z%]**, and
> maintained **[first-pass yield]**. Every task, verifier, trajectory,
> configuration, pricing snapshot, and before/after tune sheet is public.

**Interview answer (30 seconds):** Terminal-Bench measures harness/model
pairs; DeepSWE isolates models under a fixed harness. I held the harness
constant — Droid — and measured how its *configuration* changes verified work
per dollar: protocol conformance first, then paired before/after trials with
deterministic verification. The result is both a practical tuning guide for
Droid users and reproducible product signal for Factory.

**Launch post:** counts + dollar deltas + one chart + repo link + @FactoryAI.

**Submission prerequisites:** resume (required upload) · timezone · disclaimer
present · all links live · claims registry CI green.

## 12. Risks and guardrails

| Risk | Guardrail |
|---|---|
| `droid exec` output-schema drift (~10 releases/mo) | Record `droid --version` before every batch; pin per run; schema-version field in ledger; auto-update caveat documented |
| Benchmark overfitting | Pilot/confirmatory split (§8.10); frozen decision rules |
| Cache attribution limits (Droid reports session-level totals only) | Scope v0 claims to session-level; per-request layer only via v1 proxy; publish layer disagreements |
| Provider pricing volatility (2 changes already this quarter) | Versioned pricing tables + effective-date guards + window stamping |
| Trademark / affiliation | Disclaimer everywhere; nominative use only; "Factory Droid" referenced as the measured product |
| Cost overrun | Budget cap flag in runner; n discipline; off-peak scheduling for BYOK arms |
| Upstream dev-preview APIs | v0 depends on **none** (CLI-level only); adapter/plugin work deferred to north star |
| False-positive verifiers | Tri-force + 3× flake check + behavioral-only assertions + acceptance-breadth review |

## 13. Local environment facts (verified 2026-08-18)

- Droid v0.197.0 at `~/.local/bin/droid`; latest is v0.198.0 (2026-08-17).
- `~/.factory/`: `sessions/` (**two-level**: `<encoded-cwd>/<uuid>.settings.json`
  + `.jsonl` — verified live 2026-08-18), `droids/` (opus-planner,
  luna-research-worker, luna-review-worker, sol-strategist,
  sequential-delivery-worker, scrutiny-feature-reviewer,
  user-testing-flow-validator), `plugins/`, `settings.json`, `env.sh`
  (600-mode BYOK keys, added M1).
- Session settings carry `tokenUsage.{inputTokens, outputTokens,
  cacheReadTokens, cacheCreationTokens, thinkingTokens, factoryCredits}`,
  `inclusiveTokenUsage`, `providerLock`, `assistantActiveTimeMs`,
  `tags [{name:"exec"}]`. **Route-class lesson (probe, 2026-08-18):**
  `factoryCredits` is present-but-0 on BYOK sessions under droid 0.197 —
  the reliable discriminator is the `custom:` model prefix.
- **Key hygiene (updated M1):** the plaintext Z.AI key was relocated to
  `~/.factory/env.sh` (mode 600, sourced from `~/.zshrc`, referenced as
  `${ZAI_API_KEY}`); GLM-5.3 + three Zen free routes wired the same way.
  Rotation at the Z.AI console is still recommended before M5 config
  snapshots.
- memex (`~/Code/projects/memex`) provides `matchKind()` / `analyze()` for
  filesystem-torture tasks — import the approach, not the dep.
- `~/Code/projects/mini-swe-subs` — guarded mini-swe-agent runner + prior
  3-model arena experience (Aug 14); reusable as the minimal reference
  profile runner in the north-star cross-runtime phase.
- `~/Code/projects/dsh-shell-bakeoff` — separate effort (DSH desktop shells);
  no overlap, don't merge.
- `~/Code/projects/santiagosainz-skills` — dormant; candidate Guild
  submission #2 (add a Droid adapter target) after this one lands.

## 14. Working sequence (first two weeks)

```text
 1. Build droidtune diagnose
 2. Build droidtune baseline
 3. Author six tasks; validate oracle/no-op/cheat
 4. Record baseline evidence packs
 5. Change one tunable
 6. Record tuned evidence packs
 7. Run fresh confirmatory paired trials
 8. Generate claims report from raw data only
 9. Publish tasks, trajectories, failures, prices, configs, report
10. Submit only the claims that survive the pipeline
```

## 15. Evidence base

All verified facts, pricing tables, and citations live in
`docs/research-2026-08.md`. Anything not cited there is not load-bearing.
