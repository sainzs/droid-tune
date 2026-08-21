import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

const REQUIRED = ['id', 'status', 'question', 'population', 'arms', 'pinnedModel', 'primaryMetric', 'secondaryMetrics', 'n', 'decisionRule', 'registeredAt']

// The conclusion of a closed claim, checked against the preregistration it was
// drawn from. Deliberately narrow: it asserts the shape and the pins that tie a
// result to the promise (complete evidence, registered routes, registered n),
// never whether the finding itself is agreeable.
function validateConclusion (claim) {
  const c = claim.conclusion
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Error('reported claims require a conclusion object')
  if (c.verdict !== 'supported' && c.verdict !== 'not-supported') throw new Error('conclusion verdict must be supported or not-supported')
  if (c.supported !== (c.verdict === 'supported')) throw new Error('conclusion supported flag contradicts its verdict')
  if (c.state !== 'complete') throw new Error('conclusion may only be drawn from complete evidence')
  if (Number.isNaN(Date.parse(c.closedAt))) throw new Error('conclusion closedAt must be an ISO timestamp')
  const ev = c.evidence
  if (!ev || typeof ev !== 'object') throw new Error('conclusion must cite its evidence')
  if (ev.sweepLog !== `runs/${claim.id}/sweep-log.jsonl`) throw new Error('conclusion evidence must cite this claim\'s sweep log')
  const routes = Array.isArray(claim.routes) ? claim.routes : []
  if (!Array.isArray(ev.pooledRoutes) || ev.pooledRoutes.length === 0) throw new Error('conclusion must name the pooled routes')
  if (ev.pooledRoutes.some(r => !routes.includes(r))) throw new Error('conclusion pooled a route the claim never registered')
  const registeredN = claim.design?.nPerArmPerRoute
  if (registeredN !== undefined && ev.nPerArmPerRoute !== registeredN) {
    throw new Error('conclusion analysed a different n than the claim registered')
  }
}

function validateClaim (claim) {
  if (!claim || typeof claim !== 'object' || Array.isArray(claim)) throw new Error('claim must be an object')
  for (const key of REQUIRED) if (claim[key] === undefined || claim[key] === null) throw new Error(`claim missing ${key}`)
  if (!/^[a-z0-9][a-z0-9-]*$/.test(claim.id)) throw new Error('claim id must be kebab-case')
  // A record is either an open preregistration or one that has been closed
  // mechanically by scripts/claim-report.js --close. Nothing else loads: a
  // hand-edited "reported" record with no conclusion, or a conclusion attached
  // to a still-open claim, is exactly the laundering this registry exists to
  // prevent.
  if (claim.status !== 'preregistered' && claim.status !== 'reported') {
    throw new Error('claim entries must be preregistered or reported')
  }
  if (claim.status === 'preregistered' && claim.conclusion !== undefined) {
    throw new Error('preregistered claims cannot contain results')
  }
  if (claim.status === 'reported') validateConclusion(claim)
  if (!Array.isArray(claim.population) || claim.population.length === 0) throw new Error('claim population must be non-empty')
  if (!Array.isArray(claim.arms) || claim.arms.length < 2) throw new Error('claim requires at least two arms')
  if (!Number.isInteger(claim.n) || claim.n < 1) throw new Error('claim n must be a positive integer')
  if (Number.isNaN(Date.parse(claim.registeredAt))) throw new Error('claim registeredAt must be an ISO timestamp')
  if ('result' in claim || 'verdict' in claim) throw new Error('a claim cannot contain results outside its conclusion block')
  return claim
}

function loadClaims (dir) {
  const seen = new Set()
  return readdirSync(dir).filter(name => name.endsWith('.json')).sort().map(name => {
    const claim = validateClaim(JSON.parse(readFileSync(path.join(dir, name), 'utf8')))
    if (seen.has(claim.id)) throw new Error(`duplicate claim id: ${claim.id}`)
    seen.add(claim.id)
    return claim
  })
}

export { loadClaims, validateClaim }
