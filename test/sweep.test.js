import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  buildSchedule,
  loadSweepClaim,
  renderSchedule,
  renderSweepSummary,
  resolveRoute,
  runSweep,
  REPLACEMENT_CAP_PER_ROUTE
} from '../lib/sweep.js'
import { routeSlug } from '../lib/paths.js'
import { sha256String } from '../lib/pack.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const bin = path.join(root, 'bin', 'droidtune.js')

function run (args, opts = {}) {
  try {
    const stdout = execFileSync('node', [bin, ...args], { encoding: 'utf8', ...opts })
    return { code: 0, stdout }
  } catch (err) {
    return { code: err.status, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }
  }
}

// A self-contained claim fixture: temp tune file (hash-pinned like a real
// claim), temp settings.json with two customModels, one task dir. Small n
// keeps the schedules tiny; the claim shape matches claims/dt-v1-*.json.
function makeFixture (t, overrides = {}) {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'droidtune-sweep-'))
  t.after(() => rmSync(temp, { recursive: true, force: true }))
  const tuneFile = path.join(temp, 'tune', 'AGENTS.md')
  mkdirSync(path.dirname(tuneFile), { recursive: true })
  writeFileSync(tuneFile, '# test tune\n')
  const taskDir = path.join(temp, 'tasks', 't-x')
  mkdirSync(taskDir, { recursive: true })
  const configPath = path.join(temp, 'settings.json')
  writeFileSync(configPath, JSON.stringify({
    customModels: [
      { id: 'route-a', model: 'route-a-model', displayName: 'Route A' },
      { id: 'route-b', model: 'route-b-model', displayName: 'Route B' }
    ]
  }))
  const claim = {
    id: 'dt-test-sweep',
    status: 'preregistered',
    population: ['t-x'],
    arms: ['no-tune', 'ledger-lite'],
    tuneFile,
    tuneSha256: sha256String(readFileSync(tuneFile)),
    routes: ['route-a', 'route-b'],
    design: { nPerArmPerRoute: 2, autoLevel: 'high', timeoutMs: 300000 },
    ...overrides
  }
  const claimPath = path.join(temp, 'claim.json')
  writeFileSync(claimPath, JSON.stringify(claim))
  const runsDir = path.join(temp, 'runs')
  return { temp, tuneFile, taskDir, configPath, claimPath, runsDir, claim }
}

// Stands in for runTrial: records the call, writes a manifest+results pair
// exactly where the runner would (so resume/pack-existence logic is exercised
// for real), and returns the outcome the scenario decides. No droid involved.
// The sweep verifies an adopted pack's provenance against the claim before
// trusting it, so every fake pack here carries the manifest fields the runner
// would write: provenance.modelRequested, and provenance.tune (pinned sha256)
// on the tuned arm / null on the control arm.
function packProvenance (fixture, route, arm, overrides = {}) {
  const control = arm === fixture.claim.arms[0]
  const tuneBuf = control ? null : readFileSync(fixture.tuneFile)
  return {
    modelRequested: route,
    tune: tuneBuf
      ? { name: arm, file: fixture.tuneFile, sha256: sha256String(tuneBuf), bytes: tuneBuf.length }
      : null,
    ...overrides
  }
}

function fakeRunOne (fixture, calls, decide) {
  return async (o) => {
    calls.push(o)
    const outcome = decide(o, calls.length)
    const dir = path.join(o.runsDir, o.tuneName, routeSlug(o.model), path.basename(o.taskDir), `attempt-${o.attempt}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
      provenance: packProvenance(fixture, o.model, o.tuneName)
    }))
    writeFileSync(path.join(dir, 'results.json'), JSON.stringify({ outcome }))
    return { outcome, manifestPath: path.join(dir, 'manifest.json') }
  }
}

function writePack (fixture, route, arm, attempt, outcome, provenanceOverrides = {}) {
  const dir = path.join(fixture.runsDir, arm, routeSlug(route), 't-x', `attempt-${attempt}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    provenance: packProvenance(fixture, route, arm, provenanceOverrides)
  }))
  writeFileSync(path.join(dir, 'results.json'), JSON.stringify({ outcome }))
}

function readLog (fixture) {
  const logPath = path.join(fixture.runsDir, 'dt-test-sweep', 'sweep-log.jsonl')
  if (!existsSync(logPath)) return []
  return readFileSync(logPath, 'utf8').trim().split('\n').map(JSON.parse)
}

// For dry runs and tests that must fail before any trial would execute.
async function unreachableRunOne () {
  throw new Error('runOne must not be called')
}

