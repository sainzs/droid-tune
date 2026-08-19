#!/bin/sh
# CANARY: if you edit this file, verifierSha changes — that is intended.
set -u
OUT="${1:-.}"
mkdir -p "$OUT"
sh greet.sh > "$OUT/stdout.txt" 2> "$OUT/stderr.txt"
code=$?
[ "$code" -eq 0 ] && [ "$(cat "$OUT/stdout.txt")" = "hello tune-up" ] || code=1
pass=0; fail=0
[ "$code" -eq 0 ] && pass=1 || fail=1
reward=0; [ "$code" -eq 0 ] && reward=1
printf '{"reward":%s}\n' "$reward" > "$OUT/reward.json"
cat > "$OUT/ctrf.json" <<EOF
{"results":{"tool":{"name":"t001-test.sh"},"summary":{"tests":1,"passed":$pass,"failed":$fail,"skipped":0,"pending":0,"other":0,"start":0,"stop":0},"tests":[{"name":"greet-script runs","status":"$([ "$code" -eq 0 ] && echo passed || echo failed)","duration":0}]}}
EOF
exit "$code"
