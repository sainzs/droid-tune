Implement a Python module `slugify.py` at the repository root.

It must define a single public function `slugify(text)` that converts a string
into a URL-safe slug according to these rules, applied in order:

1. Normalize Unicode to ASCII (NFKD, drop combining characters).
2. Lowercase.
3. Replace every run of one or more non-alphanumeric characters with a single
   hyphen `-`.
4. Strip leading and trailing hyphens.

Examples:
- `slugify("Hello, World!")` → `"hello-world"`
- `slugify("  --Crème brûlée-- ")` → `"creme-brulee"`
- `slugify("déjà vu")` → `"deja-vu"`
- `slugify("a___b")` → `"a-b"`
- `slugify("")` → `""`
- `slugify("!!!")` → `""`

Use only the Python standard library. The function must be importable as
`from slugify import slugify`. Commit your work to git with a descriptive
message. Do not add tests or any other files.

CANARY: droidtune-t002-slugify
