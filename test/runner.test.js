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
