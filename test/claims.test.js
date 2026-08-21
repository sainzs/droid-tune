import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadClaims, validateClaim } from '../lib/claims.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// A committed claim is either an open promise or a closed one, and closure is
// now a real transition (scripts/claim-report.js --close), so pinning the
// registry to "everything is preregistered" would fail the day any claim is
// concluded. What must hold in both states is that a result never appears
// outside a conclusion block — that is the laundering this registry prevents.
test('committed claim registry holds valid claims, with no result outside a conclusion', () => {
  const claims = loadClaims(path.join(root, 'claims'))
  assert.ok(claims.length > 0)
  assert.ok(claims.every(claim => ['preregistered', 'reported'].includes(claim.status)))
  assert.ok(claims.every(claim => !('result' in claim)))
  // An open claim carries no conclusion; a closed one must.
  for (const claim of claims) {
    assert.equal('conclusion' in claim, claim.status === 'reported', `${claim.id} status/conclusion disagree`)
  }
})

// The registered fields of a real claim, with its lifecycle stripped back to
// the moment of registration. Tests below mutate this to build synthetic
// records; deriving it from the real file keeps them honest about the shape a
// claim actually has, while staying independent of whether that claim has
// since been concluded.
const openBase = (claim) => {
  const { conclusion, ...rest } = claim
  return { ...rest, status: 'preregistered' }
}

test('claim validation rejects result laundering into a preregistration', () => {
  const valid = openBase(loadClaims(path.join(root, 'claims')).find(c => c.id === 'dt-v1-ledger-lite-nosub'))
  assert.throws(() => validateClaim({ ...valid, result: { pass: true } }), /cannot contain results/)
})

// A synthetic conclusion in the shape scripts/claim-report.js --close writes.
// The committed claims stay preregistered; nothing here touches them.
const conclusionFor = (claim, over = {}) => ({
  verdict: 'not-supported',
  supported: false,
  state: 'complete',
  closedAt: '2026-08-21T00:00:00.000Z',
  evidence: {
    sweepLog: `runs/${claim.id}/sweep-log.jsonl`,
    pooledRoutes: [...claim.routes],
    nPerArmPerRoute: claim.design.nPerArmPerRoute
  },
  ...over
})

test('claim validation accepts a mechanically closed claim', () => {
  const valid = openBase(loadClaims(path.join(root, 'claims')).find(c => c.id === 'dt-v1-ledger-lite-nosub'))
  const closed = { ...valid, status: 'reported', conclusion: conclusionFor(valid) }
  assert.equal(validateClaim(closed).status, 'reported')
  assert.equal(validateClaim({ ...closed, conclusion: conclusionFor(valid, { verdict: 'supported', supported: true }) }).conclusion.verdict, 'supported')
})

test('claim validation rejects a reported record whose conclusion does not hold up', () => {
  const valid = openBase(loadClaims(path.join(root, 'claims')).find(c => c.id === 'dt-v1-ledger-lite-nosub'))
  const closed = (over) => ({ ...valid, status: 'reported', conclusion: conclusionFor(valid, over) })
  const cases = [
    [{ ...valid, status: 'reported' }, /require a conclusion object/],
    [closed({ verdict: 'inconclusive' }), /verdict must be supported or not-supported/],
    [closed({ supported: true }), /supported flag contradicts/],
    [closed({ state: 'incomplete' }), /complete evidence/],
    [closed({ closedAt: 'someday' }), /closedAt must be an ISO timestamp/],
    [closed({ evidence: undefined }), /must cite its evidence/],
    [closed({ evidence: { ...conclusionFor(valid).evidence, sweepLog: 'runs/other/sweep-log.jsonl' } }), /this claim's sweep log/],
    [closed({ evidence: { ...conclusionFor(valid).evidence, pooledRoutes: [] } }), /must name the pooled routes/],
    [closed({ evidence: { ...conclusionFor(valid).evidence, pooledRoutes: ['made-up-route'] } }), /never registered/],
    [closed({ evidence: { ...conclusionFor(valid).evidence, nPerArmPerRoute: 3 } }), /different n than the claim registered/],
    [{ ...valid, status: 'withdrawn' }, /must be preregistered or reported/]
  ]
  for (const [claim, expected] of cases) {
    assert.throws(() => validateClaim(claim), expected)
  }
})

test('claim validation rejects a conclusion bolted onto a still-open claim', () => {
  const valid = openBase(loadClaims(path.join(root, 'claims')).find(c => c.id === 'dt-v1-ledger-lite-nosub'))
  assert.throws(() => validateClaim({ ...valid, conclusion: conclusionFor(valid) }), /preregistered claims cannot contain results/)
  // And a closed claim may not carry a second, top-level verdict either.
  assert.throws(
    () => validateClaim({ ...valid, status: 'reported', conclusion: conclusionFor(valid), verdict: 'supported' }),
    /cannot contain results outside its conclusion block/
  )
})

test('dt-v1-ledger-lite-nosub preregisters arms, routes, n, and an exact primary metric', () => {
  const claim = loadClaims(path.join(root, 'claims')).find(c => c.id === 'dt-v1-ledger-lite-nosub')
  assert.ok(claim, 'the ledger-lite claim must be registered')
  assert.deepEqual(claim.population, ['t004-git-surgery'])
  assert.deepEqual(claim.arms, ['no-tune', 'ledger-lite'])
  assert.deepEqual(claim.routes, [
    'hy3-free', 'nemotron-3.5-lightning-free', 'laguna-s-2.1-free', 'nemotron-3-ultra-free'
  ])
  assert.equal(claim.primaryMetric, 'no-submission-rate')
  assert.equal(claim.design.nPerArmPerRoute, 10)
  assert.equal(claim.design.nPerArm, claim.design.nPerArmPerRoute * claim.routes.length)
  assert.equal(claim.design.totalTrials, claim.design.nPerArm * claim.arms.length)
  // The metric must say what is in the denominator, not just name a ratio.
  assert.match(claim.primaryMetricDefinition, /reached the model/)
  assert.match(claim.primaryMetricDefinition, /TIMEOUT is never counted as a NO_SUBMISSION/)
  assert.match(claim.limitations, /Not run/)
})

test('the ledger-lite claim pins the exact tune content it will measure', async () => {
  const { createHash } = await import('node:crypto')
  const { readFileSync } = await import('node:fs')
  const claim = loadClaims(path.join(root, 'claims')).find(c => c.id === 'dt-v1-ledger-lite-nosub')
  const onDisk = readFileSync(path.join(root, claim.tuneFile))
  assert.equal(
    claim.tuneSha256,
    createHash('sha256').update(onDisk).digest('hex'),
    'the preregistered tune hash no longer matches tunes/ledger-lite/AGENTS.md — editing the tune invalidates the preregistration'
  )
})
