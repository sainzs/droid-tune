// Sweep driver for preregistered claims (claims/<id>.json).
//
// A claim in `claims/` is a promise made before data exists: which task, which
// routes, which arms, how many trials, and what will be counted. `sweep` is
// the executor for that promise. It takes one claim, turns its design into a
// deterministic trial schedule, and drives `lib/runner.js` (or an injected
// runOne in tests) through that schedule, writing one evidence pack per trial
// under runs/<arm>/<route>/<task>/attempt-N and one append-only sweep log at
// runs/<claim-id>/sweep-log.jsonl.
//
// The design decisions that matter:
//
// 1. Default is a dry run. A claim's schedule touches up to
//    routes × arms × n live droid execs; nobody should trigger that by
//    omitting a flag. Without --live, sweep prints the schedule table with
//    each slot's status and spawns nothing. --live executes. --limit n runs
//    only the first n pending slots and then stops cleanly, so a sweep can be
//    driven in paced batches against rate-limited free routes.
//
// 2. Resumability is pack-existence, not a state file. A slot is done if and
//    only if runs/<arm>/<route>/<task>/attempt-N/manifest.json exists — the
//    same collision signal the runner and the trial CLI use. Rerunning the
//    sweep after an interruption therefore re-runs only missing slots; a
//    crashed process cannot leave the sweep thinking a trial happened when no
//    pack exists. The log is append-only JSONL: every executed slot appends a
//    line (route, arm, attempt, outcome, packPath), every scheduled
//    replacement appends a SCHEDULED line, every dropped route appends a
//    ROUTE_DROPPED line. Prior lines are never rewritten — the log is the
//    sweep's history, including the history of its failures.
//
//    Three hardening rules keep resume as trustworthy as a fresh run:
//    - Adoption is verified, not assumed. A done pack's manifest must prove it
//      belongs to this sweep: the pinned tune sha256 on the tuned arm, no tune
//      provenance on the control arm, and a modelRequested matching the slot's
//      route. Foreign bytes on the path refuse the whole sweep naming the
//      pack — re-running the slot would overwrite the evidence, so the
//      operator moves the pack aside. A results.json without a manifest.json
//      is a half-written pack (a run died mid-pack): same refusal, never a
//      silent re-run over partial evidence.
//    - Adopted packs get the exclusion rule too. A done pack whose outcome is
//      replaceable (it never reached the model — e.g. a pre-sweep smoke test
//      on the same path) is put through the same replacement/cap/drop logic
//      as an in-process result, idempotently: the log's SCHEDULED lines and
//      the disk's replacement packs record what is already queued, so resuming
//      twice never double-schedules.
//    - An abort is sticky. A SWEEP_ABORTED log line blocks every later live
//      run until the operator passes --resume-after-abort, which appends an
//      ABORT_ACKNOWLEDGED line so the decision to continue on a once-broken
//      harness is itself on the record.
//
// 3. The claim's exclusion rule is implemented, not paraphrased. Outcomes in
//    REPLACEABLE_OUTCOMES never reached the model, so they are replaced by a
//    re-run at the same arm and route (attempt number above the registered n,
//    appended to the schedule), capped at REPLACEMENT_CAP_PER_ROUTE per route
//    across both arms. The cap counts the UNION of replacement slots keyed by
//    (arm, attempt) across the log's SCHEDULED lines and the packs on disk —
//    a log and a disk history that partially overlap must not sum to less
//    than the truth and let a replacement slip past the cap. Every attempt —
//    replaced ones included — stays on disk and in the log. Past the cap the
//    route is marked ROUTE_DROPPED in the log and summary and nothing further
//    is scheduled on it, matching the claim's "drops that route from the
//    pooled analysis entirely rather than analysing it partially".
//
// 4. The sweep reports; it does not conclude. The final summary is per-route ×
//    per-arm outcome counts plus pending/dropped slots and the replacement
//    tally. Computing the claim's statistics (pooled rates, Fisher exact, the
//    decision rule) is a separate deliberate step that reads these packs —
//    the sweep must never re-cut the metric after seeing results, so it
//    computes no metric at all.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sha256String } from './pack.js'
import { routeSlug } from './paths.js'
import { resolveTuneFile } from './tune.js'
import { runTrial } from './runner.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// The claim's exclusionRule, as a constant: these outcomes mean the trial
// never produced a model attempt, so it is replaced rather than counted.
export const REPLACEABLE_OUTCOMES = ['PROVIDER_ERROR', 'DROID_ERROR', 'VERIFIER_ERROR']

