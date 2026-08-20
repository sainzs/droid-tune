import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { readObservations } from '../lib/weather.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const script = path.join(root, 'scripts', 'route-weather.js')
const weatherDir = path.join(root, 'weather')

function run (args, env = {}) {
  try {
    const stdout = execFileSync('node', [script, ...args], {
      encoding: 'utf8',
      // Scrub any real credential out of the child's environment: nothing in
      // this file may make a network call, and an inherited key is the only
      // way one could.
      env: { ...process.env, OPENCODE_ZEN_KEY: '', ...env }
    })
    return { code: 0, stdout, stderr: '' }
  } catch (err) {
    return { code: err.status, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }
  }
}

// --- the committed report must stay a function of the committed data -------
// The scheduled workflow commits with [skip ci], so the generated files are
// not validated at the moment they are written. This is the guard that catches
// them on the next real push, exactly like scripts/check-demo-table.js does
// for the results table.
test('the committed weather report and badge match the committed observations', () => {
  const r = run(['--render', '--check'])
  assert.equal(r.code, 0, `${r.stdout}${r.stderr}`)
  assert.match(r.stdout, /generated files match/)
})

test('--check fails loudly when the report has drifted from the data', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'droidtune-rw-'))
  try {
    const data = path.join(dir, 'route-status.jsonl')
    writeFileSync(data, JSON.stringify({
      date: '2026-08-20', ts: '2026-08-20T06:00:00.000Z', route: 'hy3-free', status: 'OK'
    }) + '\n')
    assert.equal(run(['--render', '--data', data, '--out-dir', dir, '--routes', 'hy3-free']).code, 0)
    assert.equal(run(['--render', '--check', '--data', data, '--out-dir', dir, '--routes', 'hy3-free']).code, 0)

    writeFileSync(path.join(dir, 'README.md'), '# stale\n')
    const r = run(['--render', '--check', '--data', data, '--out-dir', dir, '--routes', 'hy3-free'])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /no longer match/)
    assert.match(r.stderr, /--render/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- credential handling --------------------------------------------------
test('--probe without a key refuses rather than recording a machine problem as an outage', () => {
  const r = run(['--probe'])
  assert.equal(r.code, 2)
  assert.match(r.stderr, /OPENCODE_ZEN_KEY is not set/)
  assert.match(r.stderr, /not about the routes/)
})

test('no mode flag is a usage error', () => {
  const r = run([])
  assert.equal(r.code, 2)
  assert.match(r.stderr, /--probe .* or --render/)
})

test('--days must be a positive integer', () => {
  assert.equal(run(['--render', '--days', '0']).code, 2)
  assert.equal(run(['--render', '--days', 'lots']).code, 2)
})

// --- the committed artifacts ---------------------------------------------
test('the committed observation series is well formed and carries no unreadable lines', () => {
  const { observations, parseErrors } = readObservations(path.join(weatherDir, 'route-status.jsonl'))
  assert.equal(parseErrors, 0)
  for (const o of observations) {
    assert.match(o.date, /^\d{4}-\d{2}-\d{2}$/)
    assert.equal(typeof o.route, 'string')
    assert.ok(o.latencyMs === null || typeof o.latencyMs === 'number')
  }
})

// A committed file is forever. This asserts the redaction actually held on the
// real data, not just on the synthetic cases in weather.test.js.
test('nothing under weather/ contains anything credential-shaped', () => {
  const blob = ['route-status.jsonl', 'README.md', 'badge.json']
    .map(f => readFileSync(path.join(weatherDir, f), 'utf8')).join('\n')
  assert.doesNotMatch(blob, /sk-[A-Za-z0-9_-]{8,}/, 'an sk- token reached a committed weather file')
  assert.doesNotMatch(blob, /[Bb]earer\s+[A-Za-z0-9._-]{8,}/, 'a bearer token reached a committed weather file')
  assert.doesNotMatch(blob, /[A-Za-z0-9_-]{32,}/, 'a token-shaped run reached a committed weather file')
})

test('the committed badge is valid shields endpoint JSON', () => {
  const badge = JSON.parse(readFileSync(path.join(weatherDir, 'badge.json'), 'utf8'))
  assert.equal(badge.schemaVersion, 1)
  assert.equal(badge.label, 'free routes')
  assert.match(badge.message, /^(?:\d+\/\d+ up|no data)$/)
})

// --- the workflow ---------------------------------------------------------
// The workflow is the part nobody runs locally, so the properties that matter
// are asserted against its source rather than left to a code review.
test('the scheduled workflow never echoes the key and probes each route once', () => {
  const wf = readFileSync(path.join(root, '.github', 'workflows', 'route-weather.yml'), 'utf8')
  assert.match(wf, /schedule:/)
  assert.match(wf, /cron:/)
  assert.match(wf, /workflow_dispatch:/)
  assert.match(wf, /OPENCODE_ZEN_KEY: \$\{\{ secrets\.OPENCODE_ZEN_KEY \}\}/)
  // The key is passed as an env var to one step and never interpolated into a
  // shell command, where it would land in the public build log.
  assert.doesNotMatch(wf, /echo .*OPENCODE_ZEN_KEY/)
  assert.doesNotMatch(wf, /set -x/)
  assert.doesNotMatch(wf, /\$\{\{ secrets\.OPENCODE_ZEN_KEY \}\}[^\n]*run:/)
  // Exactly one probe invocation.
  assert.equal((wf.match(/route-weather\.js --probe/g) ?? []).length, 1)
  assert.doesNotMatch(wf, /--probe[^\n]*--probe/)
  // Data-only commits must not spend a CI run on the full gate.
  assert.match(wf, /\[skip ci\]/)
  // A fork has no secret; a scheduled run there would fail every morning.
  assert.match(wf, /github\.repository == 'sainzs\/droid-tune'/)
  assert.match(wf, /contents: write/)
})

test('the ci workflow still guards the demo table and does not run the probe', () => {
  const ci = readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8')
  assert.match(ci, /check-demo-table\.js/)
  assert.doesNotMatch(ci, /--probe/)
  assert.doesNotMatch(ci, /OPENCODE_ZEN_KEY/)
})
