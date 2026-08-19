#!/bin/sh
set -eu
target="${1:?usage: solve.sh TARGET_DIR}"
cd "$target"

cat > calc/__init__.py <<'EOF'
from .core import add

__all__ = ["add"]
EOF

cat > calc/core.py <<'EOF'
def add(a, b):
    return a + b
EOF

cat > calc/cli.py <<'EOF'
import sys

from . import add


def main(argv=None):
    args = sys.argv[1:] if argv is None else argv
    a, b = int(args[0]), int(args[1])
    print(add(a, b))


if __name__ == "__main__":
    main()
EOF

cat > main.py <<'EOF'
import sys

from calc import add

if __name__ == "__main__":
    a, b = int(sys.argv[1]), int(sys.argv[2])
    print(add(a, b))
EOF

git add -A
git commit -qm "rename compute to add everywhere"
