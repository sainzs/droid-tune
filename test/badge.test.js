import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  badgeFromRuns, badgeFromWeather, colorForRatio, readOutcomes, renderBadge, shieldsEndpointUrl
} from '../lib/badge.js'
import { makeObservation, summarize } from '../lib/weather.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const demoPack = path.join(root, 'demo-pack')
const fixturePacks = path.join(root, 'test', 'fixtures', 'audit', 'packs')

function packTree (spec) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'droidtune-badge-'))
  for (const [task, outcomes] of Object.entries(spec)) {
    outcomes.forEach((outcome, i) => {
      const attDir = path.join(dir, task, `attempt-${i + 1}`)
      mkdirSync(attDir, { recursive: true })
      writeFileSync(path.join(attDir, 'results.json'), JSON.stringify({ outcome }))
    })
  }
  return dir
}

// A routed tree nests one level deeper than a pre-route one. A badge that
// counted only one shape would under-report the very sweep it summarizes.
function routedPackTree (spec) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'droidtune-badge-routed-'))
  for (const [rel, outcome] of Object.entries(spec)) {
    const attDir = path.join(dir, rel)
    mkdirSync(attDir, { recursive: true })
    writeFileSync(path.join(attDir, 'results.json'), JSON.stringify({ outcome }))
  }
  return dir
}

test('badgeFromRuns counts routed and pre-route packs in one tree', () => {
  const dir = routedPackTree({
    'hy3-free/t004/attempt-1': 'VERIFIED_PASS',
    'hy3-free/t004/attempt-2': 'NO_SUBMISSION',
    'nemotron-3-ultra-free/t004/attempt-1': 'VERIFIED_PASS',
    't900-demo/attempt-1': 'VERIFIED_PASS'
  })
  try {
    const badge = badgeFromRuns(dir)
    assert.match(badge.message, /3\/4/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- color ---------------------------------------------------------------
test('badge color tracks the ratio, and absent data is grey rather than green', () => {
  assert.equal(colorForRatio(1), 'brightgreen')
  assert.equal(colorForRatio(0.8), 'green')
  assert.equal(colorForRatio(0.65), 'yellowgreen')
  assert.equal(colorForRatio(0.5), 'yellow')
  assert.equal(colorForRatio(0.3), 'orange')
  assert.equal(colorForRatio(0), 'red')
  assert.equal(colorForRatio(null), 'lightgrey')
  assert.equal(colorForRatio(NaN), 'lightgrey')
})

// --- runs badge -----------------------------------------------------------
test('the runs badge is computed from the same committed packs the table reads', () => {
  // demo-pack is the repo's public reproducibility fixture; results-table.js
  // reports 13/23 (57%) over it, and the badge must not disagree.
  const badge = badgeFromRuns(demoPack)
  assert.equal(badge.schemaVersion, 1)
  assert.equal(badge.label, 'verified pass')
  assert.equal(badge.message, '13/23 (57%)')
  assert.equal(badge.color, 'yellow')
})

test('trials that never reached the model stay out of the denominator', () => {
  // demo-pack holds 24 packs; one is a PROVIDER_ERROR that never reached a
  // model. Counting it as a failure would understate the routes that answered.
  assert.equal(readOutcomes(demoPack).length, 24)
  assert.match(badgeFromRuns(demoPack).message, /\/23 /)

  const dir = packTree({ t1: ['VERIFIED_PASS', 'PROVIDER_ERROR', 'DROID_ERROR', 'VERIFIER_ERROR'] })
  try {
    assert.equal(badgeFromRuns(dir).message, '1/1 (100%)')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a runs dir with no scoreable trials says no data instead of 0%', () => {
  const dir = packTree({ t1: ['PROVIDER_ERROR', 'PROVIDER_ERROR'] })
  try {
    const badge = badgeFromRuns(dir)
    assert.equal(badge.message, 'no data')
    assert.equal(badge.color, 'lightgrey')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an absent or empty runs dir is not an error, it is no data', () => {
  assert.equal(badgeFromRuns(path.join(root, 'no-such-runs-dir')).message, 'no data')
  const empty = mkdtempSync(path.join(os.tmpdir(), 'droidtune-badge-empty-'))
  try {
    assert.equal(badgeFromRuns(empty).message, 'no data')
  } finally {
    rmSync(empty, { recursive: true, force: true })
  }
})

test('a single pack directory is read directly, not only a task tree', () => {
  const outcomes = readOutcomes(fixturePacks)
  assert.deepEqual(outcomes.sort(), ['NO_SUBMISSION', 'VERIFIED_PASS', 'VERIFIED_PASS'])
})

test('the runs badge label is overridable', () => {
  assert.equal(badgeFromRuns(demoPack, { label: 'demo-pack' }).label, 'demo-pack')
})

// --- weather badge --------------------------------------------------------
const weatherSeries = (spec) => Object.entries(spec).flatMap(([date, routes]) =>
  Object.entries(routes).map(([route, status]) => makeObservation({ route, status, at: `${date}T06:00:00.000Z` })))

test('the weather badge reports the same up-count as the rendered table', () => {
  const s = summarize(weatherSeries({
    '2026-08-20': { 'hy3-free': 'OK', 'glm-5-free': 'UNSUPPORTED', 'kimi-k2.5-free': 'OK', 'mimo-v2.5-free': 'RATE_LIMITED' }
  }), { routes: ['hy3-free', 'glm-5-free', 'kimi-k2.5-free', 'mimo-v2.5-free'] })
  const badge = badgeFromWeather(s)
  assert.equal(badge.label, 'free routes')
  assert.equal(badge.message, `${s.up}/${s.total} up`)
  assert.equal(badge.message, '2/4 up')
  assert.equal(badge.color, 'yellow')
})

test('a total outage renders a red badge, not a missing one', () => {
  const s = summarize(weatherSeries({ '2026-08-20': { 'hy3-free': 'ERROR', 'glm-5-free': 'ERROR' } }), {
    routes: ['hy3-free', 'glm-5-free']
  })
  assert.equal(badgeFromWeather(s).message, '0/2 up')
  assert.equal(badgeFromWeather(s).color, 'red')
})

test('a weather series with no observations yet is grey and says no data', () => {
  const badge = badgeFromWeather(summarize([], { routes: ['hy3-free'] }))
  assert.equal(badge.message, 'no data')
  assert.equal(badge.color, 'lightgrey')
  assert.equal(badgeFromWeather(null).message, 'no data')
})

// --- rendering ------------------------------------------------------------
test('a rendered badge is valid shields endpoint JSON with a trailing newline', () => {
  const text = renderBadge(badgeFromRuns(demoPack))
  assert.ok(text.endsWith('\n'))
  const parsed = JSON.parse(text)
  assert.deepEqual(Object.keys(parsed).sort(), ['color', 'label', 'message', 'schemaVersion'])
  assert.equal(parsed.schemaVersion, 1)
  assert.equal(typeof parsed.label, 'string')
  assert.equal(typeof parsed.message, 'string')
})

test('rendering is byte-stable so a regenerated badge compares equal to a committed one', () => {
  assert.equal(renderBadge(badgeFromRuns(demoPack)), renderBadge(badgeFromRuns(demoPack)))
})

test('the shields endpoint URL percent-encodes the raw file URL', () => {
  const url = shieldsEndpointUrl('https://raw.githubusercontent.com/sainzs/droid-tune/main/weather/badge.json')
  assert.equal(
    url,
    'https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fsainzs%2Fdroid-tune%2Fmain%2Fweather%2Fbadge.json'
  )
})
