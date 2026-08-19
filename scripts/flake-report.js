#!/usr/bin/env node
// Tabulate a flake-check sweep into a per-task × per-model outcome matrix +
// per-task pass rates. Reads the on-disk evidence packs (manifest.json /
// results.json) under a runs dir — the authoritative record — rather than any
// lossy console capture. Model labels are derived from the recorded
// provenance.modelObserved, so distinct models never collapse.
//
// Usage: node scripts/flake-report.js [--runs-dir runs/m4-flake2]
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import path from 'node:path'

const rdIdx = process.argv.indexOf('--runs-dir')
const runsDir = rdIdx > -1 ? process.argv[rdIdx + 1] : 'runs/m4-flake2'
if (!existsSync(runsDir)) { console.error(`runs dir not found: ${runsDir}`); process.exit(2) }

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

console.log(`## Outcome matrix — ${runsDir} (count per task × model)\n`)
const w = 16
console.log('task'.padEnd(26) + models.map(m => m.padStart(w)).join('') + 'TOTAL'.padStart(w))
for (const t of tasks) {
  const cells = models.map(m => {
    const cell = rows.filter(r => r.task === t && r.model === m)
    const tally = {}
    for (const r of cell) tally[r.outcome] = (tally[r.outcome] ?? 0) + 1
    const s = Object.entries(tally).map(([o, n]) => `${n}×${o.replace('VERIFIED_', 'V_').replace(/_/g, '')}`).join(',')
    return (s || '—').padStart(w)
  })
  console.log(t.padEnd(26) + cells.join('') + String(rows.filter(r => r.task === t).length).padStart(w))
}

console.log('\n## Per-task VERIFIED_PASS rate\n')
for (const t of tasks) {
  const cell = rows.filter(r => r.task === t)
  const pass = cell.filter(r => r.outcome === 'VERIFIED_PASS').length
  const total = cell.length
  const bar = '█'.repeat(Math.round((pass / total) * 20)).padEnd(20, '·')
  console.log(`  ${t.padEnd(26)} ${String(pass).padStart(2)}/${total}  ${bar}  ${(100 * pass / total).toFixed(0)}%`)
}

console.log('\n## Non-pass outcomes (the signal)\n')
const np = rows.filter(r => r.outcome !== 'VERIFIED_PASS')
if (np.length === 0) console.log('  (none — clean sweep)')
for (const r of np) console.log(`  ${r.task}  ${r.model}  ${r.attempt}  ${r.outcome}`)

// Token usage summary (free routes — cost is $0, but tokens are the evidence).
let tin = 0, tout = 0, n = 0
for (const r of rows) if (r.tokens) { tin += r.tokens.inputTokens ?? 0; tout += r.tokens.outputTokens ?? 0; n++ }
console.log(`\n## Tokens (n=${n} with usage)  in=${tin}  out=${tout}`)

const total = rows.length
const pass = rows.filter(r => r.outcome === 'VERIFIED_PASS').length
console.log(`\nTOTAL ${pass}/${total} VERIFIED_PASS (${total ? (100 * pass / total).toFixed(0) : 0}%)`)
