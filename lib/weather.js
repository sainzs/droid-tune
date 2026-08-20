// Free-route weather: what a "known-free" BYOK route actually did today.
//
// README and AGENTS.md both name four OpenCode Zen free routes as working "as
// of 2026-08-19". That kind of sentence rots silently — a 2026-08-19 probe of
// all ten configured free routes found only four usable, and there is no
// reason to think that number is stable. This module turns the claim into a
// dated observation series: one minimal chat-completion probe per route per
// day, appended to a JSONL, rendered as a table nobody has to trust.
//
// Everything here is pure: classification, aggregation, and rendering take
// data in and return data out. The network lives in scripts/route-weather.js,
// so the interesting logic is testable offline against recorded responses.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

// The free ids configured in this repo's own ~/.factory/settings.json. The
// first four are the ones M4 found usable; the rest are advertised and are
// exactly what this report exists to keep honest.
const FREE_ROUTES = [
  'hy3-free',
  'nemotron-3.5-lightning-free',
  'laguna-s-2.1-free',
  'nemotron-3-ultra-free',
  'deepseek-v4-flash-free',
  'glm-5-free',
  'kimi-k2.5-free',
  'mimo-v2.5-free'
]

const ZEN_BASE_URL = 'https://opencode.ai/zen/v1'

// ERROR is the catch-all. It is deliberately distinct from TIMEOUT and from
// the three "the provider answered and said no" classes, because "we could not
// reach it" and "it told us to go away" are different facts about a route.
const STATUSES = ['OK', 'RATE_LIMITED', 'UNSUPPORTED', 'AUTH', 'TIMEOUT', 'ERROR']

// How each status renders in the table, and what it means in the legend.
const CELL = {
  OK: '✓',
  RATE_LIMITED: '429',
  UNSUPPORTED: 'n/a',
  AUTH: 'auth',
  TIMEOUT: 't/o',
  ERROR: 'err'
}
const NO_DATA = '·'

const LEGEND = [
  ['✓', 'OK — answered with a well-formed completion'],
  ['429', 'RATE_LIMITED — throttled'],
  ['n/a', 'UNSUPPORTED — the gateway does not route that model id'],
  ['auth', 'AUTH — credential rejected'],
  ['t/o', 'TIMEOUT — no response inside the probe timeout'],
  ['err', 'ERROR — network failure or an unrecognized rejection'],
  ['·', 'no probe recorded that day']
]

// Never let a credential reach disk or a log, even by accident. The probe
// never logs headers, but a provider that echoes the Authorization header back
// in an error body would otherwise put the key straight into a committed file.
// The last pattern is deliberately blunt: any 32+ character token-shaped run
// is replaced, which also eats innocent request ids. Losing a request id from
// a diagnostic string costs nothing; committing a key costs everything.
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /(?:Bearer|bearer)\s+[A-Za-z0-9._-]{8,}/g,
  /[A-Za-z0-9_-]{32,}/g
]

function redactSecrets (text, extra = []) {
  let out = String(text ?? '')
  for (const value of extra) {
    if (typeof value === 'string' && value.length >= 8) {
      out = out.split(value).join('[redacted]')
    }
  }
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[redacted]')
  return out
}

// Classify one probe result. `status` is the HTTP status (null when the
// request never completed), `body` the raw response text, `error` the thrown
// error if any.
//
// Ordering matters and mirrors lib/runner.js's provider-error subclassifier:
// an unsupported model id and a bad credential are BOTH commonly reported as
// 401 by this gateway, so the model-id case is tested first. Classifying on
// the message rather than the status is the only way to tell them apart, and
// telling them apart is the whole value of the report — "your key is dead" and
// "that route no longer exists" call for opposite responses.
function classifyProbe ({ httpStatus = null, body = '', error = null, secrets = [] } = {}) {
  const detailOf = (s) => {
    const clean = redactSecrets(String(s ?? '').replace(/\s+/g, ' ').trim(), secrets)
    return clean === '' ? null : clean.slice(0, 200)
  }

  if (error) {
    const name = error.name ?? ''
    const msg = String(error.message ?? error)
    if (name === 'AbortError' || name === 'TimeoutError' || /timed?\s*out|ETIMEDOUT/i.test(msg)) {
      return { status: 'TIMEOUT', detail: detailOf(msg) }
    }
    return { status: 'ERROR', detail: detailOf(msg) }
  }

  const text = String(body ?? '')
  let parsed = null
  try { parsed = JSON.parse(text) } catch {}
  // Some gateways answer 200 with an error envelope; trust the envelope over
  // the status line.
  const envelopeError = parsed && typeof parsed === 'object' && parsed.error
    ? (typeof parsed.error === 'string' ? parsed.error : (parsed.error.message ?? JSON.stringify(parsed.error)))
    : null
  const message = envelopeError ?? text

  if (httpStatus === 200 && !envelopeError) {
    const ok = parsed && Array.isArray(parsed.choices) && parsed.choices.length > 0
    if (ok) return { status: 'OK', detail: null }
    // A 200 whose body is not a completion is not a working route; say so
    // rather than crediting it.
    return { status: 'ERROR', detail: detailOf(`200 without choices: ${text.slice(0, 120)}`) }
  }

  if (/\b(?:not supported|unsupported|unknown model|model_not_found|no such model|invalid model)\b/i.test(message)) {
    return { status: 'UNSUPPORTED', detail: detailOf(message) }
  }
  if (httpStatus === 429 || /\brate.?limit|too many requests|quota exceeded\b/i.test(message)) {
    return { status: 'RATE_LIMITED', detail: detailOf(message) }
  }
  if (httpStatus === 401 || httpStatus === 403 || /\b(?:unauthorized|forbidden|invalid api key|invalid_api_key|authentication)\b/i.test(message)) {
    return { status: 'AUTH', detail: detailOf(message) }
  }
  return { status: 'ERROR', detail: detailOf(`HTTP ${httpStatus ?? '?'}: ${message.slice(0, 160)}`) }
}

