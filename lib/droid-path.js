import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

// Shared droid-binary resolution, used by both `diagnose` and any command
// that needs a working droid binary to spawn (`trial`, `baseline`). Priority:
// explicit path > DROID_PATH env var > ~/.local/bin/droid > PATH. Each
// candidate is verified with `--version` before being accepted, so a stale or
// non-executable entry earlier in the list doesn't shadow a working one later.
// Previously this lived only in lib/diagnose.js, so `trial`/`baseline` used a
// separate hardcoded ~/.local/bin/droid guess that ignored DROID_PATH, PATH,
// and never verified the binary actually runs — `diagnose` could find droid
// while `trial` failed for the same machine.
export function resolveDroid (explicit) {
  const candidates = explicit
    ? [explicit]
    : [process.env.DROID_PATH, path.join(os.homedir(), '.local', 'bin', 'droid'), 'droid'].filter(Boolean)
  for (const cand of candidates) {
    const res = spawnSync(cand, ['--version'], { encoding: 'utf8', timeout: 15000 })
    if (!res.error && res.status === 0) {
      return { path: cand, version: (res.stdout || '').trim() || null }
    }
  }
  return null
}
