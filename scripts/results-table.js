#!/usr/bin/env node
// Render evidence packs as a Markdown results table for the README.
//
// Unlike scripts/flake-report.js (a console-oriented aggregator), this emits
// documentation-ready Markdown and, critically, reports WHY a trial failed.
// droid exec collapses several distinct provider conditions into a single
// `PROVIDER_ERROR` whose only distinguishing detail lives in the session
// transcript as a `BYOK Error: <code> <text>` line. A results table that shows
// eight PROVIDER_ERRORs is useless; one that separates "the route rate-limited
// us" from "that model id isn't routable" is evidence.
//
// Usage:
//   node scripts/results-table.js --runs-dir runs/m4-flake3
//   node scripts/results-table.js --runs-dir runs/m4-flake3 --tasks t002-slugify,t003-path-canonicalize
//   node scripts/results-table.js --runs-dir runs/m5-byok-sweep --title "BYOK sweep"
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(name)
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const runsDir = arg('--runs-dir', 'runs/m4-flake3')
const only = (arg('--tasks') ?? '').split(',').map(s => s.trim()).filter(Boolean)
const title = arg('--title', runsDir)

if (!existsSync(runsDir)) {
  console.error(`runs dir not found: ${runsDir}`)
  process.exit(2)
}

// A trial that never reached the model is not a model result. Keep these
// separable from genuine model outcomes so they can never be laundered into a
// quality signal.
const NON_MODEL = new Set(['PROVIDER_ERROR', 'DROID_ERROR', 'VERIFIER_ERROR'])

// Recover the underlying provider condition. Prefer a structured field if the
// runner recorded one; otherwise fall back to the transcript's BYOK error text.
// Classify on the MESSAGE, not the HTTP status: an unsupported model id and a
// bad credential are both reported as 401.
// Anchor strictly on droid's explicit `BYOK Error: <code> <text>` line. Loose
// keyword matching over the whole transcript produces false precision — an
// unrelated "401" or "authentication" substring elsewhere in a session will
// mislabel a rate-limit failure as an auth failure. When no explicit error
// line is present, say `unknown` rather than guessing.
function providerErrorKind (dir, results) {
  if (results.providerErrorKind) return results.providerErrorKind
  let blob = ''
  for (const f of ['errors.json', 'transcript.jsonl']) {
    const p = path.join(dir, f)
    if (existsSync(p)) { try { blob += readFileSync(p, 'utf8') } catch {} }
  }
  const m = blob.match(/BYOK Error:\s*(\d{3})\s*([^"\\\n]*)/i)
  if (!m) return 'unknown'
  const [, code, text] = m
  if (code === '429' || /rate limit/i.test(text)) return 'rate_limit'
  if (/is not supported/i.test(text)) return 'unsupported_model'
  if (code === '401' || code === '403') return 'auth'
  return 'unknown'
}

const shortModel = (id) =>
  (id ?? 'unknown').replace(/^custom:/, '').replace(/-OpenCode.*$/, '')

const rows = []
for (const task of readdirSync(runsDir)) {
  const taskDir = path.join(runsDir, task)
  let st; try { st = statSync(taskDir) } catch { continue }
  if (!st.isDirectory()) continue
  if (only.length && !only.includes(task)) continue

  for (const att of readdirSync(taskDir).filter(d => d.startsWith('attempt-'))) {
    const dir = path.join(taskDir, att)
    const rj = path.join(dir, 'results.json')
    if (!existsSync(rj)) continue

    let results = {}
    try { results = JSON.parse(readFileSync(rj, 'utf8')) } catch { continue }
    const outcome = results.outcome ?? 'ERROR'

    let model = 'unknown'
    try {
      const m = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
      model = shortModel(m.provenance?.modelObserved ?? m.provenance?.modelRequested)
    } catch {}

    rows.push({
      task,
      model,
      attempt: att,
      outcome,
      durationMs: results.durationMs ?? null,
      kind: NON_MODEL.has(outcome) ? providerErrorKind(dir, results) : null
    })
  }
}

if (rows.length === 0) {
  console.error(`no evidence packs found under ${runsDir}`)
  process.exit(2)
}

const tasks = [...new Set(rows.map(r => r.task))].sort()
const models = [...new Set(rows.map(r => r.model))].sort()

// Only trials that actually reached the model count toward a pass rate.
const scored = rows.filter(r => !NON_MODEL.has(r.outcome))
const passes = scored.filter(r => r.outcome === 'VERIFIED_PASS').length
const unreached = rows.length - scored.length

const CELL = { VERIFIED_PASS: 'PASS', VERIFIED_FAIL: 'fail', NO_SUBMISSION: 'no-sub', TIMEOUT: 'timeout' }
const cell = (r) => r.kind ? r.kind.replace(/_/g, '-') : (CELL[r.outcome] ?? r.outcome.toLowerCase())

console.log(`### ${title}\n`)
console.log(`| task | ${models.join(' | ')} |`)
console.log(`| --- | ${models.map(() => '---').join(' | ')} |`)
for (const t of tasks) {
  const cells = models.map(m => {
    const c = rows.filter(r => r.task === t && r.model === m)
    return c.length ? c.map(cell).join(', ') : '—'
  })
  console.log(`| \`${t}\` | ${cells.join(' | ')} |`)
}

console.log('')
if (scored.length > 0) {
  const pct = (100 * passes / scored.length).toFixed(0)
  console.log(`**${passes}/${scored.length} VERIFIED_PASS (${pct}%)** across ${tasks.length} tasks x ${models.length} routes.`)
} else {
  console.log(`**0 scoreable trials** — no trial in this sweep reached the model.`)
}
if (unreached > 0) {
  const byKind = {}
  for (const r of rows.filter(r => NON_MODEL.has(r.outcome))) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1
  const detail = Object.entries(byKind).map(([k, n]) => `${n} ${k.replace(/_/g, '-')}`).join(', ')
  console.log(`\n${unreached} further trial(s) never reached the model (${detail}) and are excluded from the pass rate rather than counted as failures.`)
}