test('loadSweepClaim refuses a claim whose status is not preregistered', async (t) => {
  const fixture = makeFixture(t, { status: 'analysed' })
  assert.throws(() => loadSweepClaim(fixture.claimPath), /status "analysed"/)
})

test('loadSweepClaim refuses a tune whose sha256 drifted after preregistration', async (t) => {
  const fixture = makeFixture(t, { tuneSha256: 'deadbeef'.repeat(8) })
  assert.throws(() => loadSweepClaim(fixture.claimPath), /pins tuneSha256/)
})

test('loadSweepClaim validates the design fields it executes', async (t) => {
  assert.throws(() => loadSweepClaim(makeFixture(t, { design: {} }).claimPath), /nPerArmPerRoute/)
  assert.throws(
    () => loadSweepClaim(makeFixture(t, { design: { nPerArmPerRoute: 2, autoLevel: 'max', timeoutMs: 1 } }).claimPath),
    /autoLevel/)
  assert.throws(() => loadSweepClaim(makeFixture(t, { routes: [] }).claimPath), /routes/)
  assert.throws(() => loadSweepClaim(makeFixture(t, { population: ['a', 'b'] }).claimPath), /exactly one task/)
})

test('loadSweepClaim accepts a well-formed preregistered claim', async (t) => {
  const fixture = makeFixture(t)
  const claim = loadSweepClaim(fixture.claimPath)
  assert.equal(claim.id, 'dt-test-sweep')
  assert.equal(claim.tuneFileResolved, fixture.tuneFile)
})

test('resolveRoute matches exact ids, unique substrings, and refuses ambiguity', async (t) => {
  const fixture = makeFixture(t)
  assert.equal(resolveRoute('route-a', fixture.configPath), 'route-a')
  assert.equal(resolveRoute('route-a-model', fixture.configPath), 'route-a')
  assert.equal(resolveRoute('a-model', fixture.configPath), 'route-a')
  assert.throws(() => resolveRoute('route-', fixture.configPath), /ambiguous/)
  assert.throws(() => resolveRoute('zzz', fixture.configPath), /does not resolve/)
})

test('buildSchedule alternates arms within a route and tunes only the non-control arm', async (t) => {
  const fixture = makeFixture(t)
  const claim = loadSweepClaim(fixture.claimPath)
  const schedule = buildSchedule(claim)
  assert.equal(schedule.length, 8)
  assert.deepEqual(
    schedule.filter(s => s.route === 'route-a').map(s => [s.arm, s.attempt]),
    [['no-tune', 1], ['ledger-lite', 1], ['no-tune', 2], ['ledger-lite', 2]])
  assert.deepEqual(
    schedule.filter(s => s.route === 'route-b').map(s => [s.arm, s.attempt]),
    [['no-tune', 1], ['ledger-lite', 1], ['no-tune', 2], ['ledger-lite', 2]])
  assert.ok(schedule.filter(s => s.arm === 'no-tune').every(s => s.tuneFile === null))
  assert.ok(schedule.filter(s => s.arm === 'ledger-lite').every(s => s.tuneFile === fixture.tuneFile))
})

test('dry run spawns nothing, writes nothing, and reports the full schedule', async (t) => {
  const fixture = makeFixture(t)
  const calls = []
  const result = await runSweep({
    claimPath: fixture.claimPath,
    runsDir: fixture.runsDir,
    configPath: fixture.configPath,
    taskDir: fixture.taskDir,
    runOne: async () => { throw new Error('a dry run must never execute a trial') }
  })
  assert.equal(result.live, false)
  assert.equal(result.executed, 0)
  assert.equal(result.slots.length, 8)
  assert.ok(result.slots.every(s => s.status === 'pending'))
  assert.equal(calls.length, 0)
  assert.equal(existsSync(result.logPath), false)
  const table = renderSchedule(result)
  assert.match(table, /DRY RUN/)
  assert.match(table, /route-a\s+no-tune\s+1\s+pending/)
})

test('dry run annotates slots whose packs already exist as done', async (t) => {
  const fixture = makeFixture(t)
  writePack(fixture, 'route-a', 'no-tune', 1, 'VERIFIED_PASS')
  const result = await runSweep({
    claimPath: fixture.claimPath,
    runsDir: fixture.runsDir,
    configPath: fixture.configPath,
    taskDir: fixture.taskDir,
    runOne: async () => { throw new Error('unreachable') }
  })
  const done = result.slots.filter(s => s.status === 'done')
  assert.equal(done.length, 1)
  assert.equal(done[0].outcome, 'VERIFIED_PASS')
  assert.match(renderSchedule(result), /done — VERIFIED_PASS/)
})

