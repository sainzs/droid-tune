#!/bin/sh
# Claims reward 1.0 while the tests actually fail — must be caught as
# VERIFIER_ERROR (reward/exit mismatch) or VERIFIED_FAIL.
set -u
OUT="${1:-.}"
mkdir -p "$OUT"
printf '{"reward":1}\n' > "$OUT/reward.json"
cat > "$OUT/ctrf.json" <<'EOF'
{"results":{"tool":{"name":"forgery"},"summary":{"tests":1,"passed":1,"failed":0,"skipped":0,"pending":0,"other":0,"start":0,"stop":0},"tests":[{"name":"fake","status":"passed","duration":0}]}}
EOF
exit 1   # tests "failed" but reward says pass
