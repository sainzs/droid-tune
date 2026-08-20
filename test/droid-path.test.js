import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDroid } from '../lib/droid-path.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fakeDroid = path.join(root, 'fixtures', 'bin', 'fake-droid')

test('resolveDroid accepts an explicit working path', () => {
  const droid = resolveDroid(fakeDroid)
  assert.ok(droid)
  assert.equal(droid.path, fakeDroid)
  assert.match(droid.version, /0\.197\.0/)
})

test('resolveDroid returns null for an explicit non-working path (no PATH/env fallback)', () => {
  // Explicit path is authoritative — if it doesn't work, resolveDroid must
  // not silently fall through to DROID_PATH or PATH behind the caller's back.
  const droid = resolveDroid(path.join(root, 'does-not-exist-droid'))
  assert.equal(droid, null)
})

test('resolveDroid falls back to DROID_PATH env var when no explicit path is given', () => {
  const prev = process.env.DROID_PATH
  process.env.DROID_PATH = fakeDroid
  try {
    const droid = resolveDroid(undefined)
    assert.ok(droid)
    assert.equal(droid.path, fakeDroid)
  } finally {
    if (prev === undefined) delete process.env.DROID_PATH
    else process.env.DROID_PATH = prev
  }
})

test('resolveDroid returns null when nothing resolves', () => {
  const prev = process.env.DROID_PATH
  delete process.env.DROID_PATH
  try {
    const droid = resolveDroid('/definitely/not/a/real/binary/for/droidtune-tests')
    assert.equal(droid, null)
  } finally {
    if (prev !== undefined) process.env.DROID_PATH = prev
  }
})
