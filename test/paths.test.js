import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { findPacks, isPackDir, packLabel, routeSlug } from '../lib/paths.js'

// --- route slug ------------------------------------------------------------
test('routeSlug strips the custom: prefix and the provider suffix', () => {
  assert.equal(routeSlug('custom:hy3-free-OpenCode-Zen-free-8'), 'hy3-free')
  assert.equal(routeSlug('custom:nemotron-3-5-lightning-free-OpenCode-Zen-free-10'), 'nemotron-3-5-lightning-free')
  assert.equal(routeSlug('hy3-free'), 'hy3-free')
  assert.equal(routeSlug('deepseek-v4-flash-0731'), 'deepseek-v4-flash-0731')
})

test('routeSlug yields a filesystem-safe segment, never an empty or traversing one', () => {
  for (const id of ['GPT-5.6/Luna', '../../etc/passwd', '..', '.', '', '   ', 'custom:', null, undefined]) {
    const slug = routeSlug(id)
    assert.ok(slug.length > 0, `empty segment for ${JSON.stringify(id)}`)
    assert.ok(!slug.includes(path.sep), `separator in slug for ${JSON.stringify(id)}`)
    assert.ok(!/^\.+$/.test(slug), `traversal segment for ${JSON.stringify(id)}`)
    assert.equal(path.basename(path.join('root', slug)), slug)
  }
  assert.equal(routeSlug(''), 'unknown-route')
  assert.equal(routeSlug(null), 'unknown-route')
  assert.equal(routeSlug(undefined), 'unknown-route')
})

test('ids that differ only in characters the sanitizer rewrites get distinct routes', () => {
  // `a/b` and `a-b` both sanitize to `a-b`. Sharing one directory would either
  // refuse a legitimate second route at the collision guard or pool two arms
  // into one pack tree — both fatal to a per-route claim.
  assert.notEqual(routeSlug('moonshotai/kimi-k3'), routeSlug('moonshotai-kimi-k3'))
  assert.notEqual(routeSlug('a/b'), routeSlug('a-b'))
  assert.notEqual(routeSlug('..'), routeSlug('.'))
  // …and the disambiguator is stable across calls.
  assert.equal(routeSlug('moonshotai/kimi-k3'), routeSlug('moonshotai/kimi-k3'))
  // Ordinary route ids stay clean — no digest noise in the common case.
  for (const id of ['hy3-free', 'custom:hy3-free-OpenCode-Zen-free-8', 'deepseek-v4-flash-0731', 'gpt-5.6-luna']) {
    assert.ok(!/-[0-9a-f]{6}$/.test(routeSlug(id)), `unexpected digest suffix for ${id}`)
  }
})

test('a native trial routes to native-droid regardless of any model argument', () => {
  assert.equal(routeSlug(null, { native: true }), 'native-droid')
  assert.equal(routeSlug('custom:fake-0', { native: true }), 'native-droid')
})

// --- pack discovery --------------------------------------------------------
function tree (spec) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'droidtune-paths-'))
  for (const rel of spec) {
    const d = path.join(dir, rel)
    mkdirSync(d, { recursive: true })
    writeFileSync(path.join(d, 'results.json'), JSON.stringify({ outcome: 'VERIFIED_PASS' }))
  }
  return dir
}

test('isPackDir accepts either half of the evidence pair', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'droidtune-paths-'))
  assert.equal(isPackDir(dir), false)
  writeFileSync(path.join(dir, 'manifest.json'), '{}')
  assert.equal(isPackDir(dir), true)
})

test('findPacks discovers routed and pre-route packs in the same tree', () => {
  // The mixed case is the real one: 45 MB of existing runs/ and the committed
  // demo-pack/ predate the route segment, so a walker that assumed either depth
  // alone would silently report on a subset.
  const dir = tree([
    'hy3-free/t004-git-surgery/attempt-1',
    'hy3-free/t004-git-surgery/attempt-2',
    'nemotron-3-ultra-free/t004-git-surgery/attempt-1',
    't900-demo/attempt-1'
  ])
  const found = findPacks(dir).map(d => packLabel(dir, d))
  assert.deepEqual(found, [
    path.join('hy3-free', 't004-git-surgery', 'attempt-1'),
    path.join('hy3-free', 't004-git-surgery', 'attempt-2'),
    path.join('nemotron-3-ultra-free', 't004-git-surgery', 'attempt-1'),
    path.join('t900-demo', 'attempt-1')
  ])
})

test('the task is the pack parent at either depth, and two routes stay distinct', () => {
  const dir = tree(['hy3-free/t004-git-surgery/attempt-1', 't004-git-surgery/attempt-1'])
  const packs = findPacks(dir)
  assert.deepEqual(packs.map(d => path.basename(path.dirname(d))), ['t004-git-surgery', 't004-git-surgery'])
  assert.equal(new Set(packs).size, 2)
})

test('descent stops at a pack, so grader artifacts inside one are not packs', () => {
  const dir = tree(['hy3-free/t004-git-surgery/attempt-1'])
  const inner = path.join(dir, 'hy3-free', 't004-git-surgery', 'attempt-1', 'grader-artifacts')
  mkdirSync(inner, { recursive: true })
  writeFileSync(path.join(inner, 'results.json'), '{}')
  assert.equal(findPacks(dir).length, 1)
})

test('findPacks is depth-capped and returns nothing for a missing root', () => {
  const dir = tree(['a/b/c/d/e/f/g/t900/attempt-1'])
  assert.deepEqual(findPacks(dir), [])
  assert.deepEqual(findPacks(path.join(dir, 'nope')), [])
})

test('a symlink loop cannot hang the walk', () => {
  const dir = tree(['t900-demo/attempt-1'])
  symlinkSync(dir, path.join(dir, 'loop'))
  assert.ok(findPacks(dir).length >= 1)
})
