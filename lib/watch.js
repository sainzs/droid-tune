// Live process-discipline watch: run lib/audit.js's detectors against a
// transcript while it is still being written, and surface each finding once,
// as it appears.
//
// The audit command answers "what did that session do" after the fact. This
// answers it during, which is the only moment the answer can still change
// anything — a stall is worth seeing on its third identical command, not in a
// post-mortem.
//
// Two things make a live watch different from a post-hoc audit, and both are
// enforced here rather than left to the caller:
//
// 1. `no-test-finish` is a TERMINAL condition. Mid-session, "has run no check
//    yet" is the normal state of every session that has not got there yet;
//    reporting it while the agent is still working would cry wolf on every
//    run. It is withheld until the watch ends, and reported by finalize().
//
// 2. Findings must be reported exactly once. Re-auditing the whole transcript
//    on every poll is the simplest correct way to read a growing file, but it
//    re-derives every earlier finding too, so each is keyed by something
//    stable under append and suppressed if already seen. A stall keys on the
//    command, not its count — otherwise the fourth identical run would report
//    the same stall a second time.
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { auditTranscript } from './audit.js'
import { listSessions } from './sessions.js'

// Categories that only make sense once the session is over.
const TERMINAL_CATEGORIES = new Set(['no-test-finish'])

// Stable under append. `at` is an index into the flattened event stream, which
// never shifts for events already written; stall is keyed on its command alone
// because its count keeps growing.
function violationKey (v) {
  switch (v.category) {
    case 'stall': return `stall|${v.command}`
    case 're-derivation': return `re-derivation|${v.file}|${v.firstToolEvent}|${v.toolEvent}`
    case 'no-test-finish': return 'no-test-finish'
    default: return `${v.category}|${v.at}|${String(v.detail).slice(0, 80)}`
  }
}

function createWatcher (opts = {}) {
  const seen = new Set()
  let last = null

  // Feed the full transcript text seen so far. Returns only findings not
  // reported before, with terminal categories held back.
  function ingest (text) {
    const result = auditTranscript(text, opts)
    last = result
    const fresh = []
    for (const v of result.violations) {
      if (TERMINAL_CATEGORIES.has(v.category)) continue
      const key = violationKey(v)
      if (seen.has(key)) continue
      seen.add(key)
      fresh.push(v)
    }
    return { fresh, result }
  }

  // Call when the session is over: releases the terminal findings that were
  // withheld during streaming, and returns the final audit.
  function finalize () {
    if (last === null) return { fresh: [], result: null }
    const fresh = []
    for (const v of last.violations) {
      if (!TERMINAL_CATEGORIES.has(v.category)) continue
      const key = violationKey(v)
      if (seen.has(key)) continue
      seen.add(key)
      fresh.push(v)
    }
    return { fresh, result: last }
  }

  return { ingest, finalize, seen, get last () { return last } }
}

// The most recently written transcript under a sessions dir.
//
// Best effort, and deliberately tolerant: a session that droid is still
// writing has a .jsonl but often no .settings.json yet, so lib/sessions.js
// surfaces it as an "orphan transcript" (DT005). That fault is a real problem
// for `diagnose`, which is auditing finished sessions; here it is the normal
// shape of the thing we are looking for, so it is ignored rather than
// reported.
async function newestTranscript (sessionsDir) {
  const { sessions } = await listSessions(sessionsDir)
  let best = null
  for (const s of sessions) {
    if (!s.jsonlPath || !existsSync(s.jsonlPath)) continue
    let mtime
    try { mtime = statSync(s.jsonlPath).mtimeMs } catch { continue }
    if (best === null || mtime > best.mtimeMs) best = { path: s.jsonlPath, id: s.id, mtimeMs: mtime }
  }
  return best
}

// Poll a growing transcript. Returns a controller with stop(); the caller
// decides when the session is over, because nothing in the transcript format
// marks the end reliably.
//
// Polling rather than fs.watch on purpose: fs.watch's semantics differ across
// platforms and it misses writes on some network and container filesystems.
// A transcript is tens of kilobytes, so re-reading it is cheap and correct.
function watchFile (filePath, {
  intervalMs = 700,
  onFindings = () => {},
  onIdle = () => {},
  ...auditOpts
} = {}) {
  const watcher = createWatcher(auditOpts)
  let lastSize = -1
  let stopped = false
  let timer = null

  const poll = () => {
    if (stopped) return
    let size
    try { size = statSync(filePath).size } catch { return }
    if (size === lastSize) { onIdle(); return }
    lastSize = size
    let text
    try { text = readFileSync(filePath, 'utf8') } catch { return }
    const { fresh, result } = watcher.ingest(text)
    if (fresh.length > 0) onFindings(fresh, result)
  }

  // One immediate pass so an already-populated file reports at once rather
  // than after a full interval.
  poll()
  timer = setInterval(poll, intervalMs)
  // Do not hold the event loop open on our account; the CLI keeps itself alive.
  if (typeof timer.unref === 'function') timer.unref()

  return {
    watcher,
    poll,
    stop () {
      stopped = true
      if (timer) clearInterval(timer)
      return watcher.finalize()
    }
  }
}

// --- rendering ------------------------------------------------------------
function renderFinding (v) {
  const where = v.eventIndex !== undefined
    ? `event ${v.eventIndex}`
    : (v.toolEvent !== undefined ? `tool event ${v.toolEvent}` : 'session')
  const lines = [`  [${v.category}] ${where}: ${v.detail}`]
  if (v.claim) lines.push(`      claim: "${v.claim}"`)
  if (v.command) lines.push(`      command: ${v.command}`)
  return lines.join('\n')
}

function renderWatchSummary (result, { filePath } = {}) {
  if (!result) return `no transcript content was read from ${filePath ?? 'the target'}`
  const counts = Object.entries(result.counts).filter(([, n]) => n > 0)
  const head = `watched ${path.basename(filePath ?? '')} — ${result.stats.messages} messages · ` +
    `${result.stats.toolEvents} tool events · ${result.stats.checkCommands} check command(s)`
  const tail = counts.length === 0
    ? '  no violations'
    : counts.map(([c, n]) => `  ${c.padEnd(24)} ${n}`).join('\n')
  return `${head}\n${tail}`
}

export {
  TERMINAL_CATEGORIES,
  createWatcher,
  newestTranscript,
  renderFinding,
  renderWatchSummary,
  violationKey,
  watchFile
}
