import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runTriforce } from '../lib/triforce.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const bin = path.join(root, 'bin', 'droidtune.js')

function run (args, opts = {}) {
  try {
    const stdout = execFileSync('node', [bin, ...args], { encoding: 'utf8', ...opts })
    return { code: 0, stdout }
  } catch (err) {
    return { code: err.status, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }
  }
}

test('--help exits 0 and prints usage', () => {
  const r = run(['--help'])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /droidtune — Droid Tune-Up/)
  assert.match(r.stdout, /Not affiliated with Factory/)
})

test('no arguments exits 2', () => {
  const r = run([])
  assert.equal(r.code, 2)
})

test('unknown command exits 2', () => {
  const r = run(['frobnicate'])
  assert.equal(r.code, 2)
  assert.match(r.stderr, /unknown command/)
})

test('unknown flag exits 2', () => {
  const r = run(['diagnose', '--wat'])
  assert.equal(r.code, 2)
  assert.match(r.stderr, /unknown flag/)
})

test('baseline refuses to run without explicit spend confirmation', () => {
  const r = run(['baseline'])
  assert.equal(r.code, 2)
  assert.match(r.stderr, /requires --confirm-spend/)
})

test('--limit without value exits 2', () => {
  const r = run(['diagnose', '--demo', '--limit'])
  assert.equal(r.code, 2)
})

test('--demo exits 1 with expected fault ids in --json', () => {
  const r = run(['diagnose', '--demo', '--json'])
  assert.equal(r.code, 1)
  const parsed = JSON.parse(r.stdout)
  const faults = parsed.findings.filter(f => f.severity === 'fault').map(f => f.id).sort()
  assert.deepEqual(faults, ['DT002', 'DT003', 'DT004', 'DT005', 'DT006'])
})

test('--demo human output renders findings and verdict', () => {
  const r = run(['diagnose', '--demo'])
  assert.equal(r.code, 1)
  assert.match(r.stdout, /DROID TUNE-UP — DIAGNOSE/)
  assert.match(r.stdout, /FAULT {2}.*plain text.*\(DT002\)/)
  assert.match(r.stdout, /5 fault\(s\)/)
})

test('--demo exit 1 includes a note that this is expected, not a broken tool (item 6d)', () => {
  const human = run(['diagnose', '--demo'])
  assert.equal(human.code, 1)
  assert.match(human.stdout, /demo note:.*exit 1 is the expected\/correct result/)

  const json = run(['diagnose', '--demo', '--json'])
  assert.equal(json.code, 1)
  const parsed = JSON.parse(json.stdout)
  assert.match(parsed.demoNote, /exit 1 is the expected\/correct result/)
})

test('a clean (non-demo, non-fault) diagnose run has no demo note', () => {
  const fakeHome = mkdtempSync(path.join(os.tmpdir(), 'droidtune-nodemonote-home-'))
  try {
    const r = run([
      'diagnose', '--json',
      '--config', path.join(root, 'fixtures', 'settings', 'clean-settings.json'),
      '--sessions-dir', path.join(root, 'fixtures', 'sessions-clean'),
      '--droid-path', path.join(root, 'fixtures', 'bin', 'fake-droid')
    ], { env: { ...process.env, HOME: fakeHome, ZAI_API_KEY: 'fixture-value-not-a-real-key' } })
    assert.equal(r.code, 0)
    const parsed = JSON.parse(r.stdout)
    assert.equal(parsed.demoNote, undefined)
  } finally {
    rmSync(fakeHome, { recursive: true, force: true })
  }
})

test('clean config + sessions exit 0', () => {
  // clean-settings.json references ${ZAI_API_KEY}; the credential preflight
  // (DT010) requires it to be present. Set it explicitly and point HOME at an
  // empty temp dir so this assertion is hermetic and cannot pass-by-accident
  // off whatever ~/.factory/env.sh happens to exist on the machine running
  // the suite.
  const fakeHome = mkdtempSync(path.join(os.tmpdir(), 'droidtune-clean-home-'))
  try {
    const r = run([
      'diagnose',
      '--config', path.join(root, 'fixtures', 'settings', 'clean-settings.json'),
      '--sessions-dir', path.join(root, 'fixtures', 'sessions-clean'),
      '--droid-path', path.join(root, 'fixtures', 'bin', 'fake-droid')
    ], { env: { ...process.env, HOME: fakeHome, ZAI_API_KEY: 'fixture-value-not-a-real-key' } })
    assert.equal(r.code, 0)
    assert.match(r.stdout, /clean bill of health/)
  } finally {
    rmSync(fakeHome, { recursive: true, force: true })
  }
})

