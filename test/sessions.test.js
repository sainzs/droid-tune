import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { listSessions, readSession, aggregateSessions } from '../lib/sessions.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const demoSessions = path.join(root, 'fixtures', 'sessions')

test('listSessions finds paired settings+jsonl across project dirs', async () => {
  const { sessions, faults } = await listSessions(demoSessions)
  const ids = sessions.map(s => s.id.slice(0, 8))
  assert.ok(ids.includes('11111111'))
  assert.ok(ids.includes('22222222'))
  assert.ok(ids.includes('55555555')) // orphan transcript still listed
  const faultIds = faults.map(f => f.id)
  assert.ok(faultIds.includes('DT004'), 'missing transcript fault')
  assert.ok(faultIds.includes('DT005'), 'orphan transcript fault')
})

test('readSession derives route class from custom: model prefix', async () => {
  const { sessions } = await listSessions(demoSessions)
  const core = await readSession(sessions.find(s => s.id.startsWith('11111111')))
  const byok = await readSession(sessions.find(s => s.id.startsWith('22222222')))
  assert.equal(core.routeClass, 'core')
  assert.equal(byok.routeClass, 'byok')
})

test('factoryCredits present-but-zero still routes byok when model is custom: (droid 0.197 probe finding)', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'droidtune-test-'))
  try {
    const proj = path.join(tmp, '-t')
    mkdirSync(proj)
    writeFileSync(path.join(proj, 'x.settings.json'), JSON.stringify({
      model: 'custom:GLM-5.3-Z.AI-Coding-Plan-3',
      tokenUsage: { inputTokens: 3406, outputTokens: 3, cacheReadTokens: 0, cacheCreationTokens: 0, factoryCredits: 0 }
    }))
    writeFileSync(path.join(proj, 'x.jsonl'), '{"type":"message","timestamp":"2026-08-18T00:00:00.000Z","message":{"role":"assistant","content":"OK"}}')
    const { sessions } = await listSessions(tmp)
    const rec = await readSession(sessions[0])
    assert.equal(rec.routeClass, 'byok')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('readSession computes cache read share and guards zero denominator', async () => {
  const { sessions } = await listSessions(demoSessions)
  const byok = await readSession(sessions.find(s => s.id.startsWith('22222222')))
  // 8000 / (2000 + 8000) = 0.8
  assert.equal(byok.cacheReadShare, 0.8)
  const broken = await readSession(sessions.find(s => s.id.startsWith('33333333')))
  assert.equal(broken.cacheReadShare, null)
})

test('readSession flags unparseable settings', async () => {
  const { sessions } = await listSessions(demoSessions)
  const broken = await readSession(sessions.find(s => s.id.startsWith('33333333')))
  assert.equal(broken.settings, null)
  assert.deepEqual(broken.faults.map(f => f.id), ['DT003'])
})

test('readSession flags null usage with messages', async () => {
  const { sessions } = await listSessions(demoSessions)
  const nullUsage = await readSession(sessions.find(s => s.id.startsWith('66666666')))
  assert.deepEqual(nullUsage.faults.map(f => f.id), ['DT006'])
})

test('readSession extracts droid version and message counts from jsonl', async () => {
  const { sessions } = await listSessions(demoSessions)
  const core = await readSession(sessions.find(s => s.id.startsWith('11111111')))
  assert.equal(core.droidVersion, '0.197.0')
  assert.equal(core.messageCount, 2)
  assert.equal(core.events.userMessageCount, 1)
  assert.equal(core.events.assistantMessageCount, 1)
  assert.equal(core.firstTs, '2026-08-17T10:00:00.000Z')
})

test('probe-tagged sessions are identified', async () => {
  const { sessions } = await listSessions(demoSessions)
  const probe = await readSession(sessions.find(s => s.id.startsWith('77777777')))
  assert.equal(probe.isProbeSession, true)
})

test('aggregates exclude probe sessions and weight cache share', async () => {
  const { sessions } = await listSessions(demoSessions)
  const records = []
  for (const s of sessions) records.push(await readSession(s))
  const agg = aggregateSessions(records)
  assert.equal(agg.excludedProbe, 1)
  assert.equal(agg.byRouteClass.core, 3) // 11111111 + 44444444 + 66666666 (native model names)
  assert.equal(agg.byRouteClass.byok, 1)
  assert.equal(agg.byRouteClass.unknown, 0)
  // excl. probe: in = 1000+2000+10 = 3010; cacheRead = 50000+8000+100 = 58100
  assert.equal(agg.weightedCacheReadShare, 58100 / 61110)
})

test('missing sessions dir yields DT007 fault', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'droidtune-test-'))
  try {
    const { sessions, faults } = await listSessions(path.join(tmp, 'nope'))
    assert.equal(sessions.length, 0)
    assert.equal(faults[0].id, 'DT007')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('loose non-dir entries at root are ignored', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'droidtune-test-'))
  try {
    writeFileSync(path.join(tmp, 'stray.txt'), 'x')
    const { sessions, faults } = await listSessions(tmp)
    assert.equal(sessions.length, 0)
    assert.equal(faults.length, 0)
    mkdirSync(path.join(tmp, 'proj'))
    writeFileSync(path.join(tmp, 'proj', 'a.settings.json'), '{"model":"m"}')
    writeFileSync(path.join(tmp, 'proj', 'a.jsonl'), '{"type":"session_start","version":"1"}')
    const again = await listSessions(tmp)
    assert.equal(again.sessions.length, 1)
    assert.equal(again.faults.length, 0)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