// --- probing --------------------------------------------------------------
// The request body is frozen here and documented verbatim in the rendered
// report, so "what was measured" is one thing, not two.
function probeBody (route) {
  return {
    model: route,
    messages: [{ role: 'user', content: 'ping' }],
    max_tokens: 8,
    temperature: 0,
    stream: false
  }
}

// One request per route. No retry, no fallback, no second attempt on failure:
// the series records what happened on the first ask, and a retry loop would
// quietly turn a flaky route into a healthy-looking one.
//
// `fetchImpl` is injectable so the transport is exercised offline against
// recorded responses; production passes globalThis.fetch.
async function probeRoute (route, {
  key, fetchImpl = globalThis.fetch, timeoutMs = 20000, baseUrl = ZEN_BASE_URL, now = () => Date.now()
} = {}) {
  const started = now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      // Never logged, never echoed, never written. The probe reports
      // route/status/latency and nothing else.
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(probeBody(route)),
      signal: controller.signal
    })
    const body = await res.text()
    const verdict = classifyProbe({ httpStatus: res.status, body, secrets: [key] })
    return { ...verdict, route, httpStatus: res.status, latencyMs: now() - started }
  } catch (error) {
    const verdict = classifyProbe({ error, secrets: [key] })
    return { ...verdict, route, httpStatus: null, latencyMs: now() - started }
  } finally {
    clearTimeout(timer)
  }
}

// Sequential on purpose: a parallel burst would rate-limit the probe set
// against itself and then record that as a property of the routes.
async function probeRoutes (routes, opts = {}) {
  const results = []
  for (const route of routes) {
    const r = await probeRoute(route, opts)
    results.push(r)
    if (typeof opts.onResult === 'function') opts.onResult(r)
  }
  return results
}

// --- observation storage --------------------------------------------------
const dateOf = (iso) => String(iso).slice(0, 10)

function makeObservation ({ route, status, httpStatus = null, latencyMs = null, detail = null, at = new Date().toISOString(), probe = 'chat.completions' }) {
  if (!STATUSES.includes(status)) throw new Error(`unknown route status: ${status}`)
  return {
    date: dateOf(at),
    ts: at,
    route,
    status,
    httpStatus,
    latencyMs,
    detail: detail ?? null,
    probe
  }
}

function readObservations (jsonlPath) {
  if (!existsSync(jsonlPath)) return { observations: [], parseErrors: 0 }
  const observations = []
  let parseErrors = 0
  for (const line of readFileSync(jsonlPath, 'utf8').split('\n')) {
    const s = line.trim()
    if (!s) continue
    let rec
    try { rec = JSON.parse(s) } catch { parseErrors++; continue }
    if (!rec || typeof rec.route !== 'string' || !STATUSES.includes(rec.status)) { parseErrors++; continue }
    if (typeof rec.date !== 'string') rec.date = dateOf(rec.ts ?? '')
    observations.push(rec)
  }
  return { observations, parseErrors }
}

// Append-only, one line per observation — the same discipline lib/ledger.js
// uses. History is never rewritten, so a route that broke and recovered leaves
// both facts on disk.
function appendObservations (jsonlPath, observations) {
  if (observations.length === 0) return 0
  mkdirSync(path.dirname(jsonlPath), { recursive: true })
  appendFileSync(jsonlPath, observations.map(o => JSON.stringify(o)).join('\n') + '\n')
  return observations.length
}

