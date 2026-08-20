import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { listSessions, readSession, aggregateSessions } from './sessions.js'
import { resolveDroid } from './droid-path.js'
import { referencedCredentialVars, autoloadCredentials } from './credentials.js'

const ENV_REF = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/
const SECRET_KEY_RE = /api?key|secret|token|password/i
const PROBE_TAG = 'droidtune-probe'

export const FAULT_IDS = {
  DROID_MISSING: 'DT001',
  PLAINTEXT_KEY: 'DT002',
  CONFIG_MISSING: 'DT008',
  CONFIG_UNPARSEABLE: 'DT009',
  CREDENTIAL_MISSING: 'DT010',
  PROBE_FAIL: 'DT-P001',
  PROBE_CACHE_FIELDS: 'DT-P002',
  PROBE_NO_ROUTE: 'DT-P003'
}

export const HINT_IDS = {
  CODING_ENDPOINT: 'DT101',
  NEWER_GLM: 'DT102',
  THINKING_TAX: 'DT103',
  CORE_CREDIT_SLOTS: 'DT104'
}

export function repoRoot () {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
}

function redactConfig (cfg) {
  const clone = structuredClone(cfg)
  const walk = (node) => {
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (typeof v === 'string' && SECRET_KEY_RE.test(k) && !ENV_REF.test(v)) {
          node[k] = {
            redacted: true,
            sha256: crypto.createHash('sha256').update(v).digest('hex').slice(0, 12),
            length: v.length
          }
        } else {
          walk(v)
        }
      }
    }
  }
  walk(clone)
  return clone
}

function creditModelSlots (cfg) {
  const slots = []
  const push = (slot, model) => {
    if (!model || typeof model !== 'string') return
    if (model.startsWith('custom:') || ENV_REF.test(model)) return
    slots.push({ slot, model })
  }
  push('compactionModel', cfg.compactionModel)
  push('missionOrchestratorModel', cfg.missionOrchestratorModel)
  for (const group of ['subagentModelSettings', 'missionModelSettings']) {
    const block = cfg[group]
    if (block && typeof block === 'object') {
      for (const [k, v] of Object.entries(block)) {
        if (k.endsWith('Model')) push(`${group}.${k}`, v)
      }
    }
  }
  return slots
}

async function configFindings (cfg, add) {
  const models = Array.isArray(cfg?.customModels) ? cfg.customModels : []
  for (const m of models) {
    if (typeof m.apiKey === 'string' && !ENV_REF.test(m.apiKey)) {
      add(FAULT_IDS.PLAINTEXT_KEY, 'fault',
        `customModels entry "${m.displayName ?? m.model ?? '?'}" stores its API key as plain text. Replace it with a \${ENV_VAR} reference and set that variable in your environment instead.`,
        { model: m.model ?? null, id: m.id ?? null, index: m.index ?? null, keyLength: m.apiKey.length })
    }
  }
  const coding = models.filter(m => typeof m.baseUrl === 'string' && m.baseUrl.includes('/api/coding/'))
  if (coding.length > 0) {
    add(HINT_IDS.CODING_ENDPOINT, 'hint',
      `custom model(s) on a /api/coding/ endpoint: ${coding.map(m => m.displayName ?? m.model).join(', ')} — community reports more tool-call failures on coding endpoints than anthropic-compatible ones (docs/research-2026-08.md §4)`,
      { entries: coding.map(m => m.model) })
  }
  const glmOld = models.some(m => /^glm-[45]\.\d+$/.test(m.model ?? ''))
  const glm53 = models.some(m => (m.model ?? '') === 'glm-5.3')
  if (glmOld && !glm53) {
    add(HINT_IDS.NEWER_GLM, 'hint',
      'GLM-5.1/4.7 pinned but GLM-5.3 rolled out to the Z.AI Coding Plan on 2026-08-14 (docs/research-2026-08.md §4)',
      { current: models.filter(m => /^glm-/.test(m.model ?? '')).map(m => m.model) })
  }
  if (cfg?.sessionDefaultSettings?.reasoningEffort === 'high') {
    add(HINT_IDS.THINKING_TAX, 'hint',
      'sessionDefaultSettings.reasoningEffort is "high" — thinking is default-on for many models; 30–300 reasoning tokens can burn on trivial prompts (docs/research-2026-08.md §5, C1)',
      { slot: 'sessionDefaultSettings.reasoningEffort', value: 'high' })
  }
  const slots = creditModelSlots(cfg ?? {})
  if (slots.length > 0) {
    add(HINT_IDS.CORE_CREDIT_SLOTS, 'hint',
      `${slots.length} model slot(s) route via Droid Core (Factory credits) — BYOK equivalents may exist on your plans`,
      { slots })
  }
}