test('clean config exits 1 with DT010 when the referenced credential is unset (no env.sh)', () => {
  const fakeHome = mkdtempSync(path.join(os.tmpdir(), 'droidtune-nocred-home-'))
  try {
    const env = { ...process.env, HOME: fakeHome }
    delete env.ZAI_API_KEY
    const r = run([
      'diagnose', '--json',
      '--config', path.join(root, 'fixtures', 'settings', 'clean-settings.json'),
      '--sessions-dir', path.join(root, 'fixtures', 'sessions-clean'),
      '--droid-path', path.join(root, 'fixtures', 'bin', 'fake-droid')
    ], { env })
    assert.equal(r.code, 1)
    const parsed = JSON.parse(r.stdout)
    const dt010 = parsed.findings.find(f => f.id === 'DT010')
    assert.ok(dt010, 'expected a DT010 finding')
    assert.equal(dt010.severity, 'fault')
    assert.match(dt010.summary, /ZAI_API_KEY/)
    // Never leak the credential VALUE, only the NAME.
    assert.ok(!JSON.stringify(parsed).includes('fixture-value-not-a-real-key'))
  } finally {
    rmSync(fakeHome, { recursive: true, force: true })
  }
})

test('--demo skips the credential preflight even though fixtures reference ${ZAI_API_KEY}', () => {
  const r = run(['diagnose', '--demo', '--json'])
  const parsed = JSON.parse(r.stdout)
  assert.ok(!parsed.findings.some(f => f.id === 'DT010'), 'DT010 should not fire under --demo')
})

test('--demo --probe exits 2 (probe needs live droid)', () => {
  const r = run(['diagnose', '--demo', '--probe'])
  assert.equal(r.code, 2)
})

test('trial without --model refuses (no silent paid default) and exits 2', () => {
  const r = run(['trial', '--task', 'tasks/t001-greet-script'])
  assert.equal(r.code, 2)
  assert.match(r.stderr, /requires --model/)
  // Must not leak into "pick whatever is first in settings" behavior — the
  // error should point at known-free routes, never silently choose one.
  assert.match(r.stderr, /hy3-free/)
})

test('trial without --task exits 2 before any model/spend concern', () => {
  const r = run(['trial'])
  assert.equal(r.code, 2)
  assert.match(r.stderr, /requires --task/)
})

test('trial with a non-working --droid-path fails fast with the DT001 fault code (unified resolveDroid)', () => {
  // Isolated --runs-dir: an unrelated evidence pack already sitting at the
  // default attempt-1 path (from an earlier trial run of this same task)
  // must not make this test observe the attempt-collision guard instead of
  // the DT001 path it's actually testing.
  const runsDir = mkdtempSync(path.join(os.tmpdir(), 'droidtune-dt001-runs-'))
  try {
    const r = run([
      'trial', '--task', 'tasks/t001-greet-script', '--model', 'hy3-free',
      '--droid-path', path.join(root, 'does-not-exist-droid'),
      '--runs-dir', runsDir
    ])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /droid CLI not found/)
    assert.match(r.stderr, /DT001/)
  } finally {
    rmSync(runsDir, { recursive: true, force: true })
  }
})

test('trial resolves --task the same way `run` does, regardless of invoking cwd (plugin-cwd fix)', () => {
  // Simulates a plugin install: droid is invoked from some unrelated project
  // directory (cwd), but the task id is bundled inside the plugin/repo tree
  // (REPO_ROOT/tasks). A bare short id must resolve via REPO_ROOT/tasks, not
  // relative to whatever cwd happened to invoke the command. Use a bad
  // --droid-path so the command fails fast on DT001 (proving task resolution
  // already succeeded) rather than spawning anything live.
  const elsewhere = mkdtempSync(path.join(os.tmpdir(), 'droidtune-elsewhere-'))
  const runsDir = mkdtempSync(path.join(os.tmpdir(), 'droidtune-elsewhere-runs-'))
  try {
    const r = run([
      'trial', '--task', 't001-greet-script', '--model', 'hy3-free',
      '--droid-path', path.join(root, 'does-not-exist-droid'),
      '--runs-dir', runsDir
    ], { cwd: elsewhere })
    assert.equal(r.code, 1, `expected DT001 (task resolved) not a task-not-found usage error: ${r.stderr}`)
    assert.match(r.stderr, /DT001/)
    assert.doesNotMatch(r.stderr, /task not found/)
  } finally {
    rmSync(elsewhere, { recursive: true, force: true })
    rmSync(runsDir, { recursive: true, force: true })
  }
})

