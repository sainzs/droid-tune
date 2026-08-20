import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const script = path.join(root, 'scripts', 'results-table.js')
const demoPack = path.join(root, 'demo-pack')
const fixturePacks = path.join(root, 'test', 'fixtures', 'audit', 'packs')

const render = (args) => execFileSync('node', [script, ...args], { encoding: 'utf8' })

// The whole point of making --audit opt-in: demo-pack/EXPECTED-TABLE.md and
// the README block are byte-compared in CI, so the default output of this
// script is a frozen artifact and the audit work must not perturb it.
test('default output still reproduces the committed demo-pack snapshot byte for byte', () => {
  const actual = render(['--runs-dir', demoPack, '--title', 'demo-pack'])
  const expected = readFileSync(path.join(demoPack, 'EXPECTED-TABLE.md'), 'utf8')
  assert.equal(actual, expected)
})

test('default output carries no audit section at all', () => {
  const out = render(['--runs-dir', fixturePacks, '--title', 'fixtures'])
  assert.doesNotMatch(out, /process audit/i)
  assert.doesNotMatch(out, /claim-without-coverage/)
})

test('--audit appends to the default output without altering a byte of it', () => {
  const plain = render(['--runs-dir', fixturePacks, '--title', 'fixtures'])
  const audited = render(['--runs-dir', fixturePacks, '--title', 'fixtures', '--audit'])
  assert.ok(audited.startsWith(plain), 'the audit section must be strictly appended')
  assert.ok(audited.length > plain.length)
})

test('--audit lists only the trials with findings, plus totals and the unauditable count', () => {
  const out = render(['--runs-dir', fixturePacks, '--title', 'fixtures', '--audit'])
  assert.match(out, /### fixtures — process audit/)
  assert.match(out, /\| `t900-demo\/attempt-1` \| NO_SUBMISSION \| 1 \| 0 \| 0 \| 0 \| 1 \|/)
  assert.doesNotMatch(out, /t901-demo\/attempt-1/, 'a clean pack should not get a row')
  assert.match(out, /\*\*1 process violation\(s\)\*\* across 2 auditable pack\(s\)/)
  assert.match(out, /1 pack\(s\) carry no `transcript\.jsonl` and are excluded from the audit/)
})

test('--window is honoured by the appended audit section', () => {
  const out = render(['--runs-dir', fixturePacks, '--title', 'fixtures', '--audit', '--window', '20'])
  assert.match(out, /\*\*0 process violation\(s\)\*\*/)
})

test('--audit over the transcript-less demo-pack says so instead of printing zeros', () => {
  const out = render(['--runs-dir', demoPack, '--title', 'demo-pack', '--audit'])
  assert.match(out, /No pack under .* carries a `transcript\.jsonl`/)
  assert.match(out, /unaudited, not clean/)
  assert.doesNotMatch(out, /\| `t004-git-surgery\/attempt-17` \|/)
})
