# Free-route weather

**As of 2026-08-20, 4 of 8 free routes answered.**

| route | 08-20 | up |
| --- | --- | --- |
| `hy3-free` | ✓ | 1/1 |
| `nemotron-3.5-lightning-free` | ✓ | 1/1 |
| `laguna-s-2.1-free` | ✓ | 1/1 |
| `nemotron-3-ultra-free` | ✓ | 1/1 |
| `deepseek-v4-flash-free` | 429 | 0/1 |
| `glm-5-free` | n/a | 0/1 |
| `kimi-k2.5-free` | n/a | 0/1 |
| `mimo-v2.5-free` | 429 | 0/1 |

- `✓` — answered with a well-formed completion
- `429` — throttled
- `n/a` — the gateway does not route that model id
- `auth` — credential rejected
- `t/o` — no response inside the probe timeout
- `err` — network failure or an unrecognized rejection
- `·` — no probe recorded that day

## How this is measured

One request per route per scheduled run, sequentially, against
`https://opencode.ai/zen/v1/chat/completions`:

```json
{ "model": "<route>", "messages": [{ "role": "user", "content": "ping" }],
  "max_tokens": 8, "temperature": 0, "stream": false }
```

A route counts as `OK` only when the gateway returns HTTP 200 with a
well-formed `choices` array — a 200 carrying an error envelope is recorded
as a failure, not as uptime. Classification runs on the response *message*,
not the status code, because this gateway reports an unrecognized model id
and a rejected credential with the same 401.

The raw observations are in [`route-status.jsonl`](route-status.jsonl),
append-only, one line per probe. This file is generated from it by
`node scripts/route-weather.js --render` and is a pure function of that
data — the "as of" date is the newest date in the series, never the clock —
so a stale copy fails CI rather than rotting silently.

Nothing here is a claim about model quality. It is a claim about whether a
route answered a one-token request on a given day, which is the only thing
the probe measures.
