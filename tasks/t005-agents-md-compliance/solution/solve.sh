#!/bin/sh
set -eu
target="${1:?usage: solve.sh TARGET_DIR}"
cd "$target"

cat > greet.sh <<'EOF'
#!/bin/sh
printf 'howdy, %s!\n' "$1"
EOF
chmod +x greet.sh
git add greet.sh
git commit -qm "feat(greet): add greeting tool"
