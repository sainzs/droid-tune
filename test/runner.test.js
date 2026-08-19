import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { runTrial } from '../lib/runner.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fakeDroid = path.join(root, 'fixtures', 'bin', 'fake-droid-trial')
const taskDir = path.join(root, 'tasks', 't001-greet-script')

function makeEnv (mode) {
  const runsDir = mkdtempSync(path.join(os.tmpdir(), 'droidtune-runs-'))
  const sessionsDir = mkdtempSync(path.join(os.tmpdir(), 'droidtune-sess-'))
  const configPath = path.join(runsDir, 'config.json')
  writeFileSync(configPath, JSON.stringify({
    customModels: [{ model: 'fake-model', id: 'custom:fake-0', provider: 'anthropic', baseUrl: 'https://api.z.ai/api/anthropic', apiKey: '${X_KEY}' }]
  }))
  return {
    runsDir, sessionsDir, configPath,
    env: { ...process.env, FAKE_DROID_MODE: mode, FAKE_DROID_SESSIONS_DIR: sessionsDir },
    packDir: (r) => path.join(runsDir, 'ad-hoc', 't001-greet-script', 'attempt-1')
  }
}

test('pass mode → VERIFIED_PASS with complete evidence pack', async () => {
  const ctx = makeEnv('pass')
  try {
    const r = await runTrial({ taskDir, model: 'custom:fake-0', droidPath: fakeDroid, sessionsDir: ctx.sessionsDir, configPath: ctx.configPath, runsDir: ctx.runsDir, env: ctx.env })
    assert.equal(r.outcome, 'VERIFIED_PASS')
    assert.equal(r.results.reward, 1)
    const pack = ctx.packDir(r)
    const manifest = JSON.parse(readFileSync(path.join(pack, 'manifest.json'), 'utf8'))
    for (const f of ['instruction.md', 'tests/test.sh', 'events.jsonl', 'transcript.jsonl', 'patch.diff', 'results.json', 'usage.json', 'config.snapshot.json']) {
      assert.ok(manifest.files[f], `manifest missing ${f}`)
    }
    const events = readFileSync(path.join(pack, 'events.jsonl'), 'utf8')
    assert.match(events, /outcome\.classified/)
    assert.match(events, /trial\.end/)
    const patch = readFileSync(path.join(pack, 'patch.diff'), 'utf8')
    assert.match(patch, /greet\.sh/)
    assert.ok(!patch.includes('tests/'), 'isolation violated: tests leaked into agent patch')
    const usage = JSON.parse(readFileSync(path.join(pack, 'usage.json'), 'utf8'))
    assert.equal(usage.outputTokens, 50)
    assert.equal(usage.routeClass, 'byok')
  } finally {
    rmSync(ctx.runsDir, { recursive: true, force: true })
    rmSync(ctx.sessionsDir, { recursive: true, force: true })
  }
})

test('nosubmit mode → NO_SUBMISSION, tests never run', async () => {
  const ctx = makeEnv('nosubmit')
  try {
    const r = await runTrial({ taskDir, model: 'custom:fake-0', droidPath: fakeDroid, sessionsDir: ctx.sessionsDir, configPath: ctx.configPath, runsDir: ctx.runsDir, env: ctx.env })
    assert.equal(r.outcome, 'NO_SUBMISSION')
    assert.equal(r.results.testExit, undefined)
    const manifest = JSON.parse(readFileSync(path.join(ctx.packDir(r), 'manifest.json'), 'utf8'))
    assert.ok(!manifest.files['patch.diff'])
  } finally {
    rmSync(ctx.runsDir, { recursive: true, force: true })
    rmSync(ctx.sessionsDir, { recursive: true, force: true })
  }
})

test('fail mode → DROID_ERROR with errors.json', async () => {
  const ctx = makeEnv('fail')
  try {
    const r = await runTrial({ taskDir, model: 'custom:fake-0', droidPath: fakeDroid, sessionsDir: ctx.sessionsDir, configPath: ctx.configPath, runsDir: ctx.runsDir, env: ctx.env })
    assert.equal(r.outcome, 'DROID_ERROR')
    assert.ok(existsSync(path.join(ctx.packDir(r), 'errors.json')))
    const errors = JSON.parse(readFileSync(path.join(ctx.packDir(r), 'errors.json'), 'utf8'))
    assert.match(JSON.stringify(errors), /fake droid failure/)
  } finally {
    rmSync(ctx.runsDir, { recursive: true, force: true })
    rmSync(ctx.sessionsDir, { recursive: true, force: true })
  }
})

test('S2: 0-turn provider rejection → PROVIDER_ERROR', async () => {
  const ctx = makeEnv('provfail')
  try {
    const r = await runTrial({ taskDir, model: 'custom:fake-0', droidPath: fakeDroid, sessionsDir: ctx.sessionsDir, configPath: ctx.configPath, runsDir: ctx.runsDir, env: ctx.env })
    assert.equal(r.outcome, 'PROVIDER_ERROR')
    const errors = JSON.parse(readFileSync(path.join(ctx.packDir(r), 'errors.json'), 'utf8'))
    assert.match(String(errors.providerDetail), /429|rate limit/i)
  } finally {
    rmSync(ctx.runsDir, { recursive: true, force: true })
    rmSync(ctx.sessionsDir, { recursive: true, force: true })
  }
})

