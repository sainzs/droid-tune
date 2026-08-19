import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { listSessions, readSession } from './sessions.js'
import { openLedger } from './ledger.js'
import { writeEvidencePack } from './pack.js'
import { redactConfig } from './diagnose.js'

export const OUTCOME_CLASSES = ['VERIFIED_PASS', 'VERIFIED_FAIL', 'NO_SUBMISSION', 'TIMEOUT', 'DROID_ERROR', 'VERIFIER_ERROR', 'ABORTED_BUDGET']

const PROBE_TAG_PREFIX = 'droidtune'
const TRIAL_TAG = 'droidtune-trial'

function repoRoot () {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
}

function git (cwd, args, timeoutMs = 30000) {
  return spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: timeoutMs })
}

function tails (res) {
  const out = {}
  if (res.stdout) out.droidStdout = res.stdout.slice(-800)
  if (res.stderr) out.droidStderr = res.stderr.slice(-800)
  return out
}

async function runTrial (opts = {}) {
  const {
    taskDir, model, droidPath, sessionsDir, configPath,
    runsDir = path.join(repoRoot(), 'runs'),
    tuneName = 'ad-hoc', attempt = 1, autoLevel = 'high',
    timeoutMs = 300000, instructionFile, env = process.env
  } = opts
  if (!taskDir || !model) throw new Error('runTrial requires taskDir and model')
  const taskId = opts.taskId ?? path.basename(taskDir)
  const instruction = instructionFile ?? path.join(taskDir, 'instruction.md')
  const budget = { maxTrials: null, maxOutputTokensPerTrial: null, cumulativeOutputTokens: null, ...(opts.budget ?? {}) }
  const trialId = `${tuneName}/${taskId}/attempt-${attempt}`
  const attemptDir = path.join(runsDir, tuneName, taskId, `attempt-${attempt}`)
  const ledger = openLedger(path.join(attemptDir, 'events.jsonl'))
  const startedAt = new Date().toISOString()
  const t0 = Date.now()
  const errors = {}
  const results = { outcome: null, startedAt, budget: { ...budget } }
  const append = (type, data = {}) => ledger.append(type, { trialId, ...data }, trialId)

  append('trial.start', { taskDir, model, attempt, tuneName })

  const finish = async (opts2 = {}) => {
    const endedAt = new Date().toISOString()
    results.endedAt = endedAt
    results.durationMs = Date.now() - t0
    let manifestPath = null
    append('trial.end', { outcome: results.outcome, durationMs: results.durationMs })
    try {
      const manifest = await writeEvidencePack(attemptDir, {
        trialId,
        provenance: {
          trialId, droidVersion: opts2.droidVersion ?? null, droidPath: droidPath ?? null,
          modelRequested: model, modelObserved: results.modelObserved ?? null,
          routeClass: results.routeClass ?? null, autoLevel, timeoutMs,
          node: process.version, platform: process.platform, startedAt, endedAt
        },
        instructionPath: instruction,
        testsDir: path.join(taskDir, 'tests'),
        configSnapshot: opts2.configSnapshot ?? null,
        ledgerPath: ledger.path,
        transcriptPath: opts2.transcriptPath ?? null,
        patchDiff: opts2.patchDiff ?? null,
        results,
        usage: opts2.usage ?? null,
        pricing: null,
        errors: Object.keys(errors).length > 0 ? errors : null
      }, { allowExisting: ['events.jsonl'] })
      manifestPath = path.join(attemptDir, 'manifest.json')
    } catch (err) {
      append('pack.error', { error: String(err.message).slice(0, 200) })
      throw err
    }
    return { trialId, outcome: results.outcome, results, usage: opts2.usage ?? null, manifestPath, budgetAbort: results.budgetAbort ?? false }
  }

  if (budget.maxTrials !== null && attempt > budget.maxTrials) {
    results.outcome = 'ABORTED_BUDGET'
    errors.reason = 'maxTrials'
    append('outcome.classified', { outcome: results.outcome, reason: 'maxTrials' })
    return finish()
  }

  const worktree = mkdtempSync(path.join(os.tmpdir(), 'droidtune-wt-'))
  let transcriptPath = null
  try {
    const seed = spawnSync('sh', [path.join(taskDir, 'environment', 'seed.sh'), worktree], { encoding: 'utf8', timeout: 60000 })
    if (seed.status !== 0) {
      throw new Error(`seed.sh failed (${seed.status}): ${(seed.stderr ?? '').slice(0, 300)}`)
    }
    const seedSha = (git(worktree, ['rev-parse', 'HEAD']).stdout ?? '').trim()
    append('seed.done', { seedSha })

    const droidVersion = (spawnSync(droidPath, ['--version'], { encoding: 'utf8', timeout: 15000 }).stdout ?? '').trim() || null

    let configSnapshot = null
    try {
      configSnapshot = redactConfig(JSON.parse(readFileSync(configPath, 'utf8')))
    } catch {
      errors.configSnapshot = `unparseable or missing: ${configPath}`
    }

    const before = await listSessions(sessionsDir)
    const beforeKeys = new Set(before.sessions.map(s => s.settingsPath ?? s.jsonlPath))

    const res = spawnSync(droidPath, [
      'exec', '-m', model, '--cwd', worktree, '--auto', autoLevel,
      '--tag', TRIAL_TAG, '-o', 'json', '-f', instruction
    ], { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env })
    append('droid.exit', { status: res.error ? null : res.status, signal: res.signal ?? null, error: res.error ? String(res.error.message).slice(0, 200) : null })

    let outcome = null
    if (res.error?.code === 'ETIMEDOUT' || res.signal === 'SIGTERM') outcome = 'TIMEOUT'
    else if (res.error || res.signal) outcome = 'DROID_ERROR'
    else if (res.status !== 0) outcome = 'DROID_ERROR'
    if (outcome !== null) Object.assign(errors, tails(res))

    const after = await listSessions(sessionsDir)
    const fresh = (await Promise.all(
      after.sessions
        .filter(s => !beforeKeys.has(s.settingsPath ?? s.jsonlPath))
        .map(readSession)
    ))
    const sessionRec = fresh.find(r => r.tags.some(t => typeof t === 'string' && t.startsWith(PROBE_TAG_PREFIX))) ?? fresh[0] ?? null
    append('session.located', { sessionId: sessionRec?.id ?? null })
    if (sessionRec?.jsonlPath) {
      const tmp = mkdtempSync(path.join(os.tmpdir(), 'droidtune-tr-'))
      transcriptPath = path.join(tmp, 'transcript.jsonl')
      writeFileSync(transcriptPath, readFileSync(sessionRec.jsonlPath, 'utf8'))
    } else {
      errors.session = 'session not located'
    }
    const usage = sessionRec?.tokenUsage ?? null
    if (sessionRec) {
      results.modelObserved = sessionRec.model
      results.routeClass = sessionRec.routeClass
    }
    let budgetAbort = false
    if (usage) {
      if (budget.maxOutputTokensPerTrial !== null && usage.outputTokens > budget.maxOutputTokensPerTrial) budgetAbort = true
      if (budget.cumulativeOutputTokens !== null && budget.cumulativeOutputTokens + usage.outputTokens > budget.cumulativeOutputTokens) budgetAbort = true
    }
    results.budgetAbort = budgetAbort

    if (outcome === null) {
      const count = (git(worktree, ['rev-list', '--count', `${seedSha}..HEAD`]).stdout ?? '').trim()
      if (count === '0') {
        outcome = 'NO_SUBMISSION'
        results.reason = 'no new commits'
      } else {
        const patchDiff = git(worktree, ['diff', `${seedSha}..HEAD`]).stdout ?? ''
        const commits = (git(worktree, ['log', '--oneline', `${seedSha}..HEAD`]).stdout ?? '').trim().split('\n').filter(Boolean)
        results.commits = commits
        append('patch.extracted', { bytes: patchDiff.length, commits: commits.length })
        const gradeDir = mkdtempSync(path.join(os.tmpdir(), 'droidtune-grade-'))
        try {
          cpSync(worktree, gradeDir, { recursive: true })
          cpSync(path.join(taskDir, 'tests'), path.join(gradeDir, 'tests'), { recursive: true })
          const test = spawnSync('sh', ['tests/test.sh'], { cwd: gradeDir, encoding: 'utf8', timeout: 120000 })
          results.testExit = test.error ? null : test.status
          const rewardPath = path.join(gradeDir, 'reward.json')
          if (existsSync(rewardPath)) {
            try { results.reward = JSON.parse(readFileSync(rewardPath, 'utf8')).reward ?? null } catch {}
          }
          if (test.error || test.status === null) {
            outcome = 'VERIFIER_ERROR'
            errors.verifier = test.error ? String(test.error.message).slice(0, 200) : 'verifier produced no exit status'
          } else {
            outcome = test.status === 0 ? 'VERIFIED_PASS' : 'VERIFIED_FAIL'
          }
          append('tests.exit', { status: results.testExit, reward: results.reward ?? null })
        } finally {
          rmSync(gradeDir, { recursive: true, force: true })
        }
        results.outcome = outcome
        append('outcome.classified', { outcome })
        return await finish({ droidVersion, configSnapshot, transcriptPath, patchDiff, usage: usage ? { ...usage, sessionId: sessionRec.id, observedModel: sessionRec.model, routeClass: sessionRec.routeClass } : null })
      }
    }

    results.outcome = outcome
    append('outcome.classified', { outcome })
    return await finish({
      droidVersion, configSnapshot, transcriptPath, patchDiff: null,
      usage: usage ? { ...usage, sessionId: sessionRec.id, observedModel: sessionRec.model, routeClass: sessionRec.routeClass } : null
    })
  } finally {
    rmSync(worktree, { recursive: true, force: true })
    if (transcriptPath) rmSync(path.dirname(transcriptPath), { recursive: true, force: true })
  }
}

export { runTrial }
