Implement a Node.js module `safelist.mjs` at the repository root (ESM, Node ≥ 20,
**standard library only — no npm packages**).

It must export a single named function:

```js
export function safeListdir(names) { /* ... */ }
```

`safeListdir(names)` takes an array of directory-entry name strings (as returned
by `fs.readdir`, which can contain arbitrary bytes decoded as UTF-8 — including
invisible, control, and host-unsafe characters) and returns a **new array** of
only the names that are safe to hand to a downstream `open(2)`/`fs.readFile`
call **portably** (macOS, Linux, Windows).

A name is **unsafe** — and must be dropped — if any of these hold:

1. It contains a **control character** (U+0000–U+001F, U+007F).
2. It contains an **invisible/format** character that renders as nothing or as
   whitespace but is not a real space: U+00A0 (no-break space), U+200B
   (zero-width space), U+200E/U+200F (directional marks), U+FEFF (BOM/zero-width
   no-break space).
3. Its **stem** (name without the final extension) is a **Windows-reserved
   device name**, case-insensitive: `CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`,
   `LPT1`–`LPT9`. (`NUL.txt` and `nul` are both unsafe.)
4. It is `.` or `..`.
5. It is the empty string, or contains a path separator (`/` or `\`).

Names that are merely unusual but portable — spaces, Unicode letters, `café.txt`,
`README.md`, `archive.tar.gz` — must be **kept, in original order**, byte-for-byte.

The function must be **total and deterministic**: never throws, and any array of
strings yields a stable array. Do not mutate the input array.

Commit your work to git with a descriptive message. Do not add tests or other files.

CANARY: droidtune-t006-safe-listdir
