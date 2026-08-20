#!/usr/bin/env node
// Mechanical claim-file validator.
//
// The Claims Integrity Protocol (PLAN §8) says the tool must be incapable of
// stating a claim the evidence does not support, yet claims/*.json are
// hand-written. This script is the mechanical gate that makes drift fail CI:
// it re-derives every pin a preregistration can carry — the id/status header,
// the exact tune artifact hash, the design arithmetic, route/arm uniqueness,
// rule presence, and the registration timestamp — and is deliberately silent
// about the claim's content. A validator, not a judge.
//
// Checks (one OK/FAIL line per claim; a FAIL line names every check that
// failed, comma-separated):
//
//   1. json     — file parses as a JSON object
//   2. id       — claim.id equals the filename without ".json"
//   3. status   — one of preregistered|running|reported|withdrawn
//   4. tune     — tuneFile/tuneSha256 travel together (or not at all); the
//                 tuneFile must exist and its sha256 must match. tuneFile is
//                 repo-root-relative, as written in the committed claims
//                 ("tunes/ledger-lite/AGENTS.md"), anchored at the repository
//                 root regardless of the calling cwd.
//   5. design   — when a design is present: arms.length x routes.length x
//                 design.nPerArmPerRoute === design.totalTrials and
//                 design.nPerArm === routes.length x design.nPerArmPerRoute
//   6. routes   — when present: non-empty array of non-empty unique strings
//   7. arms     — when present: non-empty array of unique strings
//   8. primaryMetric / decisionRule — non-empty strings
//   9. exclusionRule — when present: non-empty string
//  10. registeredAt — parses as a date
//
// Usage:
//   node scripts/check-claim.js                    # every claims/*.json
//   node scripts/check-claim.js path/to/claims-dir # every *.json in a dir
//   node scripts/check-claim.js path/to/claim.json # one claim file
//
// Exit: 0 all claims OK · 1 any claim FAIL · 2 usage/IO error.
import { statSync, readdirSync, readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sha256String } from '../lib/pack.js'

// Same anchor style as test/*.test.js: the repo root, derived from this
// module's own location so the hash check is cwd-independent.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const VALID_STATUS = new Set(['preregistered', 'running', 'reported', 'withdrawn'])

const target = process.argv[2] ?? 'claims'

let baseDir = target
let files
try {
  const st = statSync(target)
  if (st.isDirectory()) {
    files = readdirSync(target).filter(name => name.endsWith('.json')).sort().map(name => path.join(target, name))
  } else if (st.isFile()) {
    files = [target]
  } else {
    console.error(`not a file or directory: ${target}`)
    process.exit(2)
  }
} catch (err) {
  console.error(`cannot read ${target}: ${err.message}`)
  process.exit(2)
}

if (files.length === 0) {
  console.error(`no claim files (*.json) found under ${target}`)
  process.exit(2)
}

const idFor = (file) => path.basename(file).replace(/\.json$/, '')
const isHex64 = (s) => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s)

