# M3 Execution Plan — verify.js hardening + tri-force CI

> Fully presolved. A junior dev can execute this verbatim. No design decisions left.
> Fixes two live M2 bugs found in review (D1: grading uncommitted files → false
> VERIFIED_PASS; D2: budget self-comparison always true).

## Decisions (frozen)

| # | Decision | Choice |
|---|----------|--------|
| D1 | Grading source | Fresh `git clone` of the repo at the run's base SHA (never the worktree) |
| D2 | reward.json | Mandatory; must agree with test exit code, else `VERIFIER_ERROR` |
| D3 | ctrf.json | Mandatory; missing/invalid → `VERIFIER_ERROR` |
| D4 | New CLI command | `triforce` (name `verify` reserved for M7) |
| D5 | Offline legs | oracle×3, no-op×2, cheats (built-in reward-forgery + `tasks/<id>/cheats/*.sh`) |
| D6 | Provenance | `verifierSha` = sha256 of tests dir contents; `gradedSha` = clone's HEAD |
| D7 | Style | Sync fs + `spawnSync`, matching runner.js |
| D8 | Ledger event | `verify.done` replaces `tests.exit` |
| D9 | Budget bug | Compare measured duration vs `--budget` arg, not vs itself |
| D10 | Cheats | Two scripts: `forgery.sh` (writes reward 1.0, fails tests) and `early-exit.sh` |
| D11 | CI | `.github/workflows/ci.yml` runs `npm run check` + offline triforce legs |

## Step 0 — Commit pending docs

Working tree has M AGENTS.md, PLAN.md, README.md, docs/research-2026-08.md.

```sh
cd ~/Code/projects/droid-tune
git add -A && git commit -m "docs: M2 status pass + M3 execution plan"
```

Done when: `git status --short` is empty and `npm test` passes (49 tests).

## Step 1 — `lib/verify.js` (new file)

Core contract enforcement + provenance. Complete file:

```js
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export class VerifierError extends Error {
  constructor(reason, detail = '') {
    super(`VERIFIER_ERROR: ${reason}${detail ? ` — ${detail}` : ''}`);
    this.name = 'VerifierError';
    this.reason = reason;
  }
}

// sha256 over a deterministic concatenation of all files under dir
// (relative path + NUL + contents), sorted by relative path.
export function hashTree(dir) {
  const files = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(dir);
  const h = createHash('sha256');
  for (const f of files) {
    h.update(f.slice(dir.length + 1));
    h.update('\0');
    h.update(readFileSync(f));
    h.update('\0');
  }
  return h.digest('hex');
}

// Load and validate reward.json in outDir against the observed test exit code.
// Returns the parsed reward object. Throws VerifierError on any disagreement.
export function checkReward(outDir, testExitCode) {
  const p = join(outDir, 'reward.json');
  if (!existsSync(p)) throw new VerifierError('reward.json missing', p);
  let r;
  try {
    r = JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    throw new VerifierError('reward.json invalid JSON', e.message);
  }
  if (typeof r.reward !== 'number' || Number.isNaN(r.reward)) {
    throw new VerifierError('reward.json missing numeric "reward"');
  }
  const claimed = r.reward > 0;
  const observed = testExitCode === 0;
  if (claimed !== observed) {
    throw new VerifierError(
      'reward/exit mismatch',
      `reward=${r.reward} but exit=${testExitCode}`,
    );
  }
  return r;
}

// Load and validate ctrf.json (minimal CTRF sanity: results.summary.present).
export function checkCtrf(outDir) {
  const p = join(outDir, 'ctrf.json');
  if (!existsSync(p)) throw new VerifierError('ctrf.json missing', p);
  let c;
  try {
    c = JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    throw new VerifierError('ctrf.json invalid JSON', e.message);
  }
  const s = c?.results?.summary;
  if (!s || typeof s.tests !== 'number') {
    throw new VerifierError('ctrf.json missing results.summary.tests');
  }
  return c;
}
```

Done when: file exists and `node -e "import('./lib/verify.js').then(m=>console.log(Object.keys(m)))"` prints the exports.

## Step 2 — Fix runner.js grading bugs (D1, D2, D8, D9)

