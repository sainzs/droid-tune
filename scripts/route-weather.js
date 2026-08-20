#!/usr/bin/env node
// Probe the configured free Zen routes once each, record what happened, and
// regenerate the report. A thin CLI: the transport, the classification, and
// the rendering all live in lib/weather.js and are tested offline against
// recorded responses.
//
// Usage:
//   node scripts/route-weather.js --probe          # live: one request per route, append, render
//   node scripts/route-weather.js --render         # offline: regenerate from committed data only
//   node scripts/route-weather.js --render --check  # offline: fail if the committed report has drifted
//
//   --routes a,b,c      restrict the probe set (default: the eight configured free ids)
//   --data <file>       observation series (default weather/route-status.jsonl)
//   --out-dir <dir>     where README.md and badge.json are written (default weather/)
//   --days <n>          columns in the rendered table (default 14)
//   --timeout-ms <n>    per-probe timeout (default 20000)
//   --dry-run           with --probe: classify and print, write nothing
//
// Credentials: OPENCODE_ZEN_KEY, read from the environment, never logged and
// never written. A missing key is a configuration error (exit 2, nothing
// written) rather than an outage — recording eight fake AUTH rows because the
// operator forgot to export a variable would poison the series with a fact
// about this machine rather than about the routes.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  FREE_ROUTES, appendObservations, makeObservation, probeRoutes,
  readObservations, renderWeather, summarize
} from '../lib/weather.js'
import { badgeFromWeather, renderBadge } from '../lib/badge.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(name)
  return i > -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback
}
const has = (name) => process.argv.includes(name)

const opts = {
  probe: has('--probe'),
  render: has('--render'),
  check: has('--check'),
  dryRun: has('--dry-run'),
  routes: (arg('--routes') ?? '').split(',').map(s => s.trim()).filter(Boolean),
  dataPath: path.resolve(arg('--data', path.join(root, 'weather', 'route-status.jsonl'))),
  outDir: path.resolve(arg('--out-dir', path.join(root, 'weather'))),
  days: Number(arg('--days', '14')),
  timeoutMs: Number(arg('--timeout-ms', '20000'))
}
if (!opts.probe && !opts.render) {
  console.error('route-weather: pass --probe (live) or --render (offline). See the header comment.')
  process.exit(2)
}
if (!Number.isInteger(opts.days) || opts.days < 1) {
  console.error('--days must be a positive integer')
  process.exit(2)
}

const routes = opts.routes.length > 0 ? opts.routes : FREE_ROUTES

function writeReport (observations) {
  const s = summarize(observations, { days: opts.days, routes })
  const readmePath = path.join(opts.outDir, 'README.md')
  const badgePath = path.join(opts.outDir, 'badge.json')
  const readme = renderWeather(s)
  const badge = renderBadge(badgeFromWeather(s))

  if (opts.check) {
    const problems = []
    for (const [p, expected] of [[readmePath, readme], [badgePath, badge]]) {
      const actual = existsSync(p) ? readFileSync(p, 'utf8') : null
      if (actual !== expected) problems.push(path.relative(root, p))
    }
    if (problems.length > 0) {
      console.error(
        `route-weather: ${problems.join(' and ')} no longer match ` +
        `${path.relative(root, opts.dataPath)}.\nRegenerate with:\n  node scripts/route-weather.js --render`
      )
      process.exit(1)
    }
    console.log(`route-weather: generated files match ${path.relative(root, opts.dataPath)} — OK`)
    return s
  }

  writeFileSync(readmePath, readme)
  writeFileSync(badgePath, badge)
  return s
}

async function main () {
  if (opts.probe) {
    const key = process.env.OPENCODE_ZEN_KEY
    if (!key) {
      console.error(
        'route-weather: OPENCODE_ZEN_KEY is not set. Refusing to probe — recording eight ' +
        'AUTH failures because a variable is missing would record a fact about this machine, ' +
        'not about the routes.'
      )
      process.exit(2)
    }
    const at = new Date().toISOString()
    const results = await probeRoutes(routes, {
      key,
      timeoutMs: opts.timeoutMs,
      onResult: (r) => console.log(`  ${r.route.padEnd(30)} ${r.status.padEnd(14)} ${r.httpStatus ?? '—'}  ${r.latencyMs}ms`)
    })
    const fresh = results.map(r => makeObservation({
      route: r.route, status: r.status, httpStatus: r.httpStatus, latencyMs: r.latencyMs, detail: r.detail, at
    }))
    if (opts.dryRun) {
      console.log('\n--dry-run: nothing written.')
      return
    }
    appendObservations(opts.dataPath, fresh)
    console.log(`\nappended ${fresh.length} observation(s) to ${path.relative(root, opts.dataPath)}`)
  }

  const { observations, parseErrors } = readObservations(opts.dataPath)
  if (parseErrors > 0) console.error(`route-weather: ${parseErrors} unreadable line(s) in the series were skipped`)
  const s = writeReport(observations)
  if (!opts.check) {
    console.log(
      s.asOf
        ? `as of ${s.asOf}, ${s.up} of ${s.total} free routes answered — wrote ${path.relative(root, opts.outDir)}/README.md and badge.json`
        : `no observations yet — wrote an empty ${path.relative(root, opts.outDir)}/README.md`
    )
  }
}

main().catch(err => {
  // A probe run must never take the workflow down in a way that loses the
  // data it already gathered; anything reaching here is a bug in this script,
  // not an outage, so it is reported as a failure.
  console.error(`route-weather: ${err && err.stack ? err.stack : err}`)
  process.exit(1)
})
