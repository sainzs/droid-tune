import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runDiagnose, redactConfig } from '../lib/diagnose.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('demo run produces exactly the expected faults and hints', async () => {
  const result = await runDiagnose({ demo: true })
  const faults = result.findings.filter(f => f.severity === 'fault').map(f => f.id).sort()
  const hints = result.findings.filter(f => f.severity === 'hint').map(f => f.id).sort()
  assert.deepEqual(faults, ['DT002', 'DT003', 'DT004', 'DT005', 'DT006'])
  assert.deepEqual(hints, ['DT101', 'DT102', 'DT103', 'DT104'])
})

test('demo stamp uses fixture droid version', async () => {
  const result = await runDiagnose({ demo: true })
  assert.equal(result.stamp.droidVersion, '0.197.0 (fixture)')
  assert.equal(result.stamp.demo, true)
})

test('plaintext key never appears in the snapshot output', async () => {
  const result = await runDiagnose({ demo: true })
  const dumped = JSON.stringify(result)
  assert.ok(!dumped.includes('sk-fixture-plaintext-DO-NOT-USE'), 'plaintext key leaked')
  const entry = result.config.settings.customModels[1]
  assert.equal(entry.apiKey.redacted, true)
  assert.equal(entry.apiKey.length, 'sk-fixture-plaintext-DO-NOT-USE'.length)
  assert.match(entry.apiKey.sha256, /^[0-9a-f]{12}$/)
})

test('env-ref keys pass through unredacted', async () => {
  const result = await runDiagnose({ demo: true })
  assert.equal(result.config.settings.customModels[0].apiKey, '${ZAI_API_KEY}')
})

test('clean fixtures yield zero faults and zero hints', async () => {
  const result = await runDiagnose({
    configPath: path.join(root, 'fixtures', 'settings', 'clean-settings.json'),
    sessionsDir: path.join(root, 'fixtures', 'sessions-clean'),
    droidPath: path.join(root, 'fixtures', 'bin', 'fake-droid')
  })
  assert.deepEqual(result.findings, [])
  assert.equal(result.sessions.aggregates.byRouteClass.core, 1)
})

test('DT104 lists non-custom model slots but not custom: ones', async () => {
  const result = await runDiagnose({ demo: true })
  const hint = result.findings.find(f => f.id === 'DT104')
  const slots = hint.evidence.slots.map(s => s.slot)
  assert.ok(slots.includes('compactionModel'))
  assert.ok(slots.includes('subagentModelSettings.heavyModel'))
  assert.ok(!slots.some(s => s.startsWith('custom:')))
})

test('redactConfig hashes nested secret-shaped strings regardless of location', () => {
  const snapshot = redactConfig({
    apiKeyHelper: 'op read zai-key',
    maxOutputTokens: 65536,
    nested: { token: 'abc123', showTokenUsageIndicator: true }
  })
  assert.equal(snapshot.apiKeyHelper.redacted, true)
  assert.equal(snapshot.maxOutputTokens, 65536)
  assert.equal(snapshot.nested.token.redacted, true)
  assert.equal(snapshot.nested.showTokenUsageIndicator, true)
})

test('limit caps the recent-session table only', async () => {
  const result = await runDiagnose({ demo: true, limit: 2 })
  assert.equal(result.sessions.table.length, 2)
  assert.equal(result.sessions.tableLimit, 2)
  assert.ok(result.sessions.total >= 7)
})
