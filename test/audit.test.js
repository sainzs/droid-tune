import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CATEGORIES, DEFAULTS, auditPack, auditPath, auditRuns, auditTranscript,
  claimSentences, isCheckCommand, parseTranscript, renderAudit
} from '../lib/audit.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixtures = path.join(root, 'test', 'fixtures', 'audit')
const load = (name) => readFileSync(path.join(fixtures, `${name}.jsonl`), 'utf8')
const audit = (name, opts) => auditTranscript(load(name), opts)

// --- both-ways detector tests --------------------------------------------
// Every detector must (a) fire on a planted transcript and (b) stay silent on
// a clean one. The planted fixtures are also asserted to fire ONLY their own
// category — a detector that bleeds into its neighbours is not a measurement.
const PLANTED = {
  'claim-without-coverage': 'claim-without-coverage',
  stall: 'stall',
  're-derivation': 're-derivation',
  'no-test-finish': 'no-test-finish'
}

for (const [category, fixture] of Object.entries(PLANTED)) {
  test(`${category} fires on the planted fixture and on nothing else`, () => {
    const r = audit(fixture)
    assert.ok(r.counts[category] >= 1, `${category} did not fire on ${fixture}.jsonl`)
    for (const other of CATEGORIES) {
      if (other === category) continue
      assert.equal(r.counts[other], 0, `${fixture}.jsonl also tripped ${other}`)
    }
    assert.ok(r.violations.some(v => v.category === category && typeof v.detail === 'string'))
  })

  test(`${category} is silent on the clean transcript`, () => {
    assert.equal(audit('clean').counts[category], 0)
  })
}

test('the clean transcript produces no violations at all', () => {
  const r = audit('clean')
  assert.equal(r.total, 0, JSON.stringify(r.violations))
  assert.ok(r.stats.checkCommands >= 1)
  assert.equal(r.stats.parseErrors, 0)
})

// --- what each planted fixture actually reports ---------------------------
test('claim-without-coverage names the offending sentence and the empty window', () => {
  const v = audit('claim-without-coverage').violations.find(v => v.category === 'claim-without-coverage')
  assert.match(v.claim, /all tests pass/i)
  assert.equal(v.toolEventsBefore, 11)
  assert.match(v.detail, /no check command in the 8 tool event\(s\)/)
})

test('stall reports the repeat count and the normalized command', () => {
  const v = audit('stall').violations.find(v => v.category === 'stall')
  assert.equal(v.count, 3)
  assert.match(v.command, /git rebase -i HEAD~2/)
})

test('re-derivation names the file and the gap', () => {
  const v = audit('re-derivation').violations.find(v => v.category === 're-derivation')
  assert.equal(v.file, 'core.py')
  assert.match(v.detail, /edited again 1 tool event\(s\) later/)
})

test('no-test-finish reports how much work went unchecked', () => {
  const r = audit('no-test-finish')
  const v = r.violations.find(v => v.category === 'no-test-finish')
  assert.equal(v.scope, 'session')
  assert.equal(r.stats.checkCommands, 0)
  assert.match(v.detail, /zero check commands/)
})

// --- conservatism guarantees ---------------------------------------------
test('back-to-back edits of one file are a multi-hunk change, not a re-derivation', () => {
  assert.equal(audit('adjacent-edits').counts['re-derivation'], 0)
  assert.equal(audit('adjacent-edits').total, 0)
})

test('a completion claim inside a thinking block is not a claim to the operator', () => {
  const r = audit('thinking-claim')
  assert.equal(r.counts['claim-without-coverage'], 0)
  assert.equal(r.total, 0)
})

test('a claim before any tool call is left to no-test-finish, not double-counted', () => {
  const jsonl = [
    JSON.stringify({ type: 'session_start', id: 's' }),
    JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Done. Everything works correctly.' }] } })
  ].join('\n')
  const r = auditTranscript(jsonl)
  assert.equal(r.counts['claim-without-coverage'], 0)
  assert.equal(r.counts['no-test-finish'], 0, 'no tool events means there was no work to check')
  assert.equal(r.total, 0)
})

test('a session with zero tool calls is never a no-test-finish', () => {
  const jsonl = JSON.stringify({ type: 'session_start', id: 's' })
  assert.equal(auditTranscript(jsonl).total, 0)
})