test('S2: multi-turn failure mentioning quota → DROID_ERROR (not laundered)', async () => {
  const ctx = makeEnv('multiturnfail')
  try {
    const r = await runTrial({ taskDir, model: 'custom:fake-0', droidPath: fakeDroid, sessionsDir: ctx.sessionsDir, configPath: ctx.configPath, runsDir: ctx.runsDir, env: ctx.env })
    // num_turns>0 must keep this OUT of the excludable PROVIDER_ERROR class
    // even though the result text says "quota/overloaded" (§8.8).
    assert.equal(r.outcome, 'DROID_ERROR')
  } finally {
    rmSync(ctx.runsDir, { recursive: true, force: true })
    rmSync(ctx.sessionsDir, { recursive: true, force: true })
  }
})

test('hang mode with short timeout → TIMEOUT', async () => {
  const ctx = makeEnv('hang')
  try {
    const r = await runTrial({ taskDir, model: 'custom:fake-0', droidPath: fakeDroid, sessionsDir: ctx.sessionsDir, configPath: ctx.configPath, runsDir: ctx.runsDir, timeoutMs: 2000, env: ctx.env })
    assert.equal(r.outcome, 'TIMEOUT')
  } finally {
    rmSync(ctx.runsDir, { recursive: true, force: true })
    rmSync(ctx.sessionsDir, { recursive: true, force: true })
  }
})

test('budget maxTrials=0 → ABORTED_BUDGET, droid never spawned', async () => {
  const ctx = makeEnv('pass')
  try {
    const before = readdirSync(ctx.sessionsDir).length
    const r = await runTrial({ taskDir, model: 'custom:fake-0', droidPath: fakeDroid, sessionsDir: ctx.sessionsDir, configPath: ctx.configPath, runsDir: ctx.runsDir, attempt: 1, budget: { maxTrials: 0 }, env: ctx.env })
    assert.equal(r.outcome, 'ABORTED_BUDGET')
    assert.equal(readdirSync(ctx.sessionsDir).length, before)
    const errors = JSON.parse(readFileSync(path.join(ctx.packDir(r), 'errors.json'), 'utf8'))
    assert.equal(errors.reason, 'maxTrials')
  } finally {
    rmSync(ctx.runsDir, { recursive: true, force: true })
    rmSync(ctx.sessionsDir, { recursive: true, force: true })
  }
})

function makeOfflineCtx () {
  return {
    runsDir: mkdtempSync(path.join(os.tmpdir(), 'droidtune-runs-')),
    packDir: (r) => path.dirname(r.manifestPath)
  }
}

