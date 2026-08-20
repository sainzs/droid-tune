---
description: Render a Markdown results table from Droid Tune-Up evidence packs (scripts/results-table.js).
---

Render the results table from evidence packs under `runs/`. Execute:

node ${DROID_PLUGIN_ROOT}/scripts/results-table.js $ARGUMENTS --runs-dir runs

The trailing `--runs-dir runs` is the default when $ARGUMENTS omits it; if the caller passes their own `--runs-dir`, that wins. Do not reimplement the table or provider-error classification; the script already does both.
