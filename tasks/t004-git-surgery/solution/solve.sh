#!/bin/sh
# Oracle: produce a tip calc.sh where add/multiply/divide all work and the good
# divide contribution is preserved. Any history rewrite is acceptable.
set -eu
target="${1:?usage: solve.sh TARGET_DIR}"
cd "$target"

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
chmod +x calc.sh
rm -f JUNK.txt
git add -A
git commit -qm "fix add and multiply; preserve divide; drop junk"