async function runProbe ({ droid, modelArg, configPath, sessionsDir, timeoutMs = 120000, add }) {
  let cfg = null
  try {
    cfg = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch {}
  const models = Array.isArray(cfg?.customModels) ? cfg.customModels : []
  let chosen = null
  if (typeof modelArg === 'string' && modelArg !== '') {
    chosen = models.find(m => m.id === modelArg || m.model === modelArg) ??
      models.find(m => [m.id, m.model, m.displayName].some(v => typeof v === 'string' && v.includes(modelArg)))
    if (!chosen) chosen = { id: modelArg, model: modelArg, passthrough: true }
  } else {
    chosen = models.find(m => m.provider === 'anthropic' && /z\.ai/.test(m.baseUrl ?? '')) ?? models[0] ?? null
  }
  if (!chosen) {
    add(FAULT_IDS.PROBE_NO_ROUTE, 'fault', '--probe was requested but settings.json has no customModels to route through. Add a custom model entry (or pass a model with --probe <id>) before probing.', { configPath })
    return { ok: false }
  }
  const modelId = chosen.id ?? chosen.model
  const before = new Set((await listSessions(sessionsDir)).sessions.map(s => s.settingsPath ?? s.jsonlPath))
  const tmp = mkdtempSync(path.join(os.homedir(), `.${PROBE_TAG}-`))
  const startedAt = Date.now()
  let res
  try {
    res = spawnSync(droid.path, [
      'exec', '-m', modelId,
      '--cwd', tmp,
      '--tag', PROBE_TAG,
      '-o', 'json',
      'Reply with exactly: OK'
    ], { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 })
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }) } catch {}
  }
  const durationMs = Date.now() - startedAt
  const evidence = {
    requestedId: modelId,
    exitStatus: res.error ? null : res.status,
    signal: res.signal ?? null,
    spawnError: res.error ? String(res.error.message).slice(0, 200) : null,
    stdoutTail: (res.stdout ?? '').slice(-800),
    stderrTail: (res.stderr ?? '').slice(-800),
    durationMs
  }
  const probe = { ok: false, ...evidence }
  if (res.error || res.status !== 0) {
    add(FAULT_IDS.PROBE_FAIL, 'fault',
      `The probe run through ${modelId} did not complete${res.error ? ` (spawn error: ${res.error.code ?? res.error.message})` : ` (droid exited ${res.status}${res.signal ? `, signal ${res.signal}` : ''})`}. Check that model id and its credentials are correct, then retry.`,
      evidence)
    return probe
  }
  const after = await listSessions(sessionsDir)
  const newPaths = after.sessions.filter(s => !before.has(s.settingsPath ?? s.jsonlPath))
  const newRecords = await Promise.all(newPaths.map(readSession))
  const probeSession = newRecords.find(r => r.isProbeSession) ?? newRecords[0] ?? null
  if (!probeSession) {
    add(FAULT_IDS.PROBE_FAIL, 'fault', `The probe ran but no new session showed up under ${sessionsDir}, so its result can't be verified. Confirm droid is writing sessions to that directory and retry.`, evidence)
    return probe
  }
  const tu = probeSession.tokenUsage
  const hasCacheFields = !!tu &&
    Object.prototype.hasOwnProperty.call(tu, 'cacheReadTokens') &&
    Object.prototype.hasOwnProperty.call(tu, 'cacheCreationTokens')
  probe.sessionId = probeSession.id
  probe.observedModel = probeSession.model
  probe.providerLock = probeSession.providerLock
  probe.routeClass = probeSession.routeClass
  probe.tokenUsage = tu
  probe.hasCacheFields = hasCacheFields
  if (!hasCacheFields) {
    add(FAULT_IDS.PROBE_CACHE_FIELDS, 'fault',
      `Probe session ${probeSession.id} is missing the disjoint cache fields (cacheReadTokens/cacheCreationTokens), so token accounting can't be trusted. This usually means an older droid build — update droid and re-run the probe.`,
      { ...evidence, tokenUsage: tu ?? null })
    return probe
  }
  add('DT-I001', 'info',
    `probe passed via ${modelId} — session ${probeSession.id.slice(0, 8)} model=${probeSession.model} providerLock=${probeSession.providerLock} route=${probeSession.routeClass}`,
    { requestedId: modelId, observedModel: probeSession.model, providerLock: probeSession.providerLock, routeClass: probeSession.routeClass, tokenUsage: tu, durationMs })
  probe.ok = true
  return probe
}