// "capped at 5 replacements per route across both arms" (exclusionRule).
export const REPLACEMENT_CAP_PER_ROUTE = 5

// A harness fault is not a route problem and must never be papered over with a
// replacement: it means this runner broke mid-sweep, so every subsequent slot is
// suspect. Stop and make the operator fix it. (HARNESS_ERROR did not exist when
// the claim was registered, which is precisely why the claim's exclusionRule
// does not name it — it must not be silently folded into that rule.)
export const ABORT_OUTCOMES = ['HARNESS_ERROR']

// Reached the model, but not a valid observation of the arm: the agent
// committed the tune into the graded history. Not replaceable — replacing it
// would quietly resample until the arm looked clean. It is reported instead.
export const INVALID_OBSERVATION_OUTCOMES = ['TUNE_CONTAMINATED']

const ATTEMPT_DIR_RE = /^attempt-(\d+)$/

// Load and validate a claim as a sweepable preregistration. This is stricter
// than lib/claims.js's registry validation on the fields the sweep actually
// executes: a claim that parses as registry data but has no routes, no design,
// or a drifted tune is not a runnable experiment.
export function loadSweepClaim (claimPath) {
  let claim
  try {
    claim = JSON.parse(readFileSync(claimPath, 'utf8'))
  } catch (err) {
    throw new Error(`cannot read claim ${claimPath}: ${err.message}`)
  }
  if (!claim || typeof claim !== 'object' || Array.isArray(claim)) {
    throw new Error(`claim ${claimPath} must be a JSON object`)
  }
  // The id becomes a path segment for the sweep log; require the registry's
  // kebab-case shape so no claim can write outside the runs dir.
  if (typeof claim.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(claim.id)) {
    throw new Error('claim id must be a kebab-case string')
  }
  // A sweep IS the preregistration's data collection. Running a claim whose
  // status has already moved on (analysed, completed, ...) would collect
  // fresh data under an id that already has a meaning, so refuse.
  if (claim.status !== 'preregistered') {
    throw new Error(
      `claim ${claim.id} has status "${claim.status}" — a sweep can only run a claim whose status is "preregistered"`
    )
  }
  if (!Array.isArray(claim.arms) || claim.arms.length < 2 || claim.arms.some(a => typeof a !== 'string' || a === '')) {
    throw new Error('claim arms must name at least two arms (first is the control arm)')
  }
  if (!Array.isArray(claim.routes) || claim.routes.length === 0 || claim.routes.some(r => typeof r !== 'string' || r === '')) {
    throw new Error('claim routes must be a non-empty list of route ids')
  }
  if (!Array.isArray(claim.population) || claim.population.length !== 1 || typeof claim.population[0] !== 'string') {
    throw new Error('sweep supports exactly one task in claim population')
  }
  const design = claim.design ?? {}
  if (!Number.isInteger(design.nPerArmPerRoute) || design.nPerArmPerRoute < 1) {
    throw new Error('claim design.nPerArmPerRoute must be a positive integer')
  }
  if (!['low', 'medium', 'high'].includes(design.autoLevel)) {
    throw new Error('claim design.autoLevel must be low, medium, or high')
  }
  if (!Number.isInteger(design.timeoutMs) || design.timeoutMs < 1) {
    throw new Error('claim design.timeoutMs must be a positive integer')
  }
  // The claim pins its tune by content hash, not just by path — a tune file
  // that drifts after preregistration silently reruns a different experiment
  // under the same claim id, so verify before anything runs.
  let tuneSpec = claim.tuneFile
  if (typeof tuneSpec !== 'string' || tuneSpec === '') throw new Error('claim tuneFile is required')
  if (!path.isAbsolute(tuneSpec) && !existsSync(tuneSpec)) {
    const candidate = path.join(REPO_ROOT, tuneSpec)
    if (existsSync(candidate)) tuneSpec = candidate
  }
  const tuneFile = resolveTuneFile(tuneSpec)
  const sha = sha256String(readFileSync(tuneFile))
  if (sha !== claim.tuneSha256) {
    throw new Error(
      `tune file ${tuneFile} hashes to ${sha}, but claim ${claim.id} pins tuneSha256 ${claim.tuneSha256} — ` +
      `the preregistered tune must not drift after registration`
    )
  }
  return { ...claim, tuneFileResolved: tuneFile }
}

