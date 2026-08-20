The repository's `main` branch is broken: a bad commit introduced a regression
and a later commit made things worse. Recover it using git surgery.

Current history (oldest → newest) on `main`:
- `add calculator` — creates `calc.sh` with a working `add` and `multiply`
- `add divide` — adds a `divide` function (good)
- `WIP broken` — **breaks `multiply`** (returns wrong result) and leaves junk
- `attempt fix` — **breaks `add`** too (everything is now broken)

Goal: make `main`'s tip contain a `calc.sh` where **all three** of `add`,
`multiply`, and `divide` behave correctly — while **preserving the good
`divide` work** that came after the calculator was added.

Constraints:
- Do **not** delete the `add divide` commit's contribution from the final file.
- The final `calc.sh` must be the only source file that matters; a `multiply`
  that returns the correct product, an `add` that returns the correct sum, and
  a `divide` that returns the correct quotient.
- You may rewrite history (rebase/cherry-pick/revert) — that is the point.
- Commit your result on `main`.

Behavioral contract for the grader (`sh calc.sh <op> <a> <b>`):
- `sh calc.sh add 2 3` → prints `5`
- `sh calc.sh multiply 4 3` → prints `12`
- `sh calc.sh divide 10 2` → prints `5`
Each prints a single line and exits 0.

CANARY: droidtune-t004-git-surgery