function ledgerEvents (packDir) {
  return readFileSync(path.join(packDir, 'events.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map(JSON.parse)
}

test('offline oracle run → VERIFIED_PASS and budgetAbort stays false when usage is null', async () => {
  const ctx = makeOfflineCtx()
  try {
    const r = await runTrial({ taskDir, model: 'offline', runsDir: ctx.runsDir, offline: true, budget: { cumulativeOutputTokens: 0, maxOutputTokensPerTrial: 0 } })
    assert.equal(r.outcome, 'VERIFIED_PASS')
    assert.equal(r.budgetAbort, false, 'null usage must not trip the budget gate')
    assert.equal(r.results.budgetAbort, false)
    const events = ledgerEvents(ctx.packDir(r))
    const vd = events.find(e => e.type === 'verify.done')
    assert.ok(vd, 'verify.done event present')
    assert.equal(vd.data.budgetOk, true)
    assert.ok(vd.data.verifierSha, 'verifierSha recorded')
    assert.ok(vd.data.gradedSha, 'gradedSha recorded')
  } finally {
    rmSync(ctx.runsDir, { recursive: true, force: true })
  }
})

test('budget gate trips on measured output tokens (maxOutputTokensPerTrial)', async () => {
  const ctx = makeEnv('pass')
  try {
    const r = await runTrial({ taskDir, model: 'custom:fake-0', droidPath: fakeDroid, sessionsDir: ctx.sessionsDir, configPath: ctx.configPath, runsDir: ctx.runsDir, budget: { maxOutputTokensPerTrial: 10 }, env: ctx.env })
    assert.equal(r.outcome, 'VERIFIED_PASS')
    assert.equal(r.budgetAbort, true, 'usage 50 > budget 10 must trip the gate')
    const events = ledgerEvents(ctx.packDir(r))
    const vd = events.find(e => e.type === 'verify.done')
    assert.equal(vd.data.budgetOk, false)
  } finally {
    rmSync(ctx.runsDir, { recursive: true, force: true })
    rmSync(ctx.sessionsDir, { recursive: true, force: true })
  }
})

test('forgery cheat → VERIFIER_ERROR with reward/exit mismatch in ledger', async () => {
  const ctx = makeOfflineCtx()
  try {
    const r = await runTrial({ taskDir, model: 'offline', runsDir: ctx.runsDir, offline: true, cheat: 'forgery' })
    assert.equal(r.outcome, 'VERIFIER_ERROR')
    const events = ledgerEvents(ctx.packDir(r))
    const vd = events.find(e => e.type === 'verify.done')
    assert.equal(vd.data.verdict, 'VERIFIER_ERROR')
    assert.equal(vd.data.reason, 'reward/exit mismatch')
  } finally {
    rmSync(ctx.runsDir, { recursive: true, force: true })
  }
})

// D1: grading must grade the committed state (fresh git clone), never the
// dirty worktree. These fixtures use a custom task whose test.sh checks the
// output of solution.js; the oracle solve.sh leaves the passing solution
// UNCOMMITTED in the dirty variant, so only a worktree-based grader would
// see it.
const SEED_SH = `#!/bin/sh
set -eu
target="\${1:?usage: seed.sh TARGET_DIR}"
mkdir -p "\$target"
cd "\$target"
git init -q -b main 2>/dev/null || { git init -q; git symbolic-ref HEAD refs/heads/main; }
git config user.email "trial@droidtune.local"
git config user.name "droidtune trial"
printf '%s\n' "seed" > README.md
printf '%s\n' "console.log('WRONG')" > solution.js
git add -A
git commit -qm "seed"
`

const SOLVE_DIRTY = `#!/bin/sh
set -eu
target="\${1:?usage: solve.sh TARGET_DIR}"
cd "\$target"
# Commit a harmless change so there is at least one agent commit.
printf '%s\n' "noop" >> README.md
git add README.md
git commit -qm "noop commit"
# Make the tests pass in the WORKTREE only — left uncommitted (dirty).
printf '%s\n' "console.log('hello tune-up')" > solution.js
`

const SOLVE_COMMIT = `#!/bin/sh
set -eu
target="\${1:?usage: solve.sh TARGET_DIR}"
cd "\$target"
printf '%s\n' "console.log('hello tune-up')" > solution.js
git add solution.js
git commit -qm "fix solution"
`

const TEST_SH = `#!/bin/sh
set -u
OUT="\${1:-.}"
mkdir -p "\$OUT"
node solution.js > "\$OUT/stdout.txt" 2> "\$OUT/stderr.txt"
code=\$?
[ "\$code" -eq 0 ] && [ "\$(cat "\$OUT/stdout.txt")" = "hello tune-up" ] || code=1
pass=0; fail=0
[ "\$code" -eq 0 ] && pass=1 || fail=1
reward=0; [ "\$code" -eq 0 ] && reward=1
printf '{"reward":%s}\\n' "\$reward" > "\$OUT/reward.json"
status=failed; [ "\$code" -eq 0 ] && status=passed
printf '{"results":{"tool":{"name":"d1-fixture"},"summary":{"tests":1,"passed":%s,"failed":%s,"skipped":0,"pending":0,"other":0,"start":0,"stop":0},"tests":[{"name":"prints greeting","status":"%s","duration":0}]}}\\n' "\$pass" "\$fail" "\$status" > "\$OUT/ctrf.json"
exit "\$code"
`

function makeD1Fixture (solveMode) {
  const base = mkdtempSync(path.join(os.tmpdir(), 'droidtune-d1-'))
  mkdirSync(path.join(base, 'environment'), { recursive: true })
  mkdirSync(path.join(base, 'solution'), { recursive: true })
  mkdirSync(path.join(base, 'tests'), { recursive: true })
  writeFileSync(path.join(base, 'instruction.md'), '# D1 dirty-file isolation fixture\n')
  writeFileSync(path.join(base, 'environment', 'seed.sh'), SEED_SH)
  writeFileSync(path.join(base, 'solution', 'solve.sh'), solveMode === 'commit' ? SOLVE_COMMIT : SOLVE_DIRTY)
  writeFileSync(path.join(base, 'tests', 'test.sh'), TEST_SH)
  return base
}

test('grading excludes uncommitted worktree files (D1)', async () => {
  const base = makeD1Fixture('dirty')
  const runsDir = mkdtempSync(path.join(os.tmpdir(), 'droidtune-runs-'))
  try {
    const r = await runTrial({ taskDir: base, model: 'offline', runsDir, offline: true })
    // The worktree's dirty solution.js would pass; the committed state graded
    // from the fresh clone still fails. Verdict must follow the commit.
    assert.equal(r.outcome, 'VERIFIED_FAIL')
  } finally {
    rmSync(base, { recursive: true, force: true })
    rmSync(runsDir, { recursive: true, force: true })
  }
})

test('grading sees committed solution (D1 control)', async () => {
  const base = makeD1Fixture('commit')
  const runsDir = mkdtempSync(path.join(os.tmpdir(), 'droidtune-runs-'))
  try {
    const r = await runTrial({ taskDir: base, model: 'offline', runsDir, offline: true })
    assert.equal(r.outcome, 'VERIFIED_PASS')
  } finally {
    rmSync(base, { recursive: true, force: true })
    rmSync(runsDir, { recursive: true, force: true })
  }
})
