// shields.io endpoint badges, generated from evidence rather than asserted.
//
// A README badge is the most-read number in a repository and the least-checked
// one. These are computed from the same committed artifacts the reporting
// tools read — evidence packs under a runs dir, or the free-route observation
// series — so a badge cannot say something the repo cannot back up.
//
// Schema: https://shields.io/badges/endpoint-badge
//   { schemaVersion: 1, label, message, color }
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { findPacks, isPackDir } from './paths.js'

// Same exclusion results-table.js applies: a trial that never reached the
// model is not a model result and must not be laundered into a quality signal
// by sitting in a pass-rate denominator.
const NON_MODEL = new Set(['PROVIDER_ERROR', 'DROID_ERROR', 'VERIFIER_ERROR'])

// Shields' named colors, coarsest to finest. A badge with no data is grey and
// says so — never green by default.
function colorForRatio (ratio) {
  if (ratio === null || Number.isNaN(ratio)) return 'lightgrey'
  if (ratio >= 0.9) return 'brightgreen'
  if (ratio >= 0.75) return 'green'
  if (ratio >= 0.6) return 'yellowgreen'
  if (ratio >= 0.4) return 'yellow'
  if (ratio >= 0.2) return 'orange'
  return 'red'
}

const isDir = (p) => { try { return statSync(p).isDirectory() } catch { return false } }
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null } }

// Outcomes only. scripts/results-table.js owns the rich reader (model labels,
// provider-error subclassification); a badge needs one number and duplicating
// the whole thing here would give two places to disagree.
function readOutcomes (runsDir) {
  const outcomes = []
  if (!isDir(runsDir)) return outcomes
  // Depth-agnostic (lib/paths.js): counts packs in a routed tree and in a
  // pre-route one alike, so a badge never silently reports on a subset.
  if (isPackDir(runsDir)) {
    const results = readJson(path.join(runsDir, 'results.json'))
    if (results) outcomes.push(results.outcome ?? 'ERROR')
    return outcomes
  }
  for (const dir of findPacks(runsDir)) {
    const results = readJson(path.join(dir, 'results.json'))
    if (results) outcomes.push(results.outcome ?? 'ERROR')
  }
  return outcomes
}

function badgeFromRuns (runsDir, { label = 'verified pass' } = {}) {
  const outcomes = readOutcomes(runsDir)
  const scored = outcomes.filter(o => !NON_MODEL.has(o))
  const pass = scored.filter(o => o === 'VERIFIED_PASS').length
  if (scored.length === 0) {
    return { schemaVersion: 1, label, message: 'no data', color: 'lightgrey' }
  }
  const ratio = pass / scored.length
  return {
    schemaVersion: 1,
    label,
    message: `${pass}/${scored.length} (${Math.round(100 * ratio)}%)`,
    color: colorForRatio(ratio)
  }
}

// Takes a summary from lib/weather.js summarize(), not a directory, so the
// badge and the rendered table can never disagree about what "up" means.
function badgeFromWeather (summary, { label = 'free routes' } = {}) {
  if (!summary || summary.asOf === null || summary.total === 0) {
    return { schemaVersion: 1, label, message: 'no data', color: 'lightgrey' }
  }
  const ratio = summary.up / summary.total
  return {
    schemaVersion: 1,
    label,
    message: `${summary.up}/${summary.total} up`,
    color: colorForRatio(ratio)
  }
}

// Trailing newline so the file is a well-formed text file and a regenerated
// copy compares equal to a committed one byte for byte.
function renderBadge (badge) {
  return JSON.stringify(badge, null, 2) + '\n'
}

// Shields fetches the endpoint JSON over the public raw URL; nothing else can
// see a private repo's file, which is worth saying out loud next to the code
// that builds the URL.
function shieldsEndpointUrl (rawJsonUrl) {
  return `https://img.shields.io/endpoint?url=${encodeURIComponent(rawJsonUrl)}`
}

export {
  NON_MODEL,
  badgeFromRuns,
  badgeFromWeather,
  colorForRatio,
  readOutcomes,
  renderBadge,
  shieldsEndpointUrl
}
