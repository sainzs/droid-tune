---
description: Render a Markdown results table from Droid Tune-Up evidence packs (scripts/results-table.js).
---

Render the results table from evidence packs under the plugin's `runs/` directory. Execute:

node ${DROID_PLUGIN_ROOT}/scripts/results-table.js $ARGUMENTS --runs-dir ${DROID_PLUGIN_ROOT}/runs

The trailing `--runs-dir ${DROID_PLUGIN_ROOT}/runs` is the default when $ARGUMENTS omits it; if the caller passes their own `--runs-dir`, that wins (results-table.js's arg parser keeps the first occurrence of a flag, so an earlier `--runs-dir` in $ARGUMENTS takes precedence over this trailing default). This MUST match where `/tune-trial` actually writes packs: `droidtune trial` defaults `--runs-dir` to `${DROID_PLUGIN_ROOT}/runs` (i.e. the plugin/repo root's `runs/`, resolved independently of the invoking shell's cwd) — a bare relative `--runs-dir runs` here would instead resolve against whatever directory the caller's shell/droid session happened to be in, which is very often NOT where `/tune-trial` wrote anything. Do not reimplement the table or provider-error classification; the script already does both.
