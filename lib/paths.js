// Evidence-pack path layout.
//
// Packs live at <runs>/<tune>/<route>/<task>/attempt-N. The route segment sits
// between the tune and the task for two reasons: a sweep that runs one tune and
// one task across several routes would otherwise collide on attempt numbers
// (route 2's attempt-1 lands on route 1's pack), and putting the route above the
// task keeps `basename(dirname(packDir))` equal to the task id for every reader,
// while making <runs>/<tune>/<route> a valid runs root in its own right.
//
// Packs written before this layout existed sit one level shallower
// (<runs>/<tune>/<task>/attempt-N), and committed fixtures still use that shape,
// so discovery here is by depth-limited descent rather than by fixed depth.
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const isDir = (p) => { try { return statSync(p).isDirectory() } catch { return false } }

// A directory is a pack if it carries either half of the evidence pair. Checking
// both — rather than manifest.json alone — means a trial that died before the
// manifest was written is still discoverable instead of silently vanishing.
export function isPackDir (dir) {
  return existsSync(path.join(dir, 'results.json')) || existsSync(path.join(dir, 'manifest.json'))
}

// Filesystem-safe route segment for a model id. Mirrors the `shortModel` display
// normalization (strip the `custom:` prefix and the `-OpenCode…` provider suffix)
// so a pack's path segment and its rendered model label cannot drift apart.
export function routeSlug (model, { native = false } = {}) {
  if (native) return 'native-droid'
  const id = String(model ?? '')
  // The two documented rewrites — they are display normalizations, applied to
  // every id of that shape, and so cannot make two distinct routes converge.
  const canonical = id.replace(/^custom:/, '').replace(/-OpenCode.*$/, '').toLowerCase()
  // No id at all: one condition, one directory — never an empty path segment,
  // which would silently collapse the route level out of the pack path.
  if (canonical === '') return 'unknown-route'
  const slug = canonical
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
  // Beyond those rewrites, the sanitizer IS lossy: `a/b` and `a-b` both reduce
  // to `a-b`, and a dots-only id ('.', '..') would be a path-traversal segment
  // rather than a route. Two routes sharing a directory would either trip the
  // collision guard on a legitimate trial or pool two arms into one pack tree,
  // so any id the sanitizer had to alter carries a digest of the original.
  // Ordinary route ids (hy3-free, deepseek-v4-flash-0731) are untouched.
  const lossy = slug !== canonical || /^\.+$/.test(slug)
  if (!lossy) return slug
  const digest = createHash('sha256').update(id).digest('hex').slice(0, 6)
  return slug === '' || /^\.+$/.test(slug) ? `unknown-route-${digest}` : `${slug}-${digest}`
}

// Natural order for a directory name, so a walk lists attempt-2 before
// attempt-10 instead of the lexicographic attempt-10, attempt-11, attempt-12,
// attempt-2, … every reader renders. Embedded integer runs compare numerically
// (arbitrary-length, via BigInt); every other chunk compares in plain
// code-unit order, which keeps non-attempt names deterministic without any
// locale dependence.
const compareNames = (a, b) => {
  const chunksRe = /\d+|\D+/g
  const aChunks = a.match(chunksRe) ?? [a]
  const bChunks = b.match(chunksRe) ?? [b]
  const n = Math.min(aChunks.length, bChunks.length)
  for (let i = 0; i < n; i++) {
    const x = aChunks[i]
    const y = bChunks[i]
    const xNum = /^\d/.test(x)
    const yNum = /^\d/.test(y)
    if (xNum && yNum) {
      const diff = BigInt(x) - BigInt(y)
      if (diff !== 0n) return diff < 0n ? -1 : 1
      if (x !== y) return x < y ? -1 : 1 // same value, different zero padding
    } else if (xNum !== yNum) {
      return xNum ? -1 : 1 // digits sort before letters, as in code-unit order
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return aChunks.length - bChunks.length
}

// Every pack under `root`, deepest-first-safe and deterministically sorted.
// Descent stops at a pack (a pack's own subdirectories — grader-artifacts/ — are
// never packs) and at `maxDepth`, so a symlink loop or an unexpectedly deep tree
// cannot hang a walk.
export function findPacks (root, { maxDepth = 6 } = {}) {
  const found = []
  if (!isDir(root)) return found
  const walk = (dir, depth) => {
    if (depth > maxDepth) return
    let entries
    try { entries = readdirSync(dir).sort(compareNames) } catch { return }
    for (const name of entries) {
      const child = path.join(dir, name)
      if (!isDir(child)) continue
      if (isPackDir(child)) found.push(child)
      else walk(child, depth + 1)
    }
  }
  walk(root, 1)
  return found
}

// Label a pack by its path relative to the runs root it was found under, so a
// pre-route pack still reads `t004-git-surgery/attempt-1` while a routed one
// reads `hy3-free/t004-git-surgery/attempt-1`.
export function packLabel (root, dir) {
  const rel = path.relative(root, dir)
  return rel === '' ? path.basename(dir) : rel
}
