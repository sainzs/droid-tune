---
description: Run a guided Droid Tune-Up trial on a configured BYOK route through the droidtune CLI.
---

Run one task end-to-end through `droid exec` and write a hash-manifested evidence pack. Execute:

node ${DROID_PLUGIN_ROOT}/bin/droidtune.js trial $ARGUMENTS

`--model` is required — the CLI refuses to guess a model, since an implicit default could silently spend a paid plan. If the caller did not supply `--task` and `--model`, ask which task directory under `tasks/` and which configured BYOK custom model to use, then re-run with those flags. Note: trials spend the user's BYOK credits. Do not duplicate any trial, grading, or packaging logic; the CLI handles orchestration, isolation, and the evidence pack.

The CLI's own output ends with the exact evidence-pack path (`pack ...`) and the exact `/tune-report`-equivalent command to read it back (`report ...`) — always relay both lines to the caller verbatim rather than guessing a runs directory yourself.