// --- aggregation ----------------------------------------------------------
// `days` is a count of DISTINCT OBSERVED DATES, not a window ending today. A
// report generated from committed data must not change because the clock
// moved; that is what makes the rendered README a deterministic function of
// the JSONL, and therefore drift-checkable in CI.
function summarize (observations, { days = 14, routes = FREE_ROUTES } = {}) {
  const allDates = [...new Set(observations.map(o => o.date))].sort()
  const dates = allDates.slice(-days)
  const dateSet = new Set(dates)
  const asOf = dates.length > 0 ? dates[dates.length - 1] : null

  const grid = {}
  for (const route of routes) grid[route] = {}
  for (const o of observations) {
    if (!dateSet.has(o.date)) continue
    if (!grid[o.route]) grid[o.route] = {}
    // Last observation of a given day wins: one probe per route per run, but a
    // manual re-run on the same day should supersede, not duplicate.
    const prev = grid[o.route][o.date]
    if (!prev || String(o.ts ?? '') >= String(prev.ts ?? '')) grid[o.route][o.date] = o
  }

  const known = [...new Set([...routes, ...observations.filter(o => dateSet.has(o.date)).map(o => o.route)])]
  const latest = {}
  let up = 0
  for (const route of known) {
    const obs = asOf ? grid[route]?.[asOf] ?? null : null
    latest[route] = obs ? obs.status : null
    if (obs && obs.status === 'OK') up++
  }

  return {
    asOf,
    dates,
    routes: known,
    grid,
    latest,
    up,
    total: known.length,
    observationCount: observations.length,
    // Uptime over the rendered window, per route: OK probes / probes recorded.
    uptime: Object.fromEntries(known.map(route => {
      const recorded = dates.map(d => grid[route]?.[d]).filter(Boolean)
      const ok = recorded.filter(o => o.status === 'OK').length
      return [route, { ok, recorded: recorded.length, pct: recorded.length ? Math.round(100 * ok / recorded.length) : null }]
    }))
  }
}

// --- rendering ------------------------------------------------------------
const shortDate = (d) => d.slice(5)

function renderWeather (summary, { title = 'Free-route weather' } = {}) {
  const lines = [`# ${title}`, '']
  if (summary.asOf === null) {
    lines.push('No probe has been recorded yet. The first scheduled run will create one.')
    lines.push('')
    lines.push(renderProvenance())
    return lines.join('\n') + '\n'
  }

  lines.push(`**As of ${summary.asOf}, ${summary.up} of ${summary.total} free routes answered.**`)
  lines.push('')
  lines.push(`| route | ${summary.dates.map(shortDate).join(' | ')} | up |`)
  lines.push(`| --- | ${summary.dates.map(() => '---').join(' | ')} | --- |`)
  for (const route of summary.routes) {
    const cells = summary.dates.map(d => {
      const o = summary.grid[route]?.[d]
      return o ? CELL[o.status] ?? o.status : NO_DATA
    })
    const u = summary.uptime[route]
    const upCell = u && u.recorded > 0 ? `${u.ok}/${u.recorded}` : '—'
    lines.push(`| \`${route}\` | ${cells.join(' | ')} | ${upCell} |`)
  }
  lines.push('')
  for (const [sym, meaning] of LEGEND) lines.push(`- \`${sym}\` — ${meaning.replace(/^[A-Z_]+ — /, '')}`)
  lines.push('')
  lines.push(renderProvenance())
  return lines.join('\n') + '\n'
}

function renderProvenance () {
  return [
    '## How this is measured',
    '',
    'One request per route per scheduled run, sequentially, against',
    `\`${ZEN_BASE_URL}/chat/completions\`:`,
    '',
    '```json',
    '{ "model": "<route>", "messages": [{ "role": "user", "content": "ping" }],',
    '  "max_tokens": 8, "temperature": 0, "stream": false }',
    '```',
    '',
    'A route counts as `OK` only when the gateway returns HTTP 200 with a',
    'well-formed `choices` array — a 200 carrying an error envelope is recorded',
    'as a failure, not as uptime. Classification runs on the response *message*,',
    'not the status code, because this gateway reports an unrecognized model id',
    'and a rejected credential with the same 401.',
    '',
    'The raw observations are in [`route-status.jsonl`](route-status.jsonl),',
    'append-only, one line per probe. This file is generated from it by',
    '`node scripts/route-weather.js --render` and is a pure function of that',
    'data — the "as of" date is the newest date in the series, never the clock —',
    'so a stale copy fails CI rather than rotting silently.',
    '',
    'Nothing here is a claim about model quality. It is a claim about whether a',
    'route answered a one-token request on a given day, which is the only thing',
    'the probe measures.'
  ].join('\n')
}

export {
  CELL,
  FREE_ROUTES,
  LEGEND,
  NO_DATA,
  STATUSES,
  ZEN_BASE_URL,
  appendObservations,
  classifyProbe,
  makeObservation,
  probeBody,
  probeRoute,
  probeRoutes,
  readObservations,
  redactSecrets,
  renderWeather,
  summarize
}