test('live run executes the schedule in order and appends one log line per trial', async (t) => {
  const fixture = makeFixture(t)
  const calls = []
  const result = await runSweep({
    claimPath: fixture.claimPath,
    runsDir: fixture.runsDir,
    configPath: fixture.configPath,
    taskDir: fixture.taskDir,
    live: true,
    runOne: fakeRunOne(fixture, calls, () => 'VERIFIED_PASS')
  })
  assert.equal(result.executed, 8)
  assert.equal(calls.length, 8)
  assert.deepEqual(
    calls.map(c => [c.model, c.tuneName, c.attempt]),
    [
      ['route-a', 'no-tune', 1], ['route-a', 'ledger-lite', 1],
      ['route-a', 'no-tune', 2], ['route-a', 'ledger-lite', 2],
      ['route-b', 'no-tune', 1], ['route-b', 'ledger-lite', 1],
      ['route-b', 'no-tune', 2], ['route-b', 'ledger-lite', 2]
    ])
  assert.ok(calls.every(c => c.autoLevel === 'high' && c.timeoutMs === 300000))
  assert.ok(calls.filter(c => c.tuneName === 'no-tune').every(c => c.tuneFile === null))
  assert.ok(calls.filter(c => c.tuneName === 'ledger-lite').every(c => c.tuneFile === fixture.tuneFile))
  const log = readLog(fixture)
  assert.equal(log.length, 8)
  assert.ok(log.every(l => l.outcome === 'VERIFIED_PASS' && l.replacement === false && l.packPath))
  assert.equal(result.droppedRoutes.length, 0)
  const routeA = result.summary.routes.find(r => r.route === 'route-a')
  assert.deepEqual(routeA.arms.find(a => a.arm === 'no-tune').outcomes, { VERIFIED_PASS: 2 })
  assert.match(renderSweepSummary(result), /VERIFIED_PASS×2/)
})

test('live run skips slots whose packs already exist (resume by pack existence)', async (t) => {
  const fixture = makeFixture(t)
  writePack(fixture, 'route-a', 'no-tune', 1, 'VERIFIED_PASS')
  const calls = []
  const result = await runSweep({
    claimPath: fixture.claimPath,
    runsDir: fixture.runsDir,
    configPath: fixture.configPath,
    taskDir: fixture.taskDir,
    live: true,
    runOne: fakeRunOne(fixture, calls, () => 'VERIFIED_PASS')
  })
  assert.equal(result.executed, 7)
  assert.ok(!calls.some(c => c.model === 'route-a' && c.tuneName === 'no-tune' && c.attempt === 1))
  // The pre-existing pack still counts in the summary from its on-disk outcome.
  const arm = result.summary.routes.find(r => r.route === 'route-a').arms.find(a => a.arm === 'no-tune')
  assert.deepEqual(arm.outcomes, { VERIFIED_PASS: 2 })
})

test('a never-reached-model outcome is replaced at the same arm and route', async (t) => {
  const fixture = makeFixture(t)
  const calls = []
  const result = await runSweep({
    claimPath: fixture.claimPath,
    runsDir: fixture.runsDir,
    configPath: fixture.configPath,
    taskDir: fixture.taskDir,
    live: true,
    runOne: fakeRunOne(fixture, calls, (o) =>
      o.model === 'route-a' && o.tuneName === 'ledger-lite' && o.attempt === 1 ? 'PROVIDER_ERROR' : 'VERIFIED_PASS')
  })
  assert.equal(result.executed, 9)
  const replacement = calls.find(c => c.model === 'route-a' && c.tuneName === 'ledger-lite' && c.attempt === 3)
  assert.ok(replacement, 'replacement re-runs the same arm and route at an attempt above the registered n')
  const log = readLog(fixture)
  const scheduled = log.filter(l => l.outcome === 'SCHEDULED')
  assert.equal(scheduled.length, 1)
  assert.deepEqual([scheduled[0].route, scheduled[0].arm, scheduled[0].attempt, scheduled[0].replacement],
    ['route-a', 'ledger-lite', 3, true])
  // The failed attempt stays on disk and in the log.
  assert.equal(log.filter(l => l.outcome === 'PROVIDER_ERROR').length, 1)
  assert.ok(existsSync(path.join(fixture.runsDir, 'ledger-lite', 'route-a', 't-x', 'attempt-1', 'manifest.json')))
  const routeA = result.summary.routes.find(r => r.route === 'route-a')
  assert.equal(routeA.replacementsUsed, 1)
  assert.match(renderSweepSummary(result), /replacements 1\/5/)
})

