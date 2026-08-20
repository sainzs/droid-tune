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
