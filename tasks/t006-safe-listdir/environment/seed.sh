#!/bin/sh
set -eu

target="${1:?usage: seed.sh TARGET_DIR}"
mkdir -p "$target"
cd "$target"

if git init -q -b main 2>/dev/null; then :; else git init -q; git symbolic-ref HEAD refs/heads/main; fi
git config user.email "trial@droidtune.local"
git config user.name "droidtune trial"

cat > README.md <<'EOF'
# t006 fixture

Implement `safelist.mjs` per `instruction.md`. Node >= 20, ESM, stdlib only.
The verifier calls `safeListdir()` with synthetic name lists (control chars,
invisibles, Windows-reserved stems, separators) — it never creates the hostile
names on the real filesystem, so results are identical on every platform.
EOF

git add -A
git commit -qm "seed"
