#!/usr/bin/env node
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { auditPath, renderAudit } from '../lib/audit.js'
import { badgeFromRuns, badgeFromWeather, renderBadge } from '../lib/badge.js'
import { runDiagnose } from '../lib/diagnose.js'
import { renderDiagnose } from '../lib/report.js'
import { runTrial } from '../lib/runner.js'
import { makeRunOne, runTriforce } from '../lib/triforce.js'
import { runBaseline } from '../lib/baseline.js'
import { runSweep, renderSchedule, renderSweepSummary } from '../lib/sweep.js'
import { resolveDroid } from '../lib/droid-path.js'
import { resolveTuneFile } from '../lib/tune.js'
import { routeOwner, routeSlug } from '../lib/paths.js'
import { readObservations, summarize } from '../lib/weather.js'
import { newestTranscript, renderFinding, renderWatchSummary, watchFile } from '../lib/watch.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const USAGE = `droidtune — Droid Tune-Up: diagnose, tune, verify (more verified work, fewer wasted tokens)

Usage:
  droidtune diagnose [flags]     Check protocol, model routing, cache, and configuration health
  droidtune trial [flags]        Run one task end-to-end through droid exec; write an evidence pack
  droidtune baseline [flags]     Run the frozen native-Droid suite (live; explicit spend confirmation)
  droidtune sweep [flags]        Run (or preview) the trial schedule of a preregistered claim
  droidtune run <task> [flags]   Grade a task offline (oracle/--noop/--cheat) — triforce self-test
  droidtune triforce             Run the offline tri-force self-test (49 legs)
  droidtune audit <dir> [flags]  Count process violations in a pack (or a whole runs dir) — offline
  droidtune badge <target>       Emit a shields.io endpoint badge from a runs dir or from weather/
  droidtune watch [flags]        Stream audit findings from a transcript as it is written — offline

diagnose flags:
  --json                 Machine-readable output
  --demo                 Run against bundled fixtures (no Droid install needed)
  --probe [model]        Live round-trip through droid exec on a BYOK custom model
                         (opt-in; spends your BYOK credits/points; model = id, name,
                         or unique substring; default: first Z.AI anthropic entry)
  --limit <n>            Recent-session table size (default 20)

trial flags:
  --task <dir>           Task directory (required; e.g. tasks/t001-greet-script)
  --model <id>           Custom-model id or unique substring (REQUIRED — no
                         default; spends your BYOK credits/plan. Known-free
                         routes: hy3-free, nemotron-3.5-lightning-free,
                         laguna-s-2.1-free, nemotron-3-ultra-free)
  --tune <name>          Tune name for the pack path (default ad-hoc)
  --tune-file <path>     Tune dir (or AGENTS.md) copied into the worktree before
                         droid exec; e.g. tunes/ledger-lite
  --attempt <n>          Attempt number (default 1)
  --auto <level>         Autonomy: low|medium|high (default high)
  --timeout-ms <n>       Per-trial timeout (default 300000)
  --runs-dir <path>      Evidence-pack root (default ./runs)

baseline flags:
  --bundle <file>        Frozen bundle spec (default configs/native-droid.json)
  --confirm-spend        Required acknowledgement before any live baseline trial
  --runs-dir <path>      Evidence-pack root (default ./runs)

sweep flags:
  --claim <file>         Preregistered claim JSON (required; a bare id resolves
                         against claims/, e.g. dt-v1-ledger-lite-nosub)
  --live                 Execute the schedule (default: dry run — prints the
                         route/arm/attempt table with statuses; spawns nothing)
  --limit <n>            Execute only the first n pending slots, then stop
                         cleanly (paced batches against rate-limited routes)
  --runs-dir <path>      Evidence-pack root (default ./runs)

run flags:
  --offline              Offline grading (no droid); apply the task oracle solution
  --noop                 Grade an empty diff (no solution applied)
  --cheat <name>         Run tasks/<id>/cheats/<name>.sh instead of the real tests
  --tune-file <path>     Apply a tune to the worktree (same as trial; offline-safe)

audit flags:
  <dir>                  Evidence pack (…/attempt-N) or a runs/demo-pack root (required)
  --window <n>           Tool events a claim may reach back for its check (default 8)
  --stall-threshold <n>  Identical command repeats that count as a stall (default 3)
  --json                 Machine-readable output

