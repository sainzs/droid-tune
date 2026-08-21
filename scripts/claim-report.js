#!/usr/bin/env node
// claim-report — preregistered analysis for a `no-submission-rate` claim.
//
// The sweep (lib/sweep.js) collects evidence and reports; it never concludes.
// This script is the separate, deliberate analysis step: it reads the claim
// (the preregistered rules), the append-only sweep log at
// runs/<claim-id>/sweep-log.jsonl, and the evidence packs under
// runs/<arm>/<route>/<task>/attempt-N, then applies ONLY the claim's frozen
// metric definitions and decision rule.
//
//   - Primary metric (claim.primaryMetricDefinition): count(NO_SUBMISSION) /
//     count(trials that reached the model). The denominator includes TIMEOUT
//     and every VERIFIED_* outcome and excludes PROVIDER_ERROR / DROID_ERROR /
//     VERIFIER_ERROR, which never reached the model and are replaced per the
//     claim's exclusionRule (capped per route; past the cap the route drops
//     out of the pooled analysis entirely). TUNE_CONTAMINATED is reported but
//     never scored.
//   - Decision rule (claim.decisionRule): recommend the tune arm only if ALL
//     of (1) pooled NO_SUBMISSION rate at least 25 absolute percentage points
//     below the control arm; (2) two-sided Fisher exact p < 0.05 on the pooled
//     2x2 (arm x submitted/not); (3) pooled VERIFIED_PASS rate not lower than
//     the control. Any failure -> report the observed rates and state the tune
//     is not supported. The metric, the routes, and n are never re-cut after
//     seeing results.
//
// The tool never reports a supported claim from incomplete evidence: a sweep
// that is still running, was aborted by a harness fault, or has a route
// dropped from the pool is reported with its state and exits 1.
//
// --close is the one deliberate write. Analysis alone leaves a run claim
// saying "status: preregistered" and "Not run", which is a false statement
// about the repository once the packs exist. `--close` moves the claim through
// its lifecycle exactly once: preregistered -> reported, plus a `conclusion`
// block derived entirely from the analysis above. It never authors prose,
// never touches a registered field, and refuses (writing nothing) unless the
// evidence is complete and the claim is still preregistered — see
// canCloseClaim() for the full refusal list. A concluded claim is no longer
// sweepable, because lib/sweep.js runs preregistered claims only.
//
// Faithfully handling dot/dash route spellings: the Droid config keys free
// routes by slug-friendlier ids (custom:nemotron-3-5-lightning-free-...) while
// the claim names the same routes with dots (nemotron-3.5-lightning-free).
// Route identity is resolved through the config the sweep used (exact
// id/model match, then a single substring match — exactly lib/sweep.js's
// resolveRoute), with the filesystem slug form and an alphanumeric collapse as
// lossless fallbacks, so the log and the packs map back to the registered
// routes deterministically.
//
// Zero runtime dependencies (node: builtins only) and deterministic output.
//
// Usage:
//   node scripts/claim-report.js [<claim-id|claim.json>] [--runs-dir dir]
//                                [--config file] [--json]
//
// Exit codes:
//   0 supported (all three preregistered conditions met)
//   1 not supported, sweep incomplete/aborted, no evidence, or a dropped route
//   2 usage error
//   (A claim that cannot be read or fails claim validation is an ANALYSIS
//   failure — malformed data is not a usage mistake — and exits 1, not 2.)
import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { routeSlug } from '../lib/paths.js'
import { OUTCOME_CLASSES } from '../lib/runner.js'
import {
  ABORT_OUTCOMES,
  INVALID_OBSERVATION_OUTCOMES,
  REPLACEABLE_OUTCOMES,
  REPLACEMENT_CAP_PER_ROUTE
} from '../lib/sweep.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_CONFIG = path.join(os.homedir(), '.factory', 'settings.json')

// The claim's decisionRule, encoded verbatim. Constants are cited from the
// claim prose rather than parsed from it so the analysis cannot drift.
const REQUIRED_DROP_PP = 0.25 // "(1) the pooled NO_SUBMISSION rate ... at least 25 absolute percentage points below"
const FISHER_ALPHA = 0.05 // "(2) a two-sided Fisher exact test ... gives p < 0.05"

// Which outcomes count in the metric's denominator? "trials that reached the
// model": everything in the runner's outcome vocabulary except the never-
// reached-model replacements, harness faults, the runner's pre-flight budget
// abort, and the reported-but-unscored contamination class. Derived from the
// shared outcome constants so a future outcome class lands in exactly one
// bucket instead of silently leaking.
//
// ABORTED_BUDGET is the runner's pre-flight budget abort (an attempt beyond
// maxTrials, set before any spawn) — the trial never reached the model, so it
// is not a scorable observation. A real sweep passes no budget so this cannot
// occur in a live log, but on-disk/synthetic evidence must still classify it
// honestly: reported as "other", never scored, never replaced.
const PRE_FLIGHT_ABORT_OUTCOMES = ['ABORTED_BUDGET']

const SCORABLE_OUTCOMES = OUTCOME_CLASSES.filter(o =>
  !REPLACEABLE_OUTCOMES.includes(o) &&
  !ABORT_OUTCOMES.includes(o) &&
  !PRE_FLIGHT_ABORT_OUTCOMES.includes(o) &&
  !INVALID_OBSERVATION_OUTCOMES.includes(o)
)

const isDir = (p) => { try { return statSync(p).isDirectory() } catch { return false } }

// ---------------------------------------------------------------------------
// Route identity
// ---------------------------------------------------------------------------

