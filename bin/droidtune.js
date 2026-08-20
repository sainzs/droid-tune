#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runDiagnose } from '../lib/diagnose.js'
import { renderDiagnose } from '../lib/report.js'
import { runTrial } from '../lib/runner.js'
import { makeRunOne, runTriforce } from '../lib/triforce.js'
import { runBaseline } from '../lib/baseline.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const USAGE = `droidtune — Droid Tune-Up: diagnose, tune, verify (more verified work, fewer wasted tokens)

Usage:
  droidtune diagnose [flags]     Check protocol, model routing, cache, and configuration health
  droidtune trial [flags]        Run one task end-to-end through droid exec; write an evidence pack
  droidtune baseline [flags]     Run the frozen native-Droid suite (live; explicit spend confirmation)
  droidtune run <task> [flags]   Grade a task offline (oracle/--noop/--cheat) — triforce self-test
  droidtune triforce             Run the offline tri-force self-test (7 legs)

diagnose flags:
  --json                 Machine-readable output
  --demo                 Run against bundled fixtures (no Droid install needed)
  --probe [model]        Live round-trip through droid exec on a BYOK custom model
                         (opt-in; spends your BYOK credits/points; model = id, name,
                         or unique substring; default: first Z.AI anthropic entry)
  --limit <n>            Recent-session table size (default 20)

trial flags:
  --task <dir>           Task directory (required; e.g. tasks/t001-greet-script)
  --model <id>           Custom-model id or unique substring (default: first Z.AI
                         anthropic entry in settings; spends your BYOK credits)
  --tune <name>          Tune name for the pack path (default ad-hoc)
  --attempt <n>          Attempt number (default 1)
  --auto <level>         Autonomy: low|medium|high (default high)
  --timeout-ms <n>       Per-trial timeout (default 300000)
  --runs-dir <path>      Evidence-pack root (default ./runs)

baseline flags:
  --bundle <file>        Frozen bundle spec (default configs/native-droid.json)
  --confirm-spend        Required acknowledgement before any live baseline trial
  --runs-dir <path>      Evidence-pack root (default ./runs)

run flags:
  --offline              Offline grading (no droid); apply the task oracle solution
  --noop                 Grade an empty diff (no solution applied)
  --cheat <name>         Run tasks/<id>/cheats/<name>.sh instead of the real tests

common flags:
  --sessions-dir <path>  Override ~/.factory/sessions
  --config <file>        Override ~/.factory/settings.json
  --droid-path <path>    Override droid binary location
  -h, --help             Show this help

Exit codes:
  0 clean/VERIFIED_PASS · 1 faults or non-pass outcome · 2 usage error

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
  ['--auto', 'auto'],
  ['--timeout-ms', 'timeoutMs'],
  ['--runs-dir', 'runsDir'],
  ['--attempt', 'attempt'],
  ['--cheat', 'cheat'],
  ['--bundle', 'bundlePath']
])

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
    } else if (a === '--offline') {
      opts.offline = true
    } else if (a === '--noop') {
      opts.noop = true
    } else if (a === '--confirm-spend') {
      opts.confirmSpend = true
    } else if (cmd === 'run' && !a.startsWith('-') && opts.task === undefined) {
      opts.task = a
    } else if (VALUE_FLAGS.has(a)) {
      const v = rest[++i]
      if (v === undefined || v.startsWith('-')) usageError(`missing value for ${a}`)
      const key = VALUE_FLAGS.get(a)
      if (key === 'limit' || key === 'timeoutMs' || key === 'attempt') {
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

function defaultTrialPaths (opts) {
  return {
    configPath: opts.configPath ?? path.join(os.homedir(), '.factory', 'settings.json'),
    sessionsDir: opts.sessionsDir ?? path.join(os.homedir(), '.factory', 'sessions')
  }
}

function defaultTrialModel (configPath) {
  let cfg = null
  try {
    cfg = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch {
    throw new Error(`cannot read config to pick a default model: ${configPath}`)
  }
  const models = Array.isArray(cfg.customModels) ? cfg.customModels : []
  const pick = models.find(m => m.provider === 'anthropic' && /z\.ai/.test(m.baseUrl ?? '')) ?? models[0]
  if (!pick) throw new Error('no customModels configured — pass --model explicitly')
  return pick.id ?? pick.model
}

async function cmdTrial (opts) {
  if (!opts.task) usageError('trial requires --task <dir>')
  if (opts.auto !== undefined && !['low', 'medium', 'high'].includes(opts.auto)) {
    usageError('--auto must be low, medium, or high')
  }
  const paths = defaultTrialPaths(opts)
  const model = opts.model ?? defaultTrialModel(paths.configPath)
  const result = await runTrial({
    taskDir: opts.task,
    model,
    droidPath: opts.droidPath ?? path.join(os.homedir(), '.local', 'bin', 'droid'),
    sessionsDir: paths.sessionsDir,
    configPath: paths.configPath,
    runsDir: opts.runsDir,
    tuneName: opts.tune,
    attempt: opts.attempt,
    autoLevel: opts.auto ?? 'high',
    timeoutMs: opts.timeoutMs
  })
  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  } else {
    const r = result.results
    const lines = [
      `TRIAL ${result.trialId}`,
      `  outcome    ${result.outcome}` + (r.reward !== undefined ? ` (reward ${r.reward})` : '') + (r.reason ? ` — ${r.reason}` : ''),
      `  duration   ${r.durationMs}ms`,
      r.commits ? `  commits    ${r.commits.length} (${r.commits[0]})` : null,
      result.usage ? `  usage      in ${result.usage.inputTokens} · out ${result.usage.outputTokens} · cacheRead ${result.usage.cacheReadTokens} · route ${result.usage.routeClass}` : null,
      `  pack       ${result.manifestPath}`
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
    droidPath: opts.droidPath ?? path.join(os.homedir(), '.local', 'bin', 'droid'),
    runsDir: path.resolve(opts.runsDir ?? path.join(REPO_ROOT, 'runs')),
    confirmSpend: true
  })
  const pass = result.results.filter(r => r.outcome === 'VERIFIED_PASS').length
  if (opts.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  else process.stdout.write(`BASELINE ${result.bundle.id}\n  outcomes   ${pass}/${result.results.length} VERIFIED_PASS${result.stoppedByBudget ? ' (stopped by budget)' : ''}\n  snapshot   ${path.join(opts.runsDir ?? path.join(REPO_ROOT, 'runs'), result.bundle.tuneName, 'bundle.snapshot.json')}\n`)
  process.exitCode = !result.stoppedByBudget && pass === result.results.length ? 0 : 1
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
    noop: !!opts.noop
  })
  process.stdout.write(`verdict=${result.outcome}\n`)
  process.stdout.write(`task=${path.basename(taskDir)}\n`)
  process.stdout.write(`pack=${result.manifestPath}\n`)
  process.exitCode = 0
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
  if (cmd === 'run') return cmdRun(opts)
  if (cmd === 'triforce') return cmdTriforce()
  if (cmd !== 'diagnose') usageError(`unknown command: ${cmd}`)
  if (opts.probe !== null && opts.demo) usageError('--probe cannot be combined with --demo')
  const result = await runDiagnose(opts)
  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  } else {
    process.stdout.write(renderDiagnose(result) + '\n')
  }
  const faults = result.findings.filter(f => f.severity === 'fault')
  process.exitCode = faults.length > 0 ? 1 : 0
}

main().catch(err => {
  process.stderr.write(`droidtune: ${err && err.stack ? err.stack : err}\n`)
  process.exitCode = 1
})
