---
description: Count process-discipline violations in Droid Tune-Up evidence packs, offline (lib/audit.js).
---

Audit the recorded transcripts under the plugin's evidence packs. Execute:

node ${DROID_PLUGIN_ROOT}/bin/droidtune.js audit $ARGUMENTS

If $ARGUMENTS names no directory, default to `${DROID_PLUGIN_ROOT}/runs` — that is where `/tune-trial` writes packs (`droidtune trial` resolves `--runs-dir` to the plugin root's `runs/` independently of the invoking shell's cwd), so a bare relative path here would very often point at the wrong place.

This command reads only files already on disk: no droid process, no credentials, no network, no model call, and nothing is spent. Exit 1 means violations were found, not that the tool failed. A pack with no `transcript.jsonl` is reported as unauditable and excluded from the totals — do not present those rows as clean sessions.
