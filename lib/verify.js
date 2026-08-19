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
