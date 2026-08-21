import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  CLOSED_STATUS,
  CLOSURE_WRITABLE_KEYS,
  alnumRouteKey,
  analyzeClaim,
  assertRegisteredFieldsUnchanged,
  buildRouteIndex,
  classifyOutcome,
  closeClaim,
  conclusionsAgree,
  evaluateDecision,
  fisherExactTwoSided,
  loadClaim,
  parseArgs,
  renderJson,
  renderPlain,
  resolveConfigModel,
  resolveLogRoute,
  resolvePackSegment
} from '../scripts/claim-report.js'
import { routeSlug } from '../lib/paths.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const script = path.join(root, 'scripts', 'claim-report.js')

function run (args, opts = {}) {
  try {
    const stdout = execFileSync('node', [script, ...args], { encoding: 'utf8', ...opts })
    return { code: 0, stdout }
  } catch (err) {
    return { code: err.status, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }
  }
}

// Self-contained claim fixture in the exact shape claims/dt-v1-*.json use:
// temp settings.json (customModels), temp claim.json, and an existing (empty)
// runs dir. logRouteOf lets a test emit log/pack routes under the canonical
// config form rather than the claim spelling, like a real sweep would.
function makeFixture (t, {
  id = 'dt-test-claim',
  routes = ['hy3-free'],
  n = 10,
  arms = ['no-tune', 'ledger-lite'],
  task = 't004-git-surgery',
  models = null,
  logRouteOf = null,
  claimOverrides = {}
} = {}) {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'droidtune-claimreport-'))
  t.after(() => rmSync(temp, { recursive: true, force: true }))
  const runsDir = path.join(temp, 'runs')
  mkdirSync(runsDir, { recursive: true })
  const modelsList = models ?? routes.map(route => ({ id: route, model: route }))
  const configPath = path.join(temp, 'settings.json')
  writeFileSync(configPath, JSON.stringify({ customModels: modelsList }))
  const claim = {
    id,
    status: 'preregistered',
    population: [task],
    arms,
    routes,
    design: { nPerArmPerRoute: n, autoLevel: 'high', timeoutMs: 300000 },
    primaryMetric: 'no-submission-rate',
    primaryMetricDefinition: 'count(outcome == NO_SUBMISSION) / count(trials that reached the model)',
    secondaryMetrics: [],
    decisionRule: 'Recommend the tune arm only if ALL of: (1) pooled NO_SUBMISSION rate at least 25pp below control; (2) two-sided Fisher p < 0.05; (3) VERIFIED_PASS rate not lower.',
    exclusionRule: 'PROVIDER_ERROR/DROID_ERROR/VERIFIER_ERROR never reached the model and are replaced at the same arm/route, capped at 5 per route; a route past the cap drops from pooled analysis.',
    ...claimOverrides
  }
  const claimPath = path.join(temp, 'claim.json')
  writeFileSync(claimPath, JSON.stringify(claim))
  const fixture = { temp, runsDir, configPath, claimPath, claim, task }
  // The canonical (config-derived) id a sweep would write into logs and use
  // for pack slugs; identity by default since the default config matches the
  // claim routes exactly.
  fixture.canonical = (claimRoute) => logRouteOf ? (logRouteOf[claimRoute] ?? claimRoute) : claimRoute
  return fixture
}

let ts = 0
function logLine ({ route, arm, attempt, outcome, replacement = false, task = 't004-git-surgery' }) {
  ts++
  return {
    ts: new Date(Date.UTC(2026, 7, 20, 0, 0, 0) + ts * 60000).toISOString(),
    route,
    arm,
    attempt,
    model: route,
    task,
    outcome,
    tuneSha256: 'a'.repeat(64),
    replacement,
    manifestPath: `runs/${arm}/${routeSlug(route)}/${task}/attempt-${attempt}/manifest.json`,
    packPath: `runs/${arm}/${routeSlug(route)}/${task}/attempt-${attempt}`
  }
}

function writeLog (fixture, lines) {
  const dir = path.join(fixture.runsDir, fixture.claim.id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'sweep-log.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n')
}

// seqs: claimRoute -> arm -> array of n outcomes. Emits one executed line per
// base attempt, using the canonical log route for the fixture.
function baseLines (fixture, seqs) {
  const lines = []
  for (const route of fixture.claim.routes) {
    for (const arm of fixture.claim.arms) {
      seqs[route][arm].forEach((outcome, i) => {
        lines.push(logLine({ route: fixture.canonical(route), arm, attempt: i + 1, outcome, task: fixture.task }))
      })
    }
  }
  return lines
}