// Collapse punctuation, so dot and dash spellings of the same model resolve to
// the same key (nemotron-3.5-lightning-free == nemotron-3-5-lightning-free).
export function alnumRouteKey (route) {
  return String(route ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

// Resolve a claim route against the Droid config exactly the way lib/sweep.js
// does (exact id/model match, then a single substring match over
// id/model/displayName). Null when the config is absent or ambiguous — the
// callers fall back to the claim route itself, which is the right identity
// when no custom provider renamed it.
export function resolveConfigModel (route, models) {
  const exact = models.find(m => m.id === route || m.model === route)
  if (exact) return exact
  const matches = models.filter(m =>
    [m.id, m.model, m.displayName].some(v => typeof v === 'string' && v.includes(route)))
  if (matches.length !== 1) return null
  return matches[0]
}

// Three layers, computed once from the claim's routes and the config:
//   logRouteToClaim:    canonical model id -> claim route (config-derived),
//                       exact claim route id, the lossless filesystem slug of
//                       the canonical id, and its alphanumeric collapse.
//   packSegmentToClaim: pack route segment -> claim route (slug of the
//                       canonical id, plus the collapse).
//   canonicalOf/packSlugOf: forward claim-route -> canonical id / pack slug,
//                       used for reporting and pack lookup hints.
export function buildRouteIndex (claimRoutes, configModels) {
  const logRouteToClaim = new Map()
  const packSegmentToClaim = new Map()
  const canonicalOf = new Map()
  const packSlugOf = new Map()
  const add = (map, key, value) => { if (!map.has(key)) map.set(key, value) }
  for (const route of claimRoutes) {
    const resolved = resolveConfigModel(route, configModels)
    const canonical = resolved?.id ?? resolved?.model ?? route
    canonicalOf.set(route, canonical)
    packSlugOf.set(route, routeSlug(canonical))
    add(logRouteToClaim, canonical, route)
    add(logRouteToClaim, route, route)
    add(logRouteToClaim, routeSlug(canonical), route)
    add(logRouteToClaim, alnumRouteKey(routeSlug(canonical)), route)
    add(packSegmentToClaim, routeSlug(canonical), route)
    add(packSegmentToClaim, alnumRouteKey(routeSlug(canonical)), route)
  }
  return { logRouteToClaim, packSegmentToClaim, canonicalOf, packSlugOf }
}

export function resolveLogRoute (index, logRoute) {
  if (index.logRouteToClaim.has(logRoute)) return index.logRouteToClaim.get(logRoute)
  const slug = routeSlug(logRoute)
  if (index.logRouteToClaim.has(slug)) return index.logRouteToClaim.get(slug)
  return index.logRouteToClaim.get(alnumRouteKey(slug)) ?? null
}

export function resolvePackSegment (index, segment) {
  if (index.packSegmentToClaim.has(segment)) return index.packSegmentToClaim.get(segment)
  return index.packSegmentToClaim.get(alnumRouteKey(segment)) ?? null
}

// ---------------------------------------------------------------------------
// Claim loading
// ---------------------------------------------------------------------------

export function loadClaim (claimPath) {
  let claim
  try {
    claim = JSON.parse(readFileSync(claimPath, 'utf8'))
  } catch (err) {
    throw new Error(`cannot read claim ${claimPath}: ${err.message}`)
  }
  if (!claim || typeof claim !== 'object' || Array.isArray(claim)) {
    throw new Error(`claim ${claimPath} must be a JSON object`)
  }
  if (typeof claim.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(claim.id)) {
    throw new Error('claim id must be a kebab-case string')
  }
  if (!Array.isArray(claim.arms) || claim.arms.length !== 2 || claim.arms.some(a => typeof a !== 'string' || a === '')) {
    throw new Error('claim-report supports exactly two arms (first is the control arm)')
  }
  if (!Array.isArray(claim.routes) || claim.routes.length === 0 || claim.routes.some(r => typeof r !== 'string' || r === '')) {
    throw new Error('claim routes must be a non-empty list of route ids')
  }
  if (!Array.isArray(claim.population) || claim.population.length !== 1 || typeof claim.population[0] !== 'string') {
    throw new Error('claim population must name exactly one task')
  }
  if (claim.primaryMetric !== 'no-submission-rate') {
    throw new Error(`claim-report implements the no-submission-rate primary metric; this claim declares "${claim.primaryMetric}"`)
  }
  const design = claim.design ?? {}
  if (!Number.isInteger(design.nPerArmPerRoute) || design.nPerArmPerRoute < 1) {
    throw new Error('claim design.nPerArmPerRoute must be a positive integer')
  }
  if (typeof claim.decisionRule !== 'string' || claim.decisionRule === '') {
    throw new Error('claim decisionRule is required')
  }
  if (typeof claim.exclusionRule !== 'string' || claim.exclusionRule === '') {
    throw new Error('claim exclusionRule is required')
  }
  return claim
}

export function readConfigModels (configPath) {
  let cfg
  try {
    cfg = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch {
    return []
  }
  const models = Array.isArray(cfg?.customModels) ? cfg.customModels : []
  // Only identity fields are read — never credentials.
  return models
    .filter(m => m && typeof m === 'object')
    .map(m => ({ id: m.id, model: m.model, displayName: m.displayName }))
}

// ---------------------------------------------------------------------------
// Fisher exact test (two-sided, hypergeometric enumeration)
// ---------------------------------------------------------------------------

function logChoose (n, k) {
  if (!Number.isInteger(n) || !Number.isInteger(k) || k < 0 || k > n) return -Infinity
  let s = 0
  for (let i = 1; i <= k; i++) s += Math.log(n - k + i) - Math.log(i)
  return s
}

// Two-sided p for the 2x2 table [[a, b], [c, d]] — row1 the control arm,
// row2 the tune arm, col1 the "no submission" count, col2 "submitted".
// Margins are fixed; the test sums the hypergeometric probability of every
// table as extreme as the observed one, computed in log space so even a
// 40x40 design cannot overflow. Degenerate tables (an empty row or column)
// have exactly one realization given the margins, so p = 1.
export function fisherExactTwoSided (a, b, c, d) {
  if (![a, b, c, d].every(Number.isInteger) || [a, b, c, d].some(v => v < 0)) {
    throw new TypeError('fisherExactTwoSided expects four non-negative integers')
  }
  const n1 = a + b
  const n2 = c + d
  const k1 = a + c
  const N = n1 + n2
  if (n1 === 0 || n2 === 0 || k1 === 0 || k1 === N) return 1
  const lo = Math.max(0, k1 - n2)
  const hi = Math.min(n1, k1)
  const logDenom = logChoose(N, k1)
  const logP = (x) => logChoose(n1, x) + logChoose(n2, k1 - x) - logDenom
  const observedLog = logP(a)
  let sum = 0
  for (let x = lo; x <= hi; x++) {
    // 1e-9 tolerance absorbs float noise on ties at the observed probability.
    if (logP(x) <= observedLog + 1e-9) sum += Math.exp(logP(x) - observedLog)
  }
  const p = Math.exp(observedLog) * sum
  return Math.min(1, p)
}

// ---------------------------------------------------------------------------
// Evidence parsing
// ---------------------------------------------------------------------------

function readSweepLogLines (logPath) {
  if (!existsSync(logPath)) return []
  const lines = []
  for (const raw of readFileSync(logPath, 'utf8').split('\n')) {
    const s = raw.trim()
    if (s === '') continue
    try { lines.push(JSON.parse(s)) } catch { /* a corrupt line is skipped, never fatal */ }
  }
  return lines
}

const ATTEMPT_DIR_RE = /^attempt-(\d+)$/

function readPackOutcome (attemptDir) {
  try {
    const results = JSON.parse(readFileSync(path.join(attemptDir, 'results.json'), 'utf8'))
    return results.outcome ?? null
  } catch {
    return null
  }
}

export function classifyOutcome (outcome) {
  if (REPLACEABLE_OUTCOMES.includes(outcome)) return 'replaceable'
  if (SCORABLE_OUTCOMES.includes(outcome)) return 'scorable'
  if (INVALID_OBSERVATION_OUTCOMES.includes(outcome)) return 'reported'
  return 'other'
}

function emptyArmStats () {
  return {
    attempts: 0,
    outcomes: {},
    scorable: 0,
    noSubmission: 0,
    verifiedPass: 0,
    replaceable: 0,
    reported: 0,
    other: 0,
    noSubmissionRate: null,
    verifiedPassRate: null
  }
}

function addTrialToArmStats (stats, outcome) {
  stats.attempts++
  stats.outcomes[outcome] = (stats.outcomes[outcome] ?? 0) + 1
  const kind = classifyOutcome(outcome)
  if (kind === 'scorable') {
    stats.scorable++
    if (outcome === 'NO_SUBMISSION') stats.noSubmission++
    if (outcome === 'VERIFIED_PASS') stats.verifiedPass++
  } else if (kind === 'replaceable') {
    stats.replaceable++
  } else if (kind === 'reported') {
    stats.reported++
  } else {
    stats.other++
  }
  stats.noSubmissionRate = stats.scorable > 0 ? stats.noSubmission / stats.scorable : null
  stats.verifiedPassRate = stats.scorable > 0 ? stats.verifiedPass / stats.scorable : null
}

function mergeArmStats (rows) {
  const merged = emptyArmStats()
  for (const row of rows) {
    merged.attempts += row.attempts
    merged.scorable += row.scorable
    merged.noSubmission += row.noSubmission
    merged.verifiedPass += row.verifiedPass
    merged.replaceable += row.replaceable
    merged.reported += row.reported
    merged.other += row.other
    for (const [outcome, count] of Object.entries(row.outcomes)) {
      merged.outcomes[outcome] = (merged.outcomes[outcome] ?? 0) + count
    }
  }
  merged.noSubmissionRate = merged.scorable > 0 ? merged.noSubmission / merged.scorable : null
  merged.verifiedPassRate = merged.scorable > 0 ? merged.verifiedPass / merged.scorable : null
  return merged
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

// Build the full report object. Reads the sweep log (the book of record) plus
// the evidence packs (fallback for a lost log / replacement discovery), maps
// canonical routes back to the registered claim routes, computes per-route and
// pooled rates, runs the Fisher test, and applies the decision rule. It never
// writes anything.
export function analyzeClaim (opts) {
  const { claimPath = null, claim: claimOverride = null, runsDir, configPath = null } = opts
  const claim = claimOverride ?? loadClaim(claimPath)
  const configModels = configPath && existsSync(configPath) ? readConfigModels(configPath) : []
  const index = buildRouteIndex(claim.routes, configModels)
  const taskId = claim.population[0]
  const n = claim.design.nPerArmPerRoute
  const arms = claim.arms

  const logPath = path.join(runsDir, claim.id, 'sweep-log.jsonl')
  const logLines = readSweepLogLines(logPath)
  const logExists = existsSync(logPath)

  // --- log classification ---
  const abortedBy = { outcome: null }
  const droppedCanonical = new Set()
  const scheduled = []
  const executed = []
  const unknownLogRoutes = new Set()
  for (const line of logLines) {
    if (line.outcome === 'ROUTE_DROPPED') {
      droppedCanonical.add(line.route)
      continue
    }
    if (line.outcome === 'SWEEP_ABORTED') {
      abortedBy.outcome = line.outcome
      abortedBy.route = resolveLogRoute(index, line.route) ?? line.route
      abortedBy.arm = line.arm
      abortedBy.attempt = line.attempt
      continue
    }
    if (line.outcome === 'SCHEDULED') {
      scheduled.push(line)
      continue
    }
    if (line.arm == null || line.attempt == null) continue
    const claimRoute = resolveLogRoute(index, line.route)
    if (!claimRoute) { unknownLogRoutes.add(line.route); continue }
    executed.push({
      claimRoute,
      logRoute: line.route,
      arm: line.arm,
      attempt: line.attempt,
      outcome: typeof line.outcome === 'string' ? line.outcome : 'UNKNOWN',
      replacement: line.replacement === true,
      ts: typeof line.ts === 'string' ? line.ts : null
    })
  }

  const droppedRoutes = [...droppedCanonical]
    .map(route => resolveLogRoute(index, route) ?? route)
    .sort((x, y) => claim.routes.indexOf(x) - claim.routes.indexOf(y) || x.localeCompare(y))

  // --- trials, keyed claimRoute|arm|attempt; the log wins, packs fill gaps ---
  const keyOf = (route, arm, attempt) => `${route}|${arm}|attempt-${attempt}`
  const trials = new Map()
  for (const e of executed) {
    trials.set(keyOf(e.claimRoute, e.arm, e.attempt), { ...e, source: 'log' })
  }
  const foundPacks = []
  for (const arm of arms) {
    const armRoot = path.join(runsDir, arm)
    if (!isDir(armRoot)) continue
    for (const segment of readdirSync(armRoot).sort()) {
      const segPath = path.join(armRoot, segment)
      if (!isDir(segPath)) continue
      const claimRoute = resolvePackSegment(index, segment)
      if (!claimRoute) continue
      const taskPath = path.join(segPath, taskId)
      if (!isDir(taskPath)) continue
      for (const name of readdirSync(taskPath).sort()) {
        const m = name.match(ATTEMPT_DIR_RE)
        if (!m) continue
        const attemptDir = path.join(taskPath, name)
        if (!isDir(attemptDir)) continue
        const hasManifest = existsSync(path.join(attemptDir, 'manifest.json'))
        const hasResults = existsSync(path.join(attemptDir, 'results.json'))
        if (!hasManifest && !hasResults) continue
        const attempt = Number(m[1])
        foundPacks.push({ claimRoute, arm, attempt, hasManifest, attemptDir })
        const key = keyOf(claimRoute, arm, attempt)
        if (!trials.has(key)) {
          trials.set(key, {
            claimRoute,
            logRoute: null,
            arm,
            attempt,
            outcome: readPackOutcome(attemptDir) ?? 'UNKNOWN',
            replacement: attempt > n,
            ts: null,
            source: 'pack'
          })
        }
      }
    }
  }

  // Replacements used per route: SCHEDULED lines in the log, cross-checked
  // against replacement packs on disk (a lost log must not reset the cap).
  const replacementsUsed = new Map()
  for (const route of claim.routes) {
    const logged = scheduled.filter(l => resolveLogRoute(index, l.route) === route).length
    const disk = foundPacks.filter(p => p.claimRoute === route && p.attempt > n && p.hasManifest).length
    replacementsUsed.set(route, Math.max(logged, disk))
  }

  // The claim's exclusion rule drops a route that exceeded the cap entirely,
  // even when the log lost its ROUTE_DROPPED line: the on-disk replacement
  // packs are direct evidence the cap was exceeded, so the route must not be
  // pooled back in. Exactly at the cap the route survives. This must run
  // before pending-slot detection so an over-capped route with missing slots
  // is treated as dropped rather than as an incomplete sweep.
  for (const route of claim.routes) {
    if (!droppedRoutes.includes(route) && (replacementsUsed.get(route) ?? 0) > REPLACEMENT_CAP_PER_ROUTE) {
      droppedRoutes.push(route)
    }
  }
  droppedRoutes.sort((x, y) => claim.routes.indexOf(x) - claim.routes.indexOf(y) || x.localeCompare(y))

  // Pending replacement slots: a SCHEDULED line whose latest log state is still
  // SCHEDULED was queued but never executed (same rule lib/sweep.js uses when
  // it resumes a sweep) — the sweep is not done until those run or the route
  // drops.
  const latestByKey = new Map()
  for (const line of logLines) {
    if (line.arm == null || line.attempt == null) continue
    const cr = resolveLogRoute(index, line.route)
    if (cr) latestByKey.set(keyOf(cr, line.arm, line.attempt), line)
  }
  const pendingBase = []
  const pendingReplacements = []
  for (const route of claim.routes) {
    if (droppedRoutes.includes(route)) continue
    for (const arm of arms) {
      for (let attempt = 1; attempt <= n; attempt++) {
        if (!trials.has(keyOf(route, arm, attempt))) pendingBase.push({ route, arm, attempt })
      }
    }
  }
  for (const s of scheduled) {
    const cr = resolveLogRoute(index, s.route)
    if (!cr || droppedRoutes.includes(cr)) continue
    if (latestByKey.get(keyOf(cr, s.arm, s.attempt))?.outcome !== 'SCHEDULED') continue
    pendingReplacements.push({ route: cr, arm: s.arm, attempt: s.attempt })
  }

  // --- state: what does the evidence support? ---
  const expectedBase = n * arms.length * claim.routes.length
  const baseExecuted = [...trials.values()].filter(t => t.attempt <= n).length
  let state
  if (!logExists && foundPacks.length === 0) state = 'no-evidence'
  else if (abortedBy.outcome !== null) state = 'aborted'
  else if (pendingBase.length > 0 || pendingReplacements.length > 0) state = 'incomplete'
  else if (droppedRoutes.length > 0) state = 'complete-with-dropped-routes'
  else state = 'complete'
  const evaluated = state === 'complete' || state === 'complete-with-dropped-routes'
  const includedRoutes = evaluated ? claim.routes.filter(r => !droppedRoutes.includes(r)) : []

  // --- per-route tallies (all attempts published, replaced ones included) ---
  const byRoute = new Map()
  for (const route of claim.routes) {
    byRoute.set(route, { arms: new Map() })
    for (const arm of arms) byRoute.get(route).arms.set(arm, emptyArmStats())
  }
  for (const t of trials.values()) {
    const armStats = byRoute.get(t.claimRoute)?.arms.get(t.arm)
    if (armStats) addTrialToArmStats(armStats, t.outcome)
  }
  const routeStats = claim.routes.map(route => ({
    route,
    canonical: index.canonicalOf.get(route),
    dropped: droppedRoutes.includes(route),
    replacementsUsed: replacementsUsed.get(route) ?? 0,
    replacementCap: REPLACEMENT_CAP_PER_ROUTE,
    matcher: 'config-or-slug',
    arms: arms.map(arm => ({ arm, ...byRoute.get(route).arms.get(arm) }))
  }))

  // --- pooled across the included (non-dropped) routes ---
  const pooled = {}
  for (const arm of arms) {
    const rows = includedRoutes
      .map(route => byRoute.get(route).arms.get(arm))
    pooled[arm] = mergeArmStats(rows)
  }

  // --- Fisher on the pooled 2x2 (arm x submitted/not) ---
  let table = null
  let fisherP = null
  if (evaluated) {
    const control = pooled[arms[0]]
    const tune = pooled[arms[1]]
    const a = control.noSubmission
    const b = control.scorable - control.noSubmission
    const c = tune.noSubmission
    const d = tune.scorable - tune.noSubmission
    table = [[a, b], [c, d]]
    if (control.scorable > 0 && tune.scorable > 0) {
      fisherP = fisherExactTwoSided(a, b, c, d)
    }
  }

  // --- decision rule (ONLY from evaluated evidence) ---
  let decision = null
  if (evaluated) {
    decision = evaluateDecision({
      arms,
      control: pooled[arms[0]],
      tune: pooled[arms[1]],
      fisherP
    })
  }

  return {
    claimId: claim.id,
    claimPath: claimPath ? path.resolve(claimPath) : null,
    runsDir: path.resolve(runsDir),
    configPath: configPath ? path.resolve(configPath) : null,
    logPath,
    task: taskId,
    arms,
    design: { nPerArmPerRoute: n, baseTrials: expectedBase },
    state,
    evaluated,
    baseSlots: { expected: expectedBase, executed: baseExecuted, perArmPerRoute: n },
    pending: {
      base: pendingBase.length,
      baseSlots: pendingBase,
      replacements: pendingReplacements.length,
      replacementSlots: pendingReplacements
    },
    abortedBy,
    droppedRoutes,
    replacementCapPerRoute: REPLACEMENT_CAP_PER_ROUTE,
    unknownLogRoutes: [...unknownLogRoutes],
    routes: routeStats,
    pooled,
    pooledIncludedRoutes: includedRoutes,
    fisher: { table, p: fisherP, alpha: FISHER_ALPHA },
    decisionRule: {
      requiredDropPp: REQUIRED_DROP_PP,
      fisherAlpha: FISHER_ALPHA
    },
    decision
  }
}

export function evaluateDecision (opts) {
  const { arms, control, tune, fisherP } = opts
  const [controlName, tuneName] = arms
  const conditions = []
  const c1 = control.noSubmissionRate !== null && tune.noSubmissionRate !== null &&
    control.noSubmissionRate - tune.noSubmissionRate >= REQUIRED_DROP_PP
  conditions.push({
    id: 'pooled-drop',
    label: `pooled NO_SUBMISSION rate at least ${REQUIRED_DROP_PP * 100}pp below control`,
    met: c1,
    detail: control.noSubmissionRate === null || tune.noSubmissionRate === null
      ? 'cannot compute — no scorable trials in one or both arms'
      : `${formatPp(control.noSubmissionRate - tune.noSubmissionRate)} drop (${tuneName} ${formatPct(tune.noSubmissionRate)} vs ${controlName} ${formatPct(control.noSubmissionRate)})`
  })
  const c2 = fisherP !== null && fisherP < FISHER_ALPHA
  conditions.push({
    id: 'fisher',
    label: `two-sided Fisher exact p < ${FISHER_ALPHA}`,
    met: c2,
    detail: fisherP === null
      ? 'cannot compute — no scorable trials in one or both arms'
      : `p=${fmtFisherP(fisherP)}`
  })
  const c3 = control.verifiedPassRate !== null && tune.verifiedPassRate !== null &&
    tune.verifiedPassRate >= control.verifiedPassRate
  conditions.push({
    id: 'verified-pass-not-lower',
    label: 'pooled VERIFIED_PASS rate not lower in tune arm',
    met: c3,
    detail: control.verifiedPassRate === null || tune.verifiedPassRate === null
      ? 'cannot compute — no scorable trials in one or both arms'
      : `${tuneName} ${formatPct(tune.verifiedPassRate)} vs ${controlName} ${formatPct(control.verifiedPassRate)}`
  })
  const supported = c1 && c2 && c3
  return {
    verdict: supported ? 'supported' : 'not-supported',
    supported,
    conditions,
    requiredDropPp: REQUIRED_DROP_PP,
    fisherAlpha: FISHER_ALPHA
  }
}

// ---------------------------------------------------------------------------
// Closure — the lifecycle write
// ---------------------------------------------------------------------------

// The status a concluded claim carries. Reusing the registry's existing
// `reported` vocabulary rather than inventing a "closed" status keeps every
// consumer working, and it is what makes a concluded claim unsweepable for
// free: lib/sweep.js refuses any claim whose status is not `preregistered`.
export const CLOSED_STATUS = 'reported'

// The only keys closure may add or change. Every other key in the file is the
// preregistration — the promise made before data existed — and must survive a
// closure untouched. assertRegisteredFieldsUnchanged() enforces this on the
// object that is about to be serialised, not merely by construction, so a
// future edit to deriveConclusion cannot quietly rewrite a registered field.
export const CLOSURE_WRITABLE_KEYS = ['status', 'conclusion']

// Keys that must never appear in a claim file at all: `result`/`verdict` at the
// top level are how a preregistration gets laundered into a finding. Closure
// writes its findings under `conclusion`, which is validated as a whole.
const FORBIDDEN_CLAIM_KEYS = ['result', 'verdict', 'results', 'findings']

const armSummary = (stats) => ({
  attempts: stats.attempts,
  scorable: stats.scorable,
  noSubmission: stats.noSubmission,
  noSubmissionRate: stats.noSubmissionRate,
  verifiedPass: stats.verifiedPass,
  verifiedPassRate: stats.verifiedPassRate
})

// Everything here is a pure function of the analysis: no prose, no operator
// input, no judgement. `closedAt` is the only value not derived from evidence,
// which is why it is passed in rather than read from the clock in here.
export function deriveConclusion (result, closedAt) {
  const pooled = {}
  for (const arm of result.arms) pooled[arm] = armSummary(result.pooled[arm])
  return {
    status: CLOSED_STATUS,
    closedAt,
    closedBy: 'scripts/claim-report.js --close',
    state: result.state,
    verdict: result.decision.verdict,
    supported: result.decision.supported,
    evidence: {
      // Repo-relative by construction: an absolute runs path is a fact about
      // one machine, not about the claim.
      sweepLog: `runs/${result.claimId}/sweep-log.jsonl`,
      task: result.task,
      baseTrials: result.baseSlots.expected,
      nPerArmPerRoute: result.design.nPerArmPerRoute,
      pooledRoutes: result.pooledIncludedRoutes,
      droppedRoutes: result.droppedRoutes
    },
    pooled,
    perRoute: result.routes.map(r => ({
      route: r.route,
      dropped: r.dropped,
      replacementsUsed: r.replacementsUsed,
      arms: r.arms.map(a => ({ arm: a.arm, ...armSummary(a) }))
    })),
    fisher: { table: result.fisher.table, p: result.fisher.p, alpha: result.fisher.alpha },
    decisionRule: result.decisionRule,
    conditions: result.decision.conditions.map(c => ({
      id: c.id, label: c.label, met: c.met, detail: c.detail
    }))
  }
}

// Two conclusions agree when they say the same thing about the evidence. The
// closure timestamp and its author are excluded: re-closing a claim from the
// same packs must be recognised as a no-op, not as a conflict.
export function conclusionsAgree (a, b) {
  const strip = (c) => {
    const { closedAt, closedBy, ...rest } = c ?? {}
    return JSON.stringify(rest)
  }
  return strip(a) === strip(b)
}

// Why a claim may not be closed. Returns null when it may, the string
// 'already-closed' when this exact conclusion is already on disk (idempotent
// re-run), or a refusal { code, message }.
export function canCloseClaim (claim, result) {
  const forbidden = FORBIDDEN_CLAIM_KEYS.filter(k => Object.hasOwn(claim, k))
  if (forbidden.length > 0) {
    return {
      code: 'lifecycle',
      message: `claim carries result field(s) ${forbidden.join(', ')} outside the conclusion block`
    }
  }
  if (claim.status === CLOSED_STATUS) {
    if (!claim.conclusion) {
      return {
        code: 'lifecycle',
        message: `claim status is already "${CLOSED_STATUS}" but carries no conclusion — the file is inconsistent and must be fixed by hand`
      }
    }
    if (!result.evaluated || result.state !== 'complete' || !result.decision) {
      return {
        code: 'conflict',
        message: `claim is already closed, but the evidence on disk is now "${result.state}" — refusing to touch a concluded claim`
      }
    }
    if (conclusionsAgree(claim.conclusion, deriveConclusion(result, claim.conclusion.closedAt))) {
      return 'already-closed'
    }
    return {
      code: 'conflict',
      message: 'claim is already closed with a different conclusion — the evidence changed after closure; refusing to overwrite a published result'
    }
  }
  if (claim.status !== 'preregistered') {
    return {
      code: 'status',
      message: `claim status is "${claim.status}" — only a "preregistered" claim can be closed`
    }
  }
  if (claim.conclusion !== undefined) {
    return {
      code: 'lifecycle',
      message: 'claim is still preregistered but already carries a conclusion — the file is inconsistent and must be fixed by hand'
    }
  }
  // The decision rule is never applied to partial evidence, so closure — which
  // publishes that decision into the claim file — cannot be either. A sweep
  // that dropped a route analysed less than it promised: reportable, but not
  // something this tool will freeze into the preregistration on its own.
  if (result.state !== 'complete' || !result.decision) {
    return {
      code: 'evidence',
      message: `evidence state is "${result.state}" — a claim is closed only from complete evidence with every registered route intact`
    }
  }
  return null
}

// Guard against the class of bug that would matter most here: a closure that
// silently edits the preregistration. Throws rather than returning a refusal,
// because reaching it means deriveConclusion or the merge is wrong, not that
// the operator did something.
export function assertRegisteredFieldsUnchanged (before, after) {
  for (const key of Object.keys(before)) {
    if (CLOSURE_WRITABLE_KEYS.includes(key)) continue
    if (!Object.hasOwn(after, key)) {
      throw new Error(`closure dropped registered field "${key}"`)
    }
    if (JSON.stringify(after[key]) !== JSON.stringify(before[key])) {
      throw new Error(`closure would modify registered field "${key}"`)
    }
  }
  for (const key of Object.keys(after)) {
    if (!Object.hasOwn(before, key) && !CLOSURE_WRITABLE_KEYS.includes(key)) {
      throw new Error(`closure added unregistered field "${key}"`)
    }
  }
}

// Close one claim. Writes at most one file, only after every guard passes, and
// never on a refusal. The returned action is one of:
//   'closed'     — status moved to reported and a conclusion was written
//   'unchanged'  — the identical conclusion was already on disk
//   'refused'    — nothing was written; `refusal` says why
export function closeClaim (opts) {
  const { claimPath, result, now = new Date() } = opts
  const raw = readFileSync(claimPath, 'utf8')
  const before = JSON.parse(raw)
  const verdict = canCloseClaim(before, result)
  if (verdict !== null && verdict !== 'already-closed') {
    return { action: 'refused', refusal: verdict, claimPath, wrote: false, conclusion: null }
  }
  if (verdict === 'already-closed') {
    return {
      action: 'unchanged',
      refusal: null,
      claimPath,
      wrote: false,
      conclusion: before.conclusion,
      statusFrom: before.status,
      statusTo: before.status
    }
  }
  const conclusion = deriveConclusion(result, now.toISOString())
  // Key order is preserved and `conclusion` appended, so the diff a reviewer
  // sees is one status word plus one new block.
  const after = { ...before, status: CLOSED_STATUS, conclusion }
  assertRegisteredFieldsUnchanged(before, after)
  const serialized = JSON.stringify(after, null, 2) + '\n'
  // Same-directory temp + rename: a crash mid-write leaves the preregistration
  // intact rather than a truncated claim.
  const tmp = `${claimPath}.close-tmp`
  writeFileSync(tmp, serialized)
  renameSync(tmp, claimPath)
  return {
    action: 'closed',
    refusal: null,
    claimPath,
    wrote: true,
    conclusion,
    statusFrom: before.status,
    statusTo: CLOSED_STATUS
  }
}

export function renderClosure (closure) {
  const lines = ['', '## Closure (--close)']
  if (closure.action === 'refused') {
    lines.push(`  REFUSED (${closure.refusal.code}) — ${closure.refusal.message}`)
    lines.push('  Nothing was written; the claim file is unchanged.')
    return lines.join('\n')
  }
  if (closure.action === 'unchanged') {
    lines.push(`  already closed — the conclusion on disk matches this evidence exactly (closedAt ${closure.conclusion.closedAt})`)
    lines.push('  Nothing was written.')
    return lines.join('\n')
  }
  lines.push(`  status     ${closure.statusFrom} -> ${closure.statusTo}`)
  lines.push(`  conclusion ${closure.conclusion.verdict} (state ${closure.conclusion.state}) · closedAt ${closure.conclusion.closedAt}`)
  lines.push(`  written    ${closure.claimPath} — registered fields unchanged, conclusion derived from the analysis above`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function formatPct (rate) {
  return rate === null || rate === undefined ? '—' : `${(rate * 100).toFixed(1)}%`
}
function formatPp (pp) {
  return `${(pp * 100).toFixed(1)}pp`
}
function fmtFisherP (p) {
  if (p === null) return 'n/a (no scorable trials in an arm)'
  if (p === 0) return '0'
  return p < 0.001 ? p.toExponential(2) : p.toFixed(4)
}

function stateLine (result) {
  const n = result.design.nPerArmPerRoute
  switch (result.state) {
    case 'no-evidence':
      return `no-evidence — no sweep log and no evidence packs yet; the claim has not been run`
    case 'aborted':
      return `aborted — sweep terminated at ${result.abortedBy.route ?? '?'} / ${result.abortedBy.arm ?? '?'} / attempt ${result.abortedBy.attempt ?? '?'} (SWEEP_ABORTED in log)`
    case 'incomplete':
      return `incomplete — ${result.pending.base} base slot(s) of ${result.baseSlots.expected} and ${result.pending.replacements} replacement(s) still pending`
    case 'complete-with-dropped-routes':
      return `complete — ${result.droppedRoutes.length} route(s) dropped and excluded from pooled analysis per the claim`
    default:
      return `complete — all ${result.baseSlots.expected} base slots (${n} × ${result.arms.join(' / ')}) executed`
  }
}

function armOutcomeExtras (stats) {
  const parts = []
  for (const outcome of [...REPLACEABLE_OUTCOMES, 'TUNE_CONTAMINATED']) {
    const count = stats.outcomes[outcome]
    if (count > 0) parts.push(`${outcome}×${count}`)
  }
  return parts
}

export function renderPlain (result) {
  const [controlName, tuneName] = result.arms
  const lines = [
    `CLAIM REPORT ${result.claimId}`,
    `  claim      ${result.claimPath ?? '(in-memory claim)'}`,
    `  runs       ${result.runsDir}`,
    `  task       ${result.task}`,
    `  log        ${result.logPath}`,
    `  state      ${stateLine(result)}`
  ]
  if (result.unknownLogRoutes.length > 0) {
    lines.push(`  notes      ${result.unknownLogRoutes.length} log route(s) did not resolve to a registered route: ${result.unknownLogRoutes.join(', ')}`)
  }
  if (result.state === 'aborted') {
    lines.push('             The harness itself faulted (HARNESS_ERROR class), so these results are suspect.')
  }

  lines.push('', '## Per-route evidence (every attempt published, replaced ones included)')
  for (const route of result.routes) {
    const dropNote = route.dropped
      ? ' · ROUTE DROPPED — replacement cap reached; excluded from pooled analysis per the claim'
      : ''
    let head = `route ${route.route} · replacements ${route.replacementsUsed}/${route.replacementCap}${dropNote}`
    if (route.canonical !== route.route) head += ` · actual ${route.canonical}`
    lines.push('', head)
    for (const arm of route.arms) {
      const extras = armOutcomeExtras(arm)
      const extra = extras.length > 0 ? ` · ${extras.join(' · ')}` : ''
      lines.push(
        `  ${arm.arm.padEnd(12)} ${String(arm.attempts).padStart(3)} trial(s) · ` +
        `scorable ${arm.scorable} · NO_SUBMISSION ${arm.noSubmission} (${formatPct(arm.noSubmissionRate)}) · ` +
        `VERIFIED_PASS ${arm.verifiedPass} (${formatPct(arm.verifiedPassRate)})${extra}`
      )
    }
  }

  lines.push('', `## Pooled (${result.pooledIncludedRoutes.length} route(s): ${result.pooledIncludedRoutes.join(', ') || 'none'})`)
  const pooledRows = result.arms.map(arm => result.pooled[arm])
  for (let i = 0; i < result.arms.length; i++) {
    const arm = result.arms[i]
    const stats = pooledRows[i]
    const extras = armOutcomeExtras(stats)
    const extra = extras.length > 0 ? ` · ${extras.join(' · ')}` : ''
    lines.push(
      `  ${arm.padEnd(12)} ${String(stats.attempts).padStart(3)} trial(s) · ` +
      `scorable ${stats.scorable} · NO_SUBMISSION ${stats.noSubmission} (${formatPct(stats.noSubmissionRate)}) · ` +
      `VERIFIED_PASS ${stats.verifiedPass} (${formatPct(stats.verifiedPassRate)})${extra}`
    )
  }

  lines.push('', '## Decision rule (claim.decisionRule — never re-cut after results)')
  if (!result.evaluated) {
    lines.push(`  state ${result.state.toUpperCase()} — the decision rule is NOT applied to incomplete evidence`)
    lines.push(`  DECISION NOT EVALUATED — no supported claim may be reported from this evidence`)
  } else {
    const d = result.decision
    const tbl = result.fisher.table
    for (const c of d.conditions) {
      lines.push(`  (${d.conditions.indexOf(c) + 1}) ${c.label} — ${c.met ? 'MET' : 'NOT MET'} (${c.detail})`)
    }
    if (tbl) {
      lines.push(`  Fisher exact on pooled 2x2 [[${tbl[0][0]}, ${tbl[0][1]}], [${tbl[1][0]}, ${tbl[1][1]}]] p=${fmtFisherP(result.fisher.p)}`)
    } else {
      lines.push(`  Fisher exact on pooled 2x2 n/a — no scorable trials in one or both arms (no 2x2 can be formed)`)
    }
    if (d.supported) {
      lines.push(`  DECISION SUPPORTED — recommend ${tuneName} only on the preregistered conditions (all three met)`)
    } else {
      lines.push(`  DECISION NOT SUPPORTED — ${d.conditions.filter(c => !c.met).map(c => `condition ${d.conditions.indexOf(c) + 1} failed`).join('; ')}; observed rates above`)
    }
  }
  lines.push('', 'Analysis reads the sweep log and evidence packs as they are on disk; it computes no fresh trial and re-cut nothing.')
  return lines.join('\n')
}

export function renderJson (result) {
  return JSON.stringify(result, null, 2)
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `claim-report — preregistered analysis for a no-submission-rate claim (reads sweep-log.jsonl + evidence packs; never re-cuts the metric)

Usage:
  node scripts/claim-report.js [<claim-id|claim.json>] [flags]

Flags:
  --claim <file>    Claim JSON (a bare id resolves against claims/,
                    e.g. dt-v1-ledger-lite-nosub). A bare positional is an alias.
  --runs-dir <dir>  Evidence root (default ./runs under the repo)
  --config <file>   Droid config for route-id resolution (default ~/.factory/settings.json)
  --json            Machine-readable output (single JSON object)
  --close           Move a preregistered claim to "${CLOSED_STATUS}" and write a
                    conclusion derived from this analysis. The only write this
                    tool performs. Registered fields are never modified.
                    Refused unless the claim is still preregistered and the
                    evidence is complete with every registered route intact.
  -h, --help        Show this help

The decision rule (claim.decisionRule) requires ALL of:
  (1) pooled NO_SUBMISSION rate in the tune arm at least 25pp below the control
  (2) two-sided Fisher exact p < 0.05 on the pooled arm x submitted/not 2x2
  (3) pooled VERIFIED_PASS rate in the tune arm not lower than the control
If any condition fails, the observed rates are reported and the tune is stated
NOT SUPPORTED. PROVIDER_ERROR / DROID_ERROR / VERIFIER_ERROR never reached the
model: excluded from the denominator and replaced at the same arm/route, capped
per route (5). TUNE_CONTAMINATED is reported but excluded from scoring. A route
dropped for exceeding the cap is excluded from pooled analysis entirely.

Exit codes:
  0 supported (all three preregistered conditions met)
  1 not supported, sweep incomplete/aborted, no evidence, or a dropped route
  2 usage error
`

function usageError (msg) {
  process.stderr.write(`claim-report: ${msg}\n\n`)
  process.stderr.write(USAGE)
  process.exit(2)
}

export function parseArgs (argv) {
  const opts = { claim: null, runsDir: null, config: null, json: false, close: false, help: false }
  const positionals = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-h' || a === '--help') opts.help = true
    else if (a === '--json') opts.json = true
    else if (a === '--close') opts.close = true
    else if (a === '--claim') {
      const v = argv[++i]
      if (v === undefined) usageError('--claim requires a value')
      opts.claim = v
    } else if (a === '--runs-dir') {
      const v = argv[++i]
      if (v === undefined) usageError('--runs-dir requires a value')
      opts.runsDir = v
    } else if (a === '--config') {
      const v = argv[++i]
      if (v === undefined) usageError('--config requires a value')
      opts.config = v
    } else if (a.startsWith('-')) {
      usageError(`unknown flag: ${a}`)
    } else {
      positionals.push(a)
    }
  }
  if (opts.claim === null) opts.claim = positionals[0] ?? null
  return opts
}

function resolveClaimPath (claim) {
  if (claim === null || claim === '') usageError('a claim is required (e.g. dt-v1-ledger-lite-nosub)')
  let claimPath = claim
  if (!path.isAbsolute(claimPath) && !existsSync(claimPath)) {
    const name = claimPath.endsWith('.json') ? claimPath : `${claimPath}.json`
    for (const candidate of [path.join(REPO_ROOT, claimPath), path.join(REPO_ROOT, 'claims', name)]) {
      if (existsSync(candidate)) { claimPath = candidate; break }
    }
  }
  if (!existsSync(claimPath)) usageError(`claim not found: ${claim}`)
  return path.resolve(claimPath)
}

export function main () {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    process.stdout.write(USAGE)
    process.exit(0)
  }
  const claimPath = resolveClaimPath(opts.claim)
  const runsDir = path.resolve(opts.runsDir ?? path.join(REPO_ROOT, 'runs'))
  if (!existsSync(runsDir)) usageError(`runs dir not found: ${runsDir}`)
  const configPath = path.resolve(opts.config ?? DEFAULT_CONFIG)

  let result
  try {
    result = analyzeClaim({ claimPath, runsDir, configPath })
  } catch (err) {
    process.stderr.write(`claim-report: ${err && err.stack ? err.stack : err}\n`)
    process.exitCode = 1
    return
  }
  let closure = null
  if (opts.close) {
    try {
      closure = closeClaim({ claimPath, result })
    } catch (err) {
      process.stderr.write(`claim-report: refusing to close ${claimPath}: ${err && err.message ? err.message : err}\n`)
      process.exitCode = 1
      return
    }
    result = { ...result, closure }
  }
  process.stdout.write(
    (opts.json
      ? renderJson(result)
      : renderPlain(result) + (closure ? '\n' + renderClosure(closure) : '')) +
    (opts.json ? '' : '\n') + '\n'
  )
  if (closure && closure.action === 'refused') {
    process.stderr.write(`claim-report: refusing to close ${claimPath} (${closure.refusal.code}): ${closure.refusal.message}\n`)
    process.exitCode = 1
    return
  }
  // 0 only for a fully evaluated, supported claim on complete evidence with
  // every route intact. Everything else — not supported, still running,
  // aborted, dropped a route, or no evidence at all — is exit 1. Closing a
  // claim does not change this: a closed NOT SUPPORTED claim still exits 1,
  // because the exit code reports the finding, not the bookkeeping.
  process.exitCode =
    result.state === 'complete' && result.decision?.supported === true ? 0 : 1
}

const entry = process.argv[1]
if (entry && pathToFileURL(path.resolve(entry)).href === import.meta.url) main()
