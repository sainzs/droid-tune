import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import {
  FREE_ROUTES, STATUSES, appendObservations, classifyProbe, makeObservation,
  readObservations, redactSecrets, renderWeather, summarize
} from '../lib/weather.js'

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'droidtune-weather-'))

// --- classification -------------------------------------------------------
// Recorded response shapes. Each is what the probe would actually see; the
// classifier never touches the network.
test('a 200 with a well-formed completion is the only thing that counts as OK', () => {
  const body = JSON.stringify({
    id: 'chatcmpl-1',
    choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'length' }]
  })
  assert.deepEqual(classifyProbe({ httpStatus: 200, body }), { status: 'OK', detail: null })
})

test('a 200 whose body is not a completion is a failure, not uptime', () => {
  for (const body of ['', 'not json at all', JSON.stringify({ ok: true }), JSON.stringify({ choices: [] })]) {
    const r = classifyProbe({ httpStatus: 200, body })
    assert.equal(r.status, 'ERROR', `wrongly credited as OK: ${body}`)
  }
})

test('a 200 carrying an error envelope is classified on the envelope, not the status line', () => {
  const body = JSON.stringify({ error: { message: 'Rate limit exceeded, please retry' } })
  assert.equal(classifyProbe({ httpStatus: 200, body }).status, 'RATE_LIMITED')
})

test('429 and rate-limit prose both classify as RATE_LIMITED', () => {
  assert.equal(classifyProbe({ httpStatus: 429, body: 'slow down' }).status, 'RATE_LIMITED')
  assert.equal(
    classifyProbe({ httpStatus: 400, body: JSON.stringify({ error: 'Too Many Requests' }) }).status,
    'RATE_LIMITED'
  )
})

// This gateway reports an unroutable model id and a dead credential with the
// same 401, so the ordering below is the only thing that keeps them apart —
// and they call for opposite responses from a reader.
test('an unsupported model id reported as 401 is UNSUPPORTED, not AUTH', () => {
  const body = JSON.stringify({ error: { message: 'model glm-5-free is not supported' } })
  assert.equal(classifyProbe({ httpStatus: 401, body }).status, 'UNSUPPORTED')
})

test('a genuine credential rejection is AUTH', () => {
  const body = JSON.stringify({ error: { message: 'Invalid API key provided' } })
  assert.equal(classifyProbe({ httpStatus: 401, body }).status, 'AUTH')
  assert.equal(classifyProbe({ httpStatus: 403, body: 'forbidden' }).status, 'AUTH')
})

test('an aborted request is TIMEOUT and a network failure is ERROR', () => {
  const abort = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })
  assert.equal(classifyProbe({ error: abort }).status, 'TIMEOUT')
  assert.equal(classifyProbe({ error: new Error('getaddrinfo ENOTFOUND opencode.ai') }).status, 'ERROR')
})

test('a 5xx is ERROR and keeps its status in the detail', () => {
  const r = classifyProbe({ httpStatus: 503, body: 'upstream unavailable' })
  assert.equal(r.status, 'ERROR')
  assert.match(r.detail, /HTTP 503/)
})

test('every classification returns a status the schema knows', () => {
  const cases = [
    { httpStatus: 200, body: '{"choices":[{}]}' }, { httpStatus: 429, body: '' },
    { httpStatus: 401, body: 'unauthorized' }, { httpStatus: 500, body: 'x' },
    { error: new Error('boom') }
  ]
  for (const c of cases) assert.ok(STATUSES.includes(classifyProbe(c).status))
})

// --- redaction ------------------------------------------------------------
test('a credential echoed back by the provider never reaches the detail field', () => {
  const key = 'sk-live-abcdefghijklmnopqrstuvwxyz0123456789'
  const body = JSON.stringify({ error: { message: `bad key: ${key} rejected` } })
  const r = classifyProbe({ httpStatus: 401, body, secrets: [key] })
  assert.ok(!r.detail.includes(key), `detail leaked the key: ${r.detail}`)
  assert.match(r.detail, /\[redacted\]/)
})

