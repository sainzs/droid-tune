import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkCtrf, checkReward, hashTree, VerifierError } from '../lib/verify.js'

function tmp () {
  return mkdtempSync(path.join(os.tmpdir(), 'droidtune-verify-'))
}

function verifierThrows (fn, reason) {
  assert.throws(fn, (e) => e instanceof VerifierError && e.reason === reason, `expected VerifierError "${reason}"`)
}

test('hashTree is deterministic, content-sensitive, and creation-order-independent', () => {
  const base = tmp()
  try {
    const a = path.join(base, 'a')
    const b = path.join(base, 'b')
    mkdirSync(path.join(a, 'sub'), { recursive: true })
    mkdirSync(path.join(b, 'sub'), { recursive: true })
    // Write identical trees, but create the files in a different order.
    writeFileSync(path.join(a, 'z.txt'), 'zeta\n')
    writeFileSync(path.join(a, 'sub', 'm.txt'), 'mid\n')
    writeFileSync(path.join(a, 'a.txt'), 'alpha\n')
    writeFileSync(path.join(b, 'a.txt'), 'alpha\n')
    writeFileSync(path.join(b, 'z.txt'), 'zeta\n')
    writeFileSync(path.join(b, 'sub', 'm.txt'), 'mid\n')
    const ha1 = hashTree(a)
    const ha2 = hashTree(a)
    const hb = hashTree(b)
    assert.equal(ha1, ha2, 'hashTree must be deterministic')
    assert.equal(ha1, hb, 'hashTree must be independent of file creation order')
    writeFileSync(path.join(a, 'a.txt'), 'alpha CHANGED\n')
    assert.notEqual(hashTree(a), ha1, 'hashTree must change when a file changes')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('checkReward throws on missing, invalid, and mismatched reward.json', () => {
  const base = tmp()
  try {
    verifierThrows(() => checkReward(base, 0), 'reward.json missing')

    writeFileSync(path.join(base, 'reward.json'), '{not json')
    verifierThrows(() => checkReward(base, 0), 'reward.json invalid JSON')

    writeFileSync(path.join(base, 'reward.json'), '{"reward":1}\n')
    verifierThrows(() => checkReward(base, 1), 'reward/exit mismatch') // claims pass, tests failed

    writeFileSync(path.join(base, 'reward.json'), '{"reward":0}\n')
    verifierThrows(() => checkReward(base, 0), 'reward/exit mismatch') // claims fail, tests passed
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('checkReward returns the parsed object on agreement (pass and fail)', () => {
  const base = tmp()
  try {
    writeFileSync(path.join(base, 'reward.json'), '{"reward":1}\n')
    assert.deepEqual(checkReward(base, 0), { reward: 1 })

    writeFileSync(path.join(base, 'reward.json'), '{"reward":0}\n')
    assert.deepEqual(checkReward(base, 1), { reward: 0 })
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('checkCtrf throws on missing, invalid, and summary-less ctrf.json', () => {
  const base = tmp()
  try {
    verifierThrows(() => checkCtrf(base), 'ctrf.json missing')

    writeFileSync(path.join(base, 'ctrf.json'), '{bad')
    verifierThrows(() => checkCtrf(base), 'ctrf.json invalid JSON')

    writeFileSync(path.join(base, 'ctrf.json'), '{"results":{}}\n')
    verifierThrows(() => checkCtrf(base), 'ctrf.json missing results.summary.tests')

    writeFileSync(path.join(base, 'ctrf.json'), '{"results":{"summary":{"tests":"one"}}}\n')
    verifierThrows(() => checkCtrf(base), 'ctrf.json missing results.summary.tests')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('checkCtrf returns the parsed object when valid', () => {
  const base = tmp()
  try {
    const doc = { results: { tool: { name: 't' }, summary: { tests: 1 } } }
    writeFileSync(path.join(base, 'ctrf.json'), JSON.stringify(doc))
    assert.deepEqual(checkCtrf(base), doc)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
