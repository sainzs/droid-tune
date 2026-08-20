import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import {
  TERMINAL_CATEGORIES, createWatcher, newestTranscript, renderFinding,
  renderWatchSummary, violationKey, watchFile
} from '../lib/watch.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixtures = path.join(root, 'test', 'fixtures', 'audit')
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'droidtune-watch-'))

const line = (obj) => JSON.stringify(obj) + '\n'
const start = () => line({ type: 'session_start', id: 'live' })
const assistantText = (text) => line({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text }] } })
const exec = (command) => line({ type: 'message', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Execute', input: { command } }] } })
const edit = (file) => line({ type: 'message', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: file, old_str: 'a', new_str: 'b' } }] } })

// --- incremental reporting ------------------------------------------------
test('each finding is reported exactly once as the transcript grows', () => {
  const w = createWatcher()
  let text = start() + exec('git log --oneline')

  assert.deepEqual(w.ingest(text).fresh, [], 'nothing to report yet')

  text += assistantText('The regression is fixed and all tests pass.')
  const first = w.ingest(text).fresh
  assert.equal(first.length, 1)
  assert.equal(first[0].category, 'claim-without-coverage')

  // Re-ingesting the same content must not repeat the finding.
  assert.deepEqual(w.ingest(text).fresh, [])

  // …nor must appending unrelated content.
  text += exec('git status --short')
  assert.deepEqual(w.ingest(text).fresh, [])
})

test('a stall reports once, not again on every further repeat', () => {
  const w = createWatcher()
  let text = start() + exec('sh tests/test.sh') + exec('git rebase -i HEAD~2') + exec('git rebase -i HEAD~2')
  assert.deepEqual(w.ingest(text).fresh, [], 'two repeats is not yet a stall')

  text += exec('git rebase -i HEAD~2')
  const fired = w.ingest(text).fresh
  assert.equal(fired.length, 1)
  assert.equal(fired[0].category, 'stall')
  assert.equal(fired[0].count, 3)

  // The fourth and fifth identical run change the violation's count, so a
  // naive key would report the same stall again each time.
  text += exec('git rebase -i HEAD~2')
  assert.deepEqual(w.ingest(text).fresh, [])
  text += exec('git rebase -i HEAD~2')
  assert.deepEqual(w.ingest(text).fresh, [])
})

test('a second, different stalled command is a separate finding', () => {
  const w = createWatcher()
  const three = (c) => exec(c) + exec(c) + exec(c)
  w.ingest(start() + exec('sh tests/test.sh') + three('git rebase -i HEAD~2'))
  const fresh = w.ingest(start() + exec('sh tests/test.sh') + three('git rebase -i HEAD~2') + three('git cherry-pick abc')).fresh
  assert.equal(fresh.length, 1)
  assert.match(fresh[0].command, /cherry-pick/)
})

// The reason this module exists rather than calling auditTranscript in a loop.
test('no-test-finish is withheld while the session is live and released at the end', () => {
  const w = createWatcher()
  const text = start() + edit('/w/calc.py') + exec('git commit -am wip')

  const streamed = w.ingest(text)
  assert.equal(streamed.result.counts['no-test-finish'], 1, 'the audit does see it')
  assert.deepEqual(streamed.fresh, [], 'but a live watch must not report it yet')

  const final = w.finalize()
  assert.equal(final.fresh.length, 1)
  assert.equal(final.fresh[0].category, 'no-test-finish')

  assert.deepEqual(w.finalize().fresh, [], 'and only once')
})

test('a session that runs its check late never gets a spurious no-test-finish', () => {
  const w = createWatcher()
  // Mid-session the audit genuinely sees no-test-finish…
  const mid = w.ingest(start() + edit('/w/calc.py'))
  assert.equal(mid.result.counts['no-test-finish'], 1)
  assert.deepEqual(mid.fresh, [])

  // …and then the agent runs the check. Because nothing was emitted early,
  // there is nothing to retract.
  const late = w.ingest(start() + edit('/w/calc.py') + exec('sh tests/test.sh'))
  assert.equal(late.result.counts['no-test-finish'], 0)

  assert.deepEqual(w.finalize().fresh, [])
})

test('finalize before any ingest is a no-op rather than a crash', () => {
  assert.deepEqual(createWatcher().finalize(), { fresh: [], result: null })
})

test('terminal categories are exactly the ones that only make sense at the end', () => {
  assert.deepEqual([...TERMINAL_CATEGORIES], ['no-test-finish'])
})

test('violation keys are stable under append and distinct across findings', () => {
  assert.equal(violationKey({ category: 'stall', command: 'git status', count: 3 }),
    violationKey({ category: 'stall', command: 'git status', count: 9 }))
  assert.notEqual(violationKey({ category: 'stall', command: 'a' }), violationKey({ category: 'stall', command: 'b' }))
  assert.equal(violationKey({ category: 'no-test-finish' }), 'no-test-finish')
  assert.notEqual(
    violationKey({ category: 'claim-without-coverage', at: 3, detail: 'x' }),
    violationKey({ category: 'claim-without-coverage', at: 9, detail: 'x' })
  )
})

