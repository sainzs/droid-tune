#!/bin/sh
# CANARY: if you edit this file, verifierSha changes — that is intended.
# Behavioral verifier for t007-rename-symbol. Runs the three documented
# behaviors and greps for any leftover `compute`. Asserts public behavior only.
set -u
OUT="${1:-.}"
mkdir -p "$OUT"
: > "$OUT/stdout.txt"; : > "$OUT/stderr.txt"

fails=0
fail() { echo "FAIL $1" >>"$OUT/stderr.txt"; fails=$((fails+1)); }

PY="$(command -v python3 || command -v python)"

# -- 1. from calc import add; add(2,3)==5 -------------------------------------
out="$("$PY" -c 'from calc import add; print(add(2,3))' 2>>"$OUT/stderr.txt")"
[ "$out" = "5" ] || fail "from calc import add; add(2,3) -> '$out'"

# -- 2. python3 main.py 2 3 -> 5 ----------------------------------------------
out="$("$PY" main.py 2 3 2>>"$OUT/stderr.txt")"
[ "$out" = "5" ] || fail "main.py 2 3 -> '$out'"

# -- 3. python3 -m calc.cli 4 5 -> 9 -------------------------------------------
out="$("$PY" -m calc.cli 4 5 2>>"$OUT/stderr.txt")"
[ "$out" = "9" ] || fail "python -m calc.cli 4 5 -> '$out'"

# -- 4. __init__ exports add via __all__ ---------------------------------------
out="$("$PY" -c 'import calc; print("add" in calc.__all__)' 2>>"$OUT/stderr.txt")"
[ "$out" = "True" ] || fail "calc.__all__ does not export add"

# -- 5. no leftover `compute` in any .py file -----------------------------------
if grep -Rqn "compute" --include='*.py' . 2>/dev/null; then
  fail "leftover reference to 'compute' in .py files"
fi

# -- 6. old import path must be gone (importing compute should fail) -----------
if "$PY" -c 'from calc import compute' >/dev/null 2>&1; then
  fail "old name 'compute' still importable from calc"
fi

total=6
[ "$fails" -gt "$total" ] && fails=$total
passed=$(( total - fails ))
reward=0; [ "$fails" -eq 0 ] && reward=1
printf '{"reward":%s}\n' "$reward" > "$OUT/reward.json"
cat > "$OUT/ctrf.json" <<EOF
{"results":{"tool":{"name":"t007-test.sh"},"summary":{"tests":$total,"passed":$passed,"failed":$fails,"skipped":0,"pending":0,"other":0,"start":0,"stop":0},"tests":[{"name":"rename-symbol consistency","status":"$([ "$fails" -eq 0 ] && echo passed || echo failed)","duration":0}]}}
EOF
[ "$fails" -eq 0 ] && exit 0 || exit 1
