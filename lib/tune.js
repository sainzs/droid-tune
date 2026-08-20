// Apply a "tune" to a seeded task worktree before `droid exec` runs.
//
// droid-tune's premise is comparing configurations, and the cheapest real
// configuration surface Droid exposes is the one it already reads on its own:
// an `AGENTS.md` at the root of the working directory. A tune is therefore
// just a directory containing an `AGENTS.md` (see `tunes/ledger-lite/`), and
// applying it means dropping that file into the worktree. Nothing here is
// specific to any particular tune.
//
// Two properties matter enough to be enforced rather than documented:
//
// 1. The tune must not become part of the agent's submission. If it were
//    committed as an extra seed commit, it would rewrite the history that
//    tasks like t004-git-surgery describe verbatim in their instruction; if it
//    were left plainly untracked, an agent running `git add -A` would sweep it
//    into the graded patch. So it is written untracked AND listed in
//    `.git/info/exclude`, which keeps it invisible to `git add -A`/`git
//    status` while leaving the seeded history byte-identical to the no-tune
//    arm. An A/B comparison whose arms differ in the seed is not a comparison.
//
// 2. It must never clobber a task's own AGENTS.md. t005-agents-md-compliance
//    seeds project conventions the verifier grades against; silently
//    overwriting them would turn the task into a different task and quietly
//    invalidate the arm. Refuse instead.
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const TUNE_FILENAME = 'AGENTS.md'

// Resolve a `--tune-file` spec to the file that will be copied. Accepts either
// a tune directory (the documented form) or a direct path to the file.
function resolveTuneFile (spec) {
  if (!spec) throw new Error('tune spec is required')
  const resolved = path.resolve(spec)
  if (!existsSync(resolved)) throw new Error(`tune not found: ${spec}`)
  if (statSync(resolved).isDirectory()) {
    const candidate = path.join(resolved, TUNE_FILENAME)
    if (!existsSync(candidate)) {
      throw new Error(`tune directory has no ${TUNE_FILENAME}: ${spec}`)
    }
    return candidate
  }
  return resolved
}

// Keep the tune out of `git add -A` without touching the seeded history.
// `.git/info/exclude` is per-clone and never part of the tree, so the seed
// commit is unchanged and the exclusion cannot leak into the graded patch.
function excludeFromGit (worktree, name) {
  const infoDir = path.join(worktree, '.git', 'info')
  if (!existsSync(path.join(worktree, '.git'))) return false
  mkdirSync(infoDir, { recursive: true })
  const excludePath = path.join(infoDir, 'exclude')
  const prior = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : ''
  const line = `/${name}`
  if (prior.split('\n').some(l => l.trim() === line)) return true
  appendFileSync(excludePath, `${prior.endsWith('\n') || prior === '' ? '' : '\n'}${line}\n`)
  return true
}

// Copy the tune into an already-seeded worktree. Returns the provenance a pack
// needs to say which tune actually ran.
function applyTune (worktree, spec) {
  const source = resolveTuneFile(spec)
  const target = path.join(worktree, TUNE_FILENAME)
  if (existsSync(target)) {
    throw new Error(
      `refusing to apply tune: the seeded worktree already contains ${TUNE_FILENAME} ` +
      `(${target}). Overwriting a task's own conventions would change what the task ` +
      `measures — t005-agents-md-compliance grades against exactly that file.`
    )
  }
  const content = readFileSync(source)
  writeFileSync(target, content)
  const excluded = excludeFromGit(worktree, TUNE_FILENAME)
  return {
    tuneFile: source,
    tuneName: path.basename(path.dirname(source)),
    sha256: createHash('sha256').update(content).digest('hex'),
    bytes: content.length,
    target,
    gitExcluded: excluded
  }
}

export { applyTune, resolveTuneFile, TUNE_FILENAME }