test('trial refuses an --attempt collision BEFORE spawning droid, and suggests the next free attempt', () => {
  const runsDir = mkdtempSync(path.join(os.tmpdir(), 'droidtune-collision-runs-'))
  const sessionsDir = mkdtempSync(path.join(os.tmpdir(), 'droidtune-collision-sess-'))
  const configPath = path.join(runsDir, 'config.json')
  writeFileSync(configPath, JSON.stringify({
    customModels: [{ model: 'fake-model', id: 'custom:fake-0', provider: 'anthropic', baseUrl: 'https://api.z.ai/api/anthropic', apiKey: '${X_KEY}' }]
  }))
  const env = { ...process.env, X_KEY: 'fake-test-credential', FAKE_DROID_MODE: 'pass', FAKE_DROID_SESSIONS_DIR: sessionsDir }
  const baseArgs = [
    'trial', '--task', 't001-greet-script', '--model', 'custom:fake-0',
    '--config', configPath, '--sessions-dir', sessionsDir,
    '--droid-path', path.join(root, 'fixtures', 'bin', 'fake-droid-trial'),
    '--runs-dir', runsDir
  ]
  try {
    const first = run(baseArgs, { env })
    assert.equal(first.code, 0, `expected first attempt to pass: ${first.stdout}${first.stderr}`)

    // Re-running at the SAME attempt number (default 1) must refuse before
    // spawning droid at all — the fixture would exit 0/pass again if it were
    // ever invoked, so a nonzero exit here proves the guard fired first, not
    // pack.js's end-of-run non-empty-dir check.
    const second = run(baseArgs, { env })
    assert.equal(second.code, 1)
    assert.match(second.stderr, /already has an evidence pack/)
    assert.match(second.stderr, /--attempt 2/)

    // The suggested next attempt number actually works.
    const third = run([...baseArgs, '--attempt', '2'], { env })
    assert.equal(third.code, 0, `expected attempt 2 to pass: ${third.stdout}${third.stderr}`)
  } finally {
    rmSync(runsDir, { recursive: true, force: true })
    rmSync(sessionsDir, { recursive: true, force: true })
  }
})

test('two routes may share a tune, task and attempt number — packs are route-scoped', () => {
  // The sweep case the route segment exists for: the preregistered claim runs
  // one tune and one task across four routes at attempts 1..10. Without a route
  // in the path, route 2's attempt-1 would trip the collision guard and the
  // sweep could not run at all.
  const runsDir = mkdtempSync(path.join(os.tmpdir(), 'droidtune-routes-runs-'))
  const sessionsDir = mkdtempSync(path.join(os.tmpdir(), 'droidtune-routes-sess-'))
  const configPath = path.join(runsDir, 'config.json')
  writeFileSync(configPath, JSON.stringify({
    customModels: [
      { model: 'fake-model', id: 'custom:fake-0', provider: 'anthropic', baseUrl: 'https://api.z.ai/api/anthropic', apiKey: '${X_KEY}' },
      { model: 'other-model', id: 'custom:other-1', provider: 'anthropic', baseUrl: 'https://api.z.ai/api/anthropic', apiKey: '${X_KEY}' }
    ]
  }))
  const env = { ...process.env, X_KEY: 'fake-test-credential', FAKE_DROID_MODE: 'pass', FAKE_DROID_SESSIONS_DIR: sessionsDir }
  const argsFor = (model) => [
    'trial', '--task', 't001-greet-script', '--model', model,
    '--tune', 'sweep', '--config', configPath, '--sessions-dir', sessionsDir,
    '--droid-path', path.join(root, 'fixtures', 'bin', 'fake-droid-trial'),
    '--runs-dir', runsDir
  ]
  try {
    const a = run(argsFor('custom:fake-0'), { env })
    assert.equal(a.code, 0, `route A attempt 1 should pass: ${a.stdout}${a.stderr}`)
    const b = run(argsFor('custom:other-1'), { env })
    assert.equal(b.code, 0, `route B attempt 1 must not collide with route A: ${b.stdout}${b.stderr}`)

    // Both packs exist, side by side, under their own route.
    for (const route of ['fake-0', 'other-1']) {
      assert.ok(
        existsSync(path.join(runsDir, 'sweep', route, 't001-greet-script', 'attempt-1', 'manifest.json')),
        `expected a pack for route ${route}`
      )
    }

    // Within one route the guard still fires, and still names the next free number.
    const again = run(argsFor('custom:fake-0'), { env })
    assert.equal(again.code, 1)
    assert.match(again.stderr, /already has an evidence pack/)
    assert.match(again.stderr, /--attempt 2/)
    // …and it points at the route-scoped path, not the shared task path.
    assert.match(again.stderr, /sweep\/fake-0\/t001-greet-script/)
  } finally {
    rmSync(runsDir, { recursive: true, force: true })
    rmSync(sessionsDir, { recursive: true, force: true })
  }
})