function checkClaim (file) {
  const failures = []
  const fail = (check, detail) => failures.push(`${check}: ${detail}`)

  let claim
  try {
    claim = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    return [`json: ${err.message}`]
  }
  if (!claim || typeof claim !== 'object' || Array.isArray(claim)) {
    return ['json: claim is not an object']
  }

  if (claim.id !== idFor(file)) {
    fail('id', `"${claim.id}" does not match filename "${path.basename(file)}"`)
  }

  if (!VALID_STATUS.has(claim.status)) {
    fail('status', `"${claim.status}" is not one of ${[...VALID_STATUS].sort().join('|')}`)
  }

  // A tune pin is only a pin if both halves travel together.
  if (claim.tuneFile !== undefined || claim.tuneSha256 !== undefined) {
    if (typeof claim.tuneFile !== 'string' || claim.tuneFile === '') {
      fail('tune', 'tuneFile must be a non-empty string when a tune is pinned')
    } else if (!isHex64(claim.tuneSha256)) {
      fail('tune', 'tuneSha256 must be a 64-char hex string when a tune is pinned')
    } else {
      const tunePath = path.join(root, claim.tuneFile)
      if (!existsSync(tunePath)) {
        fail('tune', `tuneFile does not exist: ${claim.tuneFile}`)
      } else if (sha256String(readFileSync(tunePath, 'utf8')) !== claim.tuneSha256) {
        fail('tune', `sha256 of ${claim.tuneFile} does not match the pinned tuneSha256`)
      }
    }
  }

  // Design arithmetic — only meaningful for a claim that carries a design.
  if (claim.design !== undefined && claim.design !== null) {
    const { design, arms, routes } = claim
    const nArms = Array.isArray(arms) ? arms.length : 0
    const nRoutes = Array.isArray(routes) ? routes.length : 0
    const perRoute = design.nPerArmPerRoute
    if (!Number.isInteger(perRoute) || perRoute < 1) {
      fail('design', `nPerArmPerRoute must be a positive integer, got ${design.nPerArmPerRoute}`)
    } else if (nArms < 1 || nRoutes < 1) {
      fail('design', 'arms and routes are required to check design arithmetic')
    } else {
      const expectPerArm = nRoutes * perRoute
      const expectTotal = nArms * expectPerArm
      if (design.nPerArm !== expectPerArm) {
        fail('design', `nPerArm ${design.nPerArm} != routes ${nRoutes} x nPerArmPerRoute ${perRoute} (= ${expectPerArm})`)
      }
      if (design.totalTrials !== expectTotal) {
        fail('design', `totalTrials ${design.totalTrials} != arms ${nArms} x routes ${nRoutes} x nPerArmPerRoute ${perRoute} (= ${expectTotal})`)
      }
    }
  }

  if (claim.routes !== undefined && claim.routes !== null) {
    if (!Array.isArray(claim.routes) || claim.routes.length === 0) {
      fail('routes', 'routes must be a non-empty array when present')
    } else {
      if (claim.routes.some(r => typeof r !== 'string' || r.trim() === '')) {
        fail('routes', 'routes must be non-empty strings')
      }
      const dupes = [...new Set(claim.routes.filter((r, i) => claim.routes.indexOf(r) !== i))]
      if (dupes.length > 0) {
        fail('routes', `duplicate route(s): ${dupes.join(', ')}`)
      }
    }
  }

  if (claim.arms !== undefined && claim.arms !== null) {
    if (!Array.isArray(claim.arms) || claim.arms.length === 0) {
      fail('arms', 'arms must be a non-empty array when present')
    } else {
      const dupes = [...new Set(claim.arms.filter((a, i) => claim.arms.indexOf(a) !== i))]
      if (dupes.length > 0) {
        fail('arms', `duplicate arm(s): ${dupes.join(', ')}`)
      }
    }
  }

  if (typeof claim.primaryMetric !== 'string' || claim.primaryMetric.trim() === '') {
    fail('primaryMetric', 'must be a non-empty string')
  }
  if (typeof claim.decisionRule !== 'string' || claim.decisionRule.trim() === '') {
    fail('decisionRule', 'must be a non-empty string')
  }
  if (claim.exclusionRule !== undefined && claim.exclusionRule !== null) {
    if (typeof claim.exclusionRule !== 'string' || claim.exclusionRule.trim() === '') {
      fail('exclusionRule', 'must be a non-empty string when present')
    }
  }
  if (Number.isNaN(Date.parse(claim.registeredAt))) {
    fail('registeredAt', `"${claim.registeredAt}" is not a parseable date`)
  }

  return failures
}

let allOk = true
for (const file of files) {
  const failures = checkClaim(file)
  if (failures.length > 0) {
    allOk = false
    console.log(`FAIL ${file} — ${failures.join('; ')}`)
  } else {
    console.log(`OK ${file}`)
  }
}
process.exit(allOk ? 0 : 1)
