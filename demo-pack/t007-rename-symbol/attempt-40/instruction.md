The repo has a small Python package `calc/` whose public entry point is
misnamed. Rename the function **and every reference** so the public name is
consistent everywhere.

Current layout (committed on `main`):

- `calc/__init__.py` — `from .core import compute; __all__ = ["compute"]`
- `calc/core.py` — `def compute(a, b): return a + b`
- `calc/cli.py` — imports `compute` from the package, exposes a `main()`
- `main.py` (repo root) — `from calc import compute`, calls `compute(...)`

Goal: the public function must be renamed from `compute` to **`add`**.
After your change:

1. `from calc import add` works and `add(2, 3) == 5`.
2. `python3 main.py` (which must now import `add`) prints the sum of its two
   CLI args: `python3 main.py 2 3` → prints `5`.
3. `python3 -m calc.cli 4 5` (which must now use `add`) prints `9`.
4. **No remaining reference to the old name `compute`** exists anywhere in the
   repo's `.py` files.

Constraints:
- Keep the package layout (do not collapse everything into one file).
- `calc/__init__.py` must export `add` via `__all__`.
- Commit your work to git with a descriptive message.

The grader runs the three behaviors above and greps for any leftover `compute`.

CANARY: droidtune-t007-rename-symbol
