import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { cp, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const script = path.join(root, 'scripts', 'check-demo-table.js')
const source = path.join(root, 'demo-pack')

function run (args, opts = {}) {
  try {
    const stdout = execFileSync('node', [script, ...args], { encoding: 'utf8', ...opts })
    return { code: 0, stdout, stderr: '' }
  } catch (err) {
    return { code: err.status, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }
  }
}

async function tmpDemoPack () {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'droidtune-demo-check-'))
  const dest = path.join(dir, 'demo-pack')
  await cp(source, dest, { recursive: true })
  return dest
}

test('matches the committed snapshot at the repo root (real fixtures, no args)', () => {
  const r = run([])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /demo table matches snapshot/)
})

test('matches when pointed at an independent copy of demo-pack via --demo-dir/--snapshot', async () => {
  const demoDir = await tmpDemoPack()
  try {
    const r = run(['--demo-dir', demoDir, '--snapshot', path.join(demoDir, 'EXPECTED-TABLE.md')])
    assert.equal(r.code, 0)
    assert.match(r.stdout, /demo table matches snapshot/)
  } finally {
    await rm(path.dirname(demoDir), { recursive: true, force: true })
  }
})

test('fails loudly when the snapshot has drifted from the regenerated table', async () => {
  const demoDir = await tmpDemoPack()
  try {
    const snapshotPath = path.join(demoDir, 'EXPECTED-TABLE.md')
    const original = await readFile(snapshotPath, 'utf8')
    await writeFile(snapshotPath, original.replace('VERIFIED_PASS', 'VERIFIED_PASS (mutated)'))

    const r = run(['--demo-dir', demoDir, '--snapshot', snapshotPath])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /demo table drift detected/)
    assert.match(r.stderr, /--- expected \(snapshot\) ---/)
    assert.match(r.stderr, /--- actual \(regenerated\) ---/)
  } finally {
    await rm(path.dirname(demoDir), { recursive: true, force: true })
  }
})

test('is insensitive to the caller\'s working directory (title stays pinned to demo-pack)', async () => {
  const demoDir = await tmpDemoPack()
  try {
    const r = run(
      ['--demo-dir', demoDir, '--snapshot', path.join(demoDir, 'EXPECTED-TABLE.md')],
      { cwd: os.tmpdir() }
    )
    assert.equal(r.code, 0, r.stderr)
  } finally {
    await rm(path.dirname(demoDir), { recursive: true, force: true })
  }
})

test('exits 2 when --demo-dir does not exist', () => {
  const r = run(['--demo-dir', path.join(root, 'no-such-demo-dir')])
  assert.equal(r.code, 2)
  assert.match(r.stderr, /demo dir not found/)
})

test('exits 2 when --snapshot does not exist', async () => {
  const demoDir = await tmpDemoPack()
  try {
    const r = run(['--demo-dir', demoDir, '--snapshot', path.join(demoDir, 'NOPE.md')])
    assert.equal(r.code, 2)
    assert.match(r.stderr, /snapshot not found/)
  } finally {
    await rm(path.dirname(demoDir), { recursive: true, force: true })
  }
})

// The README carries a copy of the table for readers who never run anything.
// A stale copy there is the exact "numbers you can't check" failure this
// fixture exists to prevent, so the guard covers it too.
test('fails when the README demo-table block has drifted from the snapshot', async () => {
  const demoDir = await tmpDemoPack()
  try {
    const readmePath = path.join(path.dirname(demoDir), 'README.md')
    const snapshot = await readFile(path.join(demoDir, 'EXPECTED-TABLE.md'), 'utf8')
    const stale = snapshot.replace(/\*\*\d+\/\d+ VERIFIED_PASS[^*]*\*\*/, '**999/999 VERIFIED_PASS (999%)**')
    await writeFile(readmePath, `# Demo\n\n<!-- BEGIN:DEMO-TABLE -->\n${stale}<!-- END:DEMO-TABLE -->\n`)

    const r = run([
      '--demo-dir', demoDir,
      '--snapshot', path.join(demoDir, 'EXPECTED-TABLE.md'),
      '--readme', readmePath
    ])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /README demo table is out of date/)
  } finally {
    await rm(path.dirname(demoDir), { recursive: true, force: true })
  }
})

test('fails when the README is missing the demo-table markers', async () => {
  const demoDir = await tmpDemoPack()
  try {
    const readmePath = path.join(path.dirname(demoDir), 'README.md')
    await writeFile(readmePath, '# Demo\n\nno markers here\n')

    const r = run([
      '--demo-dir', demoDir,
      '--snapshot', path.join(demoDir, 'EXPECTED-TABLE.md'),
      '--readme', readmePath
    ])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /missing the .* markers/)
  } finally {
    await rm(path.dirname(demoDir), { recursive: true, force: true })
  }
})

test('passes when the README block matches the snapshot exactly', async () => {
  const demoDir = await tmpDemoPack()
  try {
    const readmePath = path.join(path.dirname(demoDir), 'README.md')
    const snapshot = await readFile(path.join(demoDir, 'EXPECTED-TABLE.md'), 'utf8')
    await writeFile(readmePath, `# Demo\n\n<!-- BEGIN:DEMO-TABLE -->\n${snapshot}<!-- END:DEMO-TABLE -->\n`)

    const r = run([
      '--demo-dir', demoDir,
      '--snapshot', path.join(demoDir, 'EXPECTED-TABLE.md'),
      '--readme', readmePath
    ])
    assert.equal(r.code, 0)
    assert.match(r.stdout, /and README — OK/)
  } finally {
    await rm(path.dirname(demoDir), { recursive: true, force: true })
  }
})
