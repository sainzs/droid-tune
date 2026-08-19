#!/bin/sh
set -eu
target="${1:?usage: solve.sh TARGET_DIR}"
cd "$target"

cat > safelist.mjs <<'EOF'
// Filter directory-entry names to those safe for a portable open().
// Unsafe: control chars, invisible/format chars, Windows-reserved stems,
// dot entries, empty, or any path separator. Order-preserving, non-mutating,
// total, deterministic. Invisible/control ranges are written as explicit
// codepoint escapes so the source itself carries no hostile bytes.
const CONTROL = /[\u0000-\u001F\u007F]/
const INVISIBLE = /[\u00A0\u200B\u200E\u200F\uFEFF]/
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

function stem (name) {
  const base = name.replace(/.*[\\/]/, '') // defensive; separators already rejected
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(0, dot) : base
}

export function safeListdir (names) {
  const arr = Array.isArray(names) ? names : []
  return arr.filter((n) => {
    if (typeof n !== 'string' || n.length === 0) return false
    if (n === '.' || n === '..') return false
    if (n.includes('/') || n.includes('\\')) return false
    if (CONTROL.test(n)) return false
    if (INVISIBLE.test(n)) return false
    if (RESERVED.test(stem(n))) return false
    return true
  })
}
EOF

git add safelist.mjs
git commit -qm "implement safeListdir"