// --- watching a real growing file -----------------------------------------
test('watchFile reports findings as a transcript is appended to on disk', async () => {
  const dir = tmp()
  const file = path.join(dir, 'transcript.jsonl')
  const seen = []
  let controller
  try {
    writeFileSync(file, start() + exec('git log --oneline'))
    controller = watchFile(file, { intervalMs: 15, onFindings: (fresh) => seen.push(...fresh) })
    await sleep(60)
    assert.deepEqual(seen, [], 'clean so far')

    appendFileSync(file, assistantText('Done. The task is complete.'))
    for (let i = 0; i < 60 && seen.length === 0; i++) await sleep(15)
    assert.equal(seen.length, 1, 'the claim should have surfaced')
    assert.equal(seen[0].category, 'claim-without-coverage')

    appendFileSync(file, exec('git rebase -i HEAD~2') + exec('git rebase -i HEAD~2') + exec('git rebase -i HEAD~2'))
    for (let i = 0; i < 60 && seen.length === 1; i++) await sleep(15)
    assert.equal(seen.length, 2)
    assert.equal(seen[1].category, 'stall')

    const final = controller.stop()
    assert.equal(final.fresh.length, 1)
    assert.equal(final.fresh[0].category, 'no-test-finish', 'released only at the end')
  } finally {
    if (controller) controller.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('watchFile does an immediate first pass instead of waiting a full interval', () => {
  const dir = tmp()
  try {
    const file = path.join(dir, 'transcript.jsonl')
    writeFileSync(file, readFileSync(path.join(fixtures, 'claim-without-coverage.jsonl'), 'utf8'))
    const seen = []
    const c = watchFile(file, { intervalMs: 60000, onFindings: (f) => seen.push(...f) })
    // No await: the constructor polls synchronously once.
    assert.equal(seen.length, 1)
    c.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('watchFile tolerates a file that disappears mid-watch', async () => {
  const dir = tmp()
  const file = path.join(dir, 'transcript.jsonl')
  writeFileSync(file, start() + exec('sh tests/test.sh'))
  const c = watchFile(file, { intervalMs: 10 })
  try {
    rmSync(file)
    await sleep(50)
    assert.doesNotThrow(() => c.poll())
  } finally {
    c.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a poll that finds no growth does not re-report anything', async () => {
  const dir = tmp()
  const file = path.join(dir, 'transcript.jsonl')
  writeFileSync(file, readFileSync(path.join(fixtures, 'stall.jsonl'), 'utf8'))
  const seen = []
  let idle = 0
  const c = watchFile(file, { intervalMs: 10, onFindings: (f) => seen.push(...f), onIdle: () => { idle++ } })
  try {
    await sleep(80)
    assert.equal(seen.length, 1, 'the stall, once')
    assert.ok(idle > 0, 'later polls saw no growth')
  } finally {
    c.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- session discovery ----------------------------------------------------
test('newestTranscript picks the most recently written transcript', async () => {
  const dir = tmp()
  try {
    const proj = path.join(dir, '-tmp-project')
    mkdirSync(proj, { recursive: true })
    writeFileSync(path.join(proj, 'old.jsonl'), start())
    writeFileSync(path.join(proj, 'old.settings.json'), '{}')
    await sleep(20)
    writeFileSync(path.join(proj, 'new.jsonl'), start())
    writeFileSync(path.join(proj, 'new.settings.json'), '{}')

    const newest = await newestTranscript(dir)
    assert.equal(newest.id, 'new')
    assert.equal(newest.path, path.join(proj, 'new.jsonl'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// A live droid session has written its .jsonl but often not its
// .settings.json, which lib/sessions.js flags as an orphan (DT005). That is
// the normal shape of the thing watch is looking for.
test('a live session with no settings file yet is still discoverable', async () => {
  const dir = tmp()
  try {
    const proj = path.join(dir, '-tmp-project')
    mkdirSync(proj, { recursive: true })
    writeFileSync(path.join(proj, 'in-progress.jsonl'), start() + exec('ls'))
    const newest = await newestTranscript(dir)
    assert.equal(newest.id, 'in-progress')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an empty or missing sessions dir yields null rather than throwing', async () => {
  assert.equal(await newestTranscript(path.join(root, 'no-such-sessions-dir')), null)
  const dir = tmp()
  try {
    assert.equal(await newestTranscript(dir), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- rendering ------------------------------------------------------------
test('a rendered finding names the category, the location, and the evidence', () => {
  const out = renderFinding({
    category: 'claim-without-coverage', eventIndex: 23, at: 23,
    detail: 'no check command in the 8 tool event(s) before this claim',
    claim: 'All tests pass.'
  })
  assert.match(out, /\[claim-without-coverage\] event 23/)
  assert.match(out, /claim: "All tests pass\."/)
})

test('the summary reports session shape even when nothing was found', () => {
  const w = createWatcher()
  const { result } = w.ingest(readFileSync(path.join(fixtures, 'clean.jsonl'), 'utf8'))
  const out = renderWatchSummary(result, { filePath: '/x/clean.jsonl' })
  assert.match(out, /clean\.jsonl/)
  assert.match(out, /no violations/)
  assert.match(out, /1 check command/)
})

test('the summary says so when nothing was ever read', () => {
  assert.match(renderWatchSummary(null, { filePath: '/x/y.jsonl' }), /no transcript content/)
})
