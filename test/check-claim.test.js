import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const script = path.join(root, 'scripts', 'check-claim.js')
const claimsDir = path.join(root, 'claims')

const run = (args) => spawnSync('node', [script, ...args], { encoding: 'utf8' })

// --- real claims -----------------------------------------------------------

test('every committed claim passes, ending each line OK', () => {
  const r = run([])
  assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  assert.equal(r.stdout.trim(), [
    'OK claims/dt-v0-cache-stability.json',
    'OK claims/dt-v1-ledger-lite-nosub.json'
  ].join('\n'))

  // An explicit directory arg prints the paths exactly as constructed.
  const abs = run([claimsDir])
  assert.equal(abs.status, 0, `stderr: ${abs.stderr}`)
  assert.equal(abs.stdout.trim(), [
    `OK ${path.join(claimsDir, 'dt-v0-cache-stability.json')}`,
    `OK ${path.join(claimsDir, 'dt-v1-ledger-lite-nosub.json')}`
  ].join('\n'))
})

test('a single claim file may be passed as argv', () => {
  const file = path.join('claims', 'dt-v1-ledger-lite-nosub.json')
  const r = run([file])
  assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  assert.equal(r.stdout.trim(), `OK ${file}`)
})

test('a missing target is a usage/IO error with exit 2', () => {
  const r = run([path.join(os.tmpdir(), `droidtune-no-such-claims-${process.pid}`)])
  assert.equal(r.status, 2)
  assert.match(r.stderr, /cannot read/)
})

test('a directory with no claim files is a usage/IO error with exit 2', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'droidtune-cc-empty-'))
  try {
    const r = run([dir])
    assert.equal(r.status, 2)
    assert.match(r.stderr, /no claim files/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- synthetic bad claims ---------------------------------------------------

// A minimally complete preregistration mirroring the committed claims' shape.
// tuneFile is exercised separately: check-claim.js resolves it against the
// repo root, so tune cases pin the real tunes/ file or a name that cannot
// exist, without writing anything outside the temp dir.
const base = (id) => ({
  id,
  status: 'preregistered',
  arms: ['no-tune', 'ledger-lite'],
  routes: ['hy3-free', 'nemotron-3-ultra-free'],
  design: { nPerArmPerRoute: 5, nPerArm: 10, totalTrials: 20, autoLevel: 'high' },
  primaryMetric: 'no-submission-rate',
  decisionRule: 'Recommend ledger-lite only if the pooled rates support it.',
  exclusionRule: 'Drop a route entirely rather than analyse it partially.',
  registeredAt: '2026-08-20T00:00:00.000Z'
})

test('synthetic bad claims fail with every check named', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'droidtune-cc-bad-'))
  const CLAIMS = path.join(dir, 'claims')
  mkdirSync(CLAIMS, { recursive: true })

  const cases = [
    ['bad-json.json', '{ "id": "bad-json"', 'json'],
    ['id-mismatch.json', { ...base('id-mismatch'), id: 'some-other-id' }, 'id'],
    ['bad-status.json', { ...base('bad-status'), status: 'published' }, 'status'],
    ['tune-missing-file.json', { ...base('tune-missing-file'), tuneFile: 'no-such-tune/AGENTS.md', tuneSha256: 'a'.repeat(64) }, 'tune'],
    ['tune-sha-mismatch.json', { ...base('tune-sha-mismatch'), tuneFile: 'tunes/ledger-lite/AGENTS.md', tuneSha256: 'b'.repeat(64) }, 'tune'],
    ['tune-partial.json', { ...base('tune-partial'), tuneFile: 'tunes/ledger-lite/AGENTS.md' }, 'tune'],
    ['design-total.json', { ...base('design-total'), design: { nPerArmPerRoute: 5, nPerArm: 10, totalTrials: 25 } }, 'design'],
    ['design-nperarm.json', { ...base('design-nperarm'), design: { nPerArmPerRoute: 5, nPerArm: 8, totalTrials: 20 } }, 'design'],
    ['dup-routes.json', { ...base('dup-routes'), routes: ['hy3-free', 'hy3-free'] }, 'routes'],
    ['empty-routes.json', { ...base('empty-routes'), routes: [], design: undefined }, 'routes'],
    ['blank-route.json', { ...base('blank-route'), routes: ['hy3-free', '  '] }, 'routes'],
    ['dup-arms.json', { ...base('dup-arms'), arms: ['no-tune', 'no-tune'] }, 'arms'],
    ['empty-primary.json', { ...base('empty-primary'), primaryMetric: '' }, 'primaryMetric'],
    ['blank-decision.json', { ...base('blank-decision'), decisionRule: '   ' }, 'decisionRule'],
    ['empty-exclusion.json', { ...base('empty-exclusion'), exclusionRule: '' }, 'exclusionRule'],
    ['bad-date.json', { ...base('bad-date'), registeredAt: 'not-a-date' }, 'registeredAt']
  ]
  const write = (name, content) => writeFileSync(
    path.join(CLAIMS, name),
    typeof content === 'string' ? content : JSON.stringify(content, null, 2)
  )
  try {
    for (const [name, content] of cases) write(name, content)
    write('good.json', base('good'))

    const r = run([CLAIMS])
    assert.equal(r.status, 1, 'any failing claim must exit 1')
    const lines = r.stdout.trim().split('\n')
    assert.equal(lines.length, cases.length + 1, r.stdout)

    for (const [name, , check] of cases) {
      const line = lines.find(l => l.includes(`FAIL ${path.join(CLAIMS, name)}`))
      assert.ok(line, `missing FAIL line for ${name}\n${r.stdout}`)
      assert.match(line, new RegExp(`\\b${check}:`), `FAIL line for ${name} must name the ${check} check\n${line}`)
    }

    const ok = lines.find(l => l.includes('OK '))
    assert.ok(ok?.endsWith(path.join(CLAIMS, 'good.json')), 'the valid claim must still print OK\n' + r.stdout)
    for (const [, , check] of cases) {
      assert.ok(!ok.includes(`${check}:`), 'the OK line must not carry a failing check')
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a single bad claim file exits 1 and names its check', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'droidtune-cc-one-'))
  const file = path.join(dir, 'broken.json')
  writeFileSync(file, JSON.stringify({ ...base('broken'), status: 'shipped' }))
  try {
    const r = run([file])
    assert.equal(r.status, 1)
    assert.match(r.stdout.trim(), /^FAIL .* — status: "shipped"/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a claim failing several checks names them all on one line', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'droidtune-cc-multi-'))
  const file = path.join(dir, 'multi.json')
  writeFileSync(file, JSON.stringify({ ...base('multi'), status: 'published', registeredAt: 'yesterday-ish' }))
  try {
    const r = run([file])
    assert.equal(r.status, 1)
    assert.match(r.stdout.trim(), /status: "published"/)
    assert.match(r.stdout.trim(), /registeredAt: "yesterday-ish"/)
    assert.equal(r.stdout.trim().split('\n').length, 1, 'all checks must share one FAIL line')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a valid synthetic claim alone exits 0', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'droidtune-cc-good-'))
  const file = path.join(dir, 'fine.json')
  writeFileSync(file, JSON.stringify(base('fine')))
  try {
    const r = run([file])
    assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    assert.equal(r.stdout.trim(), `OK ${file}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
