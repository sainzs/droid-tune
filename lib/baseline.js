import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { redactConfig } from './diagnose.js'
import { sha256String } from './pack.js'
import { getPricingTable } from './pricing.js'
import { hashTree } from './verify.js'
import { runTrial } from './runner.js'
import { loadClaims } from './claims.js'

function configSha (configPath) {
  return sha256String(JSON.stringify(redactConfig(JSON.parse(readFileSync(configPath, 'utf8')))))
}

function readDroidVersion (droidPath) {
  return (spawnSync(droidPath, ['--version'], { encoding: 'utf8', timeout: 15000 }).stdout ?? '').trim() || null
}

function validateBundle (bundle) {
  if (bundle?.schemaVersion !== 1) throw new Error('baseline bundle schemaVersion must be 1')
  if (!/^[a-z0-9][a-z0-9-]*$/.test(bundle.id ?? '')) throw new Error('baseline bundle id must be kebab-case')
  if (bundle.route !== 'droid-core-default') throw new Error('baseline route must be droid-core-default')
  if (!Array.isArray(bundle.tasks) || bundle.tasks.length === 0) throw new Error('baseline tasks must be non-empty')
  if (new Set(bundle.tasks).size !== bundle.tasks.length) throw new Error('baseline tasks must be unique')
  if (!Number.isInteger(bundle.attempts) || bundle.attempts < 1) throw new Error('baseline attempts must be positive')
  if (!['low', 'medium', 'high'].includes(bundle.autoLevel)) throw new Error('invalid baseline autoLevel')
  if (!Number.isInteger(bundle.timeoutMs) || bundle.timeoutMs < 1) throw new Error('invalid baseline timeoutMs')
  if (!Array.isArray(bundle.claimIds) || bundle.claimIds.length === 0 || new Set(bundle.claimIds).size !== bundle.claimIds.length) {
    throw new Error('baseline claimIds must be non-empty and unique')
  }
  for (const key of ['maxOutputTokensPerTrial', 'cumulativeOutputTokens']) {
    if (!Number.isInteger(bundle.budget?.[key]) || bundle.budget[key] < 1) throw new Error(`invalid baseline budget.${key}`)
  }
  getPricingTable(bundle.pricingTableId)
  return bundle
}

function freezeBundle ({ bundle, bundlePath, repoRoot, configPath, droidPath }) {
  const frozenConfigSha = configSha(configPath)
  const droidVersion = readDroidVersion(droidPath)
  if (!droidVersion) throw new Error(`cannot read Droid version from ${droidPath}`)
  const tasks = bundle.tasks.map(id => {
    const taskDir = path.join(repoRoot, 'tasks', id)
    return { id, taskSha: hashTree(taskDir), verifierSha: hashTree(path.join(taskDir, 'tests')) }
  })
  const source = readFileSync(bundlePath, 'utf8')
  const registry = new Map(loadClaims(path.join(repoRoot, 'claims')).map(claim => [claim.id, claim]))
  const claims = bundle.claimIds.map(id => {
    if (!registry.has(id)) throw new Error(`baseline bundle references unknown claim: ${id}`)
    const claimPath = path.join(repoRoot, 'claims', `${id}.json`)
    return { id, sha256: sha256String(readFileSync(claimPath, 'utf8')) }
  })
  return {
    ...bundle,
    frozenAt: new Date().toISOString(),
    bundleSha: sha256String(source),
    droidVersion,
    configSha: frozenConfigSha,
    pricingTable: getPricingTable(bundle.pricingTableId),
    claims,
    tasks,
    taskSetSha: sha256String(JSON.stringify(tasks.map(task => [task.id, task.taskSha]))),
    verifierSetSha: sha256String(JSON.stringify(tasks.map(task => [task.id, task.verifierSha])))
  }
}

async function runBaseline (opts) {
  if (!opts.confirmSpend) throw new Error('baseline requires --confirm-spend before any live trial')
  const bundle = validateBundle(JSON.parse(readFileSync(opts.bundlePath, 'utf8')))
  const frozen = freezeBundle({ ...opts, bundle })
  const baselineDir = path.join(opts.runsDir, bundle.tuneName)
  mkdirSync(baselineDir, { recursive: true })
  writeFileSync(path.join(baselineDir, 'bundle.snapshot.json'), JSON.stringify(frozen, null, 2) + '\n', { flag: 'wx' })
  const results = []
  const runOne = opts.runOne ?? runTrial
  let cumulativeOutputTokensUsed = 0
  for (const task of frozen.tasks) {
    for (let attempt = 1; attempt <= bundle.attempts; attempt++) {
      if (configSha(opts.configPath) !== frozen.configSha) throw new Error('Droid config changed during frozen baseline')
      if (readDroidVersion(opts.droidPath) !== frozen.droidVersion) throw new Error('Droid version changed during frozen baseline')
      const result = await runOne({
        taskDir: path.join(opts.repoRoot, 'tasks', task.id),
        native: true,
        droidPath: opts.droidPath,
        sessionsDir: opts.sessionsDir,
        configPath: opts.configPath,
        runsDir: opts.runsDir,
        tuneName: bundle.tuneName,
        attempt,
        autoLevel: bundle.autoLevel,
        timeoutMs: bundle.timeoutMs,
        budget: { ...bundle.budget, cumulativeOutputTokensUsed },
        pricingTableId: bundle.pricingTableId,
        provenance: { bundleId: bundle.id, bundleSha: frozen.bundleSha, claimIds: bundle.claimIds }
      })
      results.push(result)
      cumulativeOutputTokensUsed += result.usage?.outputTokens ?? 0
      if (result.budgetAbort) return { bundle: frozen, results, stoppedByBudget: true }
    }
  }
  return { bundle: frozen, results, stoppedByBudget: false }
}

export { freezeBundle, runBaseline, validateBundle }
