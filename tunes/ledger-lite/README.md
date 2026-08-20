# ledger-lite

A workspace-discipline block that Droid reads on its own. `AGENTS.md` in this
directory is copied into the task worktree before `droid exec` runs; Droid
picks it up natively, so no prompt injection, wrapper, or harness hook is
involved.

```sh
node bin/droidtune.js trial --task tasks/t004-git-surgery \
  --model hy3-free --tune ledger-lite --tune-file tunes/ledger-lite
```

Any directory containing an `AGENTS.md` works — `--tune-file` is general, and
this tune is only the first one.

## What it asks for

- **Gate** — classify the work as fast / full / loop before starting, with the
  floor rule that anything you cannot check in one glance is not fast.
- **Ledger** — five lines (Goal, Core, Verified, Open, Next), rewritten whole
  at every seam rather than appended to.
- **Hub** — fix each name, path, id, and number once, then read it from there.
- **Checkpoint** — nothing counts as verified without
  `by: <command> including <edges>`, and never claim done/fixed/verified
  without having run the check in that session.
- **Finish** — **always commit completed work to git**; an uncommitted working
  tree is not a submission.

That last line is the one this tune exists for. In this repo's M4 flake check,
7 of 8 `t004-git-surgery` attempts scored `NO_SUBMISSION`: the models performed
the git surgery correctly, checked the behavior, narrated success, and never
ran `git commit`. The commit contract is aimed squarely at that failure.
Whether it actually moves the rate was preregistered as
`claims/dt-v1-ledger-lite-nosub.json` and measured 2026-08-20: **not
supported** — a 5.0pp pooled NO_SUBMISSION reduction against the required
25pp, Fisher exact p = 0.7695, VERIFIED_PASS floor intact. Full tables and
provenance: `docs/dt-v1-ledger-lite-nosub-results-2026-08-20.md`.

## Cost

1721 bytes / 294 words / 46 lines, prepended to the model's context once per
session. That is roughly **390 tokens** — a words × 1.33 estimate, not a
tokenizer count: this repo carries zero runtime dependencies and vendors no
tokenizer, so treat the figure as an estimate and measure against your own
route's reported `inputTokens` if the number matters.

## How it is applied

`lib/tune.js` writes the file into the seeded worktree as an **untracked**
file and adds it to `.git/info/exclude`. Both halves matter:

- Not committed, so the seeded history stays byte-identical to the no-tune
  arm. `t004-git-surgery`'s instruction names its four seed commits verbatim;
  an extra tune commit would change the task itself.
- Excluded, so an agent running `git add -A` cannot sweep the tune into the
  graded patch.

Applying a tune onto a task that ships its own `AGENTS.md` is refused, not
silently resolved — `t005-agents-md-compliance` grades against exactly that
file, so overwriting it would quietly measure a different task. The pack's
provenance records the tune name, path, size, and SHA-256, and the event
ledger gets a `tune.applied` entry, so a pack can always name the tune that
produced it.

## Attribution

Distilled from the [J-Space Cognition Suite
V3.6](https://github.com/Tiger3807861189/J-Space-Cognition-Suite-V3.6),
released under the Apache License 2.0. The gate/ledger/hub/checkpoint
vocabulary and the "no claim without running the check" rule are J-Space's;
this file is an original, heavily compressed restatement of that subset — no
J-Space text or code is copied, and the git-commit contract in the Finish
section is droid-tune's own addition, driven by the `t004` evidence above.
