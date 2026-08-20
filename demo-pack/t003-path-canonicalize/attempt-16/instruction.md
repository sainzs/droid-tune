Implement a Node.js module `canonicalize.mjs` at the repository root (ESM,
Node ≥ 20, **standard library only — no npm packages**).

It must export a single named function:

```js
export function canonicalizePath(name) { /* ... */ }
```

`canonicalizePath(name)` takes a single path component (a file or directory
name, not a multi-segment path) and returns a canonical key string such that
names that are "the same" for a human reader map to the **same** key, and
genuinely different names map to **different** keys. The collisions you must
collapse, in priority order:

1. **Normalization twins** — NFC and NFD forms of the same string are equal.
   `café.txt` (U+00E9) and `café.txt` (e + U+0301 combining) → same key.
2. **Case twins** — differing only by letter case are equal.
   `README.md` and `readme.md` → same key.
3. **Compatibility twins** — equal after NFKC compatibility decomposition
   plus case folding: ligatures (`ﬁle.txt` U+FB01), full-width forms
   (`ＦＩＬＥ.txt`), the Kelvin sign (`K` U+212A vs `k`), etc. → same key.

The function must be **total and deterministic**: it never throws, and any
string (including empty, control characters, and invisibles such as U+00A0 or
U+200B) yields a stable string key. Trailing/leading whitespace and invisibles
that do not affect human identity may be preserved or stripped, but your rule
must be consistent.

Commit your work to git with a descriptive message. Do not add tests or other
files.

CANARY: droidtune-t003-path-canonicalize