test('unparseable transcript lines are counted, not silently dropped or guessed at', () => {
  const r = audit('malformed')
  assert.equal(r.stats.parseErrors, 2)
  assert.equal(r.stats.checkCommands, 1)
  assert.equal(r.total, 0)
})

// --- claim recognition ----------------------------------------------------
test('claim recognition fires on completion assertions', () => {
  for (const s of [
    'All tests pass.',
    'The fix is verified.',
    'Done.',
    'It works correctly.',
    'The task is complete.',
    'The bug is now fixed.'
  ]) assert.equal(claimSentences(s).length, 1, `missed: ${s}`)
})

test('claim recognition stays silent on intent, hedging, negation, and failure reports', () => {
  for (const s of [
    "Let me verify that the tests pass.",
    "I'll check whether it works correctly next.",
    'The tests do not pass yet.',
    'This is not fixed.',
    'Two tests are still failing.',
    'Should I mark the task complete?',
    'I need to verify this before saying it works correctly.'
  ]) assert.deepEqual(claimSentences(s), [], `false positive on: ${s}`)
})

// --- check-command recognition -------------------------------------------
test('check recognition covers the common runners, linters, and type checkers', () => {
  for (const c of [
    'npm test', 'pnpm run check', 'python3 -m pytest -q', 'pytest tests/',
    'go test ./...', 'cargo test', 'make check', 'node --test test/',
    'npx vitest run', 'sh tests/test.sh', './run_tests.sh', 'tsc --noEmit',
    'shellcheck greet.sh', 'ruff check .'
  ]) assert.equal(isCheckCommand(c), true, `not recognized as a check: ${c}`)
})

test('check recognition does not treat inspection or version control as verification', () => {
  for (const c of [
    'git log --oneline', 'git status --short', 'ls -la', 'cat calc.sh',
    'git add -A && git commit -m wip', 'git rebase -i HEAD~2', 'mkdir -p build'
  ]) assert.equal(isCheckCommand(c), false, `wrongly counted as a check: ${c}`)
})

test('running a workspace artifact through an interpreter counts as a behavioral check', () => {
  const artifacts = new Set(['calc.sh', 'slugify.py'])
  assert.equal(isCheckCommand('cd /w && sh calc.sh add 2 3', artifacts), true)
  assert.equal(isCheckCommand('python3 -c "from slugify import slugify; print(slugify(\'a b\'))"', artifacts), true)
  // Without the artifact having been seen, the same command is not evidence.
  assert.equal(isCheckCommand('cd /w && sh calc.sh add 2 3', new Set()), false)
})

test('a file first seen only in a shell command still counts as an artifact later', () => {
  // Models that use `cat X` instead of the Read tool used to defeat artifact
  // tracking, which manufactured false no-test-finish findings.
  const jsonl = [
    JSON.stringify({ type: 'session_start', id: 's' }),
    JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Execute', input: { command: 'cat calc.sh' } }] } }),
    JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Execute', input: { command: 'sh calc.sh add 2 3' } }] } })
  ].join('\n')
  const r = auditTranscript(jsonl)
  assert.equal(r.stats.checkCommands, 1)
  assert.equal(r.counts['no-test-finish'], 0)
})

// --- options --------------------------------------------------------------
test('a wider coverage window can absorb a claim the default window flags', () => {
  assert.equal(audit('claim-without-coverage').counts['claim-without-coverage'], 1)
  assert.equal(audit('claim-without-coverage', { coverageWindow: 20 }).counts['claim-without-coverage'], 0)
  assert.equal(DEFAULTS.coverageWindow, 8)
})

test('the stall threshold is configurable and reported back', () => {
  assert.equal(audit('stall', { stallThreshold: 4 }).counts.stall, 0)
  assert.equal(audit('stall', { stallThreshold: 2 }).counts.stall, 1)
  assert.equal(audit('stall').options.stallThreshold, DEFAULTS.stallThreshold)
})

// --- transcript parsing ---------------------------------------------------
test('parseTranscript flattens messages into an ordered typed stream', () => {
  const { events, messages, sessionId } = parseTranscript(load('clean'))
  assert.equal(sessionId, 'fixture-clean')
  assert.equal(messages, 10)
  assert.deepEqual(events.map(e => e.i), events.map((_, i) => i))
  const tools = events.filter(e => e.kind === 'tool_use')
  assert.deepEqual(tools.map(t => t.name), ['Read', 'Create', 'Execute', 'Execute'])
  assert.equal(tools[0].filePath, '/w/README.md')
  assert.equal(tools[2].command, 'cd /w && sh tests/test.sh')
})