async function runDiagnose (opts = {}) {
  const demo = !!opts.demo
  const root = repoRoot()
  const defaults = {
    configPath: path.join(os.homedir(), '.factory', 'settings.json'),
    sessionsDir: path.join(os.homedir(), '.factory', 'sessions'),
    droidPath: null
  }
  const paths = demo
    ? {
        configPath: path.join(root, 'fixtures', 'settings', 'demo-settings.json'),
        sessionsDir: path.join(root, 'fixtures', 'sessions'),
        droidPath: path.join(root, 'fixtures', 'bin', 'fake-droid')
      }
    : defaults
  const configPath = opts.configPath ?? paths.configPath
  const sessionsDir = opts.sessionsDir ?? paths.sessionsDir
  const findings = []
  const add = (id, severity, summary, evidence = {}) => findings.push({ id, severity, summary, evidence })

  const stamp = {
    droidPath: opts.droidPath ?? paths.droidPath ?? null,
    droidVersion: null,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    utc: new Date().toISOString(),
    demo
  }
  const droid = resolveDroid(opts.droidPath ?? paths.droidPath)
  if (!droid) {
    add(FAULT_IDS.DROID_MISSING, 'fault',
      `droidtune couldn't find a working droid CLI (tried: ${stamp.droidPath ?? 'DROID_PATH, ~/.local/bin/droid, PATH'}). Install droid or point at it with --droid-path <path> or DROID_PATH.`,
      { droidPath: stamp.droidPath })
  } else {
    stamp.droidPath = droid.path
    stamp.droidVersion = droid.version
  }

  let configRaw = null
  let cfg = null
  const snapshot = { path: configPath, exists: existsSync(configPath), settings: null }
  if (!snapshot.exists) {
    add(FAULT_IDS.CONFIG_MISSING, 'fault', `Droid's config file isn't where droidtune looked (${configPath}). Create it or pass --config <file>.`, { configPath })
  } else {
    try {
      configRaw = readFileSync(configPath, 'utf8')
      cfg = JSON.parse(configRaw)
      snapshot.settings = redactConfig(cfg)
    } catch (err) {
      add(FAULT_IDS.CONFIG_UNPARSEABLE, 'fault',
        `Droid's config file (${configPath}) isn't valid JSON, so droidtune can't read it. Fix the syntax error or restore a known-good copy.`,
        { configPath, error: String(err.message).slice(0, 200) })
    }
  }
  if (cfg) await configFindings(cfg, add)

  // Credential preflight: lib/runner.js's runTrial fails fast (before any
  // droid spawn) when the active config references a ${VAR} credential that
  // isn't present in the environment and can't be sourced from
  // ~/.factory/env.sh. Previously `diagnose` never checked this, so it could
  // report a clean bill of health while a trial was guaranteed to fail on
  // exactly this gap. Reuses the same lib/credentials.js helpers runner.js
  // uses — no duplicated logic — and never reads/prints/logs a credential
  // VALUE, only the ${VAR} NAMEs the config references. Skipped under
  // --demo: the bundled fixtures model config/session shape, not a live
  // credential environment (matches --probe's demo exclusion above).
  if (cfg && !demo) {
    const required = referencedCredentialVars(configPath)
    if (required.length > 0) {
      const envShPath = opts.envShPath ?? path.join(os.homedir(), '.factory', 'env.sh')
      const activeEnv = autoloadCredentials(opts.env ?? process.env, required, envShPath)
      const stillMissing = required.filter(v => activeEnv[v] === undefined || activeEnv[v] === '')
      if (stillMissing.length > 0) {
        add(FAULT_IDS.CREDENTIAL_MISSING, 'fault',
          `settings.json's customModels reference ${stillMissing.join(', ')}, which ${stillMissing.length > 1 ? 'are' : 'is'} not set in your environment — a trial will fail with a confusing provider error on this same gap. Set ${stillMissing.length > 1 ? 'them' : 'it'} however you manage secrets (e.g. source ~/.factory/env.sh) and re-run.`,
          { missing: stillMissing, envShChecked: envShPath })
      }
    }
  }

  const listed = await listSessions(sessionsDir)
  for (const f of listed.faults) add(f.id, f.severity, f.summary, f.evidence)
  const records = []
  for (const rec of listed.sessions) {
    const full = await readSession(rec)
    for (const f of full.faults) add(f.id, f.severity, f.summary, f.evidence)
    records.push(full)
  }
  records.sort((a, b) => (b.settingsMtime ?? b.lastTs ?? '').localeCompare(a.settingsMtime ?? a.lastTs ?? ''))
  const aggregates = aggregateSessions(records)

  let probe = null
  if (opts.probe !== undefined && opts.probe !== null) {
    if (demo) {
      add(FAULT_IDS.PROBE_FAIL, 'fault', '--probe cannot run together with --demo, since the bundled fixtures have no live droid to call. Drop --demo and run --probe against a real config.', {})
    } else if (!droid) {
      add(FAULT_IDS.PROBE_FAIL, 'fault', '--probe needs a working droid CLI to spawn, and none was found. Install droid or point at it with --droid-path <path> or DROID_PATH.', {})
    } else {
      probe = await runProbe({
        droid,
        modelArg: typeof opts.probe === 'string' ? opts.probe : '',
        configPath,
        sessionsDir,
        add
      })
    }
  }

  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 20
  const table = records.slice(0, limit).map(r => ({
    id: r.id,
    projectDir: r.projectDir,
    model: r.model,
    reasoningEffort: r.reasoningEffort,
    routeClass: r.routeClass,
    tags: r.tags,
    messageCount: r.messageCount,
    droidVersion: r.droidVersion,
    tokenUsage: r.tokenUsage,
    cacheReadShare: r.cacheReadShare,
    firstTs: r.firstTs,
    lastTs: r.lastTs,
    settingsMtime: r.settingsMtime
  }))

  return {
    stamp,
    config: snapshot,
    sessions: { dir: sessionsDir, total: records.length, aggregates, tableLimit: limit, table },
    findings,
    probe
  }
}

export { runDiagnose, runProbe, redactConfig }
