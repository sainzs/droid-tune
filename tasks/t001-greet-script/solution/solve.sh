#!/bin/sh
set -eu

target="${1:?usage: solve.sh TARGET_DIR}"
cd "$target"

cat > greet.sh <<'EOF'
#!/bin/sh
printf 'hello tune-up\n'
EOF
chmod +x greet.sh

git add greet.sh
git commit -qm "add greet script"