test('a tool_use with a missing or malformed input object does not throw', () => {
  const jsonl = [
    JSON.stringify({ type: 'session_start', id: 's' }),
    JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Create' }] } }),
    JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: null }] } })
  ].join('\n')
  const r = auditTranscript(jsonl)
  assert.equal(r.stats.toolEvents, 2)
  assert.equal(r.counts['re-derivation'], 0)
})

// --- pack and runs traversal ---------------------------------------------
test('auditPack reads a pack transcript and carries its outcome and model', () => {
  const r = auditPack(path.join(fixtures, 'packs', 't900-demo', 'attempt-1'))
  assert.equal(r.auditable, true)
  assert.equal(r.outcome, 'NO_SUBMISSION')
  assert.equal(r.model, 'hy3-free')
  assert.equal(r.trialId, 'fixture/t900-demo/attempt-1')
  assert.equal(r.counts['claim-without-coverage'], 1)
})

test('a pack whose manifest lists a transcript it does not contain is unauditable, not clean', () => {
  const r = auditPack(path.join(fixtures, 'packs', 't900-demo', 'attempt-2'))
  assert.equal(r.auditable, false)
  assert.match(r.reason, /listed in the manifest but absent/)
  assert.equal(r.total, 0)
})

test('auditRuns aggregates per trial and excludes unauditable packs from the totals', () => {
  const r = auditRuns(path.join(fixtures, 'packs'))
  assert.equal(r.packCount, 3)
  assert.equal(r.auditablePacks, 2)
  assert.equal(r.unauditablePacks, 1)
  assert.equal(r.totals['claim-without-coverage'], 1)
  assert.equal(r.total, 1)
  assert.deepEqual(r.packs.map(p => `${p.task}/${p.attempt}`), [
    't900-demo/attempt-1', 't900-demo/attempt-2', 't901-demo/attempt-1'
  ])
})

test('auditPath dispatches on directory shape', () => {
  assert.equal(auditPath(path.join(fixtures, 'packs')).mode, 'runs')
  assert.equal(auditPath(path.join(fixtures, 'packs', 't901-demo', 'attempt-1')).mode, 'pack')
  assert.throws(() => auditPath(path.join(fixtures, 'nope')), /not a directory/)
})

// --- rendering ------------------------------------------------------------
test('the single-pack report names every category and quotes the claim', () => {
  const out = renderAudit(auditPath(path.join(fixtures, 'packs', 't900-demo', 'attempt-1')))
  for (const c of CATEGORIES) assert.match(out, new RegExp(c))
  assert.match(out, /NO_SUBMISSION/)
  assert.match(out, /claim: "The regression is fixed and all tests pass\./)
})

test('the aggregate report prints a row per trial, a TOTAL, and an exclusion note', () => {
  const out = renderAudit(auditRuns(path.join(fixtures, 'packs')))
  assert.match(out, /t900-demo\/attempt-1/)
  assert.match(out, /\(no transcript — not auditable\)/)
  assert.match(out, /^TOTAL \(2\/3 auditable\)/m)
  assert.match(out, /excluded from the totals rather than counted as clean/)
})

// --- attribution ----------------------------------------------------------
test('lib/audit.js carries the J-Space Apache-2.0 attribution for the ship-check concept', () => {
  const src = readFileSync(path.join(root, 'lib', 'audit.js'), 'utf8')
  assert.match(src, /J-Space Cognition Suite V3\.6/)
  assert.match(src, /Apache License 2\.0/)
  assert.match(src, /github\.com\/Tiger3807861189\/J-Space-Cognition-Suite-V3\.6/)
})

test('several claim sentences in one text block count as one act of claiming', () => {
  const jsonl = [
    JSON.stringify({ type: 'session_start', id: 's' }),
    JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Execute', input: { command: 'git log --oneline' } }] } }),
    JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.\nAll tests pass.\nThe task is complete.' }] } })
  ].join('\n')
  const r = auditTranscript(jsonl)
  assert.equal(r.counts['claim-without-coverage'], 1)
  assert.equal(r.violations.find(v => v.category === 'claim-without-coverage').claimCount, 3)
})
