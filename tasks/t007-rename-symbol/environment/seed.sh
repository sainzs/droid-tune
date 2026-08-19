#!/bin/sh
set -eu

target="${1:?usage: seed.sh TARGET_DIR}"
mkdir -p "$target"
cd "$target"

if git init -q -b main 2>/dev/null; then :; else git init -q; git symbolic-ref HEAD refs/heads/main; fi
git config user.email "trial@droidtune.local"
git config user.name "droidtune trial"

mkdir -p calc

cat > calc/__init__.py <<'EOF'
from .core import compute

__all__ = ["compute"]
EOF

cat > calc/core.py <<'EOF'
def compute(a, b):
    return a + b
EOF

cat > calc/cli.py <<'EOF'
import sys

from . import compute


def main(argv=None):
    args = sys.argv[1:] if argv is None else argv
    a, b = int(args[0]), int(args[1])
    print(compute(a, b))


if __name__ == "__main__":
    main()
EOF

cat > main.py <<'EOF'
import sys

from calc import compute

if __name__ == "__main__":
    a, b = int(sys.argv[1]), int(sys.argv[2])
    print(compute(a, b))
EOF

git add -A
git commit -qm "seed"
