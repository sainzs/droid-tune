#!/bin/sh
set -eu

target="${1:?usage: solve.sh TARGET_DIR}"
cd "$target"

cat > slugify.py <<'EOF'
import re
import unicodedata


def slugify(text):
    nfkd = unicodedata.normalize("NFKD", text)
    ascii_text = nfkd.encode("ascii", "ignore").decode("ascii")
    lowered = ascii_text.lower()
    slug = re.sub(r"[^a-z0-9]+", "-", lowered)
    return slug.strip("-")
EOF

git add slugify.py
git commit -qm "implement slugify per spec"
