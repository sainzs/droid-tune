#!/usr/bin/env node
// Tabulate a flake-check sweep into a per-task × per-model outcome matrix +
// per-task pass rates. Reads the on-disk evidence packs (manifest.json /
// results.json) under a runs dir — the authoritative record — rather than any
// lossy console capture. Model labels are derived from the recorded
// provenance.modelObserved, so distinct models never collapse.
//
// Usage:
//   node scripts/flake-report.js [--runs-dir runs/m4-flake3]
//                               [--task t002-slugify [--task t003-...]]
//                               [--tasks t002-slugify,t003-...]
//                               [--json]
//
// `--task` may be repeated; `--tasks` takes a comma-separated list. Either
// selects a subset of task directories to aggregate (and the report states the
// included scope so a reader can reproduce a published number). `--json` emits
// the same aggregation as a single JSON object instead of the text report.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

// --- argument parsing ---
function nextVal (i, flag) {
  const v = process.argv[i + 1]
  if (v === undefined) { console.error(`${flag} requires a value`); process.exit(2) }
  return v
}
function parseArgs () {
  let runsDir = 'runs/m4-flake3'
  const taskFilter = []
  let json = false
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i]
    if (a === '--runs-dir') { runsDir = nextVal(i, a); i++ }
    else if (a === '--task') { taskFilter.push(nextVal(i, a)); i++ }
    else if (a === '--tasks') {
      for (const id of nextVal(i, a).split(',')) { const t = id.trim(); if (t) taskFilter.push(t) }
      i++
    } else if (a === '--json') { json = true }
    // unknown flags are ignored to preserve legacy behavior
  }
  return { runsDir, taskFilter, json }
}
const { runsDir, taskFilter, json } = parseArgs()
if (!existsSync(runsDir)) { console.error(`runs dir not found: ${runsDir}`); process.exit(2) }

// Actual task directories on disk (used to validate the filter).
const taskEntries = readdirSync(runsDir).filter(d => {
  try { return statSync(path.join(runsDir, d)).isDirectory() } catch { return false }
})
if (taskFilter.length > 0) {
  const missing = taskFilter.filter(id => !taskEntries.includes(id))
  if (missing.length > 0) {
    console.error(`task not found under ${runsDir}: ${missing.join(', ')}\n` +
      `available tasks: ${taskEntries.slice().sort().join(', ')}`)
    process.exit(2)
  }
}
const filterSet = new Set(taskFilter)

// Distinct short label per observed model id.
const SHORT = {
  'custom:hy3-free-OpenCode-Zen-free-8': 'hy3',
  'custom:laguna-s-2-1-free-OpenCode-Zen-free-11': 'laguna-s',
  'custom:nemotron-3-5-lightning-free-OpenCode-Zen-free-10': 'nem-lightning',
  'custom:nemotron-3-ultra-free-OpenCode-Zen-free-9': 'nem-ultra'
}
const short = (id) => SHORT[id] ?? (id ?? 'unknown').replace(/^custom:/, '').replace(/-OpenCode.*$/, '')

const rows = []
for (const task of readdirSync(runsDir)) {
  if (filterSet.size > 0 && !filterSet.has(task)) continue
  const taskDir = path.join(runsDir, task)
  let attempts = []
  try { attempts = readdirSync(taskDir).filter(d => d.startsWith('attempt-')) } catch { continue }
  for (const att of attempts) {
    const rj = path.join(taskDir, att, 'results.json')
    const mj = path.join(taskDir, att, 'manifest.json')
    if (!existsSync(rj)) continue
    let outcome = 'ERROR', model = 'unknown', tokens = null
    try { outcome = JSON.parse(readFileSync(rj, 'utf8')).outcome ?? 'ERROR' } catch {}
    try {
      const m = JSON.parse(readFileSync(mj, 'utf8'))
      model = short(m.provenance?.modelObserved ?? m.provenance?.modelRequested)
    } catch {}
    const uj = path.join(taskDir, att, 'usage.json')
    if (existsSync(uj)) { try { tokens = JSON.parse(readFileSync(uj, 'utf8')) } catch {} }
    rows.push({ task, model, attempt: att, outcome, tokens })
  }
}

