# droid-tune — Verified Evidence Base (August 2026)

Every load-bearing fact behind `PLAN.md`, with sources. Verified 2026-08-18.
Anything not cited here is not load-bearing. Prices move; check before runs.

---

## 1. Factory Guild (the gate)

Source: https://factory.ai/ambassador (page fetched 2026-08-18, incl. submission-guide HTML).

- Application: (1) build something with Factory, (2) post publicly,
  (3) submit the link. New candidates interview with the Guild Council.
  "We curate for quality and don't accept every submission by default."
- Form: name, email, LinkedIn, **resume (required upload)**, timezone,
  submission link; consent to Factory reposting.
- Ranks: Apprentice (full Max-plan credits, welcome kit, group mentorship) →
  Craftsman (Ultra credits, 1:1 mentorship, premium kit) → Artisan
  (unlimited credits, hiring fast-track, conference stipend, NDA previews).
- Open-source guide — Do: public repo, clear README + license, explain how it
  uses Factory/Droid, quickstart, kept working. Don't: empty repos, no README,
  **"copies of existing projects with no added value."**
- Writing guide — Do: end-to-end walkthrough, exact Droid features used,
  screenshots/diffs, before/after or a real metric. Don't: invented benchmarks.

## 2. Factory / Droid platform facts

Sources: https://docs.factory.ai (CLI reference, BYOK, hooks, plugins, skills,
subagents, changelog), https://github.com/Factory-AI.

- Droid CLI v0.198.0 shipped 2026-08-17 (198 releases logged; ~10/month in
  Aug 2026). Local install: v0.197.0.
- `droid exec`: headless mode with `--output-format text|json|stream-json|
  stream-jsonrpc`, `-f prompt.md`, `--auto <level>`, `--worktree`,
  `--use-spec`; exit codes 0/1/2 (clean/runtime/usage).
- BYOK: `customModels[]` in `~/.factory/settings.json` — `model`,
  `displayName`, `baseUrl`, `apiKey` (supports `${ENV}`), `provider`
  (`anthropic` | `openai` | `generic-chat-completion-api`),
  `maxOutputTokens`, `noImageSupport`, `apiKeyHelper`, `extraHeaders`.
- Session telemetry: `~/.factory/sessions/<id>.settings.json` →
  `tokenUsage.{inputTokens, outputTokens, cacheReadTokens,
  cacheCreationTokens, thinkingTokens}` + `.jsonl` transcript. Session-level
  totals only (no per-message usage). Documented independently by OpenUsage
  (openusage.sh/docs/providers/droid), ccusage, SuperBased, toktrail,
  llm-usage-metrics.
- In-session: `/cost`, `/stats [period]`, `/context`, `/model`, `/compress`.
- Hooks: 9 events (PreToolUse w/ `permissionDecision`
  allow/deny/ask + `updatedInput`, PostToolUse, UserPromptSubmit,
  Notification, Stop, SubagentStop, PreCompact, SessionStart, SessionEnd);
  JSON on stdin; exit 2 blocks; user/project scopes; plugin hooks via
  `${DROID_PLUGIN_ROOT}`.
- Plugins: `.factory-plugin/plugin.json` + `skills/ commands/ droids/ hooks/
  mcp.json`; marketplaces (`marketplace.json`); Claude-Code layouts
  auto-translate; `droid plugin marketplace add <url>` installs.
- Custom droids (subagents): `.factory/droids/*.md` frontmatter `model`,
  `reasoningEffort`, `tools` categories (read-only/edit/execute/web/mcp).
- Skills: `SKILL.md` + frontmatter, progressive disclosure, user-invocable as
  slash commands.
- AGENTS.md: durable project instructions; nested discovery; reads CLAUDE.md
  compat.
- Recent releases relevant to us: v0.198 diff-wrap (08-17); v0.196 SessionStart
  hook-context fix (08-14); v0.194 TS-SDK session messages + custom-model
  credential error fix (08-12); v0.193 MiniMax M2.5 retired (08-11); v0.190
  Opus 5 in Auto model + HTTPS proxy (08-07); v0.189 custom-model key-helper
  fix (08-06). Historical: "corrupted unicode normalization in file paths"
  fix (pre-2026) — precedent for filesystem-torture category.
