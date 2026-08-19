#!/bin/sh
set -eu

target="${1:?usage: solve.sh TARGET_DIR}"
cd "$target"

cat > canonicalize.mjs <<'EOF'
// Canonical key for a single path component. Collapses, in priority order:
//   1. normalization twins (NFC/NFD) via NFKC (a superset of NFC here)
//   2. case twins via toLowerCase
//   3. compatibility twins (ligatures, width, Kelvin) via NFKC
// Total and deterministic: any string yields a stable string key, never throws.
export function canonicalizePath (name) {
  const s = typeof name === 'string' ? name : String(name ?? '')
  return s.normalize('NFKC').toLowerCase()
}
EOF

git add canonicalize.mjs
git commit -qm "implement canonicalizePath"
