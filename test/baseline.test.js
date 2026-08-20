import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runBaseline } from '../lib/baseline.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const bundlePath = path.join(root, 'configs', 'native-droid.json')

test('baseline refuses to spend before reading or writing run state', async () => {
  const runsDir = path.join(os.tmpdir(), `droidtune-no-spend-${Date.now()}`)
  await assert.rejects(runBaseline({ confirmSpend: false, runsDir }), /--confirm-spend/)
  assert.equal(existsSync(runsDir), false)
})

test('baseline freezes provenance before dispatching the complete bundle', async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'droidtune-baseline-'))
  const configPath = path.join(temp, 'settings.json')
  writeFileSync(configPath, JSON.stringify({ customModels: [] }))
  const calls = []
  try {
    const result = await runBaseline({
      bundlePath,
      repoRoot: root,
      configPath,
      sessionsDir: path.join(temp, 'sessions'),
      droidPath: path.join(root, 'fixtures', 'bin', 'fake-droid'),
      runsDir: path.join(temp, 'runs'),
      confirmSpend: true,
      // Stub the runner-dirty check to a fixed clean value so this assertion
      // is hermetic and doesn't depend on whether the machine running the
      // suite happens to have uncommitted changes elsewhere in the repo.
      runnerProvenance: () => ({ runnerSha: 'test-fixture-sha', runnerDirty: false }),
      runOne: async opts => {
        calls.push(opts)
        return { outcome: 'VERIFIED_PASS' }
      }
    })
    assert.equal(calls.length, 6)
    assert.ok(calls.every(call => call.native === true && call.model === undefined))
    assert.ok(calls.every(call => call.pricingTableId === 'factory-credits-observed-v1'))
    assert.ok(calls.every(call => call.budget.maxOutputTokensPerTrial === 100000))
    assert.equal(result.stoppedByBudget, false)
    assert.ok(result.bundle.bundleSha)
    assert.ok(result.bundle.configSha)
    assert.deepEqual(result.bundle.claims.map(claim => claim.id), ['dt-v0-cache-stability'])
    assert.ok(result.bundle.claims[0].sha256)
    assert.equal(result.bundle.tasks.length, 6)
    assert.ok(result.bundle.tasks.every(task => task.taskSha && task.verifierSha))
    assert.ok(result.bundle.taskSetSha)
    assert.ok(result.bundle.verifierSetSha)
    const snapshot = JSON.parse(readFileSync(path.join(temp, 'runs', 'native-droid', 'bundle.snapshot.json'), 'utf8'))
    assert.equal(snapshot.bundleSha, result.bundle.bundleSha)
    assert.equal(result.bundle.runnerSha, 'test-fixture-sha')
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})

test('baseline refuses when the runner working tree is dirty (never claims a clean SHA over mutated code)', async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'droidtune-baseline-dirty-'))
  const configPath = path.join(temp, 'settings.json')
  writeFileSync(configPath, JSON.stringify({ customModels: [] }))
  try {
    await assert.rejects(
      runBaseline({
        bundlePath,
        repoRoot: root,
        configPath,
        sessionsDir: path.join(temp, 'sessions'),
        droidPath: path.join(root, 'fixtures', 'bin', 'fake-droid'),
        runsDir: path.join(temp, 'runs'),
        confirmSpend: true,
        runnerProvenance: () => ({ runnerSha: 'test-fixture-sha', runnerDirty: true }),
        runOne: async () => { throw new Error('runOne must never be called when the runner tree is dirty') }
      }),
      /dirty runner working tree/
    )
    // Refuses before writing anything — mirrors the confirm-spend guard above.
    assert.equal(existsSync(path.join(temp, 'runs')), false)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})