- Factory keeps benchmarking internal (`legacy-bench`, terminal-bench runs).
  Org: `factory-plugins` (~102⭐: core, droid-control, security-engineer,
  typescript, debugging, code-review, droid-evolved, autoresearch),
  `cursed-plugins` (104⭐), `eslint-plugin` (209⭐), `droid-action` (51⭐),
  `droid-sdk-typescript` (38⭐, "major overhaul in progress" — avoid),
  `vfs` (Rust, "filesystem for agents").
- Community gaps verified 2026-08: GitHub topic `factory-droid-cli` → 1 repo;
  no community eval harness; no hooks library; BYOK is hand-edited JSON
  (open issue Factory-AI/factory#1267: no context-window detection for
  custom models); discussion #8: custom-droid model pins silently fall back
  and burn credits; T3 Code (pingdotgg/t3code, ~19k⭐, MIT) supports
  Codex/Claude/Cursor/Grok/OpenCode but **not** Droid (community complaints
  ongoing); no community mobile client (Factory's mobile surface is
  steer-only).
- "droid-bench" name free (only collision: academic DroidBench, Android
  taint analysis — unrelated). We chose **Droid Tune-Up** regardless.
- Factory Series C: $150M @ $1.5B post-money, Khosla-led, announced
  2026-04-16 (TechCrunch / factory.ai/news/series-c). Coverage notes Factory
  "declined to publish" SWE-Bench numbers.

## 3. Benchmark parents

### Terminal-Bench 3.0 (frontierbench.ai, harbor-framework/frontier-bench)

- TB3 shipped with 74 tasks / 7 domains; best ~34% (GPT-5.6 Sol via Codex
  34.4%, Fable 5 via Claude Code 33.8%). TB 2.1 saturated (~79–84%).
- Measures **harness×model pairs** (leaderboard rows are agent products).
  Paper: model choice > scaffold choice (Codex +52% across models vs
  Terminus 2 +17% for one model). arXiv:2601.11868 (ICLR 2026).
- Harbor task format: `instruction.md`, `task.toml`, `environment/Dockerfile`
  (or `docker_image`), `solution/solve.sh`, `tests/test.sh` writing
  `/logs/verifier/reward.txt|reward.json`. Separate agent vs verifier
  containers enable re-grading.
- Verification: outcome-driven (final container state), never transcript;
  specificity/solvability/integrity criteria; oracle + no-op + adversarial
  cheat-agent validation; deterministic grading only (LLM judge only for
  post-hoc analysis); ≥5 trials, 95% CI; canary strings.
- Known weaknesses (their own ABC): flakiness, contamination (all public),
  no quantitative flaw-impact analysis, leaderboard saturation, internet
  access. Community criticism: harness confounds dominate.

### DeepSWE v1.1 (datacurve-ai/deep-swe, 1.4k⭐, Apache-2.0)

- 113 original contamination-free tasks, 91 repos, 5 languages; reference
  solutions avg 668 LOC; prompts ~2.2k chars. Tasks never merged upstream;
  shallow clone with future history destroyed.
- Behavioral verifiers asserting public APIs; review rubric: prompt↔verifier
  bijection, acceptance breadth, realism, environment cleanliness; verifiers
  run 3× during authoring (flake gate); regression tests gate unrelated
  breakage. Audit: SWE-bench Pro verifiers 8.5% FP / 24% FN vs DeepSWE
  0.3% / 1.1%.
- v1.1 (2026-06-14; leaderboard refreshed 2026-08-13): agent commits →
  patch extracted → graded in pristine container; CTRF per-test reports
  (test-dropping shows as missing); natural git env (`main` at base commit).
- Beyond pass-rate axes: cost/task, output tokens, steps.
- v1.1 numbers (mini-swe-agent, Aug 13 refresh): claude-opus-5 74% @$11.84 ·
  gpt-5.6-sol 73% @$8.39 · gpt-5.6-luna 67% @$0.61 · **deepseek-v4-pro 63%
  @$0.24** · opus-4.8 59% @$13.22 · **deepseek-v4-flash 53% @$0.10** ·
  glm-5.2 44% @$3.92 · sonnet-5 54% @$26.40.
- Their "Future work": decompose model vs scaffolding (same models under
  multiple harnesses) — our project operationalizes this for Droid.

## 4. Cache economics (as of 2026-08-18)

### DeepSeek (api-docs.deepseek.com)