test('trial errors on an unresolvable --task before any droid/model concern', () => {
  const r = run(['trial', '--task', 'not-a-real-task-xyz', '--model', 'hy3-free'])
  assert.equal(r.code, 2)
  assert.match(r.stderr, /task not found/)
})

test('trial (fixture droid, pass mode) prints the pack path AND the exact report command to read it back', () => {
  // Uses fixtures/bin/fake-droid-trial (a local shell fixture, no live spend,
  // no network) — same fixture test/runner.test.js uses for full-trial
  // coverage. Verifies bin/droidtune.js's human output extends the existing
  // `pack ...` line with an exact, runnable `report ...` line that points at
  // the SAME --runs-dir the trial actually wrote to.
  const runsDir = mkdtempSync(path.join(os.tmpdir(), 'droidtune-cli-runs-'))
  const sessionsDir = mkdtempSync(path.join(os.tmpdir(), 'droidtune-cli-sess-'))
  const configPath = path.join(runsDir, 'config.json')
  writeFileSync(configPath, JSON.stringify({
    customModels: [{ model: 'fake-model', id: 'custom:fake-0', provider: 'anthropic', baseUrl: 'https://api.z.ai/api/anthropic', apiKey: '${X_KEY}' }]
  }))
  try {
    const r = run([
      'trial', '--task', 't001-greet-script', '--model', 'custom:fake-0',
      '--config', configPath, '--sessions-dir', sessionsDir,
      '--droid-path', path.join(root, 'fixtures', 'bin', 'fake-droid-trial'),
      '--runs-dir', runsDir
    ], { env: { ...process.env, X_KEY: 'fake-test-credential', FAKE_DROID_MODE: 'pass', FAKE_DROID_SESSIONS_DIR: sessionsDir } })
    assert.equal(r.code, 0, `expected VERIFIED_PASS: ${r.stdout}${r.stderr}`)
    assert.match(r.stdout, /^ {2}pack {7}.*manifest\.json$/m)
    assert.match(r.stdout, /^ {2}report {5}node .*results-table\.js --runs-dir /m)
    // The report command's --runs-dir must be the SAME dir the pack was
    // actually written under — this is the exact mismatch the plugin bug had.
    const reportLine = r.stdout.split('\n').find(l => l.trim().startsWith('report'))
    assert.ok(reportLine.includes(runsDir), `report command does not reference the actual runs dir: ${reportLine}`)
  } finally {
    rmSync(runsDir, { recursive: true, force: true })
    rmSync(sessionsDir, { recursive: true, force: true })
  }
})

