import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { applyTune, resolveTuneFile, TUNE_FILENAME } from '../lib/tune.js'
import { runTrial } from '../lib/runner.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ledgerLite = path.join(root, 'tunes', 'ledger-lite')

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'droidtune-tunetest-'))
const git = (cwd, args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })

function seededRepo () {
  const dir = tmp()
  execFileSync('git', ['-C', dir, 'init', '-q', '-b', 'main'])
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'trial@droidtune.local'])
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'droidtune trial'])
  writeFileSync(path.join(dir, 'calc.sh'), '#!/bin/sh\necho ok\n')
  execFileSync('git', ['-C', dir, 'add', 'calc.sh'])
  execFileSync('git', ['-C', dir, 'commit', '-qm', 'seed'])
  return dir
}

// --- resolution -----------------------------------------------------------
test('a tune spec resolves from a directory or from the file itself', () => {
  const fromDir = resolveTuneFile(ledgerLite)
  assert.equal(fromDir, path.join(ledgerLite, TUNE_FILENAME))
  assert.equal(resolveTuneFile(fromDir), fromDir)
})

test('a missing tune, and a tune directory with no AGENTS.md, both fail loudly', () => {
  assert.throws(() => resolveTuneFile(path.join(root, 'tunes', 'nope')), /tune not found/)
  const empty = tmp()
  try {
    assert.throws(() => resolveTuneFile(empty), new RegExp(`no ${TUNE_FILENAME}`))
  } finally {
    rmSync(empty, { recursive: true, force: true })
  }
})

// --- application ----------------------------------------------------------
test('applyTune writes AGENTS.md and reports its content hash', () => {
  const wt = seededRepo()
  try {
    const info = applyTune(wt, ledgerLite)
    const written = readFileSync(path.join(wt, TUNE_FILENAME))
    assert.deepEqual(written, readFileSync(path.join(ledgerLite, TUNE_FILENAME)))
    assert.equal(info.tuneName, 'ledger-lite')
    assert.equal(info.bytes, written.length)
    assert.equal(info.sha256, createHash('sha256').update(written).digest('hex'))
    assert.equal(info.gitExcluded, true)
  } finally {
    rmSync(wt, { recursive: true, force: true })
  }
})

// The two properties that keep a tune arm comparable to its baseline arm.
test('the tune is invisible to git: history unchanged and `git add -A` cannot stage it', () => {
  const wt = seededRepo()
  try {
    const headBefore = git(wt, ['rev-parse', 'HEAD']).stdout.trim()
    applyTune(wt, ledgerLite)

    assert.equal(git(wt, ['rev-parse', 'HEAD']).stdout.trim(), headBefore, 'seed history must not move')
    assert.equal(git(wt, ['status', '--porcelain']).stdout.trim(), '', 'the tune must not show as untracked')

    execFileSync('git', ['-C', wt, 'add', '-A'])
    assert.equal(git(wt, ['diff', '--cached', '--name-only']).stdout.trim(), '', '`git add -A` must not stage the tune')

    // …and it is genuinely on disk for droid to read.
    assert.ok(readFileSync(path.join(wt, TUNE_FILENAME), 'utf8').includes('ALWAYS commit completed work to git'))
  } finally {
    rmSync(wt, { recursive: true, force: true })
  }
})

// .git/info/exclude is friction, not a capability boundary: an agent that wants
// to commit the tune can still do it. What must hold is that the harness NOTICES
// — a contaminated trial cannot be scored as a clean result for the tuned arm.
test('`git add -f` can still stage the tune — the exclude file is not a boundary', () => {
  const wt = seededRepo()
  try {
    applyTune(wt, ledgerLite)
    execFileSync('git', ['-C', wt, 'add', '-f', TUNE_FILENAME])
    assert.equal(
      git(wt, ['diff', '--cached', '--name-only']).stdout.trim(), TUNE_FILENAME,
      'this is the documented gap the runner-side contamination check exists to catch'
    )
  } finally {
    rmSync(wt, { recursive: true, force: true })
  }
})

