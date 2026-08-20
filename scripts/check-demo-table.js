#!/usr/bin/env node
// Drift guard for the public reproducibility fixture.
//
// demo-pack/EXPECTED-TABLE.md is a committed snapshot of
// `node scripts/results-table.js --runs-dir demo-pack`. It exists so a
// stranger cloning this repo can regenerate the exact table that ships in
// README between the <!-- BEGIN:DEMO-TABLE --> / <!-- END:DEMO-TABLE -->
// markers, from evidence packs that are actually committed (unlike
// runs/, which is gitignored). If results-table.js's output for demo-pack/
// ever changes — because the script's logic changed, or because someone
// edited a fixture file — this script fails loudly instead of letting the
// snapshot silently rot.
//
// Usage:
//   node scripts/check-demo-table.js
//   node scripts/check-demo-table.js --demo-dir demo-pack --snapshot demo-pack/EXPECTED-TABLE.md
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name)
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const demoDir = arg('--demo-dir', path.join(root, 'demo-pack'))
const snapshotPath = arg('--snapshot', path.join(demoDir, 'EXPECTED-TABLE.md'))
const resultsTableScript = path.join(root, 'scripts', 'results-table.js')

if (!existsSync(demoDir)) {
  console.error(`demo dir not found: ${demoDir}`)
  process.exit(2)
}
if (!existsSync(snapshotPath)) {
  console.error(`snapshot not found: ${snapshotPath}`)
  process.exit(2)
}

// results-table.js defaults --title to --runs-dir, and the snapshot was
// generated with a short relative path ("demo-pack"). Pin --title explicitly
// to the directory's basename so the header stays stable no matter what
// absolute path the caller or CI runner passes in — otherwise the snapshot
// would drift on every machine/checkout whose absolute path differs.
const title = path.basename(demoDir)

let actual
try {
  actual = execFileSync(
    'node',
    [resultsTableScript, '--runs-dir', demoDir, '--title', title],
    { encoding: 'utf8' }
  )
} catch (err) {
  console.error('results-table.js failed to run against the demo pack:')
  console.error(err.stderr ?? err.message)
  process.exit(2)
}

const expected = readFileSync(snapshotPath, 'utf8')

if (actual !== expected) {
  console.error(`demo table drift detected: regenerating from ${demoDir} no longer matches ${snapshotPath}\n`)
  console.error('--- expected (snapshot) ---')
  console.error(expected)
  console.error('--- actual (regenerated) ---')
  console.error(actual)
  console.error(
    'If this drift is intentional (fixtures or results-table.js changed on purpose), regenerate the ' +
    `snapshot with:\n  node ${path.relative(root, resultsTableScript)} --runs-dir ${path.relative(root, demoDir)} ` +
    `--title ${title} > ${path.relative(root, snapshotPath)}\nand review the diff before committing.`
  )
  process.exit(1)
}

console.log(`demo table matches snapshot (${path.relative(root, snapshotPath)}) — OK`)