// Resolve a claim route against the customModels in the Droid config, the way
// `trial --model` documents ("custom-model id or unique substring") and
// lib/diagnose.js's probe implements: exact id/model match first, then a
// substring match over id/model/displayName. A sweep is stricter than diagnose
// about ambiguity — diagnose picks the first substring hit because a probe is
// a smoke test, but a sweep that resolves one route name to two entries would
// silently pool two providers into one route's evidence, so refuse instead.
export function resolveRoute (route, configPath) {
  let cfg
  try {
    cfg = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch (err) {
    throw new Error(`cannot read Droid config ${configPath}: ${err.message}`)
  }
  const models = Array.isArray(cfg?.customModels) ? cfg.customModels : []
  const exact = models.find(m => m.id === route || m.model === route)
  if (exact) return exact.id ?? exact.model
  const matches = models.filter(m =>
    [m.id, m.model, m.displayName].some(v => typeof v === 'string' && v.includes(route)))
  if (matches.length > 1) {
    throw new Error(
      `route "${route}" is ambiguous in ${configPath} (matches ${matches.map(m => m.id ?? m.model).join(', ')}) — ` +
      `use the exact custom-model id`
    )
  }
  if (matches.length === 0) {
    const known = models.map(m => m.id ?? m.model).filter(Boolean).join(', ')
    throw new Error(
      `route "${route}" does not resolve against the customModels in ${configPath}` +
      (known ? ` (configured: ${known})` : ' (no customModels configured)')
    )
  }
  return matches[0].id ?? matches[0].model
}

// The deterministic schedule, derived from the claim and nothing else: for
// each route, slot i takes arm (i mod arms.length) and per-arm attempt number
// floor(i / arms.length) + 1, so attempts 1..n of each arm interleave
// (no-tune, ledger-lite, no-tune, ...) — the claim's ordering design, which
// keeps provider-side drift over a route from loading onto one arm. The first
// listed arm is the control and never carries the tune file, matching the
// claim's armDefinitions verbatim.
export function buildSchedule (claim) {
  const taskId = claim.population[0]
  const n = claim.design.nPerArmPerRoute
  const schedule = []
  for (const route of claim.routes) {
    for (let i = 0; i < n * claim.arms.length; i++) {
      const arm = claim.arms[i % claim.arms.length]
      schedule.push({
        route,
        arm,
        attempt: Math.floor(i / claim.arms.length) + 1,
        taskId,
        tuneFile: i % claim.arms.length === 0 ? null : claim.tuneFileResolved,
        replacement: false
      })
    }
  }
  return schedule
}

const slotKey = (slot) => `${slot.route}/${slot.arm}/attempt-${slot.attempt}`

function attemptDir (runsDir, slot) {
  return path.join(runsDir, slot.arm, routeSlug(slot.route), slot.taskId, `attempt-${slot.attempt}`)
}

// A slot is done iff its evidence pack exists — the same manifest-existence
// signal trial's collision guard uses, so resume and trial agree on what
// "already ran" means.
function packExists (runsDir, slot) {
  return existsSync(path.join(attemptDir(runsDir, slot), 'manifest.json'))
}

// A results.json with no manifest.json is a run that died mid-pack. Treating
// the slot as pending would re-run it and clobber the partial evidence, so
// refuse the sweep and name the directory; the operator moves it aside.
function assertNotHalfWritten (dir) {
  if (!existsSync(path.join(dir, 'manifest.json')) && existsSync(path.join(dir, 'results.json'))) {
    throw new Error(
      `half-written pack at ${dir}: results.json exists but manifest.json does not — ` +
      `a previous run died while writing the pack. The sweep will not re-run over partial ` +
      `evidence; move the directory aside, then resume.`
    )
  }
}

// Adopting a pre-existing pack as a slot's trial is a trust decision: the
// pack's own manifest must prove it is THIS sweep's trial — the claim's
// pinned tune sha256 on the tuned arm, no tune provenance at all on the
// control arm, and a modelRequested that names the slot's route (compared as
// route slugs, the same normalization that chose the pack's path). Anything
// else is foreign evidence sitting on this sweep's path — an ad-hoc trial, a
// different claim's run — and the sweep refuses rather than re-running the
// slot, because re-running would overwrite it. The operator moves the foreign
// pack aside and resumes.
// Why a pack at this path is not this claim's trial, or null if it is. Returned
// rather than thrown so both callers can frame it their own way: the sweep
// refuses to adopt (it is about to write), claim-report refuses to count it (it
// is about to publish). Both must apply the SAME test — a pack the sweep would
// not adopt as evidence must not become evidence just because a later tool
// found it on disk.
export function packProvenanceFault (dir, slot, claim) {
  let manifest
  try {
    manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
  } catch (err) {
    return `its manifest.json is unreadable (${err.message})`
  }
  const provenance = (manifest && typeof manifest === 'object' ? manifest.provenance : null) ?? {}
  const tune = provenance.tune ?? null
  if (slot.arm === claim.arms[0]) {
    if (tune !== null) {
      return `it records tune provenance (${tune.name ?? 'unnamed tune'}), but the control arm never carries a tune`
    }
  } else if (tune === null || tune.sha256 !== claim.tuneSha256) {
    return `its tune sha256 (${tune?.sha256 ?? 'none'}) does not match the claim's pinned tuneSha256 ${claim.tuneSha256}`
  }
  const requested = provenance.modelRequested
  if (typeof requested !== 'string' || routeSlug(requested) !== routeSlug(slot.route)) {
    return `its modelRequested (${requested ?? 'none'}) does not match the slot's route ${slot.route}`
  }
  return null
}

function verifyAdoptedPack (dir, slot, claim) {
  const why = packProvenanceFault(dir, slot, claim)
  if (why === null) return
  throw new Error(
    `refusing to adopt pack ${dir} as ${slotKey(slot)}: ${why}. ` +
    `The sweep never overwrites foreign evidence — move the pack aside (or point --runs-dir elsewhere), then resume.`
  )
}

function readPackOutcome (runsDir, slot) {
  try {
    const results = JSON.parse(readFileSync(path.join(attemptDir(runsDir, slot), 'results.json'), 'utf8'))
    return results.outcome ?? null
  } catch {
    return null
  }
}

function readSweepLog (logPath) {
  if (!existsSync(logPath)) return []
  const lines = []
  for (const raw of readFileSync(logPath, 'utf8').split('\n')) {
    const s = raw.trim()
    if (s === '') continue
    try { lines.push(JSON.parse(s)) } catch { /* a corrupt line is skipped, never fatal */ }
  }
  return lines
}

// Append-only: the log is the sweep's history, so lines are only ever added.
function appendLogLine (logPath, line) {
  mkdirSync(path.dirname(logPath), { recursive: true })
  appendFileSync(logPath, JSON.stringify(line) + '\n')
}

export async function runSweep (opts = {}) {
  const {
    claimPath,
    runsDir,
    configPath,
    sessionsDir,
    droidPath,
    taskDir = null,
    live = false,
    limit = null,
    resumeAfterAbort = false,
    runOne = runTrial
  } = opts
  const claim = loadSweepClaim(claimPath)
  const taskId = claim.population[0]
  const resolvedRunsDir = path.resolve(runsDir ?? path.join(REPO_ROOT, 'runs'))
  const resolvedTaskDir = taskDir ?? path.join(REPO_ROOT, 'tasks', taskId)
  if (live && !existsSync(resolvedTaskDir)) {
    throw new Error(`task not found: ${resolvedTaskDir} (claim population: ${taskId})`)
  }

  // Resolve every route BEFORE anything runs. Discovering a typo'd route at
  // trial 40 of 80 would leave half a sweep on disk under a route droid
  // cannot address. A dry run without a config gets a pass — the schedule is
  // a planning surface that must work on a machine with no droid install at
  // all — but --live refuses to start unverified.
  const canonicalRoutes = new Map()
  if (configPath && existsSync(configPath)) {
    for (const route of claim.routes) canonicalRoutes.set(route, resolveRoute(route, configPath))
  } else if (live) {
    throw new Error(
      `--live requires a readable Droid config (tried ${configPath ?? '(none)'}) — routes cannot be verified without one`
    )
  }
  const canonical = (route) => canonicalRoutes.get(route) ?? route

  const logPath = path.join(resolvedRunsDir, claim.id, 'sweep-log.jsonl')
  const priorLog = readSweepLog(logPath)
  const droppedRoutes = new Set(priorLog.filter(l => l.outcome === 'ROUTE_DROPPED').map(l => l.route))

  // An abort is sticky. A SWEEP_ABORTED line means the harness itself broke
  // mid-sweep and every subsequent slot is suspect; resuming as if nothing
  // happened (the faulting slot's pack exists, so it reads as "done") would
  // keep collecting on a known-broken harness. Refuse any live run until the
  // operator explicitly acknowledges the abort with --resume-after-abort,
  // which appends an ABORT_ACKNOWLEDGED line so the decision to continue is
  // itself on the record. A dry run is never blocked — it only reports the
  // state on disk.
  const lastAbortIdx = priorLog.reduce((idx, l, i) => l.outcome === 'SWEEP_ABORTED' ? i : idx, -1)
  if (live && lastAbortIdx >= 0 &&
      !priorLog.slice(lastAbortIdx + 1).some(l => l.outcome === 'ABORT_ACKNOWLEDGED')) {
    const abort = priorLog[lastAbortIdx]
    if (!resumeAfterAbort) {
      throw new Error(
        `sweep ${claim.id} was aborted and never acknowledged: SWEEP_ABORTED at ` +
        `${abort.route}/${abort.arm}/attempt-${abort.attempt} (${abort.ts ?? 'no timestamp'}). ` +
        `The harness faulted mid-sweep, so data collected around it is suspect until the fault ` +
        `is understood. Once it is, rerun with --resume-after-abort — the acknowledgement is ` +
        `appended to the sweep log so the decision to continue is on the record.`
      )
    }
    appendLogLine(logPath, {
      ts: new Date().toISOString(),
      route: abort.route ?? null,
      arm: abort.arm ?? null,
      attempt: abort.attempt ?? null,
      outcome: 'ABORT_ACKNOWLEDGED',
      packPath: null,
      replacement: false,
      note: 'operator acknowledged the harness-fault abort and chose to resume (--resume-after-abort)'
    })
  }

  // Replacements already used per route: the UNION of the replacement slots
  // the log knows about (SCHEDULED lines) and the replacement packs on disk
  // (attempt numbers above the registered n), keyed by (arm, attempt). Neither
  // history alone is authoritative — a crash can strand a SCHEDULED slot with
  // no pack, and a lost log can leave packs the log never recorded — and
  // taking Math.max of the two counts under-counts exactly when they partially
  // overlap, which would let a replacement slip past the cap.
  const replacementSlots = new Map()
  for (const route of claim.routes.map(canonical)) {
    const keys = new Set()
    for (const line of priorLog) {
      if (line.route === route && line.replacement === true && line.outcome === 'SCHEDULED' &&
          line.arm != null && line.attempt != null) {
        keys.add(`${line.arm}/attempt-${line.attempt}`)
      }
    }
    for (const arm of claim.arms) {
      const dir = path.join(resolvedRunsDir, arm, routeSlug(route), taskId)
      if (!existsSync(dir)) continue
      for (const name of readdirSync(dir)) {
        const m = name.match(ATTEMPT_DIR_RE)
        if (m && Number(m[1]) > claim.design.nPerArmPerRoute &&
            existsSync(path.join(dir, name, 'manifest.json'))) {
          keys.add(`${arm}/attempt-${Number(m[1])}`)
        }
      }
    }
    replacementSlots.set(route, keys)
  }
  const replacementsUsed = new Map([...replacementSlots.entries()].map(([route, keys]) => [route, keys.size]))

  // The queue is every slot the sweep knows about: the deterministic base
  // schedule, replacements recorded in the log (a SCHEDULED replacement whose
  // slot never completed is re-queued so a crash between scheduling and
  // executing loses no attempt), and replacement packs found on disk that
  // neither knows about (a lost log must not erase an attempt from the
  // record). Base slots come first, replacements after — matches the live
  // rule that a replacement is appended to the end of the schedule.
  const queue = buildSchedule(claim).map(s => ({ ...s, route: canonical(s.route) }))
  const known = new Set(queue.map(slotKey))
  const latestBySlot = new Map()
  for (const line of priorLog) {
    if (line.arm == null || line.attempt == null) continue
    latestBySlot.set(`${line.route}/${line.arm}/attempt-${line.attempt}`, line)
  }
  for (const line of priorLog) {
    if (line.replacement !== true || line.outcome !== 'SCHEDULED' || line.arm == null || line.attempt == null) continue
    const key = `${line.route}/${line.arm}/attempt-${line.attempt}`
    // Only a replacement whose LATEST log state is still SCHEDULED is pending;
    // one that was executed has a later outcome line and is recovered from its
    // pack on disk below instead.
    if (latestBySlot.get(key)?.outcome !== 'SCHEDULED') continue
    if (known.has(key)) continue
    known.add(key)
    queue.push({
      route: line.route,
      arm: line.arm,
      attempt: line.attempt,
      taskId,
      tuneFile: line.arm === claim.arms[0] ? null : claim.tuneFileResolved,
      replacement: true
    })
  }
  for (const route of claim.routes.map(canonical)) {
    for (const arm of claim.arms) {
      const dir = path.join(resolvedRunsDir, arm, routeSlug(route), taskId)
      if (!existsSync(dir)) continue
      for (const name of readdirSync(dir)) {
        const m = name.match(ATTEMPT_DIR_RE)
        if (!m || Number(m[1]) <= claim.design.nPerArmPerRoute) continue
        const slot = { route, arm, attempt: Number(m[1]), taskId, replacement: true }
        if (known.has(slotKey(slot))) continue
        if (!existsSync(path.join(dir, name, 'manifest.json'))) {
          assertNotHalfWritten(path.join(dir, name))
          continue
        }
        known.add(slotKey(slot))
        queue.push({ ...slot, tuneFile: arm === claim.arms[0] ? null : claim.tuneFileResolved })
      }
    }
  }

  // Initial status from disk and from the log's drop history. Adoption is
  // provenance-verified (a pack that cannot prove it belongs to this sweep
  // refuses the run, as does a half-written pack) — see verifyAdoptedPack.
  for (const slot of queue) {
    const dir = attemptDir(resolvedRunsDir, slot)
    if (packExists(resolvedRunsDir, slot)) {
      verifyAdoptedPack(dir, slot, claim)
      slot.status = 'done'
      slot.outcome = readPackOutcome(resolvedRunsDir, slot)
      slot.packPath = path.join(dir, 'manifest.json')
    } else {
      assertNotHalfWritten(dir)
      slot.status = droppedRoutes.has(slot.route) ? 'dropped' : 'pending'
    }
  }

  const result = {
    claimId: claim.id,
    live,
    taskDir: resolvedTaskDir,
    runsDir: resolvedRunsDir,
    logPath,
    executed: 0,
    stoppedByLimit: false,
    droppedRoutes: [],
    slots: queue,
    summary: null
  }
  const finish = () => {
    result.droppedRoutes = [...droppedRoutes]
    result.summary = summarizeSlots(queue, droppedRoutes, replacementsUsed, REPLACEMENT_CAP_PER_ROUTE)
    return result
  }
  if (!live) return finish()

  const tuneFor = (arm) => arm === claim.arms[0] ? null : claim.tuneFileResolved
  const nextFreeAttempt = (route, arm) => {
    let a = claim.design.nPerArmPerRoute + 1
    while (known.has(`${route}/${arm}/attempt-${a}`) ||
           packExists(resolvedRunsDir, { route, arm, attempt: a, taskId })) a++
    return a
  }

  // The claim's exclusion rule, shared by in-process results and adopted
  // packs: a slot that never reached the model is replaced at the same arm
  // and route — capped per route across both arms, counting the union of the
  // log's and disk's replacement history. SCHEDULED is logged before the slot
  // exists anywhere else, so a crash between scheduling and running leaves the
  // slot recoverable from the log on the next run.
  const scheduleReplacement = (slot) => {
    if (droppedRoutes.has(slot.route)) return
    if ((replacementsUsed.get(slot.route) ?? 0) >= REPLACEMENT_CAP_PER_ROUTE) {
      droppedRoutes.add(slot.route)
      appendLogLine(logPath, {
        ts: new Date().toISOString(),
        route: slot.route,
        arm: null,
        attempt: null,
        outcome: 'ROUTE_DROPPED',
        packPath: null,
        replacement: false
      })
      return
    }
    const attempt = nextFreeAttempt(slot.route, slot.arm)
    const replacement = {
      route: slot.route,
      arm: slot.arm,
      attempt,
      taskId,
      tuneFile: tuneFor(slot.arm),
      replacement: true,
      status: 'pending'
    }
    known.add(slotKey(replacement))
    replacementsUsed.set(slot.route, (replacementsUsed.get(slot.route) ?? 0) + 1)
    replacementSlots.get(slot.route)?.add(`${slot.arm}/attempt-${attempt}`)
    queue.push(replacement)
    appendLogLine(logPath, {
      ts: new Date().toISOString(),
      route: slot.route,
      arm: slot.arm,
      attempt,
      outcome: 'SCHEDULED',
      packPath: null,
      replacement: true
    })
  }

  // Adopted packs are not exempt from the exclusion rule: a pre-existing pack
  // whose outcome is replaceable (it never reached the model — e.g. a
  // pre-sweep smoke test that landed on the sweep's path) must not sit in the
  // evidence base as if it were this sweep's data. Put it through the same
  // replacement logic, idempotently — the union of the log's SCHEDULED lines
  // and the disk's replacement packs is the record of what is already queued
  // or executed for this arm, so resuming twice never double-schedules.
  const replaceableSeen = new Map() // `${route}/${arm}` -> adopted failures examined so far
  for (const slot of queue) {
    if (slot.status !== 'done' || !REPLACEABLE_OUTCOMES.includes(slot.outcome)) continue
    const armKey = `${slot.route}/${slot.arm}`
    const seen = (replaceableSeen.get(armKey) ?? 0) + 1
    replaceableSeen.set(armKey, seen)
    const alreadyQueued = [...(replacementSlots.get(slot.route) ?? [])]
      .filter(k => k.startsWith(`${slot.arm}/`)).length
    if (alreadyQueued >= seen) continue
    scheduleReplacement(slot)
  }

  // The queue grows as replacements are appended; iterate by index.
  for (let i = 0; i < queue.length; i++) {
    const slot = queue[i]
    if (slot.status === 'done') continue
    if (droppedRoutes.has(slot.route)) { slot.status = 'dropped'; continue }
    if (limit !== null && result.executed >= limit) {
      // Stop iterating: continuing the loop would keep re-marking dropped
      // routes against slots that can no longer run this invocation. Report
      // stoppedByLimit only when work actually remains — if the remaining
      // queue is all done/dropped, the sweep finished exactly at the limit.
      result.stoppedByLimit = queue.slice(i).some(s => s.status === 'pending' && !droppedRoutes.has(s.route))
      break
    }
    const trial = await runOne({
      taskDir: resolvedTaskDir,
      model: slot.route,
      droidPath,
      sessionsDir,
      configPath,
      runsDir: resolvedRunsDir,
      tuneName: slot.arm,
      attempt: slot.attempt,
      autoLevel: claim.design.autoLevel,
      timeoutMs: claim.design.timeoutMs,
      tuneFile: slot.tuneFile
    })
    result.executed++
    slot.status = 'done'
    slot.outcome = trial.outcome
    slot.packPath = trial.manifestPath ?? path.join(attemptDir(resolvedRunsDir, slot), 'manifest.json')
    appendLogLine(logPath, {
      ts: new Date().toISOString(),
      route: slot.route,
      arm: slot.arm,
      attempt: slot.attempt,
      outcome: trial.outcome,
      packPath: slot.packPath,
      replacement: slot.replacement === true
    })
    if (ABORT_OUTCOMES.includes(trial.outcome)) {
      result.abortedBy = { outcome: trial.outcome, route: slot.route, arm: slot.arm, attempt: slot.attempt }
      appendLogLine(logPath, {
        ts: new Date().toISOString(),
        route: slot.route,
        arm: slot.arm,
        attempt: slot.attempt,
        outcome: 'SWEEP_ABORTED',
        packPath: slot.packPath,
        replacement: false
      })
      break
    }
    if (!REPLACEABLE_OUTCOMES.includes(trial.outcome)) continue

    // In-process results go through the same exclusion-rule path as adopted
    // packs — see scheduleReplacement.
    scheduleReplacement(slot)
  }
  return finish()
}

// Per-route × per-arm outcome counts over every slot the sweep knows about —
// base schedule, replacements, resumed packs. NOTE: this deliberately does not
// compute the claim's statistics. Pooling rates, the Fisher test, and the
// decision rule are analysis, and analysis is a separate deliberate step that
// happens after the data exists; a sweep that computed the claim's own metric
// at the end of every run would be re-cutting results in the same tool that
// collected them.
function summarizeSlots (slots, droppedRoutes, replacementsUsed, cap) {
  const routes = []
  const byRoute = new Map()
  for (const slot of slots) {
    if (!byRoute.has(slot.route)) {
      const r = {
        route: slot.route,
        dropped: droppedRoutes.has(slot.route),
        replacementsUsed: replacementsUsed.get(slot.route) ?? 0,
        replacementCap: cap,
        arms: []
      }
      byRoute.set(slot.route, { ...r, byArm: new Map() })
      routes.push(r)
    }
    const routeEntry = byRoute.get(slot.route)
    if (!routeEntry.byArm.has(slot.arm)) {
      const a = { arm: slot.arm, outcomes: {}, pending: 0, dropped: 0 }
      routeEntry.byArm.set(slot.arm, a)
      routes.find(r => r.route === slot.route).arms.push(a)
    }
    const armEntry = routeEntry.byArm.get(slot.arm)
    if (slot.status === 'pending') armEntry.pending++
    else if (slot.status === 'dropped') armEntry.dropped++
    else {
      const outcome = slot.outcome ?? 'UNKNOWN'
      armEntry.outcomes[outcome] = (armEntry.outcomes[outcome] ?? 0) + 1
    }
  }
  return { routes }
}

function formatArm (a) {
  const parts = Object.entries(a.outcomes).map(([outcome, count]) => `${outcome}×${count}`)
  if (a.pending > 0) parts.push(`pending ${a.pending}`)
  if (a.dropped > 0) parts.push(`dropped ${a.dropped}`)
  return parts.length > 0 ? parts.join(' · ') : '—'
}

// The dry-run surface: the full schedule, one row per slot, with its status.
export function renderSchedule (result) {
  const lines = [
    `SWEEP ${result.claimId} — DRY RUN (pass --live to execute; nothing will be spawned)`,
    `  task      ${result.slots[0]?.taskId ?? '?'} (${result.taskDir})`,
    `  runs      ${result.runsDir}`,
    `  log       ${result.logPath}`,
    `  slots     ${result.slots.length}`
  ]
  const routeWidth = Math.max(5, ...result.slots.map(s => s.route.length))
  const armWidth = Math.max(3, ...result.slots.map(s => s.arm.length))
  lines.push(`  ${'ROUTE'.padEnd(routeWidth)}  ${'ARM'.padEnd(armWidth)}  ATTEMPT  STATUS`)
  for (const slot of result.slots) {
    lines.push(
      `  ${slot.route.padEnd(routeWidth)}  ${slot.arm.padEnd(armWidth)}  ${String(slot.attempt).padEnd(7)}  ` +
      `${slot.status}${slot.replacement ? ' (replacement)' : ''}` +
      (slot.outcome ? ` — ${slot.outcome}` : '')
    )
  }
  return lines.join('\n')
}

// The live-run book of record: outcome counts per route × per arm. The
// trailing line is a standing reminder that the sweep reports and never
// concludes — see the comment on summarizeSlots.
export function renderSweepSummary (result) {
  const lines = [
    `SWEEP ${result.claimId} — ${result.executed} trial(s) executed this run` +
      (result.stoppedByLimit ? ' (stopped by --limit; rerun to resume)' : ''),
    `  log       ${result.logPath}`
  ]
  if (result.abortedBy) {
    const a = result.abortedBy
    lines.push(
      `  ABORTED: ${a.outcome} on ${a.route} / ${a.arm} / attempt ${a.attempt}.`,
      '  The harness itself faulted, so the remaining slots were not run and every',
      '  result already collected should be treated as suspect until the fault is',
      '  understood. This is NOT one of the claim\'s replaceable exclusions: fix the',
      '  harness, then resume — do not replace the trial.'
    )
  }
  const tainted = result.summary.routes.flatMap(r => r.arms).reduce((n, a) => n + (a.outcomes.TUNE_CONTAMINATED ?? 0), 0)
  if (tainted > 0) {
    lines.push(
      `  ${tainted} trial(s) came back TUNE_CONTAMINATED (the agent committed the tune`,
      '  into the graded history). They are NOT replaced — resampling until an arm',
      '  looks clean would be exactly the re-cutting the claim forbids. Report them.'
    )
  }
  for (const route of result.summary.routes) {
    lines.push(
      `  route ${route.route} · replacements ${route.replacementsUsed}/${route.replacementCap}` +
      (route.dropped ? ' · ROUTE DROPPED (replacement cap reached — excluded from pooled analysis per the claim)' : '')
    )
    for (const arm of route.arms) lines.push(`    ${arm.arm}  ${formatArm(arm)}`)
  }
  lines.push('Outcome counts are the sweep\'s book of record — computing the claim\'s statistics (pooled rates, decision rule) is a separate deliberate analysis step, not part of the sweep.')
  return lines.join('\n')
}
