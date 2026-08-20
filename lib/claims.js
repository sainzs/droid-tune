import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

const REQUIRED = ['id', 'status', 'question', 'population', 'arms', 'pinnedModel', 'primaryMetric', 'secondaryMetrics', 'n', 'decisionRule', 'registeredAt']

function validateClaim (claim) {
  if (!claim || typeof claim !== 'object' || Array.isArray(claim)) throw new Error('claim must be an object')
  for (const key of REQUIRED) if (claim[key] === undefined || claim[key] === null) throw new Error(`claim missing ${key}`)
  if (!/^[a-z0-9][a-z0-9-]*$/.test(claim.id)) throw new Error('claim id must be kebab-case')
  if (claim.status !== 'preregistered') throw new Error('new claim entries must be preregistered')
  if (!Array.isArray(claim.population) || claim.population.length === 0) throw new Error('claim population must be non-empty')
  if (!Array.isArray(claim.arms) || claim.arms.length < 2) throw new Error('claim requires at least two arms')
  if (!Number.isInteger(claim.n) || claim.n < 1) throw new Error('claim n must be a positive integer')
  if (Number.isNaN(Date.parse(claim.registeredAt))) throw new Error('claim registeredAt must be an ISO timestamp')
  if ('result' in claim || 'verdict' in claim) throw new Error('preregistered claims cannot contain results')
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
