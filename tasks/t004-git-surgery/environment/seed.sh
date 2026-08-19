#!/bin/sh
# Seed a repo whose main history contains a regression the agent must fix while
# preserving the good "add divide" work. History (oldest->newest):
#   add calculator  (working add + multiply)
#   add divide      (good divide)
#   WIP broken      (breaks multiply, leaves junk)
#   attempt fix     (breaks add too)
set -eu

target="${1:?usage: seed.sh TARGET_DIR}"
mkdir -p "$target"
cd "$target"

if git init -q -b main 2>/dev/null; then :; else git init -q; git symbolic-ref HEAD refs/heads/main; fi
git config user.email "trial@droidtune.local"
git config user.name "droidtune trial"

# commit 1: working add + multiply
cat > calc.sh <<'EOF'
#!/bin/sh
op="$1"; a="$2"; b="$3"
case "$op" in
  add) echo $((a + b));;
  multiply) echo $((a * b));;
  *) echo "unknown op" >&2; exit 1;;
esac
EOF
chmod +x calc.sh
git add calc.sh
git commit -qm "add calculator"

# commit 2: good divide
cat > calc.sh <<'EOF'
#!/bin/sh
op="$1"; a="$2"; b="$3"
case "$op" in
  add) echo $((a + b));;
  multiply) echo $((a * b));;
  divide) echo $((a / b));;
  *) echo "unknown op" >&2; exit 1;;
esac
EOF
git add calc.sh
git commit -qm "add divide"

# commit 3: WIP broken (breaks multiply, leaves junk file)
cat > calc.sh <<'EOF'
#!/bin/sh
op="$1"; a="$2"; b="$3"
case "$op" in
  add) echo $((a + b));;
  multiply) echo $((a + b));;  # BROKEN: multiply adds
  divide) echo $((a / b));;
  *) echo "unknown op" >&2; exit 1;;
esac
EOF
echo "scratch junk" > JUNK.txt
git add calc.sh JUNK.txt
git commit -qm "WIP broken"

# commit 4: attempt fix (breaks add too)
cat > calc.sh <<'EOF'
#!/bin/sh
op="$1"; a="$2"; b="$3"
case "$op" in
  add) echo $((a - b));;        # BROKEN: add subtracts
  multiply) echo $((a + b));;   # still broken
  divide) echo $((a / b));;
  *) echo "unknown op" >&2; exit 1;;
esac
EOF
git add calc.sh
git commit -qm "attempt fix"
