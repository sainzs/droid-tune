#!/bin/sh
set -u

if [ ! -f greet.sh ]; then
    printf '%s\n' '{"task":"t001-greet-script","reward":0}' > reward.json
    exit 1
fi

out=$(sh greet.sh 2>&1)

if [ "$out" = "hello tune-up" ]; then
    printf '%s\n' '{"task":"t001-greet-script","reward":1}' > reward.json
    exit 0
fi

printf '%s\n' '{"task":"t001-greet-script","reward":0}' > reward.json
exit 1
