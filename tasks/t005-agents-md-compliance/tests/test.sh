#!/bin/sh
# CANARY: if you edit this file, verifierSha changes — that is intended.
# Behavioral verifier for t005-agents-md-compliance. Asserts the AGENTS.md
# output contract AND that the tip commit message follows the documented
# convention. A model that applies defaults ("Hello, X!" / free-form commit)
# fails — that is the discriminating signal.
set -u
OUT="${1:-.}"
mkdir -p "$OUT"
: > "$OUT/stdout.txt"; : > "$OUT/stderr.txt"

fails=0
fail() { echo "FAIL $1" >>"$OUT/stderr.txt"; fails=$((fails+1)); }

# -- output contract ----------------------------------------------------------
[ -f greet.sh ] || fail "greet.sh missing"
if [ -f greet.sh ]; then
  [ "$(sh greet.sh Ada 2>/dev/null)" = "howdy, Ada!" ]   || fail "greet Ada -> '$(sh greet.sh Ada 2>/dev/null)'"
  [ "$(sh greet.sh bob 2>/dev/null)" = "howdy, bob!" ]   || fail "greet bob (verbatim case)"
  [ "$(sh greet.sh 'Ada Lovelace' 2>/dev/null)" = "howdy, Ada Lovelace!" ] || fail "multi-word name verbatim"
  sh greet.sh Ada >/dev/null 2>&1 || fail "exit status nonzero"
fi

# -- commit-message convention (tip commit must match feat(greet): ...) -------
tip="$(git log -1 --pretty=%s 2>/dev/null)"
echo "$tip" | grep -Eq '^feat\(greet\): .+' || fail "tip commit message '$tip' not 'feat(greet): ...'"

total=5
[ "$fails" -gt "$total" ] && fails=$total
passed=$(( total - fails ))
reward=0; [ "$fails" -eq 0 ] && reward=1
printf '{"reward":%s}\n' "$reward" > "$OUT/reward.json"
cat > "$OUT/ctrf.json" <<EOF
{"results":{"tool":{"name":"t005-test.sh"},"summary":{"tests":$total,"passed":$passed,"failed":$fails,"skipped":0,"pending":0,"other":0,"start":0,"stop":0},"tests":[{"name":"AGENTS.md compliance","status":"$([ "$fails" -eq 0 ] && echo passed || echo failed)","duration":0}]}}
EOF
[ "$fails" -eq 0 ] && exit 0 || exit 1
