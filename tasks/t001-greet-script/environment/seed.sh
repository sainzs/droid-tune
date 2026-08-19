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

printf '%s\n' "trial seed" > README.md

git add -A
git commit -qm "seed"
