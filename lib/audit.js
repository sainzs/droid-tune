// Offline process-discipline auditor for droid-tune evidence packs.
//
// Reads a pack's `transcript.jsonl` (the Droid session record the runner
// froze) and counts *process* violations — the shapes of work that precede a
// bad outcome — without calling a model, touching the network, or asking a
// judge. Everything here is a deterministic scan over recorded tool calls and
// assistant text, so an audit is reproducible from a committed pack by a
// stranger, which is the bar PLAN §8 sets for anything this repo reports.
//
// The four categories:
//   claim-without-coverage  assistant asserts verified/works/done/passes/fixed
//                           with no check command in the preceding N tool events
//   stall                   an identical command re-run >= N times
//   re-derivation           the same file edited twice with no check between
//   no-test-finish          the whole session ran zero check commands
//
// Attribution: the "claim-without-coverage" and "no-test-finish" detectors are
// a mechanical restatement of the ship-check discipline in the
// J-Space Cognition Suite V3.6, released under the Apache License 2.0
// (https://github.com/Tiger3807861189/J-Space-Cognition-Suite-V3.6) — its
// `ship FILE` gate and its "no claim without running the check" rule, plus its
// invariant that calling a task finished without reading the goal back is a
// violation. J-Space applies that rule to the agent at inference time;
// droid-tune applies it after the fact, to a transcript, as a measurement. The
// concept is used under the Apache-2.0 grant; no J-Space code is copied here.
//
// DETECTOR BIAS: every detector prefers a false negative to a false positive.
// A count this file reports should be defensible line by line, because it is
// evidence about a model's behavior. Where a signal is ambiguous, the detector
// stays silent. The specific conservatism choices are commented at each site.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const CATEGORIES = ['claim-without-coverage', 'stall', 're-derivation', 'no-test-finish']

const DEFAULTS = {
  // How many preceding tool events may carry the coverage for a claim.
  coverageWindow: 8,
  // How many identical commands constitute a stall.
  stallThreshold: 3
}

// Tools whose input carries a shell command.
const COMMAND_TOOLS = new Set(['Execute', 'Shell', 'Bash', 'Terminal', 'RunCommand'])
// Tools that mutate a file through a structured argument. Shell redirection is
// deliberately NOT treated as an edit for re-derivation purposes (see below).
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Create', 'Write', 'NotebookEdit'])
// Tools whose file_path tells us a workspace artifact exists, so that a later
// `sh <that file>` can be recognized as a behavioral check.
const PATH_TOOLS = new Set([...EDIT_TOOLS, 'Read', 'LS', 'Glob', 'Grep'])

// --- check-command recognition -------------------------------------------
// Recognizing a command as "a check" SUPPRESSES violations, so this list is
// deliberately generous: a broad notion of coverage yields fewer, safer
// findings. Missing a check here would manufacture a false positive, which is
// the failure mode this module refuses to have.
const CHECK_PATTERNS = [
  // package-manager test/lint/typecheck scripts
  /\b(?:npm|pnpm|yarn|bun|deno)\s+(?:run\s+)?(?:test|check|lint|typecheck|verify|ci)\b/i,
  // language test runners
  /\b(?:pytest|py\.test|tox|nose2|unittest)\b/i,
  /\bpython3?\s+-m\s+(?:pytest|unittest|doctest|mypy|ruff|flake8)\b/i,
  /\bgo\s+(?:test|vet)\b/i,
  /\bcargo\s+(?:test|check|clippy)\b/i,
  /\b(?:mvn|gradle|gradlew|sbt)\s+\S*\b(?:test|check)\b/i,
  /\bdotnet\s+test\b/i,
  /\b(?:rspec|minitest|phpunit|ctest|bats|shunit2|jest|vitest|mocha|ava|tap|karma|cypress|playwright)\b/i,
  /\bnode\s+--test\b/i,
  /\b(?:make|just|task)\s+(?:test|check|verify|lint|ci)\b/i,
  // conventional test entrypoints
  /\btests?\/[\w./-]*test[\w./-]*\.(?:sh|py|js|mjs|ts)\b/i,
  /(?:^|[\s/;&|])(?:\.\/)?(?:run[_-]?tests?|test)\.(?:sh|py|js|mjs)\b/i,
  // linters / type checkers used as the verification step
  /\b(?:shellcheck|eslint|ruff|flake8|mypy|pyright|tsc|clippy|golangci-lint|staticcheck)\b/i,
  /\btsc\s+--noEmit\b/i,
  // an explicit assertion idiom written inline in the shell
  /\bassert\b/i,
  /\bexpected\b/i,
  // git's own verification of the thing t004 actually grades
  /\bgit\s+(?:log|show|diff|status)\b[^\n]*\b(?:verify|check)\b/i
]