test('trial labels its pack claimEligible:false in both human and --json output (item 6c)', () => {
  const runsDir = mkdtempSync(path.join(os.tmpdir(), 'droidtune-claim-runs-'))
  const sessionsDir = mkdtempSync(path.join(os.tmpdir(), 'droidtune-claim-sess-'))
  const configPath = path.join(runsDir, 'config.json')
  writeFileSync(configPath, JSON.stringify({
    customModels: [{ model: 'fake-model', id: 'custom:fake-0', provider: 'anthropic', baseUrl: 'https://api.z.ai/api/anthropic', apiKey: '${X_KEY}' }]
  }))
  const env = { ...process.env, X_KEY: 'fake-test-credential', FAKE_DROID_MODE: 'pass', FAKE_DROID_SESSIONS_DIR: sessionsDir }
  const baseArgs = [
    'trial', '--task', 't001-greet-script', '--model', 'custom:fake-0',
    '--config', configPath, '--sessions-dir', sessionsDir,
    '--droid-path', path.join(root, 'fixtures', 'bin', 'fake-droid-trial'),
    '--runs-dir', runsDir
  ]
  try {
    const human = run(baseArgs, { env })
    assert.equal(human.code, 0)
    assert.match(human.stdout, /claimEligible false — development\/ad-hoc pack/)

    const json = run([...baseArgs, '--attempt', '2', '--json'], { env })
    assert.equal(json.code, 0)
    const parsed = JSON.parse(json.stdout)
    assert.equal(parsed.claimEligible, false)
  } finally {
    rmSync(runsDir, { recursive: true, force: true })
    rmSync(sessionsDir, { recursive: true, force: true })
  }
})

test('baseline with a non-working --droid-path fails fast with the DT001 fault code (unified resolveDroid)', () => {
  const r = run([
    'baseline', '--confirm-spend',
    '--droid-path', path.join(root, 'does-not-exist-droid')
  ])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /droid CLI not found/)
  assert.match(r.stderr, /DT001/)
})

test('runTriforce: all-expected verdicts → ok:true with 7 passing legs', () => {
  const verdicts = {
    oracle: 'VERIFIED_PASS',
    noop: 'VERIFIED_FAIL',
    'cheat:forgery': 'VERIFIER_ERROR',
    'cheat:early-exit': 'VERIFIER_ERROR'
  }
  const seen = []
  const r = runTriforce((kind) => { seen.push(kind); return verdicts[kind] }, () => {})
  assert.equal(r.ok, true)
  assert.equal(r.results.length, 7)
  assert.ok(r.results.every(x => x.pass))
  assert.deepEqual(seen, ['oracle', 'oracle', 'oracle', 'noop', 'noop', 'cheat:forgery', 'cheat:early-exit'])
})

test('runTriforce: one wrong verdict → ok:false', () => {
  const expected = {
    oracle: 'VERIFIED_PASS',
    noop: 'VERIFIED_FAIL',
    'cheat:forgery': 'VERIFIER_ERROR',
    'cheat:early-exit': 'VERIFIER_ERROR'
  }
  let n = 0
  const r = runTriforce((kind) => {
    n += 1
    if (n === 4) return 'VERIFIED_PASS' // wrong for a noop leg (expects VERIFIED_FAIL)
    return expected[kind]
  }, () => {})
  assert.equal(r.ok, false)
  const failing = r.results.filter(x => !x.pass).map(x => `${x.leg} #${x.i}`)
  assert.deepEqual(failing, ['noop #1'])
})