Edits to `lib/runner.js`:

1. **Line 151 (budget):** replace the self-comparison with a measured comparison:

```js
// before: const budgetOk = budget >= budget;   // always true
const budgetOk = budget == null || durationMs <= budget * 1000;
```

(`durationMs` is the measured run duration already captured around the spawn;
if the variable name in the file differs, use the actual measured-duration var.)

2. **Lines 155–189 (grading block):** replace `cpSync(worktree, gradeDir)` with a
fresh clone at the base SHA:

```js
// Grade a fresh clone, not the worktree — never grade uncommitted files.
execFileSync('git', ['clone', '--quiet', repoRoot, gradeDir]);
execFileSync('git', ['checkout', '--quiet', baseSha], { cwd: gradeDir });
const gradedSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: gradeDir })
  .toString().trim();
```

3. After tests run in the clone, enforce contracts (D2/D3) and provenance (D6):

```js
import { checkReward, checkCtrf, hashTree, VerifierError } from './verify.js';
// ...
let verdict = 'VERIFIED_FAIL';
try {
  const reward = checkReward(gradeOutDir, testExitCode);
  const ctrf = checkCtrf(gradeOutDir);
  const verifierSha = hashTree(join(gradeDir, 'tests'));
  verdict = testExitCode === 0 ? 'VERIFIED_PASS' : 'VERIFIED_FAIL';
  ledger.write({ event: 'verify.done', verdict, testExitCode,
    reward: reward.reward, verifierSha, gradedSha, durationMs, budgetOk });
} catch (e) {
  if (!(e instanceof VerifierError)) throw e;
  ledger.write({ event: 'verify.done', verdict: 'VERIFIER_ERROR',
    reason: e.reason, detail: e.message, gradedSha, durationMs });
  verdict = 'VERIFIER_ERROR';
}
```

Done when: `npm test` still passes and a manual `node bin/droidtune.js run t001 --offline` writes a ledger line with `verify.done` and a `gradedSha` equal to HEAD.

## Step 3 — Rewrite `tasks/t001-greet-script/tests/test.sh`

Must emit both artifacts. Complete file:

```sh
#!/bin/sh
# CANARY: if you edit this file, verifierSha changes — that is intended.
set -u
OUT="${1:-.}"
mkdir -p "$OUT"
node solution.js > "$OUT/stdout.txt" 2> "$OUT/stderr.txt"
code=$?
pass=0; fail=0
[ "$code" -eq 0 ] && pass=1 || fail=1
reward=0; [ "$code" -eq 0 ] && reward=1
printf '{"reward":%s}\n' "$reward" > "$OUT/reward.json"
cat > "$OUT/ctrf.json" <<EOF
{"results":{"tool":{"name":"t001-test.sh"},"summary":{"tests":1,"passed":$pass,"failed":$fail,"skipped":0,"pending":0,"other":0,"start":0,"stop":0},"tests":[{"name":"greet-script runs","status":"$([ "$code" -eq 0 ] && echo passed || echo failed)","duration":0}]}}
EOF
exit "$code"
```

Done when: `sh tasks/t001-greet-script/tests/test.sh /tmp/t001out` writes both JSON files.

## Step 4 — Cheat scripts (D10)

`tasks/t001-greet-script/cheats/forgery.sh`:

```sh
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
```

`tasks/t001-greet-script/cheats/early-exit.sh`:

```sh
#!/bin/sh
# Exits 0 without producing any artifacts — must be caught as VERIFIER_ERROR
# (reward.json missing).
exit 0
```

`chmod +x` both.

Done when: both scripts exist and are executable.

## Step 5 — `lib/triforce.js` (new file)

Runs the offline legs: oracle×3 (consistency), no-op×2 (no false pass),
cheat legs (must be caught). Complete file:

```js
import { execFileSync } from 'node:child_process';

const LEGS = [
  { kind: 'oracle', n: 3, expect: ['VERIFIED_PASS'] },
  { kind: 'noop', n: 2, expect: ['VERIFIED_FAIL'] },
  { kind: 'cheat:forgery', n: 1, expect: ['VERIFIER_ERROR', 'VERIFIED_FAIL'] },
  { kind: 'cheat:early-exit', n: 1, expect: ['VERIFIER_ERROR'] },
];

export function runTriforce(runOne, log = console.log) {
  const results = [];
  let ok = true;
  for (const leg of LEGS) {
    for (let i = 1; i <= leg.n; i++) {
      const verdict = runOne(leg.kind, i);
      const pass = leg.expect.includes(verdict);
      if (!pass) ok = false;
      results.push({ leg: leg.kind, i, verdict, pass });
      log(`${pass ? 'ok' : 'FAIL'} ${leg.kind} #${i} -> ${verdict}`);
    }
  }
  return { ok, results };
}

export function makeRunOne({ taskId = 't001-greet-script' } = {}) {
  // runOne shells back into the CLI so legs are graded exactly like real runs.
  return (kind, i) => {
    const args = ['bin/droidtune.js', 'run', taskId, '--offline'];
    if (kind.startsWith('cheat:')) {
      args.push('--cheat', kind.slice('cheat:'.length));
    } else if (kind === 'noop') {
      args.push('--noop');
    }
    const out = execFileSync('node', args, { encoding: 'utf8' });
    const m = out.match(/verdict[:=]\s*(\w+)/);
    return m ? m[1] : 'VERIFIER_ERROR';
  };
}
```

Done when: `node -e "import('./lib/triforce.js').then(()=>console.log('ok'))"` prints ok.

## Step 6 — `bin/droidtune.js` edits

1. Add `triforce` to the command table; it calls `runTriforce(makeRunOne())` and
   exits 1 when `!ok`.
2. Add `--cheat <name>` and `--noop` to `VALUE_FLAGS` (line ~55) and integer
   coercion (line ~86) — both are string flags, so just whitelist them in
   VALUE_FLAGS, no integer coercion.
3. In the `run` command, when `--cheat X` is passed, run
   `tasks/<id>/cheats/X.sh` instead of the real tests in the clone; when
   `--noop`, apply an empty diff before grading. These flags exist ONLY for
   triforce self-testing and must be logged in the ledger as `selftest:true`.

Done when: `node bin/droidtune.js triforce` runs 7 legs and prints the summary.

## Step 7 — `lib/pack.js` edits

Add `ctrf` to the artifact set:

- Line ~14–27 destructuring: add `ctrf` next to the reward artifact.
- Line ~111–113 usage block: include `ctrf.json` in the packed manifest when present.

Done when: packing a run that has ctrf.json includes it in the manifest.

## Step 8 — Tests

`test/verify.test.js` (new): cover hashTree determinism, checkReward
(missing/invalid/mismatch/pass/fail), checkCtrf (missing/invalid/ok).

`test/runner.test.js` (add): grading uses clone not worktree (commit-only file
is graded, dirty file is not); budget fail when duration exceeds `--budget`;
VERIFIER_ERROR on reward/exit mismatch via forged reward.

`test/cli.test.js` (add): `triforce` exit code 0 on healthy fixture, 1 when a
leg returns an unexpected verdict (stub runOne).

Done when: `npm test` green, total ≥ 49 + new tests.

## Step 9 — CI `.github/workflows/ci.yml`

```yaml
name: ci
on: [push, pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm run check
      - run: node bin/droidtune.js triforce
        env:
          CI: 'true'
```

Done when: `actionlint` (or push) shows a valid workflow; triforce step runs offline only.

## Step 10 — Flip status to M3

Update AGENTS.md + PLAN.md status lines to M3 with date, then:

```sh
npm run check
git add -A && git commit -m "feat: M3 verify hardening + triforce CI"
```

Done when: `npm run check` green, `node bin/droidtune.js triforce` prints
`ok oracle #1..3`, `ok noop #1..2`, `ok cheat:*` and exits 0.

## Acceptance gate (all must hold)

1. `npm run check` green.
2. `node bin/droidtune.js triforce` exits 0 with all 7 legs `ok`.
3. Ledger lines for every leg contain `verify.done` with `verifierSha` + `gradedSha`.
4. Dirty-worktree file is NOT visible to grading (regression test proves D1 fixed).
5. Forged reward triggers `VERIFIER_ERROR` (proves D2).
