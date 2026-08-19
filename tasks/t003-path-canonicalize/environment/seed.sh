#!/bin/sh
set -eu

target="${1:?usage: seed.sh TARGET_DIR}"
mkdir -p "$target"
cd "$target"

if git init -q -b main 2>/dev/null; then
    :
else
    git init -q
    git symbolic-ref HEAD refs/heads/main
fi

git config user.email "trial@droidtune.local"
git config user.name "droidtune trial"

cat > README.md <<'EOF'
# t003 fixture

Implement `canonicalize.mjs` per `instruction.md`. Node >= 20, ESM, stdlib
only. The verifier feeds synthetic path lists (normalization/case/compatibility
twins), so it runs correctly even on normalization-insensitive volumes.
EOF

git add -A
git commit -qm "seed"