const tasks = [...new Set(rows.map(r => r.task))].sort()
const models = [...new Set(rows.map(r => r.model))].sort()

// --- shared aggregation (consumed by both text and JSON renderers) ---
const matrix = {}
for (const t of tasks) {
  const cells = {}
  for (const m of models) {
    const cell = rows.filter(r => r.task === t && r.model === m)
    const tally = {}
    for (const r of cell) tally[r.outcome] = (tally[r.outcome] ?? 0) + 1
    cells[m] = tally
  }
  matrix[t] = { cells, total: rows.filter(r => r.task === t).length }
}
const perTask = {}
for (const t of tasks) {
  const cell = rows.filter(r => r.task === t)
  const pass = cell.filter(r => r.outcome === 'VERIFIED_PASS').length
  perTask[t] = { pass, total: cell.length, pct: cell.length ? Math.round(100 * pass / cell.length) : 0 }
}
const nonPass = rows.filter(r => r.outcome !== 'VERIFIED_PASS')
  .map(r => ({ task: r.task, model: r.model, attempt: r.attempt, outcome: r.outcome }))
let tin = 0, tout = 0, n = 0
for (const r of rows) if (r.tokens) { tin += r.tokens.inputTokens ?? 0; tout += r.tokens.outputTokens ?? 0; n++ }
const total = rows.length
const pass = rows.filter(r => r.outcome === 'VERIFIED_PASS').length
const pct = total ? Math.round(100 * pass / total) : 0

const filterNote = filterSet.size === 0
  ? `Included: all ${tasks.length} task(s) found in ${runsDir}`
  : `Included (filtered to ${tasks.length}): ${tasks.join(', ')}`

if (json) {
  process.stdout.write(JSON.stringify({
    runsDir,
    filterApplied: filterSet.size > 0,
    includedTasks: tasks,
    allTasksFound: taskEntries.slice().sort(),
    models,
    matrix,
    perTaskPassRate: perTask,
    nonPass,
    tokens: { n, in: tin, out: tout },
    total: { pass, total, pct }
  }, null, 2) + '\n')
  process.exit(0)
}

console.log(`## Outcome matrix — ${runsDir} (count per task × model)\n`)
console.log(filterNote + '\n')

const w = 16
console.log('task'.padEnd(26) + models.map(m => m.padStart(w)).join('') + 'TOTAL'.padStart(w))
for (const t of tasks) {
  const cells = models.map(m => {
    const tally = matrix[t].cells[m]
    const s = Object.entries(tally).map(([o, n]) => `${n}×${o.replace('VERIFIED_', 'V_').replace(/_/g, '')}`).join(',')
    return (s || '—').padStart(w)
  })
  console.log(t.padEnd(26) + cells.join('') + String(matrix[t].total).padStart(w))
}

console.log('\n## Per-task VERIFIED_PASS rate\n')
for (const t of tasks) {
  const p = perTask[t].pass, tot = perTask[t].total
  const bar = '█'.repeat(Math.round((p / tot) * 20)).padEnd(20, '·')
  console.log(`  ${t.padEnd(26)} ${String(p).padStart(2)}/${tot}  ${bar}  ${(100 * p / tot).toFixed(0)}%`)
}

console.log('\n## Non-pass outcomes (the signal)\n')
if (nonPass.length === 0) console.log('  (none — clean sweep)')
for (const r of nonPass) console.log(`  ${r.task}  ${r.model}  ${r.attempt}  ${r.outcome}`)

console.log(`\n## Tokens (n=${n} with usage)  in=${tin}  out=${tout}`)
console.log(`\nTOTAL ${pass}/${total} VERIFIED_PASS (${total ? (100 * pass / total).toFixed(0) : 0}%)`)
