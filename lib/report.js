function fmtTokens (n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '-'
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k'
  return String(n)
}

function fmtPct (x) {
  return typeof x === 'number' && Number.isFinite(x) ? (100 * x).toFixed(1) + '%' : '-'
}

function day (ts) {
  return typeof ts === 'string' ? ts.slice(0, 10) : '-'
}

function renderDiagnose (result) {
  const { stamp, config, sessions, findings, probe } = result
  const L = []
  L.push('DROID TUNE-UP — DIAGNOSE' + (stamp.demo ? ' (fixture demo)' : ''))
  L.push(`provenance   droid ${stamp.droidVersion ?? 'not found'} · node ${stamp.node} · ${stamp.platform}/${stamp.arch} · ${stamp.utc}`)
  L.push(`droid path   ${stamp.droidPath ?? '-'}`)
  L.push('')

  L.push('CONFIG')
  if (!config.exists) {
    L.push(`  missing: ${config.path}`)
  } else if (!config.settings) {
    L.push(`  unparseable: ${config.path}`)
  } else {
    const s = config.settings
    const models = Array.isArray(s.customModels) ? s.customModels : []
    const def = s.sessionDefaultSettings ?? {}
    L.push(`  file            ${config.path}`)
    L.push(`  default model   ${def.model ?? '-'} (effort ${def.reasoningEffort ?? '-'})`)
    L.push(`  custom models   ${models.length}`)
    for (const m of models) {
      const key = m.apiKey && typeof m.apiKey === 'object'
        ? `redacted sha256:${m.apiKey.sha256} (${m.apiKey.length})`
        : (typeof m.apiKey === 'string' ? m.apiKey : '-')
      L.push(`    ${String(m.displayName ?? m.model ?? '?').padEnd(42)} ${String(m.provider ?? '?').padEnd(28)} ${key}`)
    }
  }
  L.push('')

  const a = sessions.aggregates
  L.push(`SESSIONS — ${sessions.total} total (${sessions.dir})`)
  L.push(`  route classes   core ${a.byRouteClass.core} · byok ${a.byRouteClass.byok} · unknown ${a.byRouteClass.unknown}`)
  L.push(`  exec-tagged     ${a.execTagged}` + (a.excludedProbe > 0 ? ` · probe-tagged excluded from aggregates: ${a.excludedProbe}` : ''))
  L.push(`  tokens (excl. probe)  in ${fmtTokens(a.tokens.inputTokens)} · out ${fmtTokens(a.tokens.outputTokens)} · cacheRead ${fmtTokens(a.tokens.cacheReadTokens)} · cacheWrite ${fmtTokens(a.tokens.cacheCreationTokens)} · think ${fmtTokens(a.tokens.thinkingTokens)}`)
  if (a.tokens.factoryCredits > 0) L.push(`  factory credits ${fmtTokens(a.tokens.factoryCredits)}`)
  L.push(`  cache read share (weighted)  ${fmtPct(a.weightedCacheReadShare)}`)
  if (a.dateRange.first) L.push(`  observed        ${a.dateRange.first} → ${a.dateRange.last}`)
  L.push('')

  if (sessions.table.length > 0) {
    L.push(`RECENT SESSIONS (newest ${sessions.table.length}, limit ${sessions.tableLimit})`)
    const hdr = ['  date', 'id', 'route', 'model', 'effort', 'msgs', 'cache share'].join(' ')
    L.push(hdr)
    for (const r of sessions.table) {
      const cols = [
        '  ' + day(r.lastTs ?? r.settingsMtime),
        r.id.slice(0, 8),
        (r.routeClass ?? '?').padEnd(5),
        (r.model ?? '-').slice(0, 26).padEnd(26),
        (r.reasoningEffort ?? '-').slice(0, 6).padEnd(6),
        String(r.messageCount).padStart(4),
        fmtPct(r.cacheReadShare).padStart(11)
      ]
      L.push(cols.join(' ') + (r.tags.some(t => t.startsWith('droidtune')) ? '  [probe]' : ''))
    }
    L.push('')
  }

  if (probe) {
    L.push(`PROBE — ${probe.ok ? 'PASS' : 'FAIL'} via ${probe.requestedId ?? '?'} in ${probe.durationMs ?? '?'}ms`)
    if (probe.sessionId) {
      L.push(`  session         ${probe.sessionId}`)
      L.push(`  observed model  ${probe.observedModel ?? '-'} · providerLock ${probe.providerLock ?? '-'} · route ${probe.routeClass ?? '-'}`)
      if (probe.tokenUsage) {
        const tu = probe.tokenUsage
        L.push(`  tokenUsage      in ${fmtTokens(tu.inputTokens)} · out ${fmtTokens(tu.outputTokens)} · cacheRead ${fmtTokens(tu.cacheReadTokens)} · cacheWrite ${fmtTokens(tu.cacheCreationTokens)}`)
      }
    }
    L.push('')
  }

  const faults = findings.filter(f => f.severity === 'fault')
  const hints = findings.filter(f => f.severity === 'hint')
  const infos = findings.filter(f => f.severity === 'info')
  L.push('FINDINGS')
  if (findings.length === 0) L.push('  none — clean bill of health')
  for (const f of faults) L.push(`  FAULT  ${f.summary} (${f.id})`)
  for (const h of hints) L.push(`  hint   ${h.summary} (${h.id})`)
  for (const i of infos) L.push(`  info   ${i.summary} (${i.id})`)
  L.push('')
  L.push(`verdict: ${faults.length} fault(s) · ${hints.length} hint(s)` + (probe ? ` · probe ${probe.ok ? 'PASS' : 'FAIL'}` : '') + (faults.length > 0 ? ' — fix faults before baselining' : ' — ready to baseline'))
  return L.join('\n')
}

export { renderDiagnose, fmtTokens, fmtPct }
