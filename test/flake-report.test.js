import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const script = path.join(root, 'scripts', 'flake-report.js')
const source = path.join(root, 'runs', 'm4-flake3')

function run (args) {
  try {
    const stdout = execFileSync('node', [script, ...args], { encoding: 'utf8' })
    return { code: 0, stdout }
  } catch (err) {
    return { code: err.status, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }
  }
}

const FIVE = ['t002-slugify', 't003-path-canonicalize', 't004-git-surgery', 't005-agents-md-compliance', 't007-rename-symbol']

async function tmpRuns () {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'droidtune-flake-'))
  await cp(source, path.join(dir, 'm4-flake3'), { recursive: true })
  return dir
}

test('no filter aggregates all tasks and reports 35/48', async () => {
  const base = await tmpRuns()
  try {
    const r = run(['--runs-dir', path.join(base, 'm4-flake3')])
    assert.equal(r.code, 0)
    assert.match(r.stdout, /Included: all 6 task\(s\) found in/)
    assert.match(r.stdout, /^TOTAL 35\/48 VERIFIED_PASS/m)
    // default-without-filter still includes t006 which the filtered run omits
    assert.match(r.stdout, /t006-safe-listdir/)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('--task repeated selects subset and reports 29/40', async () => {
  const base = await tmpRuns()
  try {
    const r = run(['--runs-dir', path.join(base, 'm4-flake3'), ...FIVE.flatMap(t => ['--task', t])])
    assert.equal(r.code, 0)
    assert.match(r.stdout, /Included \(filtered to 5\): t002-slugify, t003-path-canonicalize, t004-git-surgery, t005-agents-md-compliance, t007-rename-symbol/)
    assert.match(r.stdout, /^TOTAL 29\/40 VERIFIED_PASS/m)
    assert.ok(!r.stdout.includes('t006-safe-listdir'), 'filtered run must omit t006')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('--tasks comma form matches repeated --task', async () => {
  const base = await tmpRuns()
  try {
    const r = run(['--runs-dir', path.join(base, 'm4-flake3'), '--tasks', FIVE.join(',')])
    assert.equal(r.code, 0)
    assert.match(r.stdout, /^TOTAL 29\/40 VERIFIED_PASS/m)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('missing --task id errors loudly with exit 2', async () => {
  const base = await tmpRuns()
  try {
    const r = run(['--runs-dir', path.join(base, 'm4-flake3'), '--task', 't999-nope'])
    assert.equal(r.code, 2)
    assert.match(r.stderr, /task not found under/)
    assert.match(r.stderr, /t999-nope/)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('--json emits aggregated data and reflects filtering', async () => {
  const base = await tmpRuns()
  try {
    const r = run(['--runs-dir', path.join(base, 'm4-flake3'), '--task', 't002-slugify', '--json'])
    assert.equal(r.code, 0)
    const parsed = JSON.parse(r.stdout)
    assert.equal(parsed.total.pass, 8)
    assert.equal(parsed.total.total, 8)
    assert.deepEqual(parsed.includedTasks, ['t002-slugify'])
    assert.equal(parsed.filterApplied, true)
    assert.equal(parsed.allTasksFound.length, 6)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
