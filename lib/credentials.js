import { existsSync, readFileSync } from 'node:fs'

// Environment-variable references droid configs use to inject per-route
// credentials (e.g. customModels[].apiKey: "${OPENCODE_ZEN_KEY}"). A route
// whose credential is an inline literal (already redacted by runDiagnose, never
// an env ref) does not need a var present in the parent env.
const ENV_REF_RE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/

// Collect the credential-shaped env var names a config actually needs at
// runtime (via ${VAR} indirection). Generic: driven by what the config
// references, NOT a hardcoded list of secret names.
//
// Shared by lib/runner.js (fail-fast preflight before spawning droid exec)
// and lib/diagnose.js (reporting the same gap as a fault/hint before any
// trial is attempted, so `diagnose` doubles as a real first-run doctor).
export function referencedCredentialVars (configPath) {
  if (!configPath || !existsSync(configPath)) {
    // Without a config we can't know which route vars are needed, so there is
    // nothing to preflight against.
    return []
  }
  let cfg
  try {
    cfg = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch {
    return []
  }
  const vars = new Set()
  const models = Array.isArray(cfg?.customModels) ? cfg.customModels : []
  for (const m of models) {
    if (typeof m?.apiKey === 'string') {
      const m2 = m.apiKey.match(ENV_REF_RE)
      if (m2) vars.add(m2[1])
    }
  }
  return [...vars]
}

// Attempt to source the well-known local credentials file into `env` — but only
// when doing so actually supplies a referenced credential that was missing.
// We never read, print, log, or persist the file's VALUES; we only enrich a
// `${VAR}`-reference-shaped object with the names droid needs. Returns the
// env with any newly-loaded vars spliced in (new object; caller decides usage).
// If the file exists and parses as `export NAME=...` / `NAME=...` lines, only
// the var NAMES referenced by the config are imported from it.
export function autoloadCredentials (env, requiredVars, envShPath) {
  const missing = requiredVars.filter(v => env[v] === undefined || env[v] === '')
  if (missing.length === 0) return env
  if (!envShPath || !existsSync(envShPath)) return env

  // Parse the file into name→value WITHOUT exposing values elsewhere. We only
  // keep the var names the config references and only if they carry a value.
  let contents
  try {
    contents = readFileSync(envShPath, 'utf8')
  } catch {
    return env
  }
  const loaded = {}
  for (const line of contents.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const m = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!m) continue
    const name = m[1]
    // Strip a single layer of matching quotes from the value.
    let value = m[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    loaded[name] = value
  }

  const augmented = { ...env }
  for (const v of missing) {
    if (loaded[v] !== undefined && loaded[v] !== '') augmented[v] = loaded[v]
  }
  return augmented
}