test('triforce CLI exits 0 (49 offline legs)', () => {
  const r = run(['triforce'])
  assert.equal(r.code, 0, `triforce exited ${r.code}: ${r.stdout}${r.stderr}`)
  assert.match(r.stdout, /ok oracle #1 -> VERIFIED_PASS/)
  assert.match(r.stdout, /ok noop #2 -> VERIFIED_FAIL/)
  assert.match(r.stdout, /ok cheat:early-exit #1 -> VERIFIER_ERROR/)
})

// --- audit ---------------------------------------------------------------

const auditFixtures = path.join(root, 'test', 'fixtures', 'audit', 'packs')

test('audit without a directory exits 2', () => {
  const r = run(['audit'])
  assert.equal(r.code, 2)
  assert.match(r.stderr, /audit requires a directory/)
})

test('audit on a missing directory exits 2', () => {
  const r = run(['audit', path.join(root, 'no-such-dir')])
  assert.equal(r.code, 2)
  assert.match(r.stderr, /not found/)
})

test('audit on a pack with violations exits 1 and names them', () => {
  const r = run(['audit', path.join(auditFixtures, 't900-demo', 'attempt-1')])
  assert.equal(r.code, 1)
  assert.match(r.stdout, /claim-without-coverage\s+1/)
  assert.match(r.stdout, /NO_SUBMISSION/)
})

test('audit on a clean pack exits 0', () => {
  const r = run(['audit', path.join(auditFixtures, 't901-demo', 'attempt-1')])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /violations 0/)
})

test('audit --json emits the machine-readable aggregation', () => {
  const r = run(['audit', auditFixtures, '--json'])
  assert.equal(r.code, 1)
  const parsed = JSON.parse(r.stdout)
  assert.equal(parsed.mode, 'runs')
  assert.equal(parsed.packCount, 3)
  assert.equal(parsed.unauditablePacks, 1)
  assert.equal(parsed.totals['claim-without-coverage'], 1)
})

test('audit --window widens the coverage window a claim may reach back through', () => {
  const target = path.join(auditFixtures, 't900-demo', 'attempt-1')
  assert.equal(run(['audit', target]).code, 1)
  const r = run(['audit', target, '--window', '20'])
  assert.equal(r.code, 0, r.stdout)
})

test('audit --stall-threshold rejects a non-positive value', () => {
  const r = run(['audit', auditFixtures, '--stall-threshold', '0'])
  assert.equal(r.code, 2)
  assert.match(r.stderr, /must be a positive integer/)
})

test('audit over the committed demo-pack reports it as unauditable, never as clean', () => {
  // demo-pack/ was sanitized without transcripts, so there is nothing for the
  // auditor to read. The report must say so rather than print 24 zero rows
  // that a reader would mistake for 24 clean sessions.
  const r = run(['audit', path.join(root, 'demo-pack')])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /TOTAL \(0\/24 auditable\)/)
  assert.match(r.stdout, /24 pack\(s\) carry no transcript\.jsonl/)
})

// --- tunes ---------------------------------------------------------------

test('--tune-file with a name resolves against the repo tunes/ dir, not the caller cwd', () => {
  const runsDir = mkdtempSync(path.join(os.tmpdir(), 'droidtune-cli-tune-'))
  try {
    const r = run(
      ['run', 't001-greet-script', '--offline', '--tune', 'ledger-lite',
        '--tune-file', 'ledger-lite', '--runs-dir', runsDir],
      { cwd: os.tmpdir() }
    )
    assert.equal(r.code, 0, `${r.stdout}${r.stderr}`)
    assert.match(r.stdout, /verdict=VERIFIED_PASS/)
  } finally {
    rmSync(runsDir, { recursive: true, force: true })
  }
})

test('an unknown --tune-file is a usage error, not a stack trace mid-run', () => {
  const r = run(['run', 't001-greet-script', '--offline', '--tune-file', 'no-such-tune'])
  assert.equal(r.code, 2)
  assert.match(r.stderr, /tune not found/)
  assert.match(r.stderr, /looked in the current directory and/)
})

test('trial rejects --tune-file before it ever needs a model or a droid binary', () => {
  const r = run(['trial', '--task', 't001-greet-script', '--model', 'x', '--tune-file', 'no-such-tune'])
  assert.equal(r.code, 2)
  assert.match(r.stderr, /tune not found/)
})

test('--help documents --tune-file for both trial and run', () => {
  const r = run(['--help'])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /--tune-file <path> {5}Tune dir \(or AGENTS\.md\) copied into the worktree/)
  assert.match(r.stdout, /--tune-file <path> {5}Apply a tune to the worktree/)
})

// --- badge ---------------------------------------------------------------

test('badge without a target is a usage error', () => {
  const r = run(['badge'])
  assert.equal(r.code, 2)
  assert.match(r.stderr, /badge requires a target/)
})

test('badge on a missing target is a usage error', () => {
  const r = run(['badge', path.join(root, 'no-such-thing')])
  assert.equal(r.code, 2)
  assert.match(r.stderr, /not found/)
})

test('badge over a runs dir emits shields endpoint JSON matching the results table', () => {
  const r = run(['badge', 'demo-pack'], { cwd: root })
  assert.equal(r.code, 0)
  const badge = JSON.parse(r.stdout)
  assert.equal(badge.schemaVersion, 1)
  assert.equal(badge.label, 'verified pass')
  // scripts/results-table.js reports 13/23 (57%) over the same fixture.
  assert.equal(badge.message, '13/23 (57%)')
})

test('badge resolves a bare target against the repo root, not the caller cwd', () => {
  const r = run(['badge', 'demo-pack'], { cwd: os.tmpdir() })
  assert.equal(r.code, 0, r.stderr)
  assert.equal(JSON.parse(r.stdout).message, '13/23 (57%)')
})