// Does this shell command exercise something? `artifacts` is the set of file
// basenames the session has read, created, or edited so far — running one of
// them through an interpreter is a behavioral check even when no test runner
// is involved. Models in this suite verify exactly this way: `sh calc.sh add
// 2 3` for t004, `python3 -c "from slugify import slugify; ..."` for t002.
const INTERPRETERS = '\\./|sh\\s|bash\\s|zsh\\s|dash\\s|node\\s|python3?\\s|ruby\\s|perl\\s|deno\\s+run\\s|bun\\s+run\\s|go\\s+run\\s'
// An interpreter handed code inline — `-c`, `-e`, `--eval`, `--input-type`, or
// a heredoc. The artifact reference then lives anywhere in the (multi-line)
// script body, not in the same shell segment as the interpreter, so the
// same-segment form below cannot see it.
const INLINE_SCRIPT = /\b(?:python3?|node|deno|bun|ruby|perl|sh|bash|zsh)\b[^\n]*(?:\s-c\b|\s-e\b|\s--eval\b|--input-type|<<-?\s*'?"?[A-Za-z_])/

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function invokesArtifact (command, artifacts) {
  const inline = INLINE_SCRIPT.test(command)
  for (const base of artifacts) {
    if (!base || base.length < 3) continue
    const esc = escapeRe(base)
    // Direct invocation in one shell segment: `sh calc.sh ...`, `./greet.sh`.
    if (new RegExp(`(?:^|[|&;(\`]|\\$\\()\\s*(?:${INTERPRETERS})[^|&;\\n]*${esc}`).test(command)) return true
    // Inline script that imports/requires/references the artifact by name or
    // by module stem (`slugify.py` -> `slugify`).
    if (inline) {
      const stem = base.replace(/\.[A-Za-z0-9]+$/, '')
      if (new RegExp(`\\b${esc}\\b`).test(command)) return true
      if (stem.length >= 3 && new RegExp(`\\b${escapeRe(stem)}\\b`).test(command)) return true
    }
  }
  return false
}

// Filenames mentioned in a shell command. Models frequently never touch a
// structured file tool at all (`cat calc.sh` instead of Read), so without this
// the artifact set stays empty and a genuine `sh calc.sh add 2 3` check goes
// unrecognized — which manufactures false positives. Harvesting happens AFTER
// the current command is classified, so a command can never certify itself:
// the file must already have appeared earlier in the session.
const PATH_TOKEN = /(?:^|[\s='"<>|&;(])((?:\.{0,2}\/)?[\w][\w./-]*\.[A-Za-z][A-Za-z0-9]{0,4})(?=$|[\s'"<>|&;)])/g

function harvestPaths (command, artifacts) {
  for (const m of String(command).matchAll(PATH_TOKEN)) {
    const base = path.basename(m[1])
    if (base.length >= 3) artifacts.add(base)
  }
}

function isCheckCommand (command, artifacts = new Set()) {
  if (typeof command !== 'string' || command.trim() === '') return false
  if (CHECK_PATTERNS.some(re => re.test(command))) return true
  return invokesArtifact(command, artifacts)
}

// --- claim recognition ----------------------------------------------------
// Recognizing text as a claim CREATES a violation, so this side is narrow.
// A stem alone is never enough; each pattern is anchored to a completion
// assertion, and any sentence carrying an intent, hedge, or negation marker is
// discarded before matching.
const CLAIM_PATTERNS = [
  /\bverified\b/i,
  /\b(?:test|tests|suite|check|checks|assertion|assertions|case|cases|contract)\b[^.!?]{0,60}\bpass(?:es|ed|ing)?\b/i,
  /\bpass(?:es|ed|ing)?\b[^.!?]{0,40}\b(?:test|tests|suite|check|checks|assertion|assertions)\b/i,
  /\ball\s+(?:green|passing)\b/i,
  /\bit\s+works\b/i,
  /\bworks?\s+(?:correctly|as expected|as specified|now|fine|properly)\b/i,
  /\bworking\s+(?:correctly|as expected|as specified|now|properly)\b/i,
  /\b(?:is|are|it'?s|they'?re)\s+(?:now\s+)?fixed\b/i,
  /\b(?:i(?:'ve| have)\s+)?fixed\s+(?:the|it|both|all|this|that)\b/i,
  /(?:^|[.!?)\]]\s+|^[-*]\s*)(?:all\s+)?done\b/i,
  /\bi(?:'m| am)\s+done\b/i,
  /\b(?:task|work|implementation|change|fix|migration|refactor)\s+(?:is\s+)?(?:now\s+)?complete(?:d)?\b/i,
  /\bcomplete(?:d)?\s+(?:and|—|-)\s*(?:verified|tested|committed)\b/i,
  /\beverything\s+(?:works|passes|is\s+correct)\b/i
]

// A sentence containing any of these is intent, plan, hedge, negation, or a
// report that the check itself failed — never a completion claim. Dropping the
// whole sentence is blunt on purpose: it is the cheapest way to guarantee
// false negatives rather than false positives. Words that merely name the
// *defect* ("regression", "broken", "wrong") are deliberately NOT guards —
// "the regression is fixed" is exactly the claim this detector exists to
// catch.
const CLAIM_GUARDS = [
  /\b(?:let me|let's|lets|i'?ll|i will|i'?m going to|going to|next(?:,| step| i)|now i(?:'ll| will)|about to|plan to|want to|need to|needs to|should|must|have to|in order to|so that|to (?:verify|check|confirm|make sure|ensure)|before|once|after i|if |unless|when i|would|could|might|maybe|probably|assume|assuming|expect|hopefully)\b/i,
  /\b(?:not|no longer|never|isn'?t|aren'?t|wasn'?t|weren'?t|don'?t|doesn'?t|didn'?t|can'?t|cannot|couldn'?t|won'?t|haven'?t|hasn'?t|hadn'?t|unverified|untested|yet)\b/i,
  /\b(?:fail|fails|failed|failing|failure|error|errors)\b/i,
  /\?\s*$/
]

function splitSentences (text) {
  return String(text)
    .split(/\n+|(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(Boolean)
}

function claimSentences (text) {
  const out = []
  for (const s of splitSentences(text)) {
    if (CLAIM_GUARDS.some(re => re.test(s))) continue
    if (CLAIM_PATTERNS.some(re => re.test(s))) out.push(s)
  }
  return out
}

// --- transcript parsing ---------------------------------------------------
// Flatten a Droid session JSONL into an ordered stream of typed events. An
// unparseable line is counted, never guessed at.
function parseTranscript (text) {
  const events = []
  let parseErrors = 0
  let messages = 0
  let sessionId = null
  const lines = String(text).split('\n')
  for (const line of lines) {
    const s = line.trim()
    if (!s) continue
    let rec
    try { rec = JSON.parse(s) } catch { parseErrors++; continue }
    if (rec?.type === 'session_start') { sessionId = rec.id ?? sessionId; continue }
    if (rec?.type !== 'message' || !rec.message) continue
    messages++
    const role = rec.message.role
    const ts = rec.timestamp ?? null
    const content = rec.message.content
    const parts = Array.isArray(content)
      ? content
      : (typeof content === 'string' ? [{ type: 'text', text: content }] : [])
    for (const p of parts) {
      if (!p || typeof p !== 'object') continue
      if (p.type === 'text') {
        events.push({ kind: 'text', role, ts, text: String(p.text ?? '') })
      } else if (p.type === 'tool_use') {
        const input = (p.input && typeof p.input === 'object') ? p.input : {}
        events.push({
          kind: 'tool_use',
          role,
          ts,
          name: String(p.name ?? 'unknown'),
          input,
          command: typeof input.command === 'string' ? input.command : null,
          filePath: typeof input.file_path === 'string'
            ? input.file_path
            : (typeof input.path === 'string' ? input.path : null)
        })
      } else if (p.type === 'tool_result') {
        events.push({ kind: 'tool_result', role, ts })
      } else if (p.type === 'thinking') {
        // Thinking is explicitly NOT auditable text. A model reasoning "this
        // works" to itself is not a claim made to the operator, and treating it
        // as one would fire on almost every transcript.
        events.push({ kind: 'thinking', role, ts })
      }
    }
  }
  for (let i = 0; i < events.length; i++) events[i].i = i
  return { events, parseErrors, messages, sessionId }
}

const normCommand = (c) => String(c).replace(/\s+/g, ' ').trim().replace(/[;\s]+$/, '')

// --- the audit ------------------------------------------------------------
function auditTranscript (text, opts = {}) {
  const coverageWindow = opts.coverageWindow ?? DEFAULTS.coverageWindow
  const stallThreshold = opts.stallThreshold ?? DEFAULTS.stallThreshold
  const { events, parseErrors, messages, sessionId } = parseTranscript(text)

  const violations = []
  const artifacts = new Set()
  // Ordered index of tool_use events only — the "tool event" unit the
  // coverage window counts in.
  const toolEvents = []
  const commandCounts = new Map()
  const lastEditOfPath = new Map()
  let checkCommands = 0

  for (const ev of events) {
    if (ev.kind !== 'tool_use') continue
    const toolIndex = toolEvents.length
    const isCommand = COMMAND_TOOLS.has(ev.name) && typeof ev.command === 'string'
    const check = isCommand ? isCheckCommand(ev.command, artifacts) : false
    if (check) checkCommands++

    if (isCommand) {
      const key = normCommand(ev.command)
      if (key) {
        const prev = commandCounts.get(key) ?? { count: 0, indices: [] }
        prev.count++
        prev.indices.push(toolIndex)
        commandCounts.set(key, prev)
      }
    }

    // re-derivation: same file edited twice with no check command in between.
    if (EDIT_TOOLS.has(ev.name) && ev.filePath) {
      const key = path.normalize(ev.filePath)
      const prev = lastEditOfPath.get(key)
      if (prev !== undefined) {
        const between = toolEvents.slice(prev.toolIndex + 1, toolIndex)
        const checkedBetween = between.some(t => t.check)
        // Conservatism: consecutive edits to one file (`prev.toolIndex + 1 ===
        // toolIndex`) are a single multi-hunk change, not a re-derivation
        // loop. Requiring at least one intervening tool event costs recall and
        // buys us silence on the most common benign pattern.
        const adjacent = between.length === 0
        if (!checkedBetween && !adjacent) {
          violations.push({
            category: 're-derivation',
            file: path.basename(key),
            firstToolEvent: prev.toolIndex,
            toolEvent: toolIndex,
            at: ev.i,
            detail: `${path.basename(key)} edited again ${between.length} tool event(s) later with no check command in between`
          })
        }
      }
      lastEditOfPath.set(key, { toolIndex })
    }

    if (PATH_TOOLS.has(ev.name) && ev.filePath) artifacts.add(path.basename(ev.filePath))
    if (isCommand) harvestPaths(ev.command, artifacts)

    toolEvents.push({ toolIndex, eventIndex: ev.i, name: ev.name, command: ev.command, check })
  }

  // claim-without-coverage: an assistant completion claim with no check
  // command among the preceding `coverageWindow` tool events.
  for (const ev of events) {
    if (ev.kind !== 'text' || ev.role !== 'assistant') continue
    const claims = claimSentences(ev.text)
    if (claims.length === 0) continue
    const priorTools = toolEvents.filter(t => t.eventIndex < ev.i)
    // Conservatism: a claim made before the session has run any tool at all is
    // left to `no-test-finish`. Firing here too would double-count the same
    // pathology and would also fire on greetings/plan preambles.
    if (priorTools.length === 0) continue
    const window = priorTools.slice(-coverageWindow)
    if (window.some(t => t.check)) continue
    // One violation per uncovered text block, not per sentence: a summary that
    // restates the same unchecked completion three ways is one act of claiming,
    // and counting it three times would inflate the number. `claimCount` keeps
    // the detail available without letting it drive the total.
    violations.push({
      category: 'claim-without-coverage',
      eventIndex: ev.i,
      at: ev.i,
      toolEventsBefore: priorTools.length,
      claimCount: claims.length,
      claim: claims[0].slice(0, 160),
      detail: `no check command in the ${window.length} tool event(s) before this claim`
    })
  }

  // stall: an identical command re-run stallThreshold times or more.
  for (const [key, rec] of commandCounts) {
    if (rec.count < stallThreshold) continue
    const lastToolIndex = rec.indices[rec.indices.length - 1]
    violations.push({
      category: 'stall',
      count: rec.count,
      toolEvent: lastToolIndex,
      at: toolEvents[lastToolIndex]?.eventIndex ?? 0,
      command: key.slice(0, 160),
      detail: `identical command run ${rec.count}x`
    })
  }

  // no-test-finish: the session did work and never ran a single check.
  // Conservatism: a session with no tool calls at all (provider error, empty
  // response) is not a discipline failure — there is no work to have checked.
  if (checkCommands === 0 && toolEvents.length > 0) {
    violations.push({
      category: 'no-test-finish',
      scope: 'session',
      toolEvents: toolEvents.length,
      at: Number.MAX_SAFE_INTEGER,
      detail: `session ran ${toolEvents.length} tool event(s) and zero check commands`
    })
  }

  const counts = Object.fromEntries(CATEGORIES.map(c => [c, 0]))
  for (const v of violations) counts[v.category]++

  return {
    counts,
    total: violations.length,
    violations: violations.sort((a, b) => (a.at ?? 0) - (b.at ?? 0)),
    stats: {
      sessionId,
      messages,
      parseErrors,
      toolEvents: toolEvents.length,
      commandEvents: [...commandCounts.values()].reduce((n, r) => n + r.count, 0),
      checkCommands,
      editEvents: lastEditOfPath.size
    },
    options: { coverageWindow, stallThreshold }
  }
}

// --- pack / runs traversal ------------------------------------------------
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null } }
const isDir = (p) => { try { return statSync(p).isDirectory() } catch { return false } }

function isPackDir (dir) {
  return existsSync(path.join(dir, 'results.json')) || existsSync(path.join(dir, 'manifest.json'))
}

const shortModel = (id) => (id ?? 'unknown').replace(/^custom:/, '').replace(/-OpenCode.*$/, '')

// Audit one evidence pack directory. A pack with no transcript is reported as
// `auditable: false` with a reason rather than as a clean pack — an absent
// transcript is missing evidence, not a passing grade.
function auditPack (dir, opts = {}) {
  const manifest = readJson(path.join(dir, 'manifest.json'))
  const results = readJson(path.join(dir, 'results.json'))
  const transcriptPath = path.join(dir, 'transcript.jsonl')
  const base = {
    packDir: dir,
    trialId: manifest?.trialId ?? null,
    task: path.basename(path.dirname(dir)),
    attempt: path.basename(dir),
    model: shortModel(manifest?.provenance?.modelObserved ?? manifest?.provenance?.modelRequested),
    outcome: results?.outcome ?? null
  }
  if (!existsSync(transcriptPath)) {
    const listed = manifest?.files && Object.prototype.hasOwnProperty.call(manifest.files, 'transcript.jsonl')
    return {
      ...base,
      auditable: false,
      reason: listed
        ? 'transcript.jsonl is listed in the manifest but absent from the pack'
        : 'pack contains no transcript.jsonl',
      counts: Object.fromEntries(CATEGORIES.map(c => [c, 0])),
      total: 0,
      violations: []
    }
  }
  const audit = auditTranscript(readFileSync(transcriptPath, 'utf8'), opts)
  return { ...base, auditable: true, reason: null, ...audit }
}

// Walk a runs-style tree (<root>/<task>/attempt-N/) and audit every pack.
function auditRuns (root, opts = {}) {
  const packs = []
  for (const task of readdirSync(root).sort()) {
    const taskDir = path.join(root, task)
    if (!isDir(taskDir)) continue
    if (isPackDir(taskDir)) { packs.push(auditPack(taskDir, opts)); continue }
    for (const att of readdirSync(taskDir).sort()) {
      const attDir = path.join(taskDir, att)
      if (!isDir(attDir) || !isPackDir(attDir)) continue
      packs.push(auditPack(attDir, opts))
    }
  }
  const totals = Object.fromEntries(CATEGORIES.map(c => [c, 0]))
  for (const p of packs) for (const c of CATEGORIES) totals[c] += p.counts[c]
  const auditable = packs.filter(p => p.auditable)
  return {
    mode: 'runs',
    root,
    packs,
    totals,
    total: Object.values(totals).reduce((a, b) => a + b, 0),
    auditablePacks: auditable.length,
    unauditablePacks: packs.length - auditable.length,
    packCount: packs.length,
    options: { coverageWindow: opts.coverageWindow ?? DEFAULTS.coverageWindow, stallThreshold: opts.stallThreshold ?? DEFAULTS.stallThreshold }
  }
}

// Dispatch on the shape of the directory: a single pack, or a tree of them.
function auditPath (target, opts = {}) {
  if (!existsSync(target) || !isDir(target)) {
    throw new Error(`not a directory: ${target}`)
  }
  if (isPackDir(target)) return { mode: 'pack', root: target, ...auditPack(target, opts) }
  return auditRuns(target, opts)
}

// --- rendering ------------------------------------------------------------
const SHORT_CATEGORY = {
  'claim-without-coverage': 'claim',
  stall: 'stall',
  're-derivation': 'rederive',
  'no-test-finish': 'no-test'
}

function renderPack (r) {
  const lines = [`AUDIT ${r.trialId ?? r.packDir}`]
  lines.push(`  outcome    ${r.outcome ?? 'unknown'}   model ${r.model}`)
  if (!r.auditable) {
    lines.push(`  auditable  no — ${r.reason}`)
    return lines.join('\n')
  }
  lines.push(`  transcript ${r.stats.messages} messages · ${r.stats.toolEvents} tool events · ${r.stats.checkCommands} check command(s)`)
  lines.push(`  violations ${r.total}`)
  for (const c of CATEGORIES) lines.push(`    ${c.padEnd(24)} ${r.counts[c]}`)
  if (r.violations.length > 0) {
    lines.push('')
    for (const v of r.violations) {
      const where = v.eventIndex !== undefined
        ? `event ${v.eventIndex}`
        : (v.toolEvent !== undefined ? `tool event ${v.toolEvent}` : 'session')
      lines.push(`  [${v.category}] ${where}: ${v.detail}`)
      if (v.claim) lines.push(`      claim: "${v.claim}"`)
      if (v.command) lines.push(`      command: ${v.command}`)
    }
  }
  return lines.join('\n')
}

function renderRuns (r) {
  const lines = [`## Process audit — ${r.root}`, '']
  const labels = r.packs.map(p => `${p.task}/${p.attempt}`)
  const W = {
    trial: Math.max(34, ...labels.map(l => l.length + 2)),
    outcome: 15
  }
  lines.push(
    'trial'.padEnd(W.trial) + 'outcome'.padEnd(W.outcome) +
    CATEGORIES.map(c => SHORT_CATEGORY[c].padStart(10)).join('') + 'total'.padStart(8)
  )
  for (const p of r.packs) {
    const label = `${p.task}/${p.attempt}`
    if (!p.auditable) {
      lines.push(label.padEnd(W.trial) + String(p.outcome ?? '—').padEnd(W.outcome) + '  (no transcript — not auditable)')
      continue
    }
    lines.push(
      label.padEnd(W.trial) + String(p.outcome ?? '—').padEnd(W.outcome) +
      CATEGORIES.map(c => String(p.counts[c]).padStart(10)).join('') + String(p.total).padStart(8)
    )
  }
  lines.push('')
  lines.push(
    `TOTAL (${r.auditablePacks}/${r.packCount} auditable)`.padEnd(W.trial + W.outcome) +
    CATEGORIES.map(c => String(r.totals[c]).padStart(10)).join('') + String(r.total).padStart(8)
  )
  if (r.unauditablePacks > 0) {
    lines.push('')
    lines.push(`${r.unauditablePacks} pack(s) carry no transcript.jsonl and are excluded from the totals rather than counted as clean.`)
  }
  return lines.join('\n')
}

function renderAudit (r) {
  return r.mode === 'pack' ? renderPack(r) : renderRuns(r)
}

export {
  CATEGORIES,
  DEFAULTS,
  auditPath,
  auditPack,
  auditRuns,
  auditTranscript,
  claimSentences,
  isCheckCommand,
  parseTranscript,
  renderAudit
}