test('past the replacement cap the route is dropped and nothing more is scheduled on it', async (t) => {
  const fixture = makeFixture(t)
  const calls = []
  const result = await runSweep({
    claimPath: fixture.claimPath,
    runsDir: fixture.runsDir,
    configPath: fixture.configPath,
    taskDir: fixture.taskDir,
    live: true,
    runOne: fakeRunOne(fixture, calls, (o) => o.model === 'route-a' ? 'PROVIDER_ERROR' : 'VERIFIED_PASS')
  })
  // route-a: the 4 base trials fail, scheduling replacements nt/3, ll/3, nt/4,
  // ll/4; nt/3 fails and fills the cap with nt/5; ll/3 then fails and drops the
  // route, so nt/4, ll/4, nt/5 are scheduled but never execute. route-b is
  // unaffected and completes in full.
  const routeACalls = calls.filter(c => c.model === 'route-a')
  assert.equal(routeACalls.length, 6)
  assert.ok(!calls.some(c => c.model === 'route-a' && c.attempt >= 4))
  assert.equal(calls.filter(c => c.model === 'route-b').length, 4)
  assert.deepEqual(result.droppedRoutes, ['route-a'])
  const log = readLog(fixture)
  const dropped = log.filter(l => l.outcome === 'ROUTE_DROPPED')
  assert.equal(dropped.length, 1)
  assert.equal(dropped[0].route, 'route-a')
  assert.equal(log.filter(l => l.outcome === 'SCHEDULED' && l.route === 'route-a').length, REPLACEMENT_CAP_PER_ROUTE)
  const routeA = result.summary.routes.find(r => r.route === 'route-a')
  assert.equal(routeA.dropped, true)
  assert.equal(routeA.replacementsUsed, REPLACEMENT_CAP_PER_ROUTE)
  assert.equal(routeA.arms.find(a => a.arm === 'no-tune').outcomes.PROVIDER_ERROR, 3)
  assert.match(renderSweepSummary(result), /ROUTE DROPPED/)
})

test('--limit stops cleanly and a later invocation resumes, including scheduled replacements', async (t) => {
  const fixture = makeFixture(t)
  const calls1 = []
  const first = await runSweep({
    claimPath: fixture.claimPath,
    runsDir: fixture.runsDir,
    configPath: fixture.configPath,
    taskDir: fixture.taskDir,
    live: true,
    limit: 3,
    runOne: fakeRunOne(fixture, calls1, (o, n) => n === 2 ? 'PROVIDER_ERROR' : 'VERIFIED_PASS')
  })
  assert.equal(first.executed, 3)
  assert.equal(first.stoppedByLimit, true)
  // Slot 2 (route-a ledger-lite attempt 1) failed: its replacement was
  // scheduled but --limit stopped the run before it could execute.
  const scheduled = readLog(fixture).filter(l => l.outcome === 'SCHEDULED')
  assert.equal(scheduled.length, 1)
  assert.deepEqual([scheduled[0].route, scheduled[0].arm, scheduled[0].attempt], ['route-a', 'ledger-lite', 3])
  assert.ok(!existsSync(path.join(fixture.runsDir, 'ledger-lite', 'route-a', 't-x', 'attempt-3', 'manifest.json')))

  const calls2 = []
  const second = await runSweep({
    claimPath: fixture.claimPath,
    runsDir: fixture.runsDir,
    configPath: fixture.configPath,
    taskDir: fixture.taskDir,
    live: true,
    runOne: fakeRunOne(fixture, calls2, () => 'VERIFIED_PASS')
  })
  assert.equal(second.stoppedByLimit, false)
  // Remaining: route-a ll/2, route-b ×4, and the scheduled replacement ll/3.
  assert.equal(second.executed, 6)
  const reruns = calls2.filter(c => c.model === 'route-a' && c.tuneName === 'ledger-lite' && c.attempt === 3)
  assert.equal(reruns.length, 1)
  // The log survived both invocations append-only; the replacement was not
  // scheduled twice.
  const log = readLog(fixture)
  assert.equal(log.filter(l => l.outcome === 'SCHEDULED').length, 1)
  assert.equal(log.length, 3 + 1 + 6)
  const slot = second.slots.find(s => s.route === 'route-a' && s.arm === 'ledger-lite' && s.attempt === 3)
  assert.equal(slot.status, 'done')
})

test('sweep CLI requires --claim', () => {
  const r = run(['sweep'])
  assert.equal(r.code, 2)
  assert.match(r.stderr, /requires --claim/)
})

test('sweep CLI reports a missing claim file', () => {
  const r = run(['sweep', '--claim', 'no-such-claim'])
  assert.equal(r.code, 2)
  assert.match(r.stderr, /claim not found/)
})

