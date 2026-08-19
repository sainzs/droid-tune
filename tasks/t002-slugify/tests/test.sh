#!/bin/sh
# CANARY: if you edit this file, verifierSha changes — that is intended.
# Behavioral verifier for t002-slugify. Asserts public observable behavior of
# the committed `slugify.py` only — never internal symbols. Accepts any stdlib
# implementation that satisfies the spec.
set -u
OUT="${1:-.}"
mkdir -p "$OUT"

PY="${PYTHON:-python3}"

# Drive the committed module with a behavioral test program. Each case is
# (input, expected). Exit code from python = number of failed cases (capped 125).
run_tests() {
  "$PY" - <<'PYEOF'
import importlib.util
import sys

spec = importlib.util.spec_from_file_location("slugify_mod", "slugify.py")
if spec is None or spec.loader is None:
    print("IMPORT_FAIL: slugify.py not found", file=sys.stderr)
    sys.exit(126)
mod = importlib.util.module_from_spec(spec)
try:
    spec.loader.exec_module(mod)
except Exception as e:
    print(f"IMPORT_FAIL: {e}", file=sys.stderr)
    sys.exit(126)

slugify = getattr(mod, "slugify", None)
if not callable(slugify):
    print("IMPORT_FAIL: no callable slugify()", file=sys.stderr)
    sys.exit(126)

cases = [
    ("Hello, World!", "hello-world"),
    ("  --Crème brûlée-- ", "creme-brulee"),
    ("déjà vu", "deja-vu"),
    ("a___b", "a-b"),
    ("", ""),
    ("!!!", ""),
    ("One   Two\tThree", "one-two-three"),
    ("über_cool--NOW", "uber-cool-now"),
    ("123 numbers 456", "123-numbers-456"),
    ("MixedCASE Input", "mixedcase-input"),
    ("emoji 😀 strip", "emoji-strip"),
]

fails = 0
for text, expected in cases:
    try:
        got = slugify(text)
    except Exception as e:
        print(f"FAIL slugify({text!r}) raised {e}", file=sys.stderr)
        fails += 1
        continue
    if got != expected:
        print(f"FAIL slugify({text!r}) = {got!r}, want {expected!r}", file=sys.stderr)
        fails += 1

print(f"RESULTS {len(cases) - fails}/{len(cases)} passed", file=sys.stderr)
sys.exit(min(fails, 125))
PYEOF
}

STDOUT_T="$OUT/stdout.txt"
STDERR_T="$OUT/stderr.txt"
run_tests > "$STDOUT_T" 2> "$STDERR_T"
code=$?

total=11
passed=$(( total - (code > total ? total : code) ))
[ "$code" -eq 0 ] && passed=$total || true
failed=$(( total - passed ))

reward=0; [ "$code" -eq 0 ] && reward=1
printf '{"reward":%s}\n' "$reward" > "$OUT/reward.json"
cat > "$OUT/ctrf.json" <<EOF
{"results":{"tool":{"name":"t002-test.sh"},"summary":{"tests":$total,"passed":$passed,"failed":$failed,"skipped":0,"pending":0,"other":0,"start":0,"stop":0},"tests":[{"name":"slugify behavioral spec","status":"$([ "$code" -eq 0 ] && echo passed || echo failed)","duration":0}]}}
EOF
exit "$code"