badge flags:
  <target>               A runs/demo-pack dir, or 'weather' (or a route-status.jsonl)
  --label <text>         Badge label (default: "verified pass" / "free routes")
  --out <file>           Write the JSON to a file instead of stdout

watch flags:
  --file <path>          Transcript to watch (default: newest under the sessions dir)
  --interval-ms <n>      Poll interval (default 700)
  --once                 Single pass over the current contents, then exit
  --json                 Emit one JSON object per finding

common flags:
  --sessions-dir <path>  Override ~/.factory/sessions
  --config <file>        Override ~/.factory/settings.json
  --droid-path <path>    Override droid binary location
  -h, --help             Show this help

Exit codes:
  0 clean/VERIFIED_PASS/no violations · 1 faults, non-pass outcome, or violations · 2 usage error

Unofficial community project. Not affiliated with Factory.
`

function usage (code = 0) {
  process.stdout.write(USAGE)
  process.exit(code)
}

function usageError (msg) {
  process.stderr.write(`droidtune: ${msg}\n\n`)
  usage(2)
}

const VALUE_FLAGS = new Map([
  ['--sessions-dir', 'sessionsDir'],
  ['--config', 'configPath'],
  ['--droid-path', 'droidPath'],
  ['--limit', 'limit'],
  ['--task', 'task'],
  ['--model', 'model'],
  ['--tune', 'tune'],
  ['--tune-file', 'tuneFile'],
  ['--auto', 'auto'],
  ['--timeout-ms', 'timeoutMs'],
  ['--runs-dir', 'runsDir'],
  ['--attempt', 'attempt'],
  ['--cheat', 'cheat'],
  ['--bundle', 'bundlePath'],
  ['--claim', 'claim'],
  ['--window', 'window'],
  ['--label', 'label'],
  ['--out', 'out'],
  ['--file', 'file'],
  ['--interval-ms', 'intervalMs'],
  ['--stall-threshold', 'stallThreshold']
])
const INT_FLAG_KEYS = new Set(['limit', 'timeoutMs', 'attempt', 'window', 'stallThreshold', 'intervalMs'])

function parseArgs (argv) {
  if (argv.length === 0) usage(2)
  const cmd = argv[0]
  const opts = { probe: null }
  const rest = argv.slice(1)
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a === '--help' || a === '-h') usage(0)
    else if (a === '--json') opts.json = true
    else if (a === '--demo') opts.demo = true
    else if (a === '--probe') {
      const nx = rest[i + 1]
      if (nx !== undefined && !nx.startsWith('-')) { opts.probe = nx; i++ } else opts.probe = ''
    } else if (a === '--once') {
      opts.once = true
    } else if (a === '--offline') {
      opts.offline = true
    } else if (a === '--noop') {
      opts.noop = true
    } else if (a === '--confirm-spend') {
      opts.confirmSpend = true
    } else if (a === '--live') {
      opts.live = true
    } else if (cmd === 'run' && !a.startsWith('-') && opts.task === undefined) {
      opts.task = a
    } else if ((cmd === 'audit' || cmd === 'badge') && !a.startsWith('-') && opts.target === undefined) {
      opts.target = a
    } else if (VALUE_FLAGS.has(a)) {
      const v = rest[++i]
      if (v === undefined || v.startsWith('-')) usageError(`missing value for ${a}`)
      const key = VALUE_FLAGS.get(a)
      if (INT_FLAG_KEYS.has(key)) {
        const n = Number(v)
        if (!Number.isInteger(n) || n < 1) usageError(`${a} must be a positive integer`)
        opts[key] = n
      } else {
        opts[key] = v
      }
    } else {
      usageError(`unknown flag: ${a}`)
    }
  }
  return [cmd, opts]
}

// Shared with `diagnose` (lib/droid-path.js): explicit --droid-path >
// DROID_PATH env > ~/.local/bin/droid > PATH, each candidate verified with
// `--version`. Previously `trial`/`baseline` hardcoded ~/.local/bin/droid
// directly and would fail on any machine where `diagnose` had already found a
// working droid somewhere else (DROID_PATH or PATH).
function resolveDroidOrDie (opts) {
  const droid = resolveDroid(opts.droidPath)
  if (!droid) {
    throw new Error(
      `droid CLI not found or not executable (tried: ${opts.droidPath ?? 'DROID_PATH, ~/.local/bin/droid, PATH'}). ` +
      `Run 'droidtune diagnose' for details (DT001).`
    )
  }
  return droid.path
}

// Same reasoning as resolveTaskDir: a relative --tune-file resolves against
// the invoking shell's cwd, which for a plugin install is almost never the
// bundle where tunes/ lives. Fall back to REPO_ROOT (= DROID_PLUGIN_ROOT) so
// `--tune-file tunes/ledger-lite` and `--tune-file ledger-lite` both work
// regardless of where the caller stood.
function resolveTuneSpec (spec) {
  if (spec === undefined || spec === null) return null
  let resolved = path.resolve(spec)
  if (!path.isAbsolute(spec) && !existsSync(spec)) {
    for (const candidate of [path.join(REPO_ROOT, spec), path.join(REPO_ROOT, 'tunes', spec)]) {
      if (existsSync(candidate)) { resolved = candidate; break }
    }
  }
  // Fail here, before a trial spawns anything, with the same message the
  // runner would have produced deep inside a live run.
  try {
    resolveTuneFile(resolved)
  } catch (err) {
    usageError(`${err.message} (looked in the current directory and ${path.join(REPO_ROOT, 'tunes')})`)
  }
  return resolved
}

function defaultTrialPaths (opts) {
  return {
    configPath: opts.configPath ?? path.join(os.homedir(), '.factory', 'settings.json'),
    sessionsDir: opts.sessionsDir ?? path.join(os.homedir(), '.factory', 'sessions')
  }
}

// Known-free BYOK routes as of 2026-08-19 (verified working in this repo's
// own flake checks). Offered only as a suggestion in error/help text — never
// auto-selected. See docs/m4-flake-check-2026-08.md.
const KNOWN_FREE_ROUTES = ['hy3-free', 'nemotron-3.5-lightning-free', 'laguna-s-2.1-free', 'nemotron-3-ultra-free']

async function cmdTrial (opts) {
  if (!opts.task) usageError('trial requires --task <dir>')
  if (opts.auto !== undefined && !['low', 'medium', 'high'].includes(opts.auto)) {
    usageError('--auto must be low, medium, or high')
  }
  // Money bug guard: `trial` runs a LIVE droid exec that spends whatever BYOK
  // route it is given. There is no safe default model to fall back to — a
  // repo's first customModels entry may be a paid plan (e.g. a Z.AI Coding
  // Plan seat) — so refuse outright rather than silently picking one. The
  // operator must name a model explicitly; this is the confirmation gate.
  if (!opts.model) {
    usageError(
      `trial requires --model <id> — there is no default (an implicit default risks ` +
      `spending a paid plan). Known-free BYOK routes as of 2026-08-19 (verify against ` +
      `your own ~/.factory/settings.json): ${KNOWN_FREE_ROUTES.join(', ')}. ` +
      `Run 'droidtune diagnose' to see your configured customModels.`
    )
  }
  // Validate the tune spec before anything heavier fires (droid binary
  // resolution, collision guard): a typo'd --tune-file must be the same
  // usage error (exit 2) on a machine with no droid installed at all.
  const tuneFile = resolveTuneSpec(opts.tuneFile)
  const paths = defaultTrialPaths(opts)
  const model = opts.model
  // Resolve the task dir with the SAME helper `run` uses (below), instead of
  // trial's own ad-hoc handling of opts.task. This matters most for plugin
  // installs: a relative --task resolves against process.cwd() (wherever the
  // invoking shell/droid session happens to be), not against the plugin
  // bundle where tasks/ actually lives, so a plugin-relative task id like
  // "t001-greet-script" only worked if the caller's cwd happened to be the
  // plugin root. resolveTaskDir falls back to REPO_ROOT/tasks (which is
  // DROID_PLUGIN_ROOT/tasks for a plugin install) so it works regardless of
  // invoking cwd.
  const taskDir = resolveTaskDir(opts.task)
  if (!existsSync(taskDir)) usageError(`task not found: ${opts.task}`)
  // Evidence-pack root: explicit --runs-dir wins, otherwise REPO_ROOT/runs
  // (matches `baseline`'s resolution exactly, and — for a plugin install —
  // resolves to DROID_PLUGIN_ROOT/runs regardless of invoking cwd). Resolving
  // this explicitly here, rather than leaving it undefined for runner.js to
  // default internally, keeps the value available to print in the report
  // hint below.
  const resolvedRunsDir = path.resolve(opts.runsDir ?? path.join(REPO_ROOT, 'runs'))
  // Collision guard: lib/pack.js already refuses to overwrite a non-empty
  // attempt dir, but only at the very END of runTrial — after a full LIVE
  // droid exec has already run and spent whatever the route costs. Detect
  // the same collision here, BEFORE spawning droid, and refuse with the next
  // free attempt number instead of wasting a live spend on a trial that was
  // always going to fail at write time.
  const tuneName = opts.tune ?? 'ad-hoc'
  const attempt = opts.attempt ?? 1
  const taskId = path.basename(taskDir)
  // Key the guard on the SAME path runTrial will write — route segment included
  // (lib/paths.js) — or it stops guarding anything: two routes at the same
  // attempt number are distinct packs and must both be allowed to run.
  const route = routeSlug(model)
  // Route identity guard: the slug is a readable address, not an identity —
  // `custom:x-OpenCode-Zen-free-8` and a second provider's `x` both address
  // runs/<tune>/x/. Pooling two providers under one route directory would
  // corrupt any per-route claim reading that tree, and nothing downstream
  // could tell, because the arm looks like a single route. Compare against the
  // full id the existing packs recorded before writing another one.
  const owner = routeOwner(resolvedRunsDir, tuneName, route)
  if (owner !== null && owner !== model) {
    throw new Error(
      `route directory ${path.join(resolvedRunsDir, tuneName, route)} already holds packs from ` +
      `a different model id (${owner}), but this trial requests ${model}. Both ids reduce to the ` +
      `same route segment "${route}", so continuing would pool two routes into one arm. ` +
      `Use --runs-dir to keep them apart.`
    )
  }
  const attemptDirFor = (n) => path.join(resolvedRunsDir, tuneName, route, taskId, `attempt-${n}`)
  const attemptManifestPath = (n) => path.join(attemptDirFor(n), 'manifest.json')
  if (existsSync(attemptManifestPath(attempt))) {
    let next = attempt + 1
    while (existsSync(attemptManifestPath(next))) next++
    throw new Error(
      `attempt ${attempt} already has an evidence pack at ` +
      `${attemptDirFor(attempt)} — refusing to spend a live trial ` +
      `on a run that would fail at write time. Retry with --attempt ${next} (the next free attempt number).`
    )
  }
  const result = await runTrial({
    taskDir,
    model,
    droidPath: resolveDroidOrDie(opts),
    sessionsDir: paths.sessionsDir,
    configPath: paths.configPath,
    runsDir: resolvedRunsDir,
    tuneName,
    attempt,
    autoLevel: opts.auto ?? 'high',
    timeoutMs: opts.timeoutMs,
    tuneFile
  })
  const reportCmd = `node ${path.join(REPO_ROOT, 'scripts', 'results-table.js')} --runs-dir ${resolvedRunsDir}`
  // `trial` is always a development/ad-hoc run — it never freezes bundle
  // provenance, pricing, or config the way `baseline` does (see PLAN §8
  // Claims Integrity Protocol; AGENTS.md: "claim-eligible published packs
  // begin with M5 baselines"). Label it explicitly so a scratch pack under
  // runs/<tune>/... can never be mistaken for claim-grade evidence just
  // because it has a manifest and a hash-verified tree.
  const claimEligible = false
  if (opts.json) {
    process.stdout.write(JSON.stringify({ ...result, claimEligible, reportCmd }, null, 2) + '\n')
  } else {
    const r = result.results
    const lines = [
      `TRIAL ${result.trialId}`,
      `  outcome    ${result.outcome}` + (r.reward !== undefined ? ` (reward ${r.reward})` : '') + (r.reason ? ` — ${r.reason}` : ''),
      `  duration   ${r.durationMs}ms`,
      r.commits ? `  commits    ${r.commits.length} (${r.commits[0]})` : null,
      result.usage ? `  usage      in ${result.usage.inputTokens} · out ${result.usage.outputTokens} · cacheRead ${result.usage.cacheReadTokens} · route ${result.usage.routeClass}` : null,
      `  pack       ${result.manifestPath}`,
      `  report     ${reportCmd}`,
      `  claimEligible false — development/ad-hoc pack, not frozen baseline evidence (see 'droidtune baseline')`
    ].filter(Boolean)
    process.stdout.write(lines.join('\n') + '\n')
  }
  process.exitCode = result.outcome === 'VERIFIED_PASS' ? 0 : 1
}

async function cmdBaseline (opts) {
  if (!opts.confirmSpend) usageError('baseline requires --confirm-spend; it runs live Droid trials')
  const paths = defaultTrialPaths(opts)
  const result = await runBaseline({
    bundlePath: path.resolve(opts.bundlePath ?? path.join(REPO_ROOT, 'configs', 'native-droid.json')),
    repoRoot: REPO_ROOT,
    configPath: paths.configPath,
    sessionsDir: paths.sessionsDir,
    droidPath: resolveDroidOrDie(opts),
    runsDir: path.resolve(opts.runsDir ?? path.join(REPO_ROOT, 'runs')),
    confirmSpend: true
  })
  const pass = result.results.filter(r => r.outcome === 'VERIFIED_PASS').length
  if (opts.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  else process.stdout.write(`BASELINE ${result.bundle.id}\n  outcomes   ${pass}/${result.results.length} VERIFIED_PASS${result.stoppedByBudget ? ' (stopped by budget)' : ''}\n  snapshot   ${path.join(opts.runsDir ?? path.join(REPO_ROOT, 'runs'), result.bundle.tuneName, 'bundle.snapshot.json')}\n`)
  process.exitCode = !result.stoppedByBudget && pass === result.results.length ? 0 : 1
}

// `sweep` executes a preregistered claim's schedule (lib/sweep.js). Without
// --live it is a planning surface like diagnose: it prints the schedule table
// and never touches droid — no binary resolution, no spend. --live gates the
// real execution behind the same droid resolution trial uses.
async function cmdSweep (opts) {
  if (!opts.claim) usageError('sweep requires --claim <file> (e.g. claims/dt-v1-ledger-lite-nosub.json or the bare id)')
  // A bare claim id resolves against claims/ (same fallback shape as badge's
  // target resolution) so `--claim dt-v1-ledger-lite-nosub` works from any cwd.
  let claimPath = opts.claim
  if (!path.isAbsolute(claimPath) && !existsSync(claimPath)) {
    const name = claimPath.endsWith('.json') ? claimPath : `${claimPath}.json`
    for (const candidate of [path.join(REPO_ROOT, claimPath), path.join(REPO_ROOT, 'claims', name)]) {
      if (existsSync(candidate)) { claimPath = candidate; break }
    }
  }
  if (!existsSync(claimPath)) usageError(`claim not found: ${opts.claim}`)
  const paths = defaultTrialPaths(opts)
  const result = await runSweep({
    claimPath: path.resolve(claimPath),
    runsDir: path.resolve(opts.runsDir ?? path.join(REPO_ROOT, 'runs')),
    configPath: paths.configPath,
    sessionsDir: paths.sessionsDir,
    // droid is resolved only for --live: a dry run must work on a machine with
    // no droid installed at all.
    droidPath: opts.live ? resolveDroidOrDie(opts) : undefined,
    live: !!opts.live,
    limit: opts.limit ?? null
  })
  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  } else if (result.live) {
    process.stdout.write(renderSweepSummary(result) + '\n')
  } else {
    process.stdout.write(renderSchedule(result) + '\n')
  }
  // A dropped route means the registered design could not complete, which is a
  // fault worth surfacing even when every remaining trial succeeded. An abort
  // is stronger still: the harness broke mid-sweep.
  process.exitCode = (result.abortedBy || result.droppedRoutes.length > 0) ? 1 : 0
}

function resolveTaskDir (task) {
  if (path.isAbsolute(task)) return task
  if (existsSync(task)) return path.resolve(task)
  const underTasks = path.join(REPO_ROOT, 'tasks', task)
  if (existsSync(underTasks)) return underTasks
  // Allow a short id like "t001" → tasks/t001-*.
  try {
    const tasksDir = path.join(REPO_ROOT, 'tasks')
    const matches = readdirSync(tasksDir).filter(d => d === task || d.startsWith(task + '-'))
    if (matches.length === 1) return path.join(tasksDir, matches[0])
  } catch {}
  return underTasks
}

async function cmdRun (opts) {
  if (!opts.task) usageError('run requires a task id or --task <dir>')
  const taskDir = resolveTaskDir(opts.task)
  if (!existsSync(taskDir)) usageError(`task not found: ${opts.task}`)
  // The offline `run` command exists for triforce self-testing: it grades the
  // oracle solution (or an empty diff, or a cheat script) with no droid call.
  const result = await runTrial({
    taskDir,
    model: 'offline',
    runsDir: opts.runsDir,
    tuneName: opts.tune ?? 'selfcheck',
    attempt: opts.attempt ?? Date.now(),
    offline: true,
    cheat: opts.cheat ?? null,
    noop: !!opts.noop,
    tuneFile: resolveTuneSpec(opts.tuneFile)
  })
  process.stdout.write(`verdict=${result.outcome}\n`)
  process.stdout.write(`task=${path.basename(taskDir)}\n`)
  process.stdout.write(`pack=${result.manifestPath}\n`)
  process.exitCode = 0
}

// `audit` is strictly offline: it reads transcripts that are already on disk.
// No droid binary, no credentials, no network, no model — so unlike `trial` it
// has nothing to gate and nothing to spend.
async function cmdAudit (opts) {
  if (!opts.target) usageError('audit requires a directory: an evidence pack (…/attempt-N) or a runs/demo-pack root')
  const target = path.resolve(opts.target)
  if (!existsSync(target)) usageError(`not found: ${opts.target}`)
  let result
  try {
    result = auditPath(target, { coverageWindow: opts.window, stallThreshold: opts.stallThreshold })
  } catch (err) {
    usageError(err.message)
  }
  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  } else {
    process.stdout.write(renderAudit(result) + '\n')
  }
  // Same contract as `diagnose`: 0 clean, 1 when something was found. A pack
  // with no transcript is missing evidence, not a violation, so it does not
  // set the exit code — the report says so in words instead.
  process.exitCode = (result.total ?? 0) > 0 ? 1 : 0
}

// `badge` reads committed artifacts and prints JSON. Like `audit`, it is
// offline by construction — there is nothing here to spend or to leak.
//
// A badge is the most-read number in a repository and the least-checked one,
// so both variants are computed from the same files the reporting tools read
// rather than from a number someone typed once.
async function cmdBadge (opts) {
  if (!opts.target) {
    usageError("badge requires a target: a runs/demo-pack directory, or 'weather'")
  }
  let target = opts.target
  if (!path.isAbsolute(target) && !existsSync(target)) {
    const candidate = path.join(REPO_ROOT, target)
    if (existsSync(candidate)) target = candidate
  }
  target = path.resolve(target)
  if (!existsSync(target)) usageError(`not found: ${opts.target}`)

  // Dispatch on what the target actually holds, not on its name: a weather
  // series is a route-status.jsonl (or the directory containing one).
  const seriesPath = target.endsWith('.jsonl')
    ? target
    : path.join(target, 'route-status.jsonl')
  const badge = existsSync(seriesPath)
    ? badgeFromWeather(
        summarize(readObservations(seriesPath).observations),
        opts.label ? { label: opts.label } : {}
      )
    : badgeFromRuns(target, opts.label ? { label: opts.label } : {})

  const text = renderBadge(badge)
  if (opts.out) {
    writeFileSync(path.resolve(opts.out), text)
    process.stdout.write(`wrote ${path.resolve(opts.out)}: ${badge.label} — ${badge.message}\n`)
  } else {
    process.stdout.write(text)
  }
  process.exitCode = 0
}

// `watch` runs lib/audit.js's detectors against a transcript while droid is
// still writing it. Offline in the same sense `audit` is: it reads a file that
// another process happens to be appending to, and calls nothing.
async function cmdWatch (opts) {
  let target = opts.file ? path.resolve(opts.file) : null
  if (target === null) {
    const sessionsDir = opts.sessionsDir ?? path.join(os.homedir(), '.factory', 'sessions')
    const newest = await newestTranscript(sessionsDir)
    if (!newest) {
      usageError(
        `no transcript found under ${sessionsDir}. Start a droid session first, or watch a ` +
        `specific file with --file <transcript.jsonl>.`
      )
    }
    target = newest.path
    process.stderr.write(`watching newest session ${newest.id} (${target})\n`)
  }
  if (!existsSync(target)) usageError(`not found: ${opts.file ?? target}`)

  const emit = (v) => process.stdout.write(
    (opts.json ? JSON.stringify(v) : renderFinding(v)) + '\n'
  )
  const auditOpts = { coverageWindow: opts.window, stallThreshold: opts.stallThreshold }

  const controller = watchFile(target, {
    ...auditOpts,
    intervalMs: opts.intervalMs ?? 700,
    onFindings: (fresh) => { for (const v of fresh) emit(v) }
  })

  const finish = () => {
    const { fresh, result } = controller.stop()
    for (const v of fresh) emit(v)
    if (!opts.json) process.stderr.write('\n' + renderWatchSummary(result, { filePath: target }) + '\n')
    // Same contract as diagnose/audit: 1 when something was found.
    process.exitCode = (result?.total ?? 0) > 0 ? 1 : 0
  }

  if (opts.once) { finish(); return }

  // Ctrl-C is the normal way to end a watch, and it must still print the
  // terminal findings that were withheld during streaming — otherwise
  // no-test-finish, the one this tool most wants to tell you about, is the one
  // finding you never see.
  await new Promise((resolve) => {
    const onSignal = () => { process.off('SIGINT', onSignal); resolve() }
    process.on('SIGINT', onSignal)
  })
  finish()
}

async function cmdTriforce () {
  // makeRunOne shells back into this CLI from the repo root. Gate every task
  // that has the full Harbor layout (instruction + seed + oracle + tests).
  process.chdir(REPO_ROOT)
  const tasksDir = path.join(REPO_ROOT, 'tasks')
  const ids = readdirSync(tasksDir).filter(d =>
    existsSync(path.join(tasksDir, d, 'environment', 'seed.sh')) &&
    existsSync(path.join(tasksDir, d, 'solution', 'solve.sh')) &&
    existsSync(path.join(tasksDir, d, 'tests', 'test.sh')))
  if (ids.length === 0) {
    process.stderr.write('droidtune: no tasks with full Harbor layout found\n')
    process.exitCode = 2
    return
  }
  let ok = true
  for (const id of ids.sort()) {
    process.stdout.write(`task ${id}\n`)
    const res = runTriforce(makeRunOne({ taskId: id }))
    if (!res.ok) ok = false
  }
  process.exitCode = ok ? 0 : 1
}

async function main () {
  const [cmd, opts] = parseArgs(process.argv.slice(2))
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') usage(0)
  if (cmd === 'trial') return cmdTrial(opts)
  if (cmd === 'baseline') return cmdBaseline(opts)
  if (cmd === 'sweep') return cmdSweep(opts)
  if (cmd === 'run') return cmdRun(opts)
  if (cmd === 'audit') return cmdAudit(opts)
  if (cmd === 'badge') return cmdBadge(opts)
  if (cmd === 'watch') return cmdWatch(opts)
  if (cmd === 'triforce') return cmdTriforce()
  if (cmd !== 'diagnose') usageError(`unknown command: ${cmd}`)
  if (opts.probe !== null && opts.demo) usageError('--probe cannot be combined with --demo')
  const result = await runDiagnose(opts)
  const faults = result.findings.filter(f => f.severity === 'fault')
  // --demo runs against bundled fixtures deliberately seeded with faults
  // (plaintext keys, missing transcripts, etc.) so the exit-1 case has
  // something concrete to show. A first-run user trying --demo has no way to
  // know that in advance, so a nonzero exit reads as "the tool is broken"
  // rather than "the demo is working as intended." Say so explicitly.
  const demoNote = (opts.demo && faults.length > 0)
    ? 'demo note: fixtures intentionally contain faults (DT002-DT006) to demonstrate diagnose\'s findings — exit 1 is the expected/correct result here, not a failure of the tool.'
    : null
  if (opts.json) {
    process.stdout.write(JSON.stringify(demoNote ? { ...result, demoNote } : result, null, 2) + '\n')
  } else {
    process.stdout.write(renderDiagnose(result) + '\n')
    if (demoNote) process.stdout.write('\n' + demoNote + '\n')
  }
  process.exitCode = faults.length > 0 ? 1 : 0
}

main().catch(err => {
  process.stderr.write(`droidtune: ${err && err.stack ? err.stack : err}\n`)
  process.exitCode = 1
})
