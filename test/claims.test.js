import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadClaims, validateClaim } from '../lib/claims.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('committed claim registry contains valid preregistrations, not results', () => {
  const claims = loadClaims(path.join(root, 'claims'))
  assert.ok(claims.length > 0)
  assert.ok(claims.every(claim => claim.status === 'preregistered'))
  assert.ok(claims.every(claim => !('result' in claim)))
})

test('claim validation rejects result laundering into a preregistration', () => {
  const valid = loadClaims(path.join(root, 'claims'))[0]
  assert.throws(() => validateClaim({ ...valid, result: { pass: true } }), /cannot contain results/)
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
