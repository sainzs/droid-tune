---
description: Diagnose the local Factory Droid setup (versions, config, sessions, faults) via the Droid Tune-Up CLI.
---

Run the Droid Tune-Up diagnostics against the local environment. Execute:

node ${DROID_PLUGIN_ROOT}/bin/droidtune.js diagnose $ARGUMENTS

Pass any of the CLI's diagnose flags through $ARGUMENTS (e.g. `--json`, `--demo`, `--probe <model>`, `--limit <n>`). Do not reimplement any diagnostics; the CLI produces the full fault/hint report, exit code, and (with `--demo`) runs bundled fixtures with no Droid install.
