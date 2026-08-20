# Free-route routability probe — 2026-08-19

Before a sweep is worth running, the routes it names have to actually route.
This is a point-in-time probe of every free route configured in settings,
measured by running the same trial (`t001-greet-script`) through
`droidtune trial` on each one, serially, at **$0**.

**Headline: of 10 routes probed, 4 were usable.** The other 6 failed for four
distinct reasons that the harness reported, before correction, as
indistinguishable `PROVIDER_ERROR`s.

## Result

| Route | Outcome | Duration | Reason |
| --- | --- | --- | --- |
| `hy3-free` | VERIFIED_PASS | 19.5s | — |
| `nemotron-3.5-lightning-free` | VERIFIED_PASS | 22.2s | — |
| `laguna-s-2.1-free` | VERIFIED_PASS | 27.4s | — |
| `nemotron-3-ultra-free` | VERIFIED_PASS | 58.8s | — |
| `deepseek-v4-flash-free` | PROVIDER_ERROR | ~100s | `BYOK Error: 429 Rate limit exceeded` |
| `glm-5-free` | PROVIDER_ERROR | 2.3s | `BYOK Error: 401 Model glm-5-free is not supported` |
| `kimi-k2.5-free` | PROVIDER_ERROR | 2.2s | `BYOK Error: 401 Model kimi-k2.5-free is not supported` |
| `mimo-v2.5-free` | TIMEOUT | 90.6s | wall-clock timeout, no provider error emitted |
| `muse-spark-1.2` | DROID_ERROR | 1.5s | model id not present in local settings |
| `gpt-5.6-luna` | PROVIDER_ERROR | 2.7s | `Exec failed`, no BYOK error line emitted |

The four working routes are exactly the four used in the M4 flake check
(`runs/m4-flake3`) — that sweep's route selection was, in hindsight, already
the routable subset.

## Why this matters

`droid exec` reports at least four different conditions through the same
`PROVIDER_ERROR: "Exec failed"` envelope, with the distinguishing detail
appearing only inside the session transcript as a
`BYOK Error: <code> <text>` line — never in `results.json` or
`manifest.json`. Consequences:

- **A misconfigured route is indistinguishable from a bad model.** `glm-5-free`
  and `kimi-k2.5-free` are listed in settings but are not routable upstream.
  Left unclassified, a sweep across them would report a wall of failures that
  looks like model incompetence and is actually a config fault.
- **Rate limiting is not a quality signal.** The free pool's quota is tight
  enough that a sweep can exhaust it after a single successful trial. On
  2026-08-19 a full 6-task sweep on `deepseek-v4-flash-free`
  (`runs/m5-byok-sweep`) returned 0 usable trials: 5 confirmed
  `429 Rate limit exceeded` plus 1 with no error line, every one at 0 turns and
  0 tokens. Counting those as model failures would have been straightforwardly
  wrong.
- **The 401 status code is ambiguous.** Both "this model id is not supported"
  and a genuine credential failure surface as 401. Classifying on the HTTP
  status alone mislabels one as the other; the message text is what
  disambiguates.

`scripts/results-table.js` recovers the cause from the explicit error line and
excludes trials that never reached the model from the pass-rate denominator,
so provider trouble cannot be laundered into a model-quality claim.

## Limitations

- **n = 1 per route.** One trial, one task (`t001-greet-script`, the simplest in
  the suite). This measures reachability, not capability. A route that passes
  here is not thereby shown to be good; it is shown to be *usable*.
- **Point-in-time.** Free-route quotas and model availability move. The 429 on
  `deepseek-v4-flash-free` is a statement about that account at that hour, not a
  property of the model.
- **Concurrency confound.** Some of these probes ran while other droid
  processes were active against the same free pool, which plausibly worsened
  the rate limiting. The four passes are unaffected by this; the 429 is not
  cleanly attributable to quota alone.
- Two failures (`mimo-v2.5-free`, `gpt-5.6-luna`) emitted no BYOK error line, so
  their root cause is recorded as unknown rather than guessed.

## Reproducing

```sh
source ~/.factory/env.sh   # defines the BYOK keys the configured routes reference
node bin/droidtune.js trial --task tasks/t001-greet-script --model <route> \
  --tune "p-<route>" --runs-dir /tmp/dt-probe-runs --timeout-ms 90000
```

Run serially with a pause between routes; running these in parallel is what
exhausts the quota.