test('badge dispatches to the weather series on content, not on the name', () => {
  const fromDir = run(['badge', 'weather'], { cwd: root })
  const fromFile = run(['badge', path.join(root, 'weather', 'route-status.jsonl')])
  assert.equal(fromDir.code, 0)
  assert.equal(JSON.parse(fromDir.stdout).label, 'free routes')
  assert.equal(fromDir.stdout, fromFile.stdout)
})

// The workflow writes weather/badge.json through scripts/route-weather.js, and
// a reader can regenerate it with `droidtune badge weather`. If those two ever
// disagreed, the README badge and the CLI would tell different stories.
test('the badge CLI agrees byte for byte with the committed weather/badge.json', () => {
  const r = run(['badge', 'weather'], { cwd: root })
  assert.equal(r.code, 0)
  assert.equal(r.stdout, readFileSync(path.join(root, 'weather', 'badge.json'), 'utf8'))
})

test('badge --out writes the file and reports what it wrote', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'droidtune-badge-cli-'))
  try {
    const out = path.join(dir, 'badge.json')
    const r = run(['badge', 'demo-pack', '--out', out], { cwd: root })
    assert.equal(r.code, 0)
    assert.match(r.stdout, /verified pass — 13\/23 \(57%\)/)
    assert.equal(JSON.parse(readFileSync(out, 'utf8')).message, '13/23 (57%)')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('badge --label overrides the default label', () => {
  const r = run(['badge', 'demo-pack', '--label', 'demo pack'], { cwd: root })
  assert.equal(JSON.parse(r.stdout).label, 'demo pack')
})

// --- watch ---------------------------------------------------------------

// `run` above only surfaces stderr when the child fails, because execFileSync
// throws to deliver it. watch prints findings to stdout and its summary to
// stderr (so `--json` output stays pure JSONL), so its success cases need both
// streams.
function runCapture (args) {
  const r = spawnSync('node', [bin, ...args], { encoding: 'utf8' })
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

test('watch --once over a planted transcript reports the finding and exits 1', () => {
  const r = runCapture(['watch', '--file', path.join(root, 'test/fixtures/audit/claim-without-coverage.jsonl'), '--once'])
  assert.equal(r.code, 1)
  assert.match(r.stdout, /\[claim-without-coverage\]/)
  assert.match(r.stderr, /11 tool events/)
})

test('watch --once over a clean transcript exits 0 and says so', () => {
  const r = runCapture(['watch', '--file', path.join(root, 'test/fixtures/audit/clean.jsonl'), '--once'])
  assert.equal(r.code, 0)
  assert.match(r.stderr, /no violations/)
})

// --once treats the current contents as the whole session, so the terminal
// finding is released rather than withheld forever.
test('watch --once releases the terminal no-test-finish', () => {
  const r = run(['watch', '--file', path.join(root, 'test/fixtures/audit/no-test-finish.jsonl'), '--once'])
  assert.equal(r.code, 1)
  assert.match(r.stdout, /\[no-test-finish\]/)
})

test('watch --json emits one JSON object per finding', () => {
  const r = run(['watch', '--file', path.join(root, 'test/fixtures/audit/stall.jsonl'), '--once', '--json'])
  assert.equal(r.code, 1)
  const findings = r.stdout.trim().split('\n').map(l => JSON.parse(l))
  assert.equal(findings.length, 1)
  assert.equal(findings[0].category, 'stall')
  assert.equal(findings[0].count, 3)
})

test('watch on a missing --file is a usage error', () => {
  const r = run(['watch', '--file', path.join(root, 'nope.jsonl'), '--once'])
  assert.equal(r.code, 2)
  assert.match(r.stderr, /not found/)
})

test('watch with no session to find explains how to point it at one', () => {
  const r = run(['watch', '--sessions-dir', path.join(root, 'no-such-sessions'), '--once'])
  assert.equal(r.code, 2)
  assert.match(r.stderr, /no transcript found/)
  assert.match(r.stderr, /--file <transcript\.jsonl>/)
})

test('watch discovers the newest transcript under a sessions dir', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'droidtune-watch-cli-'))
  try {
    const proj = path.join(dir, '-tmp-project')
    mkdirSync(proj, { recursive: true })
    writeFileSync(
      path.join(proj, 'live.jsonl'),
      readFileSync(path.join(root, 'test/fixtures/audit/stall.jsonl'), 'utf8')
    )
    const r = runCapture(['watch', '--sessions-dir', dir, '--once'])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /watching newest session live/)
    assert.match(r.stdout, /\[stall\]/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
