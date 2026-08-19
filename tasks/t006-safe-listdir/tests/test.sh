#!/bin/sh
# CANARY: if you edit this file, verifierSha changes — that is intended.
# Behavioral verifier for t006-safe-listdir. Calls safeListdir() with synthetic
# name lists built from explicit codepoints (invisibles written as \uXXXX) —
# never creates hostile names on the real filesystem, so results are identical
# on every platform. Asserts public behavior only.
set -u
OUT="${1:-.}"
mkdir -p "$OUT"

run_tests() {
  node --input-type=module <<'EOF'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const url = pathToFileURL(path.join(process.cwd(), 'safelist.mjs')).href
let mod
try { mod = await import(url) } catch (e) {
  console.error(`IMPORT_FAIL: ${e.message}`); process.exit(126)
}
const safe = mod.safeListdir
if (typeof safe !== 'function') { console.error('IMPORT_FAIL: no exported safeListdir()'); process.exit(126) }

let fails = 0
const check = (ok, label) => { if (!ok) { console.error(`FAIL ${label}`); fails += 1 } }

// -- Names that MUST be dropped --------------------------------------------
const NBSP = ' '   // no-break space
const ZWSP = '​'   // zero-width space
const LRM  = '‎'   // left-to-right mark
const BOM  = '﻿'   // zero-width no-break space / BOM
const TAB  = '	'                           // control
const NULC = 'ac'                         // embedded control
const DEL  = 'xy'                         // DEL control

const mustDrop = [
  ['ctrl-tab', `a${TAB}b.txt`],
  ['ctrl-nul-embedded', NULC],
  ['ctrl-del', DEL],
  ['nbsp', `report${NBSP}final.txt`],
  ['zwsp', `da${ZWSP}ta.txt`],
  ['lrm', `fi${LRM}le.txt`],
  ['bom', `${BOM}config.json`],
  ['reserved-NUL', 'NUL'],
  ['reserved-nul-ext', 'nul.txt'],
  ['reserved-CON', 'CON'],
  ['reserved-com1', 'com1.log'],
  ['reserved-LPT9', 'LPT9'],
  ['dot', '.'],
  ['dotdot', '..'],
  ['empty', ''],
  ['sep-slash', 'a/b.txt'],
  ['sep-backslash', 'a\\b.txt'],
]
for (const [label, name] of mustDrop) {
  let out
  try { out = safe([name]) } catch (e) { console.error(`FAIL drop-${label}: threw ${e.message}`); fails += 1; continue }
  check(Array.isArray(out) && out.length === 0, `drop-${label}: kept ${JSON.stringify(name)}`)
}

// -- Names that MUST be kept, in order --------------------------------------
const keep = ['café.txt', 'README.md', 'archive.tar.gz', 'my file.txt', 'データ.txt', 'notes.final']
let kept
try { kept = safe(keep) } catch (e) { console.error(`FAIL keep: threw ${e.message}`); fails += 1; kept = null }
if (kept) {
  check(JSON.stringify(kept) === JSON.stringify(keep),
    `keep: order/content changed -> ${JSON.stringify(kept)}`)
}

// -- Mixed list preserves relative order of survivors ------------------------
const mixed = ['a.txt', `b${ZWSP}.txt`, 'c.txt', 'NUL', 'd.txt']
const expect = ['a.txt', 'c.txt', 'd.txt']
let mout
try { mout = safe(mixed) } catch (e) { mout = null }
check(JSON.stringify(mout) === JSON.stringify(expect),
  `mixed-order: got ${JSON.stringify(mout)} want ${JSON.stringify(expect)}`)

// -- Total + deterministic + non-mutating ------------------------------------
const nastyIn = ['', '.', '..', NULC, 'ok.txt']
const snapshot = JSON.stringify(nastyIn)
let threw = false
for (let i = 0; i < 2; i++) {
  try { safe(nastyIn) } catch (e) { threw = true }
}
check(!threw, 'safeListdir threw on nasty input')
check(JSON.stringify(nastyIn) === snapshot, 'safeListdir mutated its input array')

console.error(`RESULTS fails=${fails}`)
process.exit(Math.min(fails, 125))
EOF
}

run_tests > "$OUT/stdout.txt" 2> "$OUT/stderr.txt"
code=$?

# 17 mustDrop + 1 keep + 1 mixed + 1 no-throw + 1 non-mutating = 21
total=21
failed=$code
[ "$failed" -gt "$total" ] && failed=$total
[ "$code" -eq 0 ] && failed=0
passed=$(( total - failed ))

reward=0; [ "$code" -eq 0 ] && reward=1
printf '{"reward":%s}\n' "$reward" > "$OUT/reward.json"
cat > "$OUT/ctrf.json" <<EOF
{"results":{"tool":{"name":"t006-test.sh"},"summary":{"tests":$total,"passed":$passed,"failed":$failed,"skipped":0,"pending":0,"other":0,"start":0,"stop":0},"tests":[{"name":"safeListdir behavioral spec","status":"$([ "$code" -eq 0 ] && echo passed || echo failed)","duration":0}]}}
EOF
exit "$code"