test('sweep CLI dry run prints the schedule and writes nothing', async (t) => {
  const fixture = makeFixture(t)
  const r = run(['sweep', '--claim', fixture.claimPath, '--config', fixture.configPath, '--runs-dir', fixture.runsDir])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /DRY RUN/)
  assert.match(r.stdout, /route-b\s+ledger-lite\s+2\s+pending/)
  assert.equal(existsSync(path.join(fixture.runsDir, 'dt-test-sweep', 'sweep-log.jsonl')), false)
})

test('sweep CLI refuses an unresolvable route even on a dry run', async (t) => {
  const fixture = makeFixture(t, { routes: ['route-a', 'route-nope'] })
  const r = run(['sweep', '--claim', fixture.claimPath, '--config', fixture.configPath, '--runs-dir', fixture.runsDir])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /does not resolve/)
})

// The real claim's registered fields, written to a temp file with its lifecycle
// rolled back to registration. dt-v1-ledger-lite-nosub has since been concluded
// (status "reported"), and a sweep rightly refuses to collect fresh data under a
// concluded id — so these end-to-end tests, which exist to check that the real
// registered design schedules correctly, supply an open copy rather than
// asserting the repo's claim is forever open.
function openRealClaimPath (t) {
  const src = path.join(root, 'claims', 'dt-v1-ledger-lite-nosub.json')
  const { conclusion, ...rest } = JSON.parse(readFileSync(src, 'utf8'))
  const dir = mkdtempSync(path.join(os.tmpdir(), 'droidtune-open-claim-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const dest = path.join(dir, 'dt-v1-ledger-lite-nosub.json')
  writeFileSync(dest, JSON.stringify({ ...rest, status: 'preregistered' }, null, 2) + '\n')
  return dest
}

test('sweep CLI dry-runs the real preregistered claim end to end', async (t) => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'droidtune-sweep-real-'))
  t.after(() => rmSync(temp, { recursive: true, force: true }))
  const configPath = path.join(temp, 'settings.json')
  writeFileSync(configPath, JSON.stringify({
    customModels: ['hy3-free', 'nemotron-3.5-lightning-free', 'laguna-s-2.1-free', 'nemotron-3-ultra-free']
      .map(id => ({ id, model: id }))
  }))
  const runsDir = path.join(temp, 'runs')
  const r = run(['sweep', '--claim', openRealClaimPath(t), '--config', configPath, '--runs-dir', runsDir, '--json'])
  assert.equal(r.code, 0, r.stderr)
  const result = JSON.parse(r.stdout)
  assert.equal(result.claimId, 'dt-v1-ledger-lite-nosub')
  assert.equal(result.slots.length, 80)
  assert.ok(result.slots.every(s => s.status === 'pending'))
  assert.deepEqual(
    result.slots.slice(0, 4).map(s => [s.route, s.arm, s.attempt]),
    [['hy3-free', 'no-tune', 1], ['hy3-free', 'ledger-lite', 1], ['hy3-free', 'no-tune', 2], ['hy3-free', 'ledger-lite', 2]])
  // The tuned arm carries the preregistered, hash-verified tune file.
  assert.ok(result.slots.filter(s => s.arm === 'ledger-lite').every(s => s.tuneFile.endsWith(path.join('ledger-lite', 'AGENTS.md'))))
  assert.equal(existsSync(runsDir), false)
})

test('a HARNESS_ERROR aborts the sweep instead of being replaced or skipped', async (t) => {
  // A harness fault means this runner broke mid-sweep, so every later slot is
  // suspect. Replacing it would fold a harness bug into the claim's exclusion
  // rule, which does not name it; skipping it would keep collecting data on a
  // known-broken harness.
  const fixture = makeFixture(t)
  const calls = []
  const result = await runSweep({
    claimPath: fixture.claimPath,
    runsDir: fixture.runsDir,
    configPath: fixture.configPath,
    taskDir: fixture.taskDir,
    live: true,
    runOne: fakeRunOne(fixture, calls, (o, n) => n === 2 ? 'HARNESS_ERROR' : 'VERIFIED_PASS')
  })
  assert.equal(calls.length, 2, 'the sweep must stop at the faulting trial')
  assert.ok(result.abortedBy, 'the result must record what aborted it')
  assert.equal(result.abortedBy.outcome, 'HARNESS_ERROR')
  const log = readLog(fixture)
  assert.equal(log.filter(l => l.outcome === 'SWEEP_ABORTED').length, 1)
  // Never silently converted into a replacement.
  assert.equal(log.filter(l => l.outcome === 'SCHEDULED').length, 0)
  assert.match(renderSweepSummary(result), /ABORTED: HARNESS_ERROR/)
})