test('redaction fires on token-shaped strings even when the key is not supplied', () => {
  const out = redactSecrets('Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9')
  assert.ok(!out.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'))
})

test('redaction leaves ordinary diagnostic prose alone', () => {
  const msg = 'model hy3-free is not supported on this endpoint'
  assert.equal(redactSecrets(msg), msg)
})

// --- observations ---------------------------------------------------------
test('makeObservation derives the date from the timestamp and rejects unknown statuses', () => {
  const o = makeObservation({ route: 'hy3-free', status: 'OK', at: '2026-08-20T06:17:03.000Z', latencyMs: 812, httpStatus: 200 })
  assert.equal(o.date, '2026-08-20')
  assert.equal(o.route, 'hy3-free')
  assert.throws(() => makeObservation({ route: 'x', status: 'FINE' }), /unknown route status/)
})

test('observations append without rewriting history, and malformed lines are counted', () => {
  const dir = tmp()
  try {
    const p = path.join(dir, 'nested', 'route-status.jsonl')
    appendObservations(p, [makeObservation({ route: 'hy3-free', status: 'OK', at: '2026-08-19T06:00:00.000Z' })])
    appendObservations(p, [makeObservation({ route: 'hy3-free', status: 'RATE_LIMITED', at: '2026-08-20T06:00:00.000Z' })])
    const { observations, parseErrors } = readObservations(p)
    assert.equal(observations.length, 2)
    assert.equal(parseErrors, 0)
    assert.deepEqual(observations.map(o => o.status), ['OK', 'RATE_LIMITED'])

    writeFileSync(p, readFileSync(p, 'utf8') + 'garbage\n{"route":"x","status":"NOPE"}\n')
    assert.equal(readObservations(p).parseErrors, 2)
    assert.equal(readObservations(p).observations.length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reading a series that was never created yields an empty, non-throwing result', () => {
  const r = readObservations(path.join(tmp(), 'nothing.jsonl'))
  assert.deepEqual(r, { observations: [], parseErrors: 0 })
})

// --- summarize ------------------------------------------------------------
function series (spec) {
  // spec: { 'YYYY-MM-DD': { route: STATUS } }
  const out = []
  for (const [date, routes] of Object.entries(spec)) {
    for (const [route, status] of Object.entries(routes)) {
      out.push(makeObservation({ route, status, at: `${date}T06:00:00.000Z` }))
    }
  }
  return out
}

test('the summary window is the last N observed dates, not a window ending today', () => {
  // Data from 2026-01: a clock-relative window would render this empty forever.
  const obs = series({
    '2026-01-01': { 'hy3-free': 'OK' },
    '2026-01-02': { 'hy3-free': 'OK' },
    '2026-01-03': { 'hy3-free': 'RATE_LIMITED' }
  })
  const s = summarize(obs, { days: 2, routes: ['hy3-free'] })
  assert.deepEqual(s.dates, ['2026-01-02', '2026-01-03'])
  assert.equal(s.asOf, '2026-01-03')
  assert.equal(s.latest['hy3-free'], 'RATE_LIMITED')
})

test('the headline counts only routes that answered OK on the as-of date', () => {
  const s = summarize(series({
    '2026-08-20': { 'hy3-free': 'OK', 'glm-5-free': 'UNSUPPORTED', 'kimi-k2.5-free': 'OK', 'mimo-v2.5-free': 'RATE_LIMITED' }
  }), { routes: ['hy3-free', 'glm-5-free', 'kimi-k2.5-free', 'mimo-v2.5-free'] })
  assert.equal(s.up, 2)
  assert.equal(s.total, 4)
})

test('a route configured but never probed shows as no-data, not as down', () => {
  const s = summarize(series({ '2026-08-20': { 'hy3-free': 'OK' } }), { routes: ['hy3-free', 'never-probed'] })
  assert.equal(s.latest['never-probed'], null)
  assert.equal(s.uptime['never-probed'].recorded, 0)
  assert.equal(s.uptime['never-probed'].pct, null)
  assert.equal(s.up, 1)
  assert.equal(s.total, 2)
})

test('a route probed but absent from the configured list still appears', () => {
  const s = summarize(series({ '2026-08-20': { 'surprise-free': 'OK' } }), { routes: ['hy3-free'] })
  assert.ok(s.routes.includes('surprise-free'))
})

test('a same-day re-probe supersedes the earlier one instead of double counting', () => {
  const obs = [
    makeObservation({ route: 'hy3-free', status: 'RATE_LIMITED', at: '2026-08-20T06:00:00.000Z' }),
    makeObservation({ route: 'hy3-free', status: 'OK', at: '2026-08-20T18:00:00.000Z' })
  ]
  const s = summarize(obs, { routes: ['hy3-free'] })
  assert.equal(s.latest['hy3-free'], 'OK')
  assert.equal(s.uptime['hy3-free'].recorded, 1)
})

test('per-route uptime counts OK probes over probes actually recorded', () => {
  const s = summarize(series({
    '2026-08-18': { 'hy3-free': 'OK' },
    '2026-08-19': { 'hy3-free': 'TIMEOUT' },
    '2026-08-20': { 'hy3-free': 'OK' }
  }), { routes: ['hy3-free'] })
  assert.deepEqual(s.uptime['hy3-free'], { ok: 2, recorded: 3, pct: 67 })
})

// --- rendering ------------------------------------------------------------
test('the rendered report leads with the headline and one column per observed date', () => {
  const md = renderWeather(summarize(series({
    '2026-08-19': { 'hy3-free': 'OK', 'glm-5-free': 'UNSUPPORTED' },
    '2026-08-20': { 'hy3-free': 'OK', 'glm-5-free': 'UNSUPPORTED' }
  }), { routes: ['hy3-free', 'glm-5-free'] }))
  assert.match(md, /\*\*As of 2026-08-20, 1 of 2 free routes answered\.\*\*/)
  assert.match(md, /\| route \| 08-19 \| 08-20 \| up \|/)
  assert.match(md, /\| `hy3-free` \| ✓ \| ✓ \| 2\/2 \|/)
  assert.match(md, /\| `glm-5-free` \| n\/a \| n\/a \| 0\/2 \|/)
})

test('the rendered report documents the exact probe so a stranger can repeat it', () => {
  const md = renderWeather(summarize(series({ '2026-08-20': { 'hy3-free': 'OK' } }), { routes: ['hy3-free'] }))
  assert.match(md, /chat\/completions/)
  assert.match(md, /"max_tokens": 8/)
  assert.match(md, /Nothing here is a claim about model quality/)
})

test('an empty series renders a report that says so instead of a fake table', () => {
  const md = renderWeather(summarize([], { routes: FREE_ROUTES }))
  assert.match(md, /No probe has been recorded yet/)
  assert.doesNotMatch(md, /As of/)
})

test('rendering is a pure function of the data — same input, same bytes', () => {
  const obs = series({ '2026-08-20': { 'hy3-free': 'OK', 'kimi-k2.5-free': 'TIMEOUT' } })
  const once = renderWeather(summarize(obs, { routes: FREE_ROUTES }))
  const twice = renderWeather(summarize(obs, { routes: FREE_ROUTES }))
  assert.equal(once, twice)
})
