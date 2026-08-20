import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { listSessions, readSession } from './sessions.js'
import { openLedger } from './ledger.js'
import { writeEvidencePack } from './pack.js'
import { redactConfig } from './diagnose.js'
import { priceUsage, validatePricingRequest } from './pricing.js'
import { checkCtrf, checkReward, hashTree, VerifierError } from './verify.js'
import { referencedCredentialVars, autoloadCredentials } from './credentials.js'

export const OUTCOME_CLASSES = ['VERIFIED_PASS', 'VERIFIED_FAIL', 'NO_SUBMISSION', 'TIMEOUT', 'PROVIDER_ERROR', 'DROID_ERROR', 'VERIFIER_ERROR', 'ABORTED_BUDGET']

// Env allowlist for the spawned `droid exec`. runTrial otherwise inherits the
// caller's full process.env, whose *names* droid reflects into the session
// transcript (system context) — and PLAN §8 makes transcripts public evidence
// ("no transcript → no claim"). Leaking the caller's unrelated secret names
// (AZURE_*, AUGMENT_*, …) into a shareable pack is a hygiene gap (§13 key
// hygiene). Droid reads credentials from settings.json via ${ENV} indirection,
// so the child only needs a functional POSIX env + the specific vars its
// configured routes reference. Build that minimal env; keep it overridable via
// DROIDTUNE_ENV_ALLOW (comma-separated extra names) for exotic setups.
const ENV_ALLOW_EXACT = [
  // functional POSIX / shell
  'PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'SHELL', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TERM_PROGRAM', 'COLORTERM', 'TZ', 'PWD', 'OLDPWD', 'SHLVL', '_', 'HOSTNAME',
  // git (fixture seed/commit inside the worktree)
  'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'SSH_AUTH_SOCK', 'GIT_SSH_COMMAND',
  // XDG / runtime dirs some tools consult
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR'
]
// Prefixes whose members are credential/route vars droid may resolve from
// settings.json ${ENV} references. Matched case-sensitively against names.
const ENV_ALLOW_PREFIX = ['ZENMUX_', 'OPENCODE_', 'ZAI_', 'ANTHROPIC_', 'OPENAI_', 'AZURE_', 'AWS_', 'GOOGLE_', 'GEMINI_', 'MOONSHOT_', 'DEEPSEEK_', 'OPENROUTER_', 'FACTORY_', 'DROIDTUNE_', 'FAKE_DROID_']

function buildDroidEnv (base) {
  const extra = (base.DROIDTUNE_ENV_ALLOW ?? '').split(',').map(s => s.trim()).filter(Boolean)
  const allow = new Set([...ENV_ALLOW_EXACT, ...extra])
  const out = {}
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue
    if (allow.has(k) || ENV_ALLOW_PREFIX.some(p => k.startsWith(p))) out[k] = v
  }
  return out
}

