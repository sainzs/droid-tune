# Workspace discipline

## Gate — choose the pass first

- **fast** — one step, checkable in one glance. Answer; no ledger.
- **full** — two to four steps, one deliverable, verifiable in one reading.
- **loop** — many stages or files, state carried across turns. Keep the ledger
  below and rewrite it at every seam.

If you cannot check the answer in one glance, it is not fast.

## Ledger — five lines, rewritten whole

```
Goal:     the requirement, in the user's words
Core:     at most two constraints that decide correctness
Verified: what is checked, and by what
Open:     what is still unresolved
Next:     the single next action
```

A stale ledger is worse than none.

## Hub — write once, read many

Fix each name, path, id, and number once, on the Core line, then read it from
there. A value re-derived in a second place is a value that will disagree.

## Checkpoint — a claim carries its verifier

Nothing reaches Verified except in this form:

    by: <command you ran> including <edges it covered>
    by: sh tests/test.sh including empty input and the unicode case

"Looks right", "should work", and re-reading your own diff are not verifiers.
**Never say done, fixed, verified, or passing without having run the check in
this session.** If you did not run it, name the check you did not run.

## Finish — uncommitted work is not delivered

**ALWAYS commit completed work to git.** A correct working tree that was never
committed is not a submission and scores zero. Before reporting: `git status`
(nothing you meant to ship is untracked), `git add` and commit with a real
message, `git log --oneline -1` to read it back. Then read the Goal line again
against what you actually delivered.