- **Peak/off-peak billing effective 2026-08-16 16:00 UTC.** Peak windows
  01:00–04:00 and 06:00–10:00 UTC; off-peak = half of peak.

| Model | Input hit | Input miss | Output | (old flat, pre-08-16) |
|---|---|---|---|---|
| V4 Flash off-peak | $0.007/M | $0.22/M | $0.66/M | $0.0028 / $0.14 / $0.28 |
| V4 Flash peak | $0.014/M | $0.44/M | $1.32/M | |
| V4 Pro off-peak | $0.022/M | $0.66/M | $1.98/M | $0.003625 / $0.435 / $0.87 |
| V4 Pro peak | $0.044/M | $1.32/M | $3.96/M | |

- V4 Pro GA (V4-Pro-0813) 2026-08-13: "significantly enhanced agent
  capabilities"; vendor-reported TB2.1 87.9, DeepSWE 62.7, NL2Repo 61.5.
  Thinking effort knob: low/high/max on both V4 models (2026-08-13).
  V4-Flash-0731 (2026-07-31): DeepSWE 54.4, TB2.1 82.7; same architecture,
  re-post-trained. Old `deepseek-chat`/`deepseek-reasoner` aliases retired
  2026-07-24.
- Context 1M, max output 384K. Both OpenAI- and Anthropic-compatible
  endpoints.

### Anthropic prompt caching (platform.claude.com/docs)

- Reads 0.1× base input; writes 1.25× (5-min TTL) or 2× (1-hour TTL).
  **Default TTL changed 1h → 5m in early 2026** (silent-miss risk for sparse
  workloads). Min cacheable prefix: 1,024 tokens (Haiku) / 2,048
  (Sonnet/Opus). Usage fields: `cache_read_input_tokens`,
  `cache_creation_input_tokens`.

### Z.AI GLM (docs.z.ai)

- GLM Coding Plan is **points-based** (separate input/cached/output points);
  peak 14:00–18:00 UTC+8 Mon–Fri; off-peak 50% points. GLM-5.3 rolled out to
  Coding Plan 2026-08-14, claims "98%+ cache hit rate" on repeated context.
- Both Anthropic-compatible (`/api/anthropic`) and coding
  (`/api/coding/paas/v4`) endpoints; community reports differing behavior
  between them (more tool-call failures on coding endpoint per r/ZaiGLM).

### Cross-cutting

- Cache-hit share dominates agent cost: repeated prefix re-sent every turn;
  measured example (Zachary Proser, "The Price Floor", Aug 2026): 96.6% of
  input served from cache; input:output 218:1.
- DeepSeek cache mechanics (independent empirical work, see §5): automatic;
  activation threshold ~1,024 tokens; 256-token block alignment; any earlier
  prefix mutation invalidates everything after it.

## 5. August 2026 runtime advances (design vocabulary; vendor-neutral in product)

### Official composable runtime (deepseek-ai/deepseek-harness, MIT, dev preview)

Released 2026-08-13 alongside V4-Pro GA. Node/Cordis, "everything is a
plugin." Lessons adopted (PLAN §5):

- Append-only `SessionEvent` log is the single source of truth;
  "model-visible means logged" is a runtime invariant; model history is a
  projection (`deriveMessages()`).
- Prompt split into ordered static `PromptSection`s vs cache-safe dynamic
  `PromptContext` (logged after retained history). Tool schemas are part of
  the request envelope (`EpochHeader`) and therefore the cached prefix.
- Disjoint token accounting: `TokenUsage = input + cacheRead + cacheWrite`,
  reasoning inside output; providers that fold cache into one total must
  "subtract it back out."
- Compaction is a pluggable seam with auditable events
  (`compaction/start|summary|end`, surface `replace` op) and a
  `toolResultPruner` that prunes before summarization; triggers: `pressure`
  vs `context-overflow`.
- Subagent seam is a provider registry that already wraps external products
  (`-codex`, `-claude-code` providers) — precedent for a future Droid
  adapter without forking.
- Profiles: minimal (bash + editor, frozen prompt, no compaction — benchmark
  baseline), standard (full toolset), code mode (`run_code` batching →
  fewer round trips). Modes confirmed on deepseek.com/harness/en.