// Extract droid exec's trailing result envelope from stdout (-o json emits one
// line-delimited result object). Trust only a genuine envelope — an object with
// type:"result" AND a session_id — so a task that prints lookalike JSON to its
// own stdout cannot poison outcome classification. Returns null when absent.
function parseDroidResult (stdout) {
  if (!stdout) return null
  for (const line of stdout.trim().split('\n').reverse()) {
    const s = line.trim()
    if (!s.startsWith('{')) continue
    try {
      const o = JSON.parse(s)
      if (o && o.type === 'result' && typeof o.session_id === 'string') return o
    } catch {}
  }
  return null
}

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
    timeoutMs = 300000, instructionFile, env = process.env,
    native = false, pricingTableId = null, provenance = null,
    offline = false, cheat = null, noop = false
  } = opts
  if (!taskDir || (!model && !native)) throw new Error('runTrial requires taskDir and model (or native:true)')
  if (native && model) throw new Error('runTrial accepts either model or native:true, not both')

  // Fail-fast credential preflight — BEFORE any droid spawn / session / trial.
  // If the active config references ${VAR} credential indirection and that var
  // is absent from the parent env, try to source the well-known
  // ~/.factory/env.sh (values never read/printed), and if the credential is
  // STILL missing, abort with an actionable message. This distinguishes an
  // "operator forgot to source credentials" condition from a genuine
  // PROVIDER_ERROR (0-turn provider rejection reported by droid itself).
  let activeEnv = env
  if (!native) {
    const required = referencedCredentialVars(configPath)
    const envShPath = path.join(os.homedir(), '.factory', 'env.sh')
    activeEnv = autoloadCredentials(env, required, envShPath)
    const stillMissing = required.filter(v => activeEnv[v] === undefined || activeEnv[v] === '')
    if (stillMissing.length > 0) {
      throw new Error(
        `missing Droid credentials: ${stillMissing.join(', ')}. ` +
        `Source your credentials file (e.g. source ~/.factory/env.sh) before running droidtune, ` +
        `then retry. Refusing to spawn droid exec with unset credential(s) ` +
        `— this is a local misconfiguration, not a provider rejection.`
      )
    }
  }

  const modelRequested = native ? 'native-droid' : model
  const taskId = opts.taskId ?? path.basename(taskDir)
  const resolvedRunsDir = path.resolve(runsDir)
  const instruction = instructionFile ?? path.join(taskDir, 'instruction.md')
  const budget = { maxTrials: null, maxOutputTokensPerTrial: null, cumulativeOutputTokens: null, cumulativeOutputTokensUsed: 0, ...(opts.budget ?? {}) }
  const trialId = `${tuneName}/${taskId}/attempt-${attempt}`
  const attemptDir = path.join(resolvedRunsDir, tuneName, taskId, `attempt-${attempt}`)
  const startedAt = new Date().toISOString()
  if (pricingTableId) validatePricingRequest({ tableId: pricingTableId, at: startedAt, model: modelRequested, native })
  const ledger = openLedger(path.join(attemptDir, 'events.jsonl'))
  const t0 = Date.now()
  const errors = {}
  const results = { outcome: null, startedAt, budget: { ...budget } }
  const append = (type, data = {}) => ledger.append(type, { trialId, ...data }, trialId)

  append('trial.start', { taskDir, model: modelRequested, attempt, tuneName, ...(offline || cheat || noop ? { selftest: true, offline: !!offline, cheat, noop } : {}) })

  const finish = async (opts2 = {}) => {
    const endedAt = new Date().toISOString()
    results.endedAt = endedAt
    results.durationMs = Date.now() - t0
    let manifestPath = null
    append('trial.end', { outcome: results.outcome, durationMs: results.durationMs })
    try {
      const pricing = pricingTableId && opts2.usage
        ? priceUsage({ tableId: pricingTableId, at: startedAt, model: results.modelObserved ?? modelRequested, usage: opts2.usage, native })
        : null
      const manifest = await writeEvidencePack(attemptDir, {
        trialId,
        provenance: {
          ...(provenance ?? {}),
          trialId, droidVersion: opts2.droidVersion ?? null, droidPath: droidPath ?? null,
          modelRequested, modelObserved: results.modelObserved ?? null,
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
        ctrf: opts2.ctrf ?? null,
        artifactsDir: opts2.artifactsDir ?? null,
        pricing,
        errors: Object.keys(errors).length > 0 ? errors : null
      }, { allowExisting: opts2.artifactsDir ? ['events.jsonl', path.basename(opts2.artifactsDir)] : ['events.jsonl'] })
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

    let droidVersion = null
    let configSnapshot = null
    let usage = null
    let sessionRec = null
    let outcome = null

    if (offline) {
      // Offline self-test path (triforce): no droid process. The "submission"
      // is the task's reference solution applied to the seeded worktree, or an
      // empty diff when --noop is set.
      if (!noop) {
        const solver = path.join(taskDir, 'solution', 'solve.sh')
        const solve = spawnSync('sh', [solver, worktree], { encoding: 'utf8', timeout: 60000 })
        if (solve.status !== 0) {
          throw new Error(`solution solve.sh failed (${solve.status}): ${(solve.stderr ?? '').slice(0, 300)}`)
        }
        append('oracle.applied', { solver })
      } else {
        append('oracle.applied', { noop: true })
      }
    } else {
      droidVersion = (spawnSync(droidPath, ['--version'], { encoding: 'utf8', timeout: 15000 }).stdout ?? '').trim() || null

      try {
        configSnapshot = redactConfig(JSON.parse(readFileSync(configPath, 'utf8')))
      } catch {
        errors.configSnapshot = `unparseable or missing: ${configPath}`
      }

      const before = await listSessions(sessionsDir)
      const beforeKeys = new Set(before.sessions.map(s => s.settingsPath ?? s.jsonlPath))

      const droidArgs = ['exec']
      if (!native) droidArgs.push('-m', model)
      droidArgs.push('--cwd', worktree, '--auto', autoLevel, '--tag', TRIAL_TAG, '-o', 'json', '-f', instruction)
      const res = spawnSync(droidPath, droidArgs, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env: buildDroidEnv(activeEnv) })
      append('droid.exit', { status: res.error ? null : res.status, signal: res.signal ?? null, error: res.error ? String(res.error.message).slice(0, 200) : null })

      if (res.error?.code === 'ETIMEDOUT' || res.signal === 'SIGTERM') outcome = 'TIMEOUT'
      else if (res.error || res.signal) outcome = 'DROID_ERROR'
      else if (res.status !== 0) {
        // Droid exits non-zero both for crashes and for a cleanly-reported
        // provider failure. Classify PROVIDER_ERROR only when droid itself ran
        // fine but the provider rejected the request before any work was done —
        // i.e. a trusted result envelope (type:"result" + session_id) with
        // is_error AND zero turns. Requiring num_turns===0 ensures a real
        // multi-turn task failure (whose transcript free-text might mention
        // "overloaded"/"quota") is never laundered into an excludable provider
        // error — that would be retry-grooming (§8.8).
        const parsed = parseDroidResult(res.stdout)
        const trustedEnvelope = parsed && parsed.type === 'result' && typeof parsed.session_id === 'string'
        if (trustedEnvelope && parsed.is_error === true && (parsed.num_turns ?? 0) === 0) {
          outcome = 'PROVIDER_ERROR'
          const detail = String(parsed.result ?? '').slice(0, 300)
          errors.providerDetail = detail
          // Sub-classify the provider rejection by matching the trusted
          // envelope result text (not by re-deriving HTTP semantics elsewhere)
          // so downstream evidence can tell "back off" from "misconfigured
          // route" from "operator forgot credentials". Check unsupported_model
          // BEFORE auth, since both can nominally look like 401s.
          let kind = 'unknown'
          if (/model .* (is )?not supported/i.test(detail)) kind = 'unsupported_model'
          else if (/429|rate limit/i.test(detail)) kind = 'rate_limit'
          else if (/401|unauthorized|invalid api key|credential/i.test(detail)) kind = 'auth'
          results.providerErrorKind = kind
        } else {
          outcome = 'DROID_ERROR'
        }
      }
      if (outcome !== null) Object.assign(errors, tails(res))

      const after = await listSessions(sessionsDir)
      const fresh = (await Promise.all(
        after.sessions
          .filter(s => !beforeKeys.has(s.settingsPath ?? s.jsonlPath))
          .map(readSession)
      ))
      sessionRec = fresh.find(r => r.tags.some(t => typeof t === 'string' && t.startsWith(PROBE_TAG_PREFIX))) ?? fresh[0] ?? null
      append('session.located', { sessionId: sessionRec?.id ?? null })
      if (sessionRec?.jsonlPath) {
        const tmp = mkdtempSync(path.join(os.tmpdir(), 'droidtune-tr-'))
        transcriptPath = path.join(tmp, 'transcript.jsonl')
        writeFileSync(transcriptPath, readFileSync(sessionRec.jsonlPath, 'utf8'))
      } else {
        errors.session = 'session not located'
      }
      usage = sessionRec?.tokenUsage ?? null
      if (sessionRec) {
        results.modelObserved = sessionRec.model
        results.routeClass = sessionRec.routeClass
      }
    }
    let budgetAbort = false
    if (usage) {
      if (budget.maxOutputTokensPerTrial !== null && usage.outputTokens > budget.maxOutputTokensPerTrial) budgetAbort = true
      if (budget.cumulativeOutputTokens !== null && budget.cumulativeOutputTokensUsed + usage.outputTokens > budget.cumulativeOutputTokens) budgetAbort = true
    }
    results.budgetAbort = budgetAbort

    if (outcome === null) {
      const count = (git(worktree, ['rev-list', '--count', `${seedSha}..HEAD`]).stdout ?? '').trim()
      if (count === '0' && !noop) {
        outcome = 'NO_SUBMISSION'
        results.reason = 'no new commits'
      } else {
        const patchDiff = noop ? '' : git(worktree, ['diff', `${seedSha}..HEAD`]).stdout ?? ''
        const commits = noop ? [] : (git(worktree, ['log', '--oneline', `${seedSha}..HEAD`]).stdout ?? '').trim().split('\n').filter(Boolean)
        results.commits = commits
        // Isolation invariant (S1): the agent's committed patch must not touch
        // the verifier or oracle surfaces. If it added tests/ or solution/, the
        // submission is disqualified rather than graded — otherwise its files
        // could merge into the grading set below.
        const touched = noop ? [] : (git(worktree, ['diff', '--name-only', `${seedSha}..HEAD`]).stdout ?? '').split('\n').filter(Boolean)
        const violated = touched.filter(f => /^(tests|solution)\//.test(f) || f === 'tests' || f === 'solution')
        if (violated.length > 0) {
          outcome = 'VERIFIED_FAIL'
          results.reason = `isolation violation: patch touched ${[...new Set(violated.map(f => f.split('/')[0]))].join(', ')}`
          append('isolation.violated', { files: touched.filter(f => /^(tests|solution)(\/|$)/.test(f)) })
          results.outcome = outcome
          append('outcome.classified', { outcome })
          return await finish({ droidVersion, configSnapshot, transcriptPath, patchDiff, ctrf: null, usage: usage ? { ...usage, sessionId: sessionRec.id, observedModel: sessionRec.model, routeClass: sessionRec.routeClass } : null })
        }
        append('patch.extracted', { bytes: patchDiff.length, commits: commits.length })
        const gradeDir = mkdtempSync(path.join(os.tmpdir(), 'droidtune-grade-'))
        // Grading artifacts (reward.json, ctrf.json) are written here — outside
        // the clone so the clone stays pristine, and under attemptDir so they
        // survive the clone cleanup and reach the evidence pack.
        const artDir = path.join(attemptDir, 'grader-artifacts')
        let ctrf = null
        try {
          // Grade a fresh clone of the committed worktree state — never grade
          // uncommitted files (D1).
          execFileSync('git', ['clone', '--quiet', worktree, gradeDir])
          const gradedSha = (git(gradeDir, ['rev-parse', 'HEAD']).stdout ?? '').trim()
          // S1: replace any agent-committed tests/ wholesale, never merge — so
          // agent-supplied files cannot survive into the graded verifier set.
          rmSync(path.join(gradeDir, 'tests'), { recursive: true, force: true })
          cpSync(path.join(taskDir, 'tests'), path.join(gradeDir, 'tests'), { recursive: true })
          let test
          if (cheat) {
            const cheatScript = path.join(taskDir, 'cheats', `${cheat}.sh`)
            test = spawnSync('sh', [cheatScript, artDir], { cwd: gradeDir, encoding: 'utf8', timeout: 120000 })
          } else {
            test = spawnSync('sh', ['tests/test.sh', artDir], { cwd: gradeDir, encoding: 'utf8', timeout: 120000 })
          }
          const testExitCode = test.error ? null : test.status
          results.testExit = testExitCode
          const durationMs = Date.now() - t0
          const budgetOk = !budgetAbort
          let verdict = 'VERIFIED_FAIL'
          try {
            const reward = checkReward(artDir, testExitCode)
            ctrf = checkCtrf(artDir)
            const verifierSha = hashTree(path.join(gradeDir, 'tests'))
            results.reward = reward.reward
            verdict = testExitCode === 0 ? 'VERIFIED_PASS' : 'VERIFIED_FAIL'
            append('verify.done', { verdict, testExitCode, reward: reward.reward, verifierSha, gradedSha, durationMs, budgetOk })
          } catch (e) {
            if (!(e instanceof VerifierError)) throw e
            append('verify.done', { verdict: 'VERIFIER_ERROR', reason: e.reason, detail: e.message, gradedSha, durationMs })
            verdict = 'VERIFIER_ERROR'
          }
          outcome = verdict
        } finally {
          rmSync(gradeDir, { recursive: true, force: true })
        }
        results.outcome = outcome
        append('outcome.classified', { outcome })
        return await finish({ droidVersion, configSnapshot, transcriptPath, patchDiff, ctrf, artifactsDir: artDir, usage: usage ? { ...usage, sessionId: sessionRec.id, observedModel: sessionRec.model, routeClass: sessionRec.routeClass } : null })
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