// End-to-end: the agent solves the task AND commits the tune. Grading it as a
// pass would credit the tuned arm with a result whose graded tree is not
// comparable to the untuned arm's — exactly the claim the A/B rests on.
test('a trial whose agent commits the tune is TUNE_CONTAMINATED, not VERIFIED_PASS', async () => {
  const runsDir = mkdtempSync(path.join(os.tmpdir(), 'droidtune-taint-runs-'))
  const sessionsDir = mkdtempSync(path.join(os.tmpdir(), 'droidtune-taint-sess-'))
  const configPath = path.join(runsDir, 'config.json')
  writeFileSync(configPath, JSON.stringify({
    customModels: [{ model: 'fake-model', id: 'custom:fake-0', provider: 'anthropic', baseUrl: 'https://api.z.ai/api/anthropic', apiKey: '${X_KEY}' }]
  }))
  try {
    const r = await runTrial({
      taskDir: path.join(root, 'tasks', 't001-greet-script'),
      model: 'custom:fake-0',
      droidPath: path.join(root, 'fixtures', 'bin', 'fake-droid-trial'),
      sessionsDir, configPath, runsDir, tuneFile: ledgerLite,
      env: { ...process.env, X_KEY: 'k', FAKE_DROID_MODE: 'passtainted', FAKE_DROID_SESSIONS_DIR: sessionsDir }
    })
    assert.equal(r.outcome, 'TUNE_CONTAMINATED')
    assert.match(r.results.reason, /committed AGENTS\.md into the graded history/)
    // The evidence must show it, not just the verdict.
    const events = readFileSync(path.join(runsDir, ...String(r.trialId).split('/'), 'events.jsonl'), 'utf8')
    assert.match(events, /tune\.contaminated/)
  } finally {
    rmSync(runsDir, { recursive: true, force: true })
    rmSync(sessionsDir, { recursive: true, force: true })
  }
})

test('applying a tune over a task that ships its own AGENTS.md is refused', () => {
  const wt = seededRepo()
  try {
    writeFileSync(path.join(wt, TUNE_FILENAME), '# Project Conventions\n')
    assert.throws(() => applyTune(wt, ledgerLite), /refusing to apply tune/)
    assert.equal(readFileSync(path.join(wt, TUNE_FILENAME), 'utf8'), '# Project Conventions\n')
  } finally {
    rmSync(wt, { recursive: true, force: true })
  }
})