- Fail-loud doctrine: `UNSUPPORTED_CAPABILITY` rejected up front;
  `EMPTY_RESPONSE`/`CONTEXT_WINDOW_EXCEEDED` canonical codes.
- Developer preview: compatibility-breaking changes expected → our v0
  depends on none of it (CLI-level only).

### Independent protocol-conformance work (HenryZ838978/deepseek-harness, MIT, 46⭐)

Python protocol adapter for V4 (PyPI 2026-05-11, predates the official Node
runtime). 16 documented findings, 10 normative contract rules (C1–C10),
270+ trial JSONL fixtures. Load-bearing findings for our diagnostics:

- C2: `reasoning_content` must round-trip in multi-turn tool loops — omitting
  it returns HTTP 400 ("must be passed back").
- C1: thinking is default-on; 30–300 reasoning tokens burned on trivial
  prompts (latency + cost tax).
- C4/C6: parallel tool-call deltas interleave across `tc.index` — aggregate
  by index; tolerate empty-`choices` chunks.
- C7: hard 1M context ceiling (2²⁰), verbatim 400 includes byte count.
- C8: no volatile content in the cached prefix; mid-prefix mutation preserves
  only the first aligned 512 tokens (256-token blocks).
- Cache fields appear under both DeepSeek-native and OpenAI-shape names.
- `/beta` endpoint silently remaps `v4-pro` → `deepseek-reasoner`.
- Their README's "50× cache discount" is **already stale** post-08-16 —
  proof that pricing/protocol assumptions need versioned snapshots and
  probes (exactly our `diagnose` + `pricing.js`).

## 6. Local environment (verified 2026-08-18)

- `droid` v0.197.0 at `~/.local/bin/droid`; `~/.factory/` contains sessions/,
  droids/ (opus-planner, luna-research-worker [gpt-5.6-luna], luna-review-
  worker, sol-strategist, sequential-delivery-worker, scrutiny-feature-
  reviewer, user-testing-flow-validator), plugins/, settings.json.
- `settings.json` `customModels`: GLM-5.1 + GLM-4.7 via Z.AI (anthropic +
  OpenAI-compatible endpoints). **Plaintext API key present — rotate before
  M5.**
- memex corpus: `matchKind()` (exact/normalization/case/compatibility) and
  pure `analyze(files)` seam in `~/Code/projects/memex/lib/` — reuse pattern
  for filesystem-torture tasks; APFS NFC/NFD collisions verified live.
- `mini-swe-subs`: guarded mini-swe-agent CLI (94 tests) + Aug-14 3-model
  arena (Grok 4.6 / GLM 5.3 / DeepSeek V4 Pro, Opus-5 judge) — prior art for
  arena methodology; candidate minimal-reference runner later.
- `dsh-shell-bakeoff`: desktop-shell comparison for the DSH web UI — separate
  project, no merge.
- `santiagosainz-skills`: dormant skills repo (Codex/OpenCode/Pi) — candidate
  Guild submission #2 (add Droid plugin target) after this project ships.

## 7. Key source URLs

- Guild: factory.ai/ambassador
- Droid docs: docs.factory.ai/{droid-cli/cli-reference, model-independence/byok,
  harness/hooks, harness/plugins, harness/skills, harness/subagents,
  changelog/release-notes}
- TB3: frontierbench.ai · github.com/harbor-framework/frontier-bench ·
  harborframework.com/docs/tasks · arXiv:2601.11868
- DeepSWE: deepswe.datacurve.ai/{blog/deepswe, blog/deepswe-v1-1} ·
  github.com/datacurve-ai/deep-swe
- DeepSeek API: api-docs.deepseek.com/{quick_start/pricing, updates/} (peak
  change news260813)
- Anthropic caching: platform.claude.com/docs/en/build-with-claude/prompt-caching
- Z.AI: docs.z.ai/guides/capabilities/cache · z.ai/blog/glm-5.3
- Composable runtime: github.com/deepseek-ai/deepseek-harness ·
  docs/architecture.md · subsystems {session, system-prompt, llm-streaming,
  compaction, subagent} · deepseek.com/harness/en
- Protocol adapter: github.com/HenryZ838978/deepseek-harness
- T3 Code: github.com/pingdotgg/t3code
- Series C: techcrunch.com/2026/04/16/factory-hits-1-5b-valuation… ·
  factory.ai/news/series-c
