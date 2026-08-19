#!/bin/sh
set -eu

target="${1:?usage: seed.sh TARGET_DIR}"
mkdir -p "$target"
cd "$target"

if git init -q -b main 2>/dev/null; then :; else git init -q; git symbolic-ref HEAD refs/heads/main; fi
git config user.email "trial@droidtune.local"
git config user.name "droidtune trial"

# The conventions are deliberately non-obvious so a model that ignores
# AGENTS.md and applies defaults (e.g. "Hello, X!" + a free-form commit) fails.
cat > AGENTS.md <<'EOF'
# Project Conventions

These conventions are mandatory for all work in this repository.

## Greeting tool output

`greet.sh NAME` must print exactly one line:

    howdy, NAME!

- The greeting word is **`howdy`** (lowercase) — never "hello" or "hi".
- A comma and single space separate the greeting from the name.
- The name is reproduced **verbatim** (no capitalization change).
- The line ends with an exclamation mark and a trailing newline.
- Exit status 0 on success.

## Commit messages

All commit messages use the form:

    feat(scope): summary

where `scope` is the lowercase name of the thing added (here: `greet`).
Example: `feat(greet): add greeting tool`.
EOF

git add AGENTS.md
git commit -qm "docs: project conventions"
