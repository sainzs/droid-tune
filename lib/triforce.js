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
