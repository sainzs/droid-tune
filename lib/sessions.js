import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'

export const FAULT_IDS = {
  SESSIONS_DIR_MISSING: 'DT007',
  UNPARSEABLE_SESSION: 'DT003',
  MISSING_TRANSCRIPT: 'DT004',
  ORPHAN_TRANSCRIPT: 'DT005',
  NULL_USAGE: 'DT006'
}

const SETTINGS_SUFFIX = '.settings.json'
const JSONL_SUFFIX = '.jsonl'

async function listSessions (sessionsDir) {
  const sessions = []
  const faults = []
  let root
  try {
    root = await readdir(sessionsDir, { withFileTypes: true })
  } catch (err) {
    return {
      sessions,
      faults: [{
        id: FAULT_IDS.SESSIONS_DIR_MISSING,
        severity: 'fault',
        summary: `sessions directory not found: ${sessionsDir}`,
        evidence: { code: err.code ?? String(err.message).slice(0, 120) }
      }]
    }
  }
  for (const entry of root) {
    if (!entry.isDirectory()) continue
    const projectDir = entry.name
    let files
    try {
      files = await readdir(path.join(sessionsDir, projectDir), { withFileTypes: true })
    } catch {
      continue
    }
    const settingsBases = new Map()
    const jsonlBases = new Set()
    for (const f of files) {
      if (!f.isFile()) continue
      if (f.name.endsWith(SETTINGS_SUFFIX)) {
        settingsBases.set(f.name.slice(0, -SETTINGS_SUFFIX.length), f.name)
      } else if (f.name.endsWith(JSONL_SUFFIX)) {
        jsonlBases.add(f.name.slice(0, -JSONL_SUFFIX.length))
      }
    }
    for (const [base, settingsFile] of settingsBases) {
      const settingsPath = path.join(sessionsDir, projectDir, settingsFile)
      const hasJsonl = jsonlBases.has(base)
      if (!hasJsonl) {
        faults.push({
          id: FAULT_IDS.MISSING_TRANSCRIPT,
          severity: 'fault',
          summary: `session ${base} has settings but no transcript (.jsonl)`,
          evidence: { projectDir, session: base }
        })
      }
      const rec = {
        id: base,
        projectDir,
        settingsPath,
        jsonlPath: hasJsonl ? path.join(sessionsDir, projectDir, base + JSONL_SUFFIX) : null,
        settingsMtime: null
      }
      try {
        rec.settingsMtime = (await stat(settingsPath)).mtime.toISOString()
      } catch {}
      sessions.push(rec)
    }
    for (const base of jsonlBases) {
      if (settingsBases.has(base)) continue
      faults.push({
        id: FAULT_IDS.ORPHAN_TRANSCRIPT,
        severity: 'fault',
        summary: `transcript ${base}.jsonl has no settings file`,
        evidence: { projectDir, session: base }
      })
      sessions.push({
        id: base,
        projectDir,
        settingsPath: null,
        jsonlPath: path.join(sessionsDir, projectDir, base + JSONL_SUFFIX),
        settingsMtime: null
      })
    }
  }
  return { sessions, faults }
}

function summarizeEvents (text) {
  const summary = {
    sessionStart: null,
    messageCount: 0,
    userMessageCount: 0,
    assistantMessageCount: 0,
    firstTs: null,
    lastTs: null,
    badLines: 0
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let ev
    try {
      ev = JSON.parse(trimmed)
    } catch {
      summary.badLines += 1
      continue
    }
    if (ev.type === 'session_start') {
      summary.sessionStart = {
        version: ev.version ?? null,
        cwd: ev.cwd ?? null,
        title: ev.title ?? null
      }
    } else if (ev.type === 'message') {
      summary.messageCount += 1
      const role = ev.message?.role
      if (role === 'user') summary.userMessageCount += 1
      else if (role === 'assistant') summary.assistantMessageCount += 1
    }
    if (typeof ev.timestamp === 'string') {
      if (summary.firstTs === null || ev.timestamp < summary.firstTs) summary.firstTs = ev.timestamp
      if (summary.lastTs === null || ev.timestamp > summary.lastTs) summary.lastTs = ev.timestamp
    }
  }
  return summary
}

