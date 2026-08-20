import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runTriforce } from '../lib/triforce.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const bin = path.join(root, 'bin', 'droidtune.js')

function run (args, opts = {}) {
  try {
    const stdout = execFileSync('node', [bin, ...args], { encoding: 'utf8', ...opts })
    return { code: 0, stdout }
  } catch (err) {
    return { code: err.status, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }
  }
}

test('--help exits 0 and prints usage', () => {
  const r = run(['--help'])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /droidtune — Droid Tune-Up/)
  assert.match(r.stdout, /Not affiliated with Factory/)
})

test('no arguments exits 2', () => {
  const r = run([])
  assert.equal(r.code, 2)
})

test('unknown command exits 2', () => {
  const r = run(['frobnicate'])
  assert.equal(r.code, 2)
  assert.match(r.stderr, /unknown command/)
})

test('unknown flag exits 2', () => {
  const r = run(['diagnose', '--wat'])
  assert.equal(r.code, 2)
  assert.match(r.stderr, /unknown flag/)
})

test('baseline refuses to run without explicit spend confirmation', () => {
  const r = run(['baseline'])
  assert.equal(r.code, 2)
  assert.match(r.stderr, /requires --confirm-spend/)
})

test('--limit without value exits 2', () => {
  const r = run(['diagnose', '--demo', '--limit'])
  assert.equal(r.code, 2)
})

test('--demo exits 1 with expected fault ids in --json', () => {
  const r = run(['diagnose', '--demo', '--json'])
  assert.equal(r.code, 1)
  const parsed = JSON.parse(r.stdout)
  const faults = parsed.findings.filter(f => f.severity === 'fault').map(f => f.id).sort()
  assert.deepEqual(faults, ['DT002', 'DT003', 'DT004', 'DT005', 'DT006'])
})

test('--demo human output renders findings and verdict', () => {
  const r = run(['diagnose', '--demo'])
  assert.equal(r.code, 1)
  assert.match(r.stdout, /DROID TUNE-UP — DIAGNOSE/)
  assert.match(r.stdout, /FAULT DT002/)
  assert.match(r.stdout, /5 fault\(s\)/)
})

test('clean config + sessions exit 0', () => {
  const r = run([
    'diagnose',
    '--config', path.join(root, 'fixtures', 'settings', 'clean-settings.json'),
    '--sessions-dir', path.join(root, 'fixtures', 'sessions-clean'),
    '--droid-path', path.join(root, 'fixtures', 'bin', 'fake-droid')
  ])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /clean bill of health/)
})

test('--demo --probe exits 2 (probe needs live droid)', () => {
  const r = run(['diagnose', '--demo', '--probe'])
  assert.equal(r.code, 2)
})

test('runTriforce: all-expected verdicts → ok:true with 7 passing legs', () => {
  const verdicts = {
    oracle: 'VERIFIED_PASS',
    noop: 'VERIFIED_FAIL',
    'cheat:forgery': 'VERIFIER_ERROR',
    'cheat:early-exit': 'VERIFIER_ERROR'
  }
  const seen = []
  const r = runTriforce((kind) => { seen.push(kind); return verdicts[kind] }, () => {})
  assert.equal(r.ok, true)
  assert.equal(r.results.length, 7)
  assert.ok(r.results.every(x => x.pass))
  assert.deepEqual(seen, ['oracle', 'oracle', 'oracle', 'noop', 'noop', 'cheat:forgery', 'cheat:early-exit'])
})

test('runTriforce: one wrong verdict → ok:false', () => {
  const expected = {
    oracle: 'VERIFIED_PASS',
    noop: 'VERIFIED_FAIL',
    'cheat:forgery': 'VERIFIER_ERROR',
    'cheat:early-exit': 'VERIFIER_ERROR'
  }
  let n = 0
  const r = runTriforce((kind) => {
    n += 1
    if (n === 4) return 'VERIFIED_PASS' // wrong for a noop leg (expects VERIFIED_FAIL)
    return expected[kind]
  }, () => {})
  assert.equal(r.ok, false)
  const failing = r.results.filter(x => !x.pass).map(x => `${x.leg} #${x.i}`)
  assert.deepEqual(failing, ['noop #1'])
})

test('triforce CLI exits 0 (7 offline legs)', () => {
  const r = run(['triforce'])
  assert.equal(r.code, 0, `triforce exited ${r.code}: ${r.stdout}${r.stderr}`)
  assert.match(r.stdout, /ok oracle #1 -> VERIFIED_PASS/)
  assert.match(r.stdout, /ok noop #2 -> VERIFIED_FAIL/)
  assert.match(r.stdout, /ok cheat:early-exit #1 -> VERIFIER_ERROR/)
})
