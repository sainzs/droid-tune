#!/bin/sh
# CANARY: if you edit this file, verifierSha changes — that is intended.
# Behavioral verifier for t004-git-surgery. Asserts the public CLI contract of
# the committed calc.sh AND that the good divide work survived. Never inspects
# internal history shape — only observable behavior + presence of divide.
set -u
OUT="${1:-.}"
mkdir -p "$OUT"

fails=0
check() { # check <label> <got> <want>
  if [ "$2" != "$3" ]; then echo "FAIL $1: got '$2' want '$3'" >>"$OUT/stderr.txt"; fails=$((fails+1)); fi
}

: > "$OUT/stdout.txt"; : > "$OUT/stderr.txt"

[ -f calc.sh ] || { echo "FAIL calc.sh missing" >>"$OUT/stderr.txt"; fails=$((fails+1)); }

if [ -f calc.sh ]; then
  check "add 2 3"      "$(sh calc.sh add 2 3 2>/dev/null)" "5"
  check "add -1 1"     "$(sh calc.sh add -1 1 2>/dev/null)" "0"
  check "multiply 4 3" "$(sh calc.sh multiply 4 3 2>/dev/null)" "12"
  check "multiply 5 5" "$(sh calc.sh multiply 5 5 2>/dev/null)" "25"
  check "divide 10 2"  "$(sh calc.sh divide 10 2 2>/dev/null)" "5"
  check "divide 9 3"   "$(sh calc.sh divide 9 3 2>/dev/null)" "3"
  # the good divide contribution must be present (the point of the surgery)
  if ! sh calc.sh divide 8 4 >/dev/null 2>&1; then
    echo "FAIL divide: op not supported (good work lost)" >>"$OUT/stderr.txt"; fails=$((fails+1))
  fi
fi

total=7
[ "$fails" -gt "$total" ] && fails=$total
passed=$(( total - fails ))
reward=0; [ "$fails" -eq 0 ] && reward=1
printf '{"reward":%s}\n' "$reward" > "$OUT/reward.json"
cat > "$OUT/ctrf.json" <<EOF
{"results":{"tool":{"name":"t004-test.sh"},"summary":{"tests":$total,"passed":$passed,"failed":$fails,"skipped":0,"pending":0,"other":0,"start":0,"stop":0},"tests":[{"name":"calc.sh behavioral contract + divide preserved","status":"$([ "$fails" -eq 0 ] && echo passed || echo failed)","duration":0}]}}
EOF
[ "$fails" -eq 0 ] && exit 0 || exit 1