test('a TUNE_CONTAMINATED trial is reported, never replaced', async (t) => {
  // Replacing it would resample until the arm looked clean — the re-cutting the
  // claim's decision rule forbids.
  const fixture = makeFixture(t)
  const calls = []
  const result = await runSweep({
    claimPath: fixture.claimPath,
    runsDir: fixture.runsDir,
    configPath: fixture.configPath,
    taskDir: fixture.taskDir,
    live: true,
    runOne: fakeRunOne(fixture, calls, (o) => o.tuneName === 'ledger-lite' ? 'TUNE_CONTAMINATED' : 'VERIFIED_PASS')
  })
  assert.ok(!result.abortedBy, 'contamination is a data problem, not a harness fault')
  const log = readLog(fixture)
  assert.equal(log.filter(l => l.outcome === 'SCHEDULED').length, 0, 'no replacements')
  assert.ok(log.some(l => l.outcome === 'TUNE_CONTAMINATED'))
  assert.match(renderSweepSummary(result), /TUNE_CONTAMINATED/)
})

const sweepOpts = (fixture, over = {}) => ({
  claimPath: fixture.claimPath,
  runsDir: fixture.runsDir,
  configPath: fixture.configPath,
  sessionsDir: fixture.sessionsDir,
  taskDir: fixture.taskDir,
  ...over
})

test('a pre-existing pack with a replaceable outcome is put through the replacement rule on resume', async (t) => {
  const fixture = makeFixture(t)
  // A pre-sweep smoke test (or an earlier interrupted sweep) left a
  // PROVIDER_ERROR pack on this slot's path: it never reached the model, so
  // it must be replaced, not silently adopted as evidence.
  writePack(fixture, 'route-a', 'no-tune', 1, 'PROVIDER_ERROR')
  const first = await runSweep(sweepOpts(fixture, {
    live: true,
    runOne: fakeRunOne(fixture, [], () => 'VERIFIED_PASS')
  }))
  // 7 untouched base slots plus the replacement for the adopted failure.
  assert.equal(first.executed, 8)
  const replacement = first.slots.find(s => s.route === 'route-a' && s.arm === 'no-tune' && s.replacement)
  assert.equal(replacement.attempt, 3)
  assert.equal(replacement.status, 'done')
  assert.equal(readLog(fixture).filter(l => l.outcome === 'SCHEDULED').length, 1)
  assert.equal(first.summary.routes.find(r => r.route === 'route-a').replacementsUsed, 1)

  // Resuming again must not schedule a second replacement for the same
  // adopted failure: the log's SCHEDULED line plus the pack on disk are the
  // record that attempt-3 already answers it.
  const second = await runSweep(sweepOpts(fixture, {
    live: true,
    runOne: fakeRunOne(fixture, [], () => 'VERIFIED_PASS')
  }))
  assert.equal(second.executed, 0)
  assert.equal(readLog(fixture).filter(l => l.outcome === 'SCHEDULED').length, 1)
  assert.equal(second.summary.routes.find(r => r.route === 'route-a').replacementsUsed, 1)
})

test('a replacement scheduled but never executed is re-run, not double-scheduled', async (t) => {
  const fixture = makeFixture(t)
  // Previous run: route-a/no-tune/attempt-1 failed with PROVIDER_ERROR and
  // its replacement attempt-3 was scheduled (logged), then the process died
  // before executing it — no pack on disk for attempt-3.
  writePack(fixture, 'route-a', 'no-tune', 1, 'PROVIDER_ERROR')
  const logPath = path.join(fixture.runsDir, 'dt-test-sweep', 'sweep-log.jsonl')
  mkdirSync(path.dirname(logPath), { recursive: true })
  writeFileSync(logPath, JSON.stringify({
    ts: new Date().toISOString(),
    route: 'route-a', arm: 'no-tune', attempt: 3,
    outcome: 'SCHEDULED', packPath: null, replacement: true
  }) + '\n')
  const result = await runSweep(sweepOpts(fixture, {
    live: true,
    runOne: fakeRunOne(fixture, [], () => 'VERIFIED_PASS')
  }))
  // 7 untouched base slots plus the re-queued replacement; the SCHEDULED line
  // is the record that attempt-3 was already queued, so nothing new is logged.
  assert.equal(result.executed, 8)
  assert.equal(readLog(fixture).filter(l => l.outcome === 'SCHEDULED').length, 1)
  const reran = result.slots.find(s => s.route === 'route-a' && s.arm === 'no-tune' && s.attempt === 3)
  assert.equal(reran.status, 'done')
  assert.ok(existsSync(path.join(fixture.runsDir, 'no-tune', 'route-a', 't-x', 'attempt-3', 'manifest.json')))
})

