#!/usr/bin/env node
import { runDiagnose } from '../lib/diagnose.js'
import { renderDiagnose } from '../lib/report.js'

const USAGE = `droidtune — Droid Tune-Up: diagnose, tune, verify (more verified work, fewer wasted tokens)

Usage:
  droidtune diagnose [flags]     Check protocol, model routing, cache, and configuration health

Flags:
  --json                 Machine-readable output
  --demo                 Run against bundled fixtures (no Droid install needed)
  --probe [model]        Live round-trip through droid exec on a BYOK custom model
                         (opt-in; spends your BYOK credits/points; model = id, name,
                         or unique substring; default: first Z.AI anthropic entry)
  --sessions-dir <path>  Override ~/.factory/sessions
  --config <file>        Override ~/.factory/settings.json
  --droid-path <path>    Override droid binary location
  --limit <n>            Recent-session table size (default 20)
  -h, --help             Show this help

Exit codes:
  0 clean · 1 faults found · 2 usage error

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
    } else if (a === '--sessions-dir' || a === '--config' || a === '--droid-path' || a === '--limit') {
      const v = rest[++i]
      if (v === undefined || v.startsWith('-')) usageError(`missing value for ${a}`)
      if (a === '--limit') {
        const n = Number(v)
        if (!Number.isInteger(n) || n < 1) usageError('--limit must be a positive integer')
        opts.limit = n
      } else if (a === '--sessions-dir') opts.sessionsDir = v
      else if (a === '--config') opts.configPath = v
      else opts.droidPath = v
    } else {
      usageError(`unknown flag: ${a}`)
    }
  }
  return [cmd, opts]
}

async function main () {
  const [cmd, opts] = parseArgs(process.argv.slice(2))
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') usage(0)
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