test('an existing .git/info/exclude is appended to, not replaced, and never duplicated', () => {
  const wt = seededRepo()
  try {
    const excludePath = path.join(wt, '.git', 'info', 'exclude')
    mkdirSync(path.dirname(excludePath), { recursive: true })
    writeFileSync(excludePath, '# pre-existing\n*.log\n')
    applyTune(wt, ledgerLite)
    let body = readFileSync(excludePath, 'utf8')
    assert.match(body, /# pre-existing/)
    assert.match(body, /\*\.log/)
    assert.match(body, /^\/AGENTS\.md$/m)

    rmSync(path.join(wt, TUNE_FILENAME))
    applyTune(wt, ledgerLite)
    body = readFileSync(excludePath, 'utf8')
    assert.equal(body.split('\n').filter(l => l.trim() === '/AGENTS.md').length, 1)
  } finally {
    rmSync(wt, { recursive: true, force: true })
  }
})

// --- end to end through the runner (offline: no droid, no model, no spend) --
test('a tuned offline trial still grades VERIFIED_PASS and records the tune in its pack', async () => {
  const runsDir = tmp()
  try {
    const result = await runTrial({
      taskDir: path.join(root, 'tasks', 't004-git-surgery'),
      model: 'offline',
      runsDir,
      tuneName: 'ledger-lite',
      attempt: 1,
      offline: true,
      tuneFile: ledgerLite
    })
    assert.equal(result.outcome, 'VERIFIED_PASS', JSON.stringify(result.results))

    const packDir = path.dirname(result.manifestPath)
    const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf8'))
    assert.equal(manifest.provenance.tune.name, 'ledger-lite')
    assert.equal(manifest.provenance.tune.file, path.join(ledgerLite, TUNE_FILENAME))
    assert.equal(
      manifest.provenance.tune.sha256,
      createHash('sha256').update(readFileSync(path.join(ledgerLite, TUNE_FILENAME))).digest('hex')
    )

    const events = readFileSync(path.join(packDir, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    const applied = events.find(e => e.type === 'tune.applied')
    assert.ok(applied, 'the event ledger must record tune.applied')
    assert.equal(applied.data.gitExcluded, true)
    assert.equal(applied.data.tuneName, 'ledger-lite')

    // The tune must not appear in the graded patch.
    const patch = path.join(packDir, 'patch.diff')
    if (existsSync(patch)) assert.doesNotMatch(readFileSync(patch, 'utf8'), /AGENTS\.md/)
  } finally {
    rmSync(runsDir, { recursive: true, force: true })
  }
})

test('an untuned trial records tune: null, so the two arms are distinguishable in evidence', async () => {
  const runsDir = tmp()
  try {
    const result = await runTrial({
      taskDir: path.join(root, 'tasks', 't004-git-surgery'),
      model: 'offline',
      runsDir,
      tuneName: 'no-tune',
      attempt: 1,
      offline: true
    })
    const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf8'))
    assert.equal(manifest.provenance.tune, null)
    const events = readFileSync(path.join(path.dirname(result.manifestPath), 'events.jsonl'), 'utf8')
    assert.doesNotMatch(events, /tune\.applied/)
  } finally {
    rmSync(runsDir, { recursive: true, force: true })
  }
})

test('a tuned trial on t005 (which ships its own AGENTS.md) refuses rather than clobbering it', async () => {
  const runsDir = tmp()
  try {
    await assert.rejects(
      runTrial({
        taskDir: path.join(root, 'tasks', 't005-agents-md-compliance'),
        model: 'offline',
        runsDir,
        tuneName: 'ledger-lite',
        attempt: 1,
        offline: true,
        tuneFile: ledgerLite
      }),
      /refusing to apply tune/
    )
  } finally {
    rmSync(runsDir, { recursive: true, force: true })
  }
})

// --- the tune's own content ----------------------------------------------
test('ledger-lite states every mechanism it claims, including the commit contract', () => {
  const body = readFileSync(path.join(ledgerLite, TUNE_FILENAME), 'utf8')
  for (const needle of [
    'fast', 'full', 'loop',
    'Goal:', 'Core:', 'Verified:', 'Open:', 'Next:',
    'write once, read many',
    'by: <command you ran> including <edges it covered>',
    'ALWAYS commit completed work to git'
  ]) assert.ok(body.includes(needle), `ledger-lite is missing: ${needle}`)
  assert.match(body, /Never say done, fixed, verified, or passing without having run the check/)
})

test('tunes/ledger-lite/README.md carries the J-Space Apache-2.0 attribution and a cost figure', () => {
  const body = readFileSync(path.join(ledgerLite, 'README.md'), 'utf8')
  assert.match(body, /J-Space Cognition Suite/)
  assert.match(body, /Apache License 2\.0/)
  assert.match(body, /Tiger3807861189\/J-Space-Cognition-Suite-V3\.6/)
  assert.match(body, /## Cost/)
})

test('the documented byte count matches the file on disk', () => {
  const body = readFileSync(path.join(ledgerLite, TUNE_FILENAME))
  const readme = readFileSync(path.join(ledgerLite, 'README.md'), 'utf8')
  assert.ok(readme.includes(`${body.length} bytes`), `README claims a size the file does not have (${body.length} bytes)`)
})

// Regression: `finish()` closes over the tune provenance, and the
// ABORTED_BUDGET path returns through finish() before any worktree exists. A
// `let tuneProvenance` declared next to the worktree instead of above finish()
// put it in its temporal dead zone on that path and broke every budget-abort
// trial, tuned or not.
test('a budget abort still finishes cleanly when a tune was requested', async () => {
  const runsDir = tmp()
  try {
    const result = await runTrial({
      taskDir: path.join(root, 'tasks', 't001-greet-script'),
      model: 'offline',
      runsDir,
      tuneName: 'ledger-lite',
      attempt: 1,
      offline: true,
      tuneFile: ledgerLite,
      budget: { maxTrials: 0 }
    })
    assert.equal(result.outcome, 'ABORTED_BUDGET')
    const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf8'))
    assert.equal(manifest.provenance.tune, null, 'the tune never got applied, so it must not be claimed')
  } finally {
    rmSync(runsDir, { recursive: true, force: true })
  }
})