test('resume after an abort is refused until the operator acknowledges it', async (t) => {
  const fixture = makeFixture(t)
  const first = await runSweep(sweepOpts(fixture, {
    live: true,
    runOne: fakeRunOne(fixture, [], (o, n) => n === 2 ? 'HARNESS_ERROR' : 'VERIFIED_PASS')
  }))
  assert.equal(first.abortedBy.outcome, 'HARNESS_ERROR')

  // A plain live resume refuses — loudly, naming the faulting slot — even
  // though the faulting slot has a pack on disk and would read as "done".
  await assert.rejects(
    () => runSweep(sweepOpts(fixture, {
      live: true,
      runOne: fakeRunOne(fixture, [], () => 'VERIFIED_PASS')
    })),
    (err) => {
      assert.match(err.message, /SWEEP_ABORTED at route-a\/ledger-lite\/attempt-1/)
      assert.match(err.message, /--resume-after-abort/)
      return true
    }
  )
  // A dry run is never blocked: it only reports the state on disk.
  const dry = await runSweep(sweepOpts(fixture, { runOne: unreachableRunOne }))
  assert.equal(dry.slots.filter(s => s.status === 'done').length, 2)
})

test('a --resume-after-abort override logs the acknowledgement and resumes', async (t) => {
  const fixture = makeFixture(t)
  const first = await runSweep(sweepOpts(fixture, {
    live: true,
    runOne: fakeRunOne(fixture, [], (o, n) => n === 2 ? 'HARNESS_ERROR' : 'VERIFIED_PASS')
  }))
  assert.equal(first.abortedBy.outcome, 'HARNESS_ERROR')

  const second = await runSweep(sweepOpts(fixture, {
    live: true,
    resumeAfterAbort: true,
    runOne: fakeRunOne(fixture, [], () => 'VERIFIED_PASS')
  }))
  assert.equal(second.executed, 6)
  const log = readLog(fixture)
  const abortIdx = log.findIndex(l => l.outcome === 'SWEEP_ABORTED')
  const ackIdx = log.findIndex(l => l.outcome === 'ABORT_ACKNOWLEDGED')
  assert.ok(abortIdx >= 0)
  assert.ok(ackIdx > abortIdx)
  assert.equal(log[ackIdx].route, 'route-a')
  assert.equal(log[ackIdx].arm, 'ledger-lite')
  assert.equal(log[ackIdx].attempt, 1)
  assert.match(log[ackIdx].ts, /^\d{4}-\d{2}-\d{2}T/)

  // Once acknowledged, a plain resume is unblocked.
  const third = await runSweep(sweepOpts(fixture, {
    live: true,
    runOne: fakeRunOne(fixture, [], () => 'VERIFIED_PASS')
  }))
  assert.equal(third.executed, 0)
})

test('the replacement cap counts the union of log and disk history', async (t) => {
  const fixture = makeFixture(t)
  const logPath = path.join(fixture.runsDir, 'dt-test-sweep', 'sweep-log.jsonl')
  mkdirSync(path.dirname(logPath), { recursive: true })
  const line = (over) => JSON.stringify({
    ts: new Date().toISOString(), route: 'route-a', arm: 'no-tune',
    packPath: null, replacement: true, ...over
  })
  // Logged history: attempts 3 and 4 scheduled AND executed (packs on disk);
  // attempt 5 scheduled but never executed (crash between scheduling and
  // running). Disk-only history: attempts 6 and 7 packs the log never
  // recorded (lost log lines). True usage is the union {3,4,5,6,7} = 5 = the
  // cap; the old Math.max(3 logged, 4 disk) = 4 would have permitted a sixth.
  writePack(fixture, 'route-a', 'no-tune', 3, 'VERIFIED_PASS')
  writePack(fixture, 'route-a', 'no-tune', 4, 'VERIFIED_PASS')
  writePack(fixture, 'route-a', 'no-tune', 6, 'VERIFIED_PASS')
  writePack(fixture, 'route-a', 'no-tune', 7, 'VERIFIED_PASS')
  writeFileSync(logPath, [
    line({ attempt: 3, outcome: 'SCHEDULED' }),
    line({ attempt: 3, outcome: 'VERIFIED_PASS', packPath: 'runs/no-tune/route-a/t-x/attempt-3/manifest.json' }),
    line({ attempt: 4, outcome: 'SCHEDULED' }),
    line({ attempt: 4, outcome: 'VERIFIED_PASS', packPath: 'runs/no-tune/route-a/t-x/attempt-4/manifest.json' }),
    line({ attempt: 5, outcome: 'SCHEDULED' })
  ].join('\n') + '\n')

  const result = await runSweep(sweepOpts(fixture, {
    live: true,
    // The re-queued attempt-5 fails when it finally runs: with true usage
    // already at the cap the route must drop, not schedule an eighth attempt.
    runOne: fakeRunOne(fixture, [], (o) =>
      o.model === 'route-a' && o.tuneName === 'no-tune' && o.attempt === 5 ? 'PROVIDER_ERROR' : 'VERIFIED_PASS')
  }))
  assert.equal(result.executed, 9) // 8 base slots + the re-queued attempt-5
  const routeA = result.summary.routes.find(r => r.route === 'route-a')
  assert.equal(routeA.replacementsUsed, REPLACEMENT_CAP_PER_ROUTE)
  assert.ok(result.droppedRoutes.includes('route-a'))
  // No new SCHEDULED line past the cap; the drop is on the record instead.
  assert.equal(readLog(fixture).filter(l => l.outcome === 'SCHEDULED').length, 3)
  assert.ok(readLog(fixture).some(l => l.outcome === 'ROUTE_DROPPED' && l.route === 'route-a'))
})