function writePack (fixture, { arm, route, task = fixture.task, attempt, outcome, segment = null }) {
  const dir = path.join(fixture.runsDir, arm, segment ?? routeSlug(fixture.canonical(route)), task, `attempt-${attempt}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'manifest.json'), '{}')
  writeFileSync(path.join(dir, 'results.json'), JSON.stringify({ outcome }))
}

function analyze (fixture, opts = {}) {
  return analyzeClaim({ claimPath: fixture.claimPath, runsDir: fixture.runsDir, configPath: fixture.configPath, ...opts })
}

// ---------------------------------------------------------------------------
// Claim loading
// ---------------------------------------------------------------------------

test('loadClaim refuses malformed claims', () => {
  const base = {
    id: 'dt-test-claim',
    arms: ['no-tune', 'ledger-lite'],
    routes: ['hy3-free'],
    population: ['t004-git-surgery'],
    design: { nPerArmPerRoute: 2 },
    primaryMetric: 'no-submission-rate',
    decisionRule: 'x',
    exclusionRule: 'y'
  }
  const bad = [
    { ...base, arms: ['no-tune'] },
    { ...base, arms: ['no-tune', ''] },
    { ...base, routes: [] },
    { ...base, population: ['a', 'b'] },
    { ...base, primaryMetric: 'verified-pass-rate' },
    { ...base, design: { nPerArmPerRoute: 0 } },
    { ...base, decisionRule: '' },
    { ...base, exclusionRule: '' }
  ]
  // execute through a fixture so loadClaim reads real files
  const temp = mkdtempSync(path.join(os.tmpdir(), 'droidtune-claimreport-'))
  for (const [i, obj] of bad.entries()) {
    const claimPath = path.join(temp, `bad-${i}.json`)
    writeFileSync(claimPath, JSON.stringify(obj))
    assert.throws(() => loadClaim(claimPath))
  }
  rmSync(temp, { recursive: true, force: true })
})

test('loadClaim accepts a well-formed claim and reads it back', (t) => {
  const fixture = makeFixture(t)
  const claim = loadClaim(fixture.claimPath)
  assert.equal(claim.id, 'dt-test-claim')
  assert.equal(claim.design.nPerArmPerRoute, 10)
})

// ---------------------------------------------------------------------------
// Route identity: dot/dash normalization
// ---------------------------------------------------------------------------

test('alnumRouteKey collapses punctuation', () => {
  assert.equal(alnumRouteKey('nemotron-3.5-lightning-free'), 'nemotron35lightningfree')
  assert.equal(alnumRouteKey('nemotron-3-5-lightning-free'), 'nemotron35lightningfree')
  assert.equal(alnumRouteKey(null), '')
})

test('resolveConfigModel prefers exact id, then unique substring, and refuses ambiguity', () => {
  const models = [
    { id: 'route-a', model: 'route-a-model' },
    { id: 'route-b', model: 'route-b-model', displayName: 'Route B free' }
  ]
  assert.equal(resolveConfigModel('route-a', models).id, 'route-a')
  assert.equal(resolveConfigModel('route-a-model', models).id, 'route-a')
  assert.equal(resolveConfigModel('route-b', models).id, 'route-b')
  assert.equal(resolveConfigModel('zzz', models), null)
  assert.equal(resolveConfigModel('route-', models), null, 'substring "route-" matches both entries')
})

test('buildRouteIndex maps config canonical ids, slugs, and collapsed forms back to the claim route', () => {
  const claimRoutes = ['nemotron-3.5-lightning-free']
  const configModels = [{ id: 'custom:nemotron-3.5-lightning-free-anything', model: 'custom:nemotron-3.5-lightning-free-anything' }]
  const index = buildRouteIndex(claimRoutes, configModels)
  const route = claimRoutes[0]
  // The config-derived canonical id the sweep would put in the log.
  assert.equal(index.canonicalOf.get(route), 'custom:nemotron-3.5-lightning-free-anything')
  assert.equal(resolveLogRoute(index, 'custom:nemotron-3.5-lightning-free-anything'), route)
  // The lossless filesystem slug and its dashed variant (alphanumeric collapse).
  assert.equal(index.packSlugOf.get(route), 'nemotron-3.5-lightning-free-anything')
  assert.equal(resolveLogRoute(index, 'nemotron-3.5-lightning-free-anything'), route)
  assert.equal(resolveLogRoute(index, 'nemotron-3-5-lightning-free-anything'), route)
  assert.equal(resolveLogRoute(index, 'nemotron-3_5-lightning_free_anything'), route)
  assert.equal(resolveLogRoute(index, 'unrelated-route'), null)
  assert.equal(resolvePackSegment(index, 'nemotron-3.5-lightning-free-anything'), route)
  assert.equal(resolvePackSegment(index, 'nemotron-3-5-lightning-free-anything'), route)
  assert.equal(resolvePackSegment(index, 'unrelated-route'), null)
})

test('buildRouteIndex falls back to the claim spelling when the config does not rename the route', () => {
  const claimRoutes = ['hy3-free']
  const index = buildRouteIndex(claimRoutes, [{ id: 'hy3-free', model: 'hy3-free' }])
  assert.equal(index.canonicalOf.get('hy3-free'), 'hy3-free')
  assert.equal(index.packSlugOf.get('hy3-free'), 'hy3-free')
  assert.equal(resolveLogRoute(index, 'hy3-free'), 'hy3-free')
  assert.equal(resolveLogRoute(index, 'hy3free'), 'hy3-free')
  assert.equal(resolvePackSegment(index, 'hy3-free'), 'hy3-free')
})

// ---------------------------------------------------------------------------
// Fisher exact test
// ---------------------------------------------------------------------------

test('fisherExactTwoSided computes the two-sided p by enumeration in log space', () => {
  // [[2,1],[1,2]]: every realization is as extreme as the observed one -> p = 1.
  assert.equal(fisherExactTwoSided(2, 1, 1, 2), 1)
  // Extreme [[5,0],[0,5]]: only the flipped table ties the observed probability.
  const extreme = fisherExactTwoSided(5, 0, 0, 5)
  assert.ok(Math.abs(extreme - 2 / 252) < 1e-9, `expected 2/C(10,5), got ${extreme}`)
  // [[5,5],[0,10]]: observed 252/C(20,5); x=0 ties -> p = 2*252/15504.
  const asymmetric = fisherExactTwoSided(5, 5, 0, 10)
  assert.ok(Math.abs(asymmetric - 2 * 252 / 15504) < 1e-9, `got ${asymmetric}`)
})

test('fisherExactTwoSided handles degenerate tables and large designs without overflow', () => {
  assert.equal(fisherExactTwoSided(0, 5, 0, 5), 1, 'empty column')
  assert.equal(fisherExactTwoSided(5, 0, 5, 0), 1, 'empty row')
  assert.equal(fisherExactTwoSided(0, 0, 5, 5), 1, 'all one arm')
  const big = fisherExactTwoSided(20, 20, 0, 40)
  assert.ok(big > 0 && big < 1e-6, `large design must be tiny, got ${big}`)
  // Symmetry: swapping the two rows must not move the p-value.
  assert.equal(fisherExactTwoSided(3, 7, 10, 2), fisherExactTwoSided(10, 2, 3, 7))
})

test('fisherExactTwoSided rejects non-integer or negative inputs', () => {
  assert.throws(() => fisherExactTwoSided(1.5, 0, 0, 5), TypeError)
  assert.throws(() => fisherExactTwoSided(-1, 0, 0, 5), TypeError)
})

// ---------------------------------------------------------------------------
// Outcome classification
// ---------------------------------------------------------------------------

test('classifyOutcome buckets every class exactly once', () => {
  assert.equal(classifyOutcome('NO_SUBMISSION'), 'scorable')
  assert.equal(classifyOutcome('TIMEOUT'), 'scorable')
  assert.equal(classifyOutcome('VERIFIED_PASS'), 'scorable')
  assert.equal(classifyOutcome('VERIFIED_FAIL'), 'scorable')
  assert.equal(classifyOutcome('PROVIDER_ERROR'), 'replaceable')
  assert.equal(classifyOutcome('DROID_ERROR'), 'replaceable')
  assert.equal(classifyOutcome('VERIFIER_ERROR'), 'replaceable')
  assert.equal(classifyOutcome('TUNE_CONTAMINATED'), 'reported')
  assert.equal(classifyOutcome('HARNESS_ERROR'), 'other')
  assert.equal(classifyOutcome('ABORTED_BUDGET'), 'other')
  assert.equal(classifyOutcome('COMPLETED'), 'other')
})

// ---------------------------------------------------------------------------
// Decision evaluation
// ---------------------------------------------------------------------------

test('evaluateDecision fails every condition when rates cannot be computed', () => {
  const empty = { noSubmissionRate: null, verifiedPassRate: null, noSubmission: 0, scorable: 0, verifiedPass: 0 }
  const d = evaluateDecision({ arms: ['no-tune', 'ledger-lite'], control: empty, tune: empty, fisherP: null })
  assert.equal(d.supported, false)
  assert.equal(d.verdict, 'not-supported')
  assert.ok(d.conditions.every(c => !c.met))
  assert.match(d.conditions[0].detail, /cannot compute/)
})

// ---------------------------------------------------------------------------
// End-to-end decision truth table (complete, single route, n=10)
// ---------------------------------------------------------------------------

const SUB = 'NO_SUBMISSION'
const PASS = 'VERIFIED_PASS'
const FAIL = 'VERIFIED_FAIL'
const seqs1 = (control, tune) => ({ 'hy3-free': { 'no-tune': control, 'ledger-lite': tune } })

test('complete evidence where all three conditions hold -> supported', (t) => {
  const fixture = makeFixture(t, { n: 10 })
  writeLog(fixture, baseLines(fixture, seqs1(
    [SUB, SUB, SUB, SUB, SUB, PASS, PASS, PASS, PASS, PASS],
    [PASS, PASS, PASS, PASS, PASS, FAIL, FAIL, FAIL, FAIL, FAIL]
  )))
  const r = analyze(fixture)
  assert.equal(r.state, 'complete')
  assert.equal(r.evaluated, true)
  assert.equal(r.baseSlots.executed, 20)
  assert.equal(r.pending.base, 0)
  assert.equal(r.pending.replacements, 0)
  assert.equal(r.pooled['no-tune'].noSubmissionRate, 0.5)
  assert.equal(r.pooled['ledger-lite'].noSubmissionRate, 0)
  assert.deepEqual(r.fisher.table, [[5, 5], [0, 10]])
  assert.ok(r.fisher.p < 0.05 && r.fisher.p > 0.03, `p=${r.fisher.p}`)
  assert.equal(r.pooled['no-tune'].verifiedPassRate, 0.5)
  assert.equal(r.pooled['ledger-lite'].verifiedPassRate, 0.5)
  assert.equal(r.decision.supported, true)
  assert.equal(r.decision.verdict, 'supported')
  assert.ok(r.decision.conditions.every(c => c.met))
  assert.match(renderPlain(r), /DECISION SUPPORTED/)
})

test('pooled drop below 25pp fails condition 1', (t) => {
  const fixture = makeFixture(t, { n: 10 })
  writeLog(fixture, baseLines(fixture, seqs1(
    [SUB, SUB, SUB, SUB, SUB, FAIL, FAIL, FAIL, FAIL, FAIL],
    [SUB, SUB, SUB, FAIL, FAIL, FAIL, FAIL, FAIL, FAIL, FAIL]
  )))
  const r = analyze(fixture)
  assert.equal(r.state, 'complete')
  assert.equal(r.decision.supported, false)
  const failed = r.decision.conditions.filter(c => !c.met).map(c => c.id)
  assert.ok(failed.includes('pooled-drop'), `expected pooled-drop among ${failed.join(',')}`)
  assert.equal(r.decision.conditions[0].met, false)
  assert.match(r.decision.conditions[0].detail, /20\.0pp drop/)
  assert.match(renderPlain(r), /DECISION NOT SUPPORTED/)
})

test('Fisher p >= 0.05 fails condition 2 even when the drop is large', (t) => {
  const fixture = makeFixture(t, { n: 3 })
  writeLog(fixture, baseLines(fixture, seqs1(
    [SUB, SUB, FAIL],
    [SUB, FAIL, FAIL]
  )))
  const r = analyze(fixture)
  assert.equal(r.state, 'complete')
  assert.equal(r.fisher.p, 1, '[[2,1],[1,2]] must be maximally unremarkable')
  assert.equal(r.decision.supported, false)
  const failed = r.decision.conditions.filter(c => !c.met).map(c => c.id)
  assert.deepEqual(failed, ['fisher'])
  assert.ok(r.decision.conditions[0].met, 'the 33pp drop alone must still count as met')
})

test('Fisher strictness: p just below 0.05 keeps the claim supported', (t) => {
  const fixture = makeFixture(t, { n: 9 })
  writeLog(fixture, baseLines(fixture, seqs1(
    [SUB, SUB, SUB, SUB, SUB, SUB, PASS, PASS, PASS],
    [SUB, PASS, PASS, PASS, PASS, PASS, PASS, PASS, PASS]
  )))
  const r = analyze(fixture)
  assert.equal(r.state, 'complete')
  assert.deepEqual(r.fisher.table, [[6, 3], [1, 8]])
  assert.equal(r.fisher.p, 0.04977375565610862, '[[6,3],[1,8]] must land on the supported side of the boundary')
  assert.ok(r.fisher.p < r.fisher.alpha, 'strict p < alpha holds')
  assert.equal(r.decision.supported, true, '55.6pp drop, p=0.0498, pass rate not lower -> all three met')
  assert.ok(r.decision.conditions.every(c => c.met))
  assert.match(renderPlain(r), /DECISION SUPPORTED/)
})

test('Fisher strictness: p just above 0.05 fails condition 2 alone', (t) => {
  const fixture = makeFixture(t, { n: 15 })
  writeLog(fixture, baseLines(fixture, seqs1(
    [SUB, SUB, SUB, SUB, SUB, SUB, SUB, SUB, PASS, PASS, PASS, PASS, PASS, PASS, PASS],
    [SUB, SUB, PASS, PASS, PASS, PASS, PASS, PASS, PASS, PASS, PASS, PASS, PASS, PASS, PASS]
  )))
  const r = analyze(fixture)
  assert.equal(r.state, 'complete')
  assert.deepEqual(r.fisher.table, [[8, 7], [2, 13]])
  assert.equal(r.fisher.p, 0.0501749125437283, '[[8,7],[2,13]] must land on the unsupported side of the boundary')
  assert.ok(r.fisher.p >= 0.05, 'strict p < alpha fails')
  assert.equal(r.decision.supported, false)
  const failed = r.decision.conditions.filter(c => !c.met).map(c => c.id)
  assert.deepEqual(failed, ['fisher'], 'the 40pp drop and the pass-rate condition still pass')
  assert.ok(r.decision.conditions[0].met)
  assert.ok(r.decision.conditions[2].met)
})

test('Fisher strictness: p exactly 0.05 is not supported because the rule says p < 0.05', (t) => {
  const fixture = makeFixture(t, { n: 12 })
  writeLog(fixture, baseLines(fixture, seqs1(
    [SUB, SUB, PASS, PASS, 'TUNE_CONTAMINATED', 'TUNE_CONTAMINATED', 'TUNE_CONTAMINATED', 'TUNE_CONTAMINATED', 'TUNE_CONTAMINATED', 'TUNE_CONTAMINATED', 'TUNE_CONTAMINATED', 'TUNE_CONTAMINATED'],
    [PASS, PASS, PASS, PASS, PASS, PASS, PASS, PASS, PASS, PASS, PASS, PASS]
  )))
  const r = analyze(fixture)
  assert.equal(r.state, 'complete')
  assert.deepEqual(r.fisher.table, [[2, 2], [0, 12]])
  assert.equal(r.fisher.p, 0.05, '[[2,2],[0,12]] is exactly the boundary')
  assert.equal(r.decision.supported, false, 'p == 0.05 is NOT p < 0.05, so condition 2 fails exactly at the boundary')
  const failed = r.decision.conditions.filter(c => !c.met).map(c => c.id)
  assert.deepEqual(failed, ['fisher'])
  assert.ok(r.decision.conditions[0].met, 'the 50pp drop still passes')
  assert.ok(r.decision.conditions[2].met, 'the pass-rate condition still passes')
})

test('a lower VERIFIED_PASS rate fails condition 3 even when drop and p pass', (t) => {
  const fixture = makeFixture(t, { n: 10 })
  writeLog(fixture, baseLines(fixture, seqs1(
    [SUB, SUB, SUB, SUB, SUB, PASS, PASS, PASS, PASS, PASS],
    [FAIL, FAIL, FAIL, FAIL, FAIL, FAIL, FAIL, FAIL, FAIL, FAIL]
  )))
  const r = analyze(fixture)
  assert.equal(r.state, 'complete')
  assert.ok(r.fisher.p < 0.05, 'drop 50pp, p=0.0325')
  assert.equal(r.decision.supported, false)
  const failed = r.decision.conditions.filter(c => !c.met).map(c => c.id)
  assert.deepEqual(failed, ['verified-pass-not-lower'])
  assert.equal(r.pooled['ledger-lite'].verifiedPassRate, 0)
})

test('supported verdict over multiple routes pools the 2x2 across routes', (t) => {
  const routes = ['r1', 'r2', 'r3', 'r4']
  const fixture = makeFixture(t, { routes, n: 3, models: routes.map(id => ({ id, model: id })) })
  const seqs = {}
  for (const route of routes) {
    // control: two NO_SUBMISSION per route (8/12 pooled = 0.667); tune: all pass (0/12).
    seqs[route] = {
      'no-tune': [SUB, SUB, FAIL],
      'ledger-lite': [PASS, PASS, PASS]
    }
  }
  writeLog(fixture, baseLines(fixture, seqs))
  const r = analyze(fixture)
  assert.equal(r.baseSlots.executed, 24)
  assert.equal(r.state, 'complete')
  assert.equal(r.pooled['no-tune'].noSubmissionRate, 2 / 3)
  assert.equal(r.pooled['ledger-lite'].noSubmissionRate, 0)
  assert.deepEqual(r.fisher.table, [[8, 4], [0, 12]])
  assert.ok(r.fisher.p < 0.05 && r.fisher.p > 0.001, `p=${r.fisher.p}`)
  assert.equal(r.decision.supported, true)
  assert.equal(r.routes.length, 4)
  // Per-route rates are published even though the decision is pooled (2 of 3
  // control slots per route are NO_SUBMISSION; the pool dilutes it to 0.5).
  assert.equal(r.routes[0].arms.find(a => a.arm === 'no-tune').noSubmissionRate, 2 / 3)
})

// ---------------------------------------------------------------------------
// Incomplete / aborted / no-evidence states
// ---------------------------------------------------------------------------

test('missing base slots mark the sweep incomplete and never evaluate the decision', (t) => {
  const fixture = makeFixture(t, { n: 2 })
  writeLog(fixture, [
    logLine({ route: 'hy3-free', arm: 'no-tune', attempt: 1, outcome: SUB }),
    logLine({ route: 'hy3-free', arm: 'no-tune', attempt: 2, outcome: SUB }),
    logLine({ route: 'hy3-free', arm: 'ledger-lite', attempt: 1, outcome: PASS })
  ])
  const r = analyze(fixture)
  assert.equal(r.state, 'incomplete')
  assert.equal(r.evaluated, false)
  assert.equal(r.decision, null)
  assert.equal(r.pending.base, 1)
  assert.deepEqual(r.pending.baseSlots, [{ route: 'hy3-free', arm: 'ledger-lite', attempt: 2 }])
  assert.match(renderPlain(r), /DECISION NOT EVALUATED/)
})

test('a queued-but-unexecuted replacement keeps the sweep incomplete', (t) => {
  const fixture = makeFixture(t, { n: 2 })
  const lines = baseLines(fixture, seqs1(
    [PASS, PASS],
    [PASS, PASS]
  ))
  lines.push(logLine({ route: 'hy3-free', arm: 'no-tune', attempt: 3, outcome: 'SCHEDULED', replacement: true }))
  writeLog(fixture, lines)
  const r = analyze(fixture)
  assert.equal(r.pending.replacements, 1)
  assert.deepEqual(r.pending.replacementSlots, [{ route: 'hy3-free', arm: 'no-tune', attempt: 3 }])
  assert.equal(r.state, 'incomplete')
  assert.equal(r.decision, null)
})

test('SWEEP_ABORTED marks the evidence suspect and never evaluates', (t) => {
  const fixture = makeFixture(t, { n: 2 })
  const lines = baseLines(fixture, seqs1(
    [PASS, 'HARNESS_ERROR'],
    [PASS, PASS]
  ))
  lines.push(logLine({ route: 'hy3-free', arm: 'no-tune', attempt: 2, outcome: 'SWEEP_ABORTED' }))
  writeLog(fixture, lines)
  const r = analyze(fixture)
  assert.equal(r.state, 'aborted')
  assert.equal(r.evaluated, false)
  assert.equal(r.abortedBy.outcome, 'SWEEP_ABORTED')
  assert.equal(r.abortedBy.route, 'hy3-free')
  assert.equal(r.abortedBy.attempt, 2)
  assert.match(renderPlain(r), /aborted — sweep terminated at/)
})

test('an ABORT_ACKNOWLEDGED line is history, not a trial outcome', (t) => {
  // --resume-after-abort records the operator's decision against the aborted
  // slot; it must not overwrite that slot's real outcome in the analysis.
  const fixture = makeFixture(t, { n: 2 })
  const lines = baseLines(fixture, seqs1(
    [PASS, 'HARNESS_ERROR'],
    [PASS, PASS]
  ))
  lines.push(logLine({ route: 'hy3-free', arm: 'no-tune', attempt: 2, outcome: 'SWEEP_ABORTED' }))
  lines.push(logLine({ route: 'hy3-free', arm: 'no-tune', attempt: 2, outcome: 'ABORT_ACKNOWLEDGED' }))
  writeLog(fixture, lines)
  const r = analyze(fixture)
  assert.equal(r.state, 'aborted')
  const arm = r.routes.find(rt => rt.route === 'hy3-free').arms.find(a => a.arm === 'no-tune')
  assert.equal(arm.outcomes.HARNESS_ERROR, 1)
  assert.equal(arm.outcomes.ABORT_ACKNOWLEDGED, undefined)
})

test('an empty runs dir reports no-evidence and exits the decision', (t) => {
  const fixture = makeFixture(t)
  const r = analyze(fixture)
  assert.equal(r.state, 'no-evidence')
  assert.equal(r.evaluated, false)
  assert.equal(r.decision, null)
  assert.equal(r.pooledIncludedRoutes.length, 0)
})

// ---------------------------------------------------------------------------
// Replacements and the denominator
// ---------------------------------------------------------------------------

test('replaceable trials are excluded from the denominator and replaced at the same arm/route', (t) => {
  const fixture = makeFixture(t, { n: 2 })
  const lines = baseLines(fixture, seqs1(
    ['PROVIDER_ERROR', PASS],
    [PASS, PASS]
  ))
  lines.push(logLine({ route: 'hy3-free', arm: 'no-tune', attempt: 3, outcome: 'SCHEDULED', replacement: true }))
  lines.push(logLine({ route: 'hy3-free', arm: 'no-tune', attempt: 3, outcome: PASS, replacement: true }))
  writeLog(fixture, lines)
  const r = analyze(fixture)
  assert.equal(r.state, 'complete')
  assert.equal(r.pending.replacements, 0)
  const control = r.pooled['no-tune']
  // 3 attempts published; the PROVIDER_ERROR attempt is published but never scored.
  assert.equal(control.attempts, 3)
  assert.equal(control.replaceable, 1)
  assert.equal(control.scorable, 2)
  assert.equal(control.noSubmission, 0)
  assert.equal(control.noSubmissionRate, 0)
  assert.equal(r.routes[0].replacementsUsed, 1)
  assert.equal(r.routes[0].replacementCap, 5)
  assert.match(renderPlain(r), /PROVIDER_ERROR×1/)
})

test('evidence packs alone (lost log) still reconstruct the sweep from disk', (t) => {
  const fixture = makeFixture(t, { n: 2 })
  writePack(fixture, { arm: 'no-tune', route: 'hy3-free', attempt: 1, outcome: 'PROVIDER_ERROR' })
  writePack(fixture, { arm: 'no-tune', route: 'hy3-free', attempt: 2, outcome: PASS })
  writePack(fixture, { arm: 'no-tune', route: 'hy3-free', attempt: 3, outcome: PASS })
  writePack(fixture, { arm: 'ledger-lite', route: 'hy3-free', attempt: 1, outcome: PASS })
  writePack(fixture, { arm: 'ledger-lite', route: 'hy3-free', attempt: 2, outcome: PASS })
  const r = analyze(fixture)
  assert.equal(r.state, 'complete', 'packs cover every base slot despite no log')
  assert.equal(r.baseSlots.executed, 4)
  const control = r.pooled['no-tune']
  assert.equal(control.scorable, 2, 'the PROVIDER_ERROR attempt-1 is excluded, the replacement attempt-3 is scored')
  assert.equal(control.replaceable, 1)
  assert.equal(r.routes[0].replacementsUsed, 1, 'replacement packs count toward the cap even without a log')
  assert.equal(r.decision.supported, false)
})

test('a dropped route is excluded from pooled analysis and blocks a supported exit', (t) => {
  const routes = ['r1', 'r2']
  const fixture = makeFixture(t, { routes, n: 2, models: routes.map(id => ({ id, model: id })) })
  const lines = baseLines(fixture, {
    r1: { 'no-tune': [SUB, SUB], 'ledger-lite': [PASS, PASS] },
    r2: { 'no-tune': [SUB, SUB], 'ledger-lite': [FAIL, FAIL] }
  })
  lines.push(logLine({ route: 'r2', arm: null, attempt: null, outcome: 'ROUTE_DROPPED' }))
  writeLog(fixture, lines)
  const r = analyze(fixture)
  assert.equal(r.state, 'complete-with-dropped-routes')
  assert.equal(r.evaluated, true, 'the surviving route is still analysed')
  assert.deepEqual(r.droppedRoutes, ['r2'])
  assert.deepEqual(r.pooledIncludedRoutes, ['r1'])
  const arm = r.routes.find(x => x.route === 'r2').arms.find(a => a.arm === 'no-tune')
  assert.equal(arm.noSubmission, 2, 'dropped-route attempts stay published per-route')
  assert.equal(r.pooled['no-tune'].noSubmission, 2, 'pooled counts only r1')
  assert.equal(r.decision.supported, false)
  assert.match(renderPlain(r), /ROUTE DROPPED/)
})

test('a log route no registered claim route knows about is reported, not fatal', (t) => {
  const fixture = makeFixture(t, { n: 1 })
  const lines = baseLines(fixture, seqs1([PASS], [PASS]))
  lines.push(logLine({ route: 'ghost-route', arm: 'no-tune', attempt: 1, outcome: PASS }))
  writeLog(fixture, lines)
  const r = analyze(fixture)
  assert.deepEqual(r.unknownLogRoutes, ['ghost-route'])
  assert.equal(r.baseSlots.executed, 2, 'the unknown-route trial is ignored')
  assert.equal(r.state, 'complete')
  assert.match(renderPlain(r), /did not resolve to a registered route/)
})

test('TUNE_CONTAMINATED trials are reported and excluded from scoring, never replaced', (t) => {
  const fixture = makeFixture(t, { n: 2 })
  writeLog(fixture, baseLines(fixture, seqs1(
    ['TUNE_CONTAMINATED', PASS],
    [PASS, PASS]
  )))
  const r = analyze(fixture)
  assert.equal(r.state, 'complete')
  const control = r.pooled['no-tune']
  assert.equal(control.reported, 1)
  assert.equal(control.outcomes.TUNE_CONTAMINATED, 1)
  assert.equal(control.scorable, 1, 'contaminated trial never reaches the metric denominator')
  assert.equal(r.pending.replacements, 0)
  assert.equal(r.routes[0].replacementsUsed, 0)
  assert.match(renderPlain(r), /TUNE_CONTAMINATED×1/)
})

// ---------------------------------------------------------------------------
// Null Fisher p (an arm with no scorable trials) renders, never crashes
// ---------------------------------------------------------------------------

test('a zero-scorable control arm leaves Fisher p null and still renders', (t) => {
  const fixture = makeFixture(t, { n: 2 })
  writeLog(fixture, baseLines(fixture, seqs1(
    ['TUNE_CONTAMINATED', 'TUNE_CONTAMINATED'],
    [PASS, PASS]
  )))
  const r = analyze(fixture)
  assert.equal(r.state, 'complete')
  assert.equal(r.evaluated, true)
  assert.deepEqual(r.fisher.table, [[0, 0], [0, 2]], 'the 2x2 is still published')
  assert.equal(r.fisher.p, null)
  assert.equal(r.decision.supported, false)
  const fisherCond = r.decision.conditions.find(c => c.id === 'fisher')
  assert.equal(fisherCond.met, false)
  assert.match(fisherCond.detail, /cannot compute — no scorable trials in one or both arms/)
  const plain = renderPlain(r)
  assert.match(plain, /Fisher exact on pooled 2x2 \[\[0, 0\], \[0, 2\]\] p=n\/a \(no scorable trials in an arm\)/)
  assert.match(plain, /DECISION NOT SUPPORTED/)
})

test('an all-routes-dropped sweep renders a null Fisher p without crashing', (t) => {
  const routes = ['r1', 'r2']
  const fixture = makeFixture(t, { routes, n: 2, models: routes.map(id => ({ id, model: id })) })
  const lines = baseLines(fixture, {
    r1: { 'no-tune': [SUB, SUB], 'ledger-lite': [PASS, PASS] },
    r2: { 'no-tune': [SUB, SUB], 'ledger-lite': [FAIL, FAIL] }
  })
  lines.push(logLine({ route: 'r1', arm: null, attempt: null, outcome: 'ROUTE_DROPPED' }))
  lines.push(logLine({ route: 'r2', arm: null, attempt: null, outcome: 'ROUTE_DROPPED' }))
  writeLog(fixture, lines)
  const r = analyze(fixture)
  assert.equal(r.state, 'complete-with-dropped-routes')
  assert.equal(r.evaluated, true)
  assert.deepEqual(r.droppedRoutes, ['r1', 'r2'])
  assert.deepEqual(r.pooledIncludedRoutes, [])
  assert.deepEqual(r.fisher.table, [[0, 0], [0, 0]])
  assert.equal(r.fisher.p, null)
  const plain = renderPlain(r)
  assert.match(plain, /ROUTE DROPPED/)
  assert.match(plain, /Fisher exact on pooled 2x2 \[\[0, 0\], \[0, 0\]\] p=n\/a \(no scorable trials in an arm\)/)
})

// ---------------------------------------------------------------------------
// Replacement cap enforcement (a lost log must not reset the cap)
// ---------------------------------------------------------------------------

test('reaching the replacement cap exactly keeps the route pooled', (t) => {
  const fixture = makeFixture(t, { n: 2 })
  const lines = baseLines(fixture, seqs1(
    [PASS, PASS],
    [PASS, PASS]
  ))
  for (const attempt of [3, 4, 5, 6, 7]) {
    lines.push(logLine({ route: 'hy3-free', arm: 'ledger-lite', attempt, outcome: 'SCHEDULED', replacement: true }))
    lines.push(logLine({ route: 'hy3-free', arm: 'ledger-lite', attempt, outcome: PASS, replacement: true }))
  }
  writeLog(fixture, lines)
  const r = analyze(fixture)
  assert.equal(r.routes[0].replacementsUsed, 5)
  assert.equal(r.routes[0].dropped, false, 'exactly at the cap the route survives')
  assert.deepEqual(r.droppedRoutes, [])
  assert.equal(r.state, 'complete')
  assert.deepEqual(r.pooledIncludedRoutes, ['hy3-free'])
})

test('exceeding the replacement cap drops the route even when the log lacks the ROUTE_DROPPED line', (t) => {
  const fixture = makeFixture(t, { n: 2 })
  const lines = baseLines(fixture, seqs1(
    [PASS, PASS],
    [PASS, PASS]
  ))
  for (const attempt of [3, 4, 5, 6, 7, 8]) {
    lines.push(logLine({ route: 'hy3-free', arm: 'ledger-lite', attempt, outcome: 'SCHEDULED', replacement: true }))
    lines.push(logLine({ route: 'hy3-free', arm: 'ledger-lite', attempt, outcome: PASS, replacement: true }))
  }
  writeLog(fixture, lines)
  const r = analyze(fixture)
  assert.equal(r.routes[0].replacementsUsed, 6)
  assert.equal(r.routes[0].dropped, true)
  assert.deepEqual(r.droppedRoutes, ['hy3-free'])
  assert.equal(r.state, 'complete-with-dropped-routes')
  assert.equal(r.evaluated, true)
  assert.deepEqual(r.pooledIncludedRoutes, [], 'an over-capped route is never pooled back in')
  assert.equal(r.fisher.p, null)
  assert.match(renderPlain(r), /ROUTE DROPPED/)
})

test('replacement packs on disk without a drop line count toward the cap and drop the route', (t) => {
  const fixture = makeFixture(t, { n: 2 })
  // The log covers only the two base attempts: its SCHEDULED lines and the
  // ROUTE_DROPPED line were lost. The six replacement packs on disk are direct
  // evidence the cap was exceeded, exactly the lost-log finding addressed.
  writeLog(fixture, baseLines(fixture, seqs1(
    [PASS, PASS],
    [PASS, PASS]
  )))
  for (const attempt of [3, 4, 5, 6, 7, 8]) {
    writePack(fixture, { arm: 'ledger-lite', route: 'hy3-free', attempt, outcome: PASS })
  }
  const r = analyze(fixture)
  assert.equal(r.routes[0].replacementsUsed, 6, 'disk evidence must not be reset by the missing log lines')
  assert.equal(r.routes[0].dropped, true)
  assert.deepEqual(r.droppedRoutes, ['hy3-free'])
  assert.equal(r.state, 'complete-with-dropped-routes')
  assert.equal(r.evaluated, true)
  assert.deepEqual(r.pooledIncludedRoutes, [])
  assert.equal(r.fisher.p, null)
  assert.equal(r.decision.supported, false)
  const plain = renderPlain(r)
  assert.match(plain, /replacements 6\/5/)
  assert.match(plain, /ROUTE DROPPED — replacement cap reached/)
})

// ---------------------------------------------------------------------------
// Dot/dash route fidelity end to end
// ---------------------------------------------------------------------------

test('log-id and pack forms of the config-derived canonical route resolve to the dotted claim route', (t) => {
  const claimRoute = 'nemotron-3.5-lightning-free'
  // A config that renames the route the way Droid keys free BYOK providers:
  // the id contains the dotted claim name, so lib/sweep.js resolveRoute
  // substring matching resolves it and everything downstream uses the
  // canonical id (log field) and its lossless slug (pack directory).
  const configId = 'custom:nemotron-3.5-lightning-free-anything'
  const fixture = makeFixture(t, {
    routes: [claimRoute],
    n: 4,
    models: [{ id: configId, model: configId }],
    logRouteOf: { [claimRoute]: configId },
    claimOverrides: { id: 'dt-dotslash' }
  })
  const seqs = { [claimRoute]: { 'no-tune': [SUB, SUB, SUB, SUB], 'ledger-lite': [PASS, PASS, PASS, PASS] } }
  writeLog(fixture, baseLines(fixture, seqs))
  for (const arm of ['no-tune', 'ledger-lite']) {
    for (let a = 1; a <= 4; a++) {
      writePack(fixture, {
        arm,
        route: claimRoute,
        attempt: a,
        outcome: seqs[claimRoute][arm][a - 1],
        segment: routeSlug(configId)
      })
    }
  }
  const r = analyze(fixture)
  assert.equal(r.state, 'complete')
  assert.equal(r.routes[0].canonical, configId)
  assert.equal(r.pooledIncludedRoutes[0], claimRoute, 'the dotted claim route is the published identity')
  assert.equal(r.pooled['no-tune'].noSubmission, 4)
  assert.equal(r.pooled['ledger-lite'].noSubmission, 0)
  assert.deepEqual(r.fisher.table, [[4, 0], [0, 4]])
  assert.ok(r.fisher.p < 0.05 && r.fisher.p > 0.02, `p=${r.fisher.p}`)
  assert.equal(r.decision.supported, true, 'drop 100pp, p=0.0286, verified-pass not lower')
  assert.match(renderPlain(r), /actual custom:nemotron-3\.5-lightning-free-anything/)
})

test('dashed log and pack spellings fall back to the dotted claim route via alphanumeric collapse', (t) => {
  const claimRoute = 'nemotron-3.5-lightning-free'
  // Log carries the lossless slug form of the canonical id (no "custom:"
  // prefix); the packs on disk were renamed to the dashed variant. Both must
  // map back to the claim route.
  const slugForm = 'nemotron-3.5-lightning-free-anything'
  const dashedSegment = 'nemotron-3-5-lightning-free-anything'
  const fixture = makeFixture(t, {
    routes: [claimRoute],
    n: 1,
    models: [{ id: 'custom:' + slugForm, model: 'custom:' + slugForm }],
    logRouteOf: { [claimRoute]: slugForm },
    claimOverrides: { id: 'dt-dashes' }
  })
  writeLog(fixture, [
    logLine({ route: slugForm, arm: 'no-tune', attempt: 1, outcome: SUB }),
    logLine({ route: slugForm, arm: 'ledger-lite', attempt: 1, outcome: PASS })
  ])
  writePack(fixture, { arm: 'no-tune', route: claimRoute, attempt: 1, outcome: SUB, segment: dashedSegment })
  writePack(fixture, { arm: 'ledger-lite', route: claimRoute, attempt: 1, outcome: PASS, segment: dashedSegment })
  const r = analyze(fixture)
  assert.equal(r.state, 'complete')
  assert.equal(r.pooledIncludedRoutes[0], claimRoute)
  assert.equal(r.pooled['no-tune'].noSubmission, 1)
  assert.equal(r.pooled['ledger-lite'].noSubmission, 0)
})

// ---------------------------------------------------------------------------
// Robustness: corrupt log lines and unknown outcomes
// ---------------------------------------------------------------------------

test('a corrupt sweep-log line is skipped, never fatal', (t) => {
  const fixture = makeFixture(t, { n: 1 })
  const good = baseLines(fixture, seqs1([SUB], [PASS])).map(l => JSON.stringify(l))
  const dir = path.join(fixture.runsDir, fixture.claim.id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'sweep-log.jsonl'),
    [good[0], '{ this is not json {{{', good[1], 'not-json at all'].join('\n') + '\n')
  const r = analyze(fixture)
  assert.equal(r.state, 'complete', 'a corrupt line must not poison the whole log')
  assert.equal(r.baseSlots.executed, 2)
  assert.deepEqual(r.fisher.table, [[1, 0], [0, 1]])
  assert.match(renderPlain(r), /DECISION NOT SUPPORTED/)
})

test('an executed line with an unknown outcome is tallied as other, not fatal', (t) => {
  const fixture = makeFixture(t, { n: 2 })
  writeLog(fixture, [
    logLine({ route: 'hy3-free', arm: 'no-tune', attempt: 1, outcome: SUB }),
    logLine({ route: 'hy3-free', arm: 'no-tune', attempt: 2, outcome: SUB }),
    logLine({ route: 'hy3-free', arm: 'ledger-lite', attempt: 1, outcome: PASS }),
    logLine({ route: 'hy3-free', arm: 'ledger-lite', attempt: 2, outcome: 'SOME_STRANGE_OUTCOME' })
  ])
  const r = analyze(fixture)
  assert.equal(r.state, 'complete')
  assert.equal(r.evaluated, true)
  const tune = r.pooled['ledger-lite']
  assert.equal(tune.other, 1, 'the unknown outcome is published but never scored')
  assert.equal(tune.scorable, 1)
  assert.equal(tune.outcomes.SOME_STRANGE_OUTCOME, 1)
  assert.deepEqual(r.fisher.table, [[2, 0], [0, 1]])
  assert.equal(r.decision.supported, false)
})

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

test('renderJson serialises the full report and renderPlain renders the claim line', (t) => {
  const fixture = makeFixture(t, { n: 1 })
  writeLog(fixture, baseLines(fixture, seqs1([SUB], [PASS])))
  const r = analyze(fixture)
  const parsed = JSON.parse(renderJson(r))
  assert.equal(parsed.state, 'complete')
  assert.equal(parsed.evaluated, true)
  assert.equal(parsed.decision.supported, false, 'n=1 alone can never reach p<0.05')
  assert.equal(parsed.fisher.p, 1)
  assert.deepEqual(parsed.fisher.table, [[1, 0], [0, 1]])
  assert.deepEqual(parsed.arms, ['no-tune', 'ledger-lite'])
  const plain = renderPlain(r)
  assert.match(plain, /CLAIM REPORT dt-test-claim/)
  assert.match(plain, /state\s+complete — all 2 base slots/)
  assert.match(plain, /NO_SUBMISSION 1 \(100\.0%\)/)
  assert.match(plain, /DECISION NOT SUPPORTED — condition 2 failed/)
})

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

test('CLI exits 0 for a supported claim and prints the decision', (t) => {
  const fixture = makeFixture(t, { n: 10 })
  writeLog(fixture, baseLines(fixture, seqs1(
    [SUB, SUB, SUB, SUB, SUB, PASS, PASS, PASS, PASS, PASS],
    [PASS, PASS, PASS, PASS, PASS, FAIL, FAIL, FAIL, FAIL, FAIL]
  )))
  const r = run(['--claim', fixture.claimPath, '--runs-dir', fixture.runsDir, '--config', fixture.configPath])
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /DECISION SUPPORTED/)
  assert.match(r.stdout, /p=0\.03(25|26)/)
})

test('CLI exits 1 when a condition fails, with the observed rates published', (t) => {
  const fixture = makeFixture(t, { n: 10 })
  writeLog(fixture, baseLines(fixture, seqs1(
    [SUB, SUB, SUB, SUB, SUB, FAIL, FAIL, FAIL, FAIL, FAIL],
    [SUB, SUB, SUB, FAIL, FAIL, FAIL, FAIL, FAIL, FAIL, FAIL]
  )))
  const r = run(['--claim', fixture.claimPath, '--runs-dir', fixture.runsDir, '--config', fixture.configPath])
  assert.equal(r.code, 1, r.stderr)
  assert.match(r.stdout, /DECISION NOT SUPPORTED/)
  assert.match(r.stdout, /condition 1 failed/)
})

test('CLI --json emits a parseable report', (t) => {
  const fixture = makeFixture(t, { n: 4 })
  writeLog(fixture, baseLines(fixture, seqs1(
    [SUB, SUB, SUB, SUB],
    [PASS, PASS, PASS, PASS]
  )))
  const r = run(['--claim', fixture.claimPath, '--runs-dir', fixture.runsDir, '--config', fixture.configPath, '--json'])
  assert.equal(r.code, 0, r.stderr)
  const parsed = JSON.parse(r.stdout)
  assert.equal(parsed.claimId, 'dt-test-claim')
  assert.equal(parsed.state, 'complete')
  assert.equal(parsed.decision.supported, true)
  assert.ok(parsed.fisher.p < 0.05, `p=${parsed.fisher.p}`)
  assert.deepEqual(parsed.fisher.table, [[4, 0], [0, 4]])
  assert.deepEqual(parsed.routes.map(x => x.route), ['hy3-free'])
})

test('CLI usage errors exit 2', (t) => {
  const fixture = makeFixture(t, { n: 1 })
  assert.equal(run([]).code, 2)
  assert.equal(run(['--bogus']).code, 2)
  assert.equal(run(['--claim', 'definitely-not-a-claim']).code, 2)
  const r = run(['--claim', fixture.claimPath, '--runs-dir', path.join(os.tmpdir(), 'no-such-runs-dir-xyz')])
  assert.equal(r.code, 2)
  assert.match(r.stderr, /runs dir not found/)
})

test('CLI on the real preregistered claim with no evidence exits 1 as no-evidence', (t) => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'droidtune-claimreport-real-'))
  t.after(() => rmSync(temp, { recursive: true, force: true }))
  const runsDir = path.join(temp, 'runs')
  mkdirSync(runsDir, { recursive: true })
  const configPath = path.join(temp, 'settings.json')
  writeFileSync(configPath, JSON.stringify({
    customModels: ['hy3-free', 'nemotron-3.5-lightning-free', 'laguna-s-2.1-free', 'nemotron-3-ultra-free']
      .map(id => ({ id, model: id }))
  }))
  const r = run(['dt-v1-ledger-lite-nosub', '--runs-dir', runsDir, '--config', configPath, '--json'])
  // An unrun claim is not a conclusion: exit 1, state no-evidence.
  assert.equal(r.code, 1, r.stderr)
  const parsed = JSON.parse(r.stdout)
  assert.equal(parsed.claimId, 'dt-v1-ledger-lite-nosub')
  assert.equal(parsed.state, 'no-evidence')
  // The preregistered design is reproduced faithfully: 4 routes x 2 arms x 10.
  assert.equal(parsed.design.baseTrials, 80)
  assert.deepEqual(parsed.routes.map(x => x.route), [
    'hy3-free', 'nemotron-3.5-lightning-free', 'laguna-s-2.1-free', 'nemotron-3-ultra-free'])
})

test('CLI exits 1 for a dropped route even when a surviving route is complete', (t) => {
  const routes = ['r1', 'r2']
  const fixture = makeFixture(t, { routes, n: 2, models: routes.map(id => ({ id, model: id })) })
  const lines = baseLines(fixture, {
    r1: { 'no-tune': [SUB, SUB], 'ledger-lite': [PASS, PASS] },
    r2: { 'no-tune': [SUB, SUB], 'ledger-lite': [FAIL, FAIL] }
  })
  lines.push(logLine({ route: 'r2', arm: null, attempt: null, outcome: 'ROUTE_DROPPED' }))
  writeLog(fixture, lines)
  const r = run(['--claim', fixture.claimPath, '--runs-dir', fixture.runsDir, '--config', fixture.configPath])
  assert.equal(r.code, 1, r.stderr)
  assert.match(r.stdout, /ROUTE DROPPED/)
  assert.match(r.stdout, /DECISION NOT SUPPORTED/)
})

test('CLI exits 1 for an incomplete sweep without evaluating the decision', (t) => {
  const fixture = makeFixture(t, { n: 2 })
  writeLog(fixture, [
    logLine({ route: 'hy3-free', arm: 'no-tune', attempt: 1, outcome: SUB }),
    logLine({ route: 'hy3-free', arm: 'no-tune', attempt: 2, outcome: SUB }),
    logLine({ route: 'hy3-free', arm: 'ledger-lite', attempt: 1, outcome: PASS })
  ])
  const r = run(['--claim', fixture.claimPath, '--runs-dir', fixture.runsDir, '--config', fixture.configPath])
  assert.equal(r.code, 1, r.stderr)
  assert.match(r.stdout, /DECISION NOT EVALUATED/)
})

test('CLI exits 1 for an aborted sweep without evaluating the decision', (t) => {
  const fixture = makeFixture(t, { n: 2 })
  const lines = baseLines(fixture, seqs1(
    [PASS, 'HARNESS_ERROR'],
    [PASS, PASS]
  ))
  lines.push(logLine({ route: 'hy3-free', arm: 'no-tune', attempt: 2, outcome: 'SWEEP_ABORTED' }))
  writeLog(fixture, lines)
  const r = run(['--claim', fixture.claimPath, '--runs-dir', fixture.runsDir, '--config', fixture.configPath])
  assert.equal(r.code, 1, r.stderr)
  assert.match(r.stdout, /aborted — sweep terminated at/)
  assert.match(r.stdout, /DECISION NOT EVALUATED/)
})

test('CLI renders a null Fisher p (zero-scorable arm) without a stack trace', (t) => {
  const fixture = makeFixture(t, { n: 2 })
  writeLog(fixture, baseLines(fixture, seqs1(
    ['TUNE_CONTAMINATED', 'TUNE_CONTAMINATED'],
    [PASS, PASS]
  )))
  const r = run(['--claim', fixture.claimPath, '--runs-dir', fixture.runsDir, '--config', fixture.configPath])
  assert.equal(r.code, 1, r.stderr)
  assert.doesNotMatch(r.stderr, /TypeError| at /, 'a null Fisher p must not crash the renderer')
  assert.match(r.stdout, /Fisher exact on pooled 2x2 \[\[0, 0\], \[0, 2\]\] p=n\/a \(no scorable trials in an arm\)/)
})

test('CLI renders an all-routes-dropped sweep without a stack trace', (t) => {
  const routes = ['r1', 'r2']
  const fixture = makeFixture(t, { routes, n: 2, models: routes.map(id => ({ id, model: id })) })
  const lines = baseLines(fixture, {
    r1: { 'no-tune': [SUB, SUB], 'ledger-lite': [PASS, PASS] },
    r2: { 'no-tune': [SUB, SUB], 'ledger-lite': [FAIL, FAIL] }
  })
  lines.push(logLine({ route: 'r1', arm: null, attempt: null, outcome: 'ROUTE_DROPPED' }))
  lines.push(logLine({ route: 'r2', arm: null, attempt: null, outcome: 'ROUTE_DROPPED' }))
  writeLog(fixture, lines)
  const r = run(['--claim', fixture.claimPath, '--runs-dir', fixture.runsDir, '--config', fixture.configPath])
  assert.equal(r.code, 1, r.stderr)
  assert.doesNotMatch(r.stderr, /TypeError| at /)
  assert.match(r.stdout, /ROUTE DROPPED/)
  assert.match(r.stdout, /p=n\/a \(no scorable trials in an arm\)/)
})

test('CLI drops an over-capped route evidenced only on disk and exits 1', (t) => {
  const fixture = makeFixture(t, { n: 2 })
  writeLog(fixture, baseLines(fixture, seqs1(
    [PASS, PASS],
    [PASS, PASS]
  )))
  for (const attempt of [3, 4, 5, 6, 7, 8]) {
    writePack(fixture, { arm: 'ledger-lite', route: 'hy3-free', attempt, outcome: PASS })
  }
  const r = run(['--claim', fixture.claimPath, '--runs-dir', fixture.runsDir, '--config', fixture.configPath])
  assert.equal(r.code, 1, r.stderr)
  assert.match(r.stdout, /replacements 6\/5/)
  assert.match(r.stdout, /ROUTE DROPPED — replacement cap reached/)
})

// ---------------------------------------------------------------------------
// Closure (--close): the one write this tool performs
// ---------------------------------------------------------------------------

const readClaimFile = (fixture) => JSON.parse(readFileSync(fixture.claimPath, 'utf8'))

// n=10 single route: a 50pp drop with Fisher p = 0.033 and an equal
// VERIFIED_PASS rate, so all three registered conditions hold on complete
// evidence. (n=2 cannot reach p < 0.05 at all.)
function completeSupported (t) {
  const fixture = makeFixture(t, { n: 10 })
  writeLog(fixture, baseLines(fixture, seqs1(
    [SUB, SUB, SUB, SUB, SUB, PASS, PASS, PASS, PASS, PASS],
    [PASS, PASS, PASS, PASS, PASS, FAIL, FAIL, FAIL, FAIL, FAIL]
  )))
  return fixture
}

// Same shape, but neither arm ever submits: complete evidence, no drop.
function completeNotSupported (t) {
  const fixture = makeFixture(t, { n: 10 })
  writeLog(fixture, baseLines(fixture, seqs1(Array(10).fill(SUB), Array(10).fill(SUB))))
  return fixture
}

test('closeClaim moves a preregistered claim to reported with a derived conclusion', (t) => {
  const fixture = completeSupported(t)
  const result = analyze(fixture)
  assert.equal(result.state, 'complete')
  const closure = closeClaim({ claimPath: fixture.claimPath, result, now: new Date('2026-08-21T00:00:00.000Z') })
  assert.equal(closure.action, 'closed')
  assert.equal(closure.wrote, true)

  const onDisk = readClaimFile(fixture)
  assert.equal(onDisk.status, CLOSED_STATUS)
  assert.equal(onDisk.conclusion.verdict, 'supported')
  assert.equal(onDisk.conclusion.supported, true)
  assert.equal(onDisk.conclusion.state, 'complete')
  assert.equal(onDisk.conclusion.closedAt, '2026-08-21T00:00:00.000Z')
  assert.equal(onDisk.conclusion.closedBy, 'scripts/claim-report.js --close')
  // The registered "Not run" sentence stays byte-identical; the conclusion
  // says outright that it is scoped to registration time, so a reader of the
  // JSON is never left holding two statements that contradict each other.
  assert.equal(onDisk.conclusion.supersedesRegisteredNotRunClause, true)
  const registered = JSON.parse(readFileSync(fixture.claimPath, 'utf8'))
  assert.equal(registered.limitations, fixture.claim.limitations)
  // The conclusion cites evidence by repo-relative path and reports what it
  // actually analysed, at the n the claim registered.
  assert.equal(onDisk.conclusion.evidence.sweepLog, `runs/${fixture.claim.id}/sweep-log.jsonl`)
  assert.deepEqual(onDisk.conclusion.evidence.pooledRoutes, ['hy3-free'])
  assert.deepEqual(onDisk.conclusion.evidence.droppedRoutes, [])
  assert.equal(onDisk.conclusion.evidence.nPerArmPerRoute, fixture.claim.design.nPerArmPerRoute)
  assert.equal(onDisk.conclusion.evidence.baseTrials, 20)
  assert.ok(onDisk.conclusion.conditions.every(c => c.met))
})

test('closure leaves every registered field byte-for-byte identical', (t) => {
  const fixture = completeNotSupported(t)
  const before = readClaimFile(fixture)
  closeClaim({ claimPath: fixture.claimPath, result: analyze(fixture) })
  const after = readClaimFile(fixture)
  for (const key of Object.keys(before)) {
    if (CLOSURE_WRITABLE_KEYS.includes(key)) continue
    assert.equal(JSON.stringify(after[key]), JSON.stringify(before[key]), `closure modified registered field ${key}`)
  }
  // Exactly two things changed: the status word and the appended conclusion.
  assert.deepEqual(
    Object.keys(after).filter(k => !Object.hasOwn(before, k)),
    ['conclusion']
  )
  assert.equal(after.status, CLOSED_STATUS)
  assert.equal(before.status, 'preregistered')
})

test('closure records a not-supported verdict just as readily as a supported one', (t) => {
  const fixture = completeNotSupported(t)
  const closure = closeClaim({ claimPath: fixture.claimPath, result: analyze(fixture) })
  assert.equal(closure.action, 'closed')
  assert.equal(closure.conclusion.verdict, 'not-supported')
  assert.equal(closure.conclusion.supported, false)
})

test('re-closing the same evidence is a no-op, not a rewrite', (t) => {
  const fixture = completeSupported(t)
  closeClaim({ claimPath: fixture.claimPath, result: analyze(fixture), now: new Date('2026-08-21T00:00:00.000Z') })
  const firstBytes = readFileSync(fixture.claimPath, 'utf8')
  // A later clock must not produce a second closedAt.
  const again = closeClaim({ claimPath: fixture.claimPath, result: analyze(fixture), now: new Date('2026-09-01T00:00:00.000Z') })
  assert.equal(again.action, 'unchanged')
  assert.equal(again.wrote, false)
  assert.equal(readFileSync(fixture.claimPath, 'utf8'), firstBytes, 'an idempotent re-close must not touch the file')
})

test('closure refuses incomplete, aborted, and no-evidence sweeps without writing', (t) => {
  const cases = [
    ['incomplete', (fixture) => {
      writeLog(fixture, [logLine({ route: 'hy3-free', arm: 'no-tune', attempt: 1, outcome: SUB })])
    }],
    ['aborted', (fixture) => {
      const lines = baseLines(fixture, seqs1([SUB, SUB], [PASS, PASS]))
      lines.push(logLine({ route: 'hy3-free', arm: null, attempt: null, outcome: 'SWEEP_ABORTED' }))
      writeLog(fixture, lines)
    }],
    ['no-evidence', () => {}]
  ]
  for (const [name, seed] of cases) {
    const fixture = makeFixture(t, { n: 2 })
    seed(fixture)
    const before = readFileSync(fixture.claimPath, 'utf8')
    const closure = closeClaim({ claimPath: fixture.claimPath, result: analyze(fixture) })
    assert.equal(closure.action, 'refused', `${name} must be refused`)
    assert.equal(closure.refusal.code, 'evidence')
    assert.equal(closure.wrote, false)
    assert.equal(readFileSync(fixture.claimPath, 'utf8'), before, `${name} must leave the claim untouched`)
  }
})

test('closure refuses a sweep that dropped a registered route, however clean the survivor', (t) => {
  const routes = ['r1', 'r2']
  const fixture = makeFixture(t, { routes, n: 2, models: routes.map(id => ({ id, model: id })) })
  const lines = baseLines(fixture, {
    r1: { 'no-tune': [SUB, SUB], 'ledger-lite': [PASS, PASS] },
    r2: { 'no-tune': [SUB, SUB], 'ledger-lite': [PASS, PASS] }
  })
  lines.push(logLine({ route: 'r2', arm: null, attempt: null, outcome: 'ROUTE_DROPPED' }))
  writeLog(fixture, lines)
  const before = readFileSync(fixture.claimPath, 'utf8')
  const closure = closeClaim({ claimPath: fixture.claimPath, result: analyze(fixture) })
  assert.equal(closure.action, 'refused')
  assert.equal(closure.refusal.code, 'evidence')
  assert.match(closure.refusal.message, /every registered route intact/)
  assert.equal(readFileSync(fixture.claimPath, 'utf8'), before)
})

test('closure refuses a claim that is not preregistered', (t) => {
  const fixture = completeSupported(t)
  writeFileSync(fixture.claimPath, JSON.stringify({ ...fixture.claim, status: 'withdrawn' }))
  const closure = closeClaim({ claimPath: fixture.claimPath, result: analyze(fixture) })
  assert.equal(closure.action, 'refused')
  assert.equal(closure.refusal.code, 'status')
  assert.match(closure.refusal.message, /only a "preregistered" claim can be closed/)
})

test('closure refuses inconsistent lifecycle states rather than repairing them', (t) => {
  // A conclusion on a still-open claim, and a closed status with no conclusion:
  // both mean someone hand-edited the file, and neither is this tool's to fix.
  const preWithConclusion = completeSupported(t)
  writeFileSync(preWithConclusion.claimPath, JSON.stringify({
    ...preWithConclusion.claim, conclusion: { verdict: 'supported' }
  }))
  let closure = closeClaim({ claimPath: preWithConclusion.claimPath, result: analyze(preWithConclusion) })
  assert.equal(closure.refusal.code, 'lifecycle')
  assert.match(closure.refusal.message, /still preregistered but already carries a conclusion/)

  const closedNoConclusion = completeSupported(t)
  writeFileSync(closedNoConclusion.claimPath, JSON.stringify({ ...closedNoConclusion.claim, status: CLOSED_STATUS }))
  closure = closeClaim({ claimPath: closedNoConclusion.claimPath, result: analyze(closedNoConclusion) })
  assert.equal(closure.refusal.code, 'lifecycle')
  assert.match(closure.refusal.message, /carries no conclusion/)

  const laundered = completeSupported(t)
  writeFileSync(laundered.claimPath, JSON.stringify({ ...laundered.claim, verdict: 'supported' }))
  closure = closeClaim({ claimPath: laundered.claimPath, result: analyze(laundered) })
  assert.equal(closure.refusal.code, 'lifecycle')
  assert.match(closure.refusal.message, /outside the conclusion block/)
})

test('closure refuses to overwrite a published conclusion when the evidence changed', (t) => {
  const fixture = completeSupported(t)
  closeClaim({ claimPath: fixture.claimPath, result: analyze(fixture) })
  const published = readFileSync(fixture.claimPath, 'utf8')
  // The packs now say something different from what was published.
  writeLog(fixture, baseLines(fixture, seqs1([SUB, SUB], [SUB, SUB])))
  const closure = closeClaim({ claimPath: fixture.claimPath, result: analyze(fixture) })
  assert.equal(closure.action, 'refused')
  assert.equal(closure.refusal.code, 'conflict')
  assert.equal(readFileSync(fixture.claimPath, 'utf8'), published, 'a published conclusion is never overwritten')

  // The same holds when the evidence regressed to incomplete.
  writeLog(fixture, [logLine({ route: 'hy3-free', arm: 'no-tune', attempt: 1, outcome: SUB })])
  const stale = closeClaim({ claimPath: fixture.claimPath, result: analyze(fixture) })
  assert.equal(stale.refusal.code, 'conflict')
  assert.equal(readFileSync(fixture.claimPath, 'utf8'), published)
})

test('conclusionsAgree ignores only who closed the claim and when', () => {
  const a = { verdict: 'supported', supported: true, closedAt: 'x', closedBy: 'y' }
  assert.equal(conclusionsAgree(a, { ...a, closedAt: 'later', closedBy: 'someone else' }), true)
  assert.equal(conclusionsAgree(a, { ...a, supported: false }), false)
  assert.equal(conclusionsAgree(a, undefined), false)
})

test('assertRegisteredFieldsUnchanged catches any edit outside status and conclusion', () => {
  const before = { id: 'c', status: 'preregistered', routes: ['r1'], design: { nPerArmPerRoute: 2 } }
  const ok = { ...before, status: CLOSED_STATUS, conclusion: { verdict: 'supported' } }
  assert.doesNotThrow(() => assertRegisteredFieldsUnchanged(before, ok))
  assert.throws(() => assertRegisteredFieldsUnchanged(before, { ...ok, routes: ['r1', 'r2'] }), /modify registered field "routes"/)
  assert.throws(() => assertRegisteredFieldsUnchanged(before, { ...ok, design: { nPerArmPerRoute: 3 } }), /modify registered field "design"/)
  const dropped = { ...ok }
  delete dropped.routes
  assert.throws(() => assertRegisteredFieldsUnchanged(before, dropped), /dropped registered field "routes"/)
  assert.throws(() => assertRegisteredFieldsUnchanged(before, { ...ok, notes: 'hi' }), /added unregistered field "notes"/)
  assert.deepEqual(CLOSURE_WRITABLE_KEYS, ['status', 'conclusion'])
})

test('CLI --close closes a supported claim, reports it, and stays exit 0', (t) => {
  const fixture = completeSupported(t)
  const r = run(['--claim', fixture.claimPath, '--runs-dir', fixture.runsDir, '--config', fixture.configPath, '--close'])
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /## Closure \(--close\)/)
  assert.match(r.stdout, /status\s+preregistered -> reported/)
  assert.equal(readClaimFile(fixture).status, CLOSED_STATUS)
  // --close is opt-in: an ordinary report never writes.
  const other = completeSupported(t)
  run(['--claim', other.claimPath, '--runs-dir', other.runsDir, '--config', other.configPath])
  assert.equal(readClaimFile(other).status, 'preregistered')
})

test('CLI --close keeps exit 1 for a closed NOT SUPPORTED claim and exposes the closure as JSON', (t) => {
  const fixture = completeNotSupported(t)
  const r = run(['--claim', fixture.claimPath, '--runs-dir', fixture.runsDir, '--config', fixture.configPath, '--close', '--json'])
  assert.equal(r.code, 1, 'the exit code reports the finding, not the bookkeeping')
  const parsed = JSON.parse(r.stdout)
  assert.equal(parsed.closure.action, 'closed')
  assert.equal(parsed.closure.conclusion.verdict, 'not-supported')
  assert.equal(readClaimFile(fixture).status, CLOSED_STATUS)
})

test('CLI --close on incomplete evidence exits 1, says why on stderr, and writes nothing', (t) => {
  const fixture = makeFixture(t, { n: 2 })
  writeLog(fixture, [logLine({ route: 'hy3-free', arm: 'no-tune', attempt: 1, outcome: SUB })])
  const before = readFileSync(fixture.claimPath, 'utf8')
  const r = run(['--claim', fixture.claimPath, '--runs-dir', fixture.runsDir, '--config', fixture.configPath, '--close'])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /refusing to close/)
  assert.match(r.stdout, /REFUSED \(evidence\)/)
  assert.equal(readFileSync(fixture.claimPath, 'utf8'), before)
})

test('a closed claim is no longer sweepable', async (t) => {
  // Not a coincidence to be maintained by hand: closure reuses the registry's
  // "reported" status, and lib/sweep.js already refuses anything not
  // preregistered — so concluding a claim retires it from further sweeping.
  const { loadSweepClaim } = await import('../lib/sweep.js')
  const fixture = completeSupported(t)
  closeClaim({ claimPath: fixture.claimPath, result: analyze(fixture) })
  assert.throws(() => loadSweepClaim(fixture.claimPath), /preregistered/)
})

test('parseArgs maps flags and alias without side effects', () => {
  const opts = parseArgs(['--claim', 'x.json', '--runs-dir', 'r', '--config', 'c', '--json'])
  assert.deepEqual(opts, { claim: 'x.json', runsDir: 'r', config: 'c', json: true, close: false, help: false })
  assert.equal(parseArgs(['--close']).close, true)
  assert.equal(parseArgs(['-h']).help, true)
  assert.equal(parseArgs(['dt-v1-ledger-lite-nosub']).claim, 'dt-v1-ledger-lite-nosub')
  assert.equal(parseArgs(['--claim', 'a.json', 'b.json']).claim, 'a.json', '--claim beats a positional')
})
