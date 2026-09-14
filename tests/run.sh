#!/bin/sh
# Everything that must pass before a commit.
set -e
cd "$(dirname "$0")/.."

echo "== unit =="
dub test --skip-registry=all -q

printf "\n== build ==\n"
dub build --skip-registry=all -q
(cd cli && dub build --skip-registry=all -q && dub build --config=probe --skip-registry=all -q)
(cd cli && dub test --skip-registry=all -q)

printf "\n== crypto ==\n"
node tests/crypto_test.mjs

printf "\n== qr ==\n"
node tests/qr_test.mjs

printf "\n== api, http surface, amnesia ==\n"
python3 tests/api_test.py

printf "\n== browser ==\n"
node tests/browser_test.mjs

printf "\n== cli ==\n"
python3 tests/cli_test.py

printf "\n== crypto interop ==\n"
node tests/interop_crypto_test.mjs

printf "\n== terminal and browser together ==\n"
node tests/interop_test.mjs