function derive (rec) {
  const s = rec.settings ?? {}
  const tu = s.tokenUsage && typeof s.tokenUsage === 'object' ? s.tokenUsage : null
  rec.model = s.model ?? null
  rec.reasoningEffort = s.reasoningEffort ?? null
  rec.autonomyLevel = s.autonomyLevel ?? null
  rec.tags = Array.isArray(s.tags) ? s.tags.map(t => t && typeof t === 'object' ? t.name : t).filter(Boolean) : []
  rec.providerLock = s.providerLock ?? null
  rec.tokenUsage = tu
  rec.droidVersion = rec.events?.sessionStart?.version ?? null
  rec.messageCount = rec.events?.messageCount ?? 0
  rec.firstTs = rec.events?.firstTs ?? null
  rec.lastTs = rec.events?.lastTs ?? null
  if (rec.settings) {
    rec.routeClass = typeof rec.model === 'string'
      ? (rec.model.startsWith('custom:') ? 'byok' : 'core')
      : 'unknown'
  } else {
    rec.routeClass = null
  }
  rec.cacheReadShare = tu && (tu.inputTokens + tu.cacheReadTokens) > 0
    ? tu.cacheReadTokens / (tu.inputTokens + tu.cacheReadTokens)
    : null
  rec.isProbeSession = rec.tags.some(t => typeof t === 'string' && t.startsWith('droidtune'))
  if (rec.settings && !tu && rec.messageCount > 0) {
    rec.faults.push({
      id: FAULT_IDS.NULL_USAGE,
      severity: 'fault',
      summary: `session ${rec.id} has ${rec.messageCount} message(s) but no tokenUsage`,
      evidence: { projectDir: rec.projectDir, session: rec.id, messageCount: rec.messageCount }
    })
  }
  return rec
}

async function readSession (rec) {
  const out = { ...rec, settings: null, events: null, faults: [] }
  if (rec.settingsPath) {
    let raw = null
    try {
      raw = await readFile(rec.settingsPath, 'utf8')
    } catch (err) {
      out.faults.push({
        id: FAULT_IDS.UNPARSEABLE_SESSION,
        severity: 'fault',
        summary: `unreadable session settings: ${rec.id}`,
        evidence: { path: rec.settingsPath, error: String(err.message).slice(0, 200) }
      })
    }
    if (raw !== null) {
      try {
        out.settings = JSON.parse(raw)
      } catch (err) {
        out.faults.push({
          id: FAULT_IDS.UNPARSEABLE_SESSION,
          severity: 'fault',
          summary: `unparseable session settings: ${rec.id}`,
          evidence: { path: rec.settingsPath, error: String(err.message).slice(0, 200) }
        })
      }
    }
  }
  if (rec.jsonlPath) {
    try {
      out.events = summarizeEvents(await readFile(rec.jsonlPath, 'utf8'))
    } catch (err) {
      out.events = { sessionStart: null, messageCount: 0, userMessageCount: 0, assistantMessageCount: 0, firstTs: null, lastTs: null, badLines: 0, error: String(err.message).slice(0, 200) }
    }
  }
  return derive(out)
}

function aggregateSessions (records) {
  const agg = {
    total: records.length,
    byRouteClass: { core: 0, byok: 0, unknown: 0 },
    execTagged: 0,
    probeTagged: 0,
    excludedProbe: 0,
    tokens: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      thinkingTokens: 0,
      factoryCredits: 0
    },
    weightedCacheReadShare: null,
    dateRange: { first: null, last: null }
  }
  for (const r of records) {
    if (r.isProbeSession) { agg.excludedProbe += 1; continue }
    if (r.routeClass && r.routeClass in agg.byRouteClass) agg.byRouteClass[r.routeClass] += 1
    if (r.tags.includes('exec')) agg.execTagged += 1
    agg.probeTagged += r.isProbeSession ? 1 : 0
    const tu = r.tokenUsage
    if (tu) {
      for (const k of Object.keys(agg.tokens)) {
        if (typeof tu[k] === 'number') agg.tokens[k] += tu[k]
      }
    }
    if (r.firstTs && (agg.dateRange.first === null || r.firstTs < agg.dateRange.first)) agg.dateRange.first = r.firstTs
    if (r.lastTs && (agg.dateRange.last === null || r.lastTs > agg.dateRange.last)) agg.dateRange.last = r.lastTs
  }
  const denom = agg.tokens.inputTokens + agg.tokens.cacheReadTokens
  if (denom > 0) agg.weightedCacheReadShare = agg.tokens.cacheReadTokens / denom
  return agg
}

export { listSessions, readSession, aggregateSessions, summarizeEvents }
