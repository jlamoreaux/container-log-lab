#!/usr/bin/env bash
set -euo pipefail

# These are ordinary commands. Only democtl is instrumented by the PATH shim.
work_dir=$(mktemp -d)
trap 'rm -rf "$work_dir"' EXIT
cd "$work_dir"
ls > /dev/null
democtl locations location list --format json > locations.json
democtl inventory count batch-get --states IN_STOCK --all --format json > counts.json
democtl catalog item list --all --format json | wc -c > catalog_bytes.txt
democtl inventory purchase-order list --page-size 100 --format json > purchase_orders.json
test -s locations.json && test -s counts.json && test -s catalog_bytes.txt && test -s purchase_orders.json
read -r catalog_bytes < catalog_bytes.txt
test "$catalog_bytes" -gt 0
