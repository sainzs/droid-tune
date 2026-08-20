# Droid session: env-preflight + PROVIDER_ERROR sub-classification

- **Session id**: `df89df20-02fe-4cd4-b1f2-8c841ff7a747`
- **Model**: `hy3-free` (free BYOK route via OpenCode Zen)
- **Autonomy**: `--auto medium`
- **Invocation**: `droid exec -m hy3-free --auto medium -o json -f /tmp/droid-task-env.md`, run from the repo root with `~/.factory/env.sh` sourced.
- **Duration / usage**: input_tokens 115642, output_tokens 49016, cache_read_input_tokens 583232, factory_credits 0 (free route).
- **Result envelope**: `is_error: false`, `num_turns > 0` (multi-turn), `subtype: success`.

## Prior attempts on this task (for the record)

Before landing on `hy3-free`, three other free routes were tried and failed for
reasons unrelated to Droid's authorship quality — all visible in the local
`~/.factory/sessions/.../*.jsonl` transcripts (not committed, contain no
secrets, only BYOK error text):
- `deepseek-v4-flash-free` — `BYOK Error: 429 Rate limit exceeded` (route
  saturated by concurrent sweeps also running against the free pool), ~100s
  before failing, 0 turns.
- `glm-5-free` — `BYOK Error: 401 Model glm-5-free is not supported`, ~2s,
  0 turns. This is a currently-unsupported upstream route, not a droidtune bug.
- `kimi-k2.5-free` — same shape as glm-5-free, ~2s, 0 turns.

These three failures are themselves a real-world instance of the
`providerErrorKind` distinction this change adds: two different 401-shaped
rejections (`unsupported_model` vs the auth case) and one `rate_limit`
rejection, all of which the pre-change harness would have flattened into an
undifferentiated `PROVIDER_ERROR: "Exec failed"`.

## Prompt given to Droid

Full text: `/tmp/droid-task-env.md` (not committed; reconstructed summary
below). Two asks:

1. **Env preflight** — before spawning `droid exec`, detect whether the active
   droid config's `customModels[].apiKey` references (`${VAR}` indirection)
   are present in the environment that will be passed to the child. If not,
   attempt to auto-load `~/.factory/env.sh` (names only, never log/print
   values) to supply the missing var(s). If still missing after that, fail
   fast with an actionable error naming the missing variable(s) and the file
   to source, thrown *before* any droid spawn/session, and never classified as
   `PROVIDER_ERROR`.
2. **`providerErrorKind` sub-classification** — added mid-session after
   independently confirming (by reading this repo's own
   `runs/m5-byok-smoke/.../errors.json` and `runs/m5-byok-sweep/.../errors.json`)
   that today all 0-turn `PROVIDER_ERROR`s collapse into the same generic
   `"Exec failed"` string, with the real cause visible only in
   `transcript.jsonl`. Requested a `results.providerErrorKind` field
   (`rate_limit` | `unsupported_model` | `auth` | `unknown`) derived from the
   trusted result envelope's `result` text, checked in that priority order
   (unsupported_model before auth, since both can read as 401s).

Constraints given: keep `npm test` green, do not weaken/remove the existing S2
0-turn anti-laundering gate or its tests, preserve `buildDroidEnv`'s
allowlist hygiene (no leaking arbitrary env names), never persist secret
values anywhere, add test coverage using the existing `fixtures/bin/fake-droid-trial`
pattern, keep the change scoped.

## What Droid authored (verbatim diff, reviewed by the maintainer)

- `lib/runner.js`:
  - `referencedCredentialVars(configPath)` — extracts `${VAR}` names from
    `customModels[].apiKey` in the active config (generic, not a hardcoded
    secret-name list).
  - `autoloadCredentials(env, requiredVars, envShPath)` — parses
    `~/.factory/env.sh` line-by-line for `export NAME=value` / `NAME=value`,
    splices only the *missing, referenced* names into a copy of `env`; never
    reads/returns/logs unrelated names or values elsewhere.
  - Preflight block in `runTrial()` (before the credential-shaped
    `modelRequested`/`taskId` setup): computes required vars, attempts
    autoload, and throws a descriptive `Error` if any are still missing —
    skipped when `native: true`.
  - `buildDroidEnv(activeEnv)` — spawn now uses the (possibly autoload-enriched)
    env, preserving the existing prefix/exact allowlist filtering unchanged.
  - `providerErrorKind` classification added inside the existing 0-turn
    `PROVIDER_ERROR` branch, matched against `parsed.result` text in priority
    order `unsupported_model` → `rate_limit` → `auth` → `unknown`.
- `fixtures/bin/fake-droid-trial`: two new modes, `provfail429` and
  `provfailmodel`, emitting realistic BYOK rejection text for the new tests.
- `test/runner.test.js`: `makeEnv` now injects a dummy `X_KEY` (matching the
  fixture config's `${X_KEY}` credential reference) so existing tests still
  pass under the new preflight; four new tests — rate_limit and
  unsupported_model sub-classification, fail-fast on a missing credential with
  no env.sh available (asserts the thrown message names `X_KEY` and
  `env.sh`, and that zero droid sessions were created), and native-route
  preflight skip.

## Maintainer corrections after review

- Removed one small dead-code artifact in `autoloadCredentials`: an unused
  `stillMissing` array was computed inside the function but never used or
  returned (the caller already re-derives `stillMissing` itself after calling
  the function). Deleted those three lines; no behavior change.
- No other corrections were needed. The anti-laundering gate (S2 tests) was
  left untouched by Droid, as instructed; substance was sound.

## Empirical verification (post-fix)

1. `npm test` → 84/84 passing (up from 78 pre-change), including the
   pre-existing "S2: 0-turn provider rejection → PROVIDER_ERROR" and
   "S2: multi-turn failure mentioning quota → DROID_ERROR" gates, unmodified
   and green.
2. Fail-fast branch (unit test, controlled): env missing the config's
   referenced `${X_KEY}` and no real `env.sh` reachable → `runTrial` throws
   before any droid spawn, message names `X_KEY` and `env.sh`, zero sessions
   created.
3. Auto-load branch (live CLI, real credentials file): ran
   `env -u OPENCODE_ZEN_KEY -u ZAI_API_KEY node bin/droidtune.js trial --task
   tasks/t001-greet-script --model deepseek-v4-flash-free --tune
   scratch-envcheck --runs-dir /tmp/dt-envcheck-runs --timeout-ms 60000` (a
   shell with the credential vars explicitly unset). Previously this shape of
   invocation is exactly what produced the diagnosed 3s `PROVIDER_ERROR` in
   `runs/m5-byok-smoke`. After this change, the preflight auto-loaded the
   missing var from `~/.factory/env.sh` and let a real `droid exec` attempt
   proceed — it ran for the full 60s and ended in `TIMEOUT` (plausible given
   concurrent sweeps saturating the same free route at the time), not the
   previous instant, misclassified `PROVIDER_ERROR`. This demonstrates the
   auto-load path is live and functioning; it does not by itself demonstrate
   `VERIFIED_PASS`, which depends on route availability at time of the call.