test('adoption refuses a pack whose manifest names a different route', async (t) => {
  const fixture = makeFixture(t)
  writePack(fixture, 'route-a', 'no-tune', 1, 'VERIFIED_PASS', { modelRequested: 'route-b' })
  await assert.rejects(
    () => runSweep(sweepOpts(fixture, { runOne: unreachableRunOne })),
    (err) => {
      assert.match(err.message, /refusing to adopt pack/)
      assert.match(err.message, /route-a\/no-tune\/attempt-1/)
      assert.match(err.message, /does not match the slot's route/)
      return true
    }
  )
})

test('adoption refuses a tuned-arm pack without the pinned tune hash', async (t) => {
  const fixture = makeFixture(t)
  writePack(fixture, 'route-a', 'ledger-lite', 1, 'VERIFIED_PASS', {
    tune: { name: 'ledger-lite', file: fixture.tuneFile, sha256: '0'.repeat(64) }
  })
  await assert.rejects(
    () => runSweep(sweepOpts(fixture, { runOne: unreachableRunOne })),
    /pinned tuneSha256/
  )
})

test('adoption refuses a control-arm pack that carries tune provenance', async (t) => {
  const fixture = makeFixture(t)
  writePack(fixture, 'route-a', 'no-tune', 1, 'VERIFIED_PASS', {
    tune: { name: 'stray-tune', file: '/x', sha256: 'abc' }
  })
  await assert.rejects(
    () => runSweep(sweepOpts(fixture, { runOne: unreachableRunOne })),
    /control arm never carries a tune/
  )
})

test('a results.json without a manifest is a half-written pack, not a pending slot', async (t) => {
  const fixture = makeFixture(t)
  const dir = path.join(fixture.runsDir, 'no-tune', 'route-a', 't-x', 'attempt-1')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'results.json'), JSON.stringify({ outcome: 'PROVIDER_ERROR' }))
  await assert.rejects(
    () => runSweep(sweepOpts(fixture, { runOne: unreachableRunOne })),
    (err) => {
      assert.match(err.message, /half-written pack/)
      assert.match(err.message, /attempt-1/)
      return true
    }
  )
})

test('--limit landing exactly on the remaining work is a finish, not a stop', async (t) => {
  const fixture = makeFixture(t)
  for (const [route, arm, attempt] of [
    ['route-a', 'no-tune', 1], ['route-a', 'ledger-lite', 1],
    ['route-a', 'no-tune', 2], ['route-a', 'ledger-lite', 2],
    ['route-b', 'no-tune', 1], ['route-b', 'ledger-lite', 1]
  ]) writePack(fixture, route, arm, attempt, 'VERIFIED_PASS')
  const result = await runSweep(sweepOpts(fixture, {
    live: true,
    limit: 2,
    runOne: fakeRunOne(fixture, [], () => 'VERIFIED_PASS')
  }))
  assert.equal(result.executed, 2)
  assert.equal(result.stoppedByLimit, false)
  assert.ok(result.slots.every(s => s.status === 'done'))
})

test('sweep CLI accepts --resume-after-abort on a dry run', (t) => {
  const r = run(['sweep', '--claim', openRealClaimPath(t), '--resume-after-abort'])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /DRY RUN/)
})
