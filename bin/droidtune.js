#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runDiagnose } from '../lib/diagnose.js'
import { renderDiagnose } from '../lib/report.js'
import { runTrial } from '../lib/runner.js'

const USAGE = `droidtune — Droid Tune-Up: diagnose, tune, verify (more verified work, fewer wasted tokens)

Usage:
  droidtune diagnose [flags]     Check protocol, model routing, cache, and configuration health
  droidtune trial [flags]        Run one task end-to-end through droid exec; write an evidence pack

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
  ['--attempt', 'attempt']
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

async function main () {
  const [cmd, opts] = parseArgs(process.argv.slice(2))
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') usage(0)
  if (cmd === 'trial') return cmdTrial(opts)
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
